# Robot Eye — browser prototype for GC9A01 round displays

A single animated eye for a 1.28" GC9A01 round TFT (240×240, RGB565), prototyped in plain
HTML + vanilla JS so the logic can be ported to an ESP32-S3 (Arduino + TFT_eSPI)
almost line by line.

```
index.html      page + controls
style.css       UI styling
eye-logic.js    pure state + update logic (no DOM, no canvas)  ← this gets ported 1:1
eye-render.js   per-pixel renderer built on lookup tables      ← same structure on the MCU, framebuffer swapped for TFT_eSprite
main.js         input, UI, game loop                           ← becomes setup()/loop()
```

## Running it

Double-click `index.html` (Chrome). No server, no build, no dependencies. The
scripts are classic `<script>` tags rather than ES modules on purpose: Chrome
blocks module imports from `file://`.

- **Mouse** — the eye follows the cursor anywhere on the page.
- **Joystick** — drag the on-screen stick (springs back on release) or hold
  WASD / arrow keys. Grabbing the stick or pressing a direction key switches to
  this mode automatically. Values shown are the normalized −1..1 stick output.
- **Auto** — saccades only.
- **Space** or the **Blink** button blinks in any mode.
- **Blinking** checkbox: turns automatic blinking off. That covers both the
  random 2–6 s blinks and the blinks that come with big gaze jumps. Space and the
  Blink button still blink on demand, and a blink already in progress always
  finishes, so the eye can't get stuck half shut.
- **Cyberpunk glitches** panel: the **Glitches** checkbox turns automatic
  glitches on or off. Turning it off also cancels a burst in progress. Use
  **Glitch freq.** and **Intensity** to tune them. **G** or **Glitch now**
  triggers a burst even when automatic glitches are off. The label next to the
  button shows which effects the current burst uses.
- In Mouse/Joystick mode, after 2.5 s without input the eye falls back to
  saccades, so it never freezes.
- **Seed + Reset** restarts the simulation. With the same seed, Auto mode
  replays exactly the same animation (the logic is deterministic).
- **Look**: iris size and color, pupil base size, sclera color, and the amount
  of veins. **Eyelids**: *Black* (default) blends into the black bezel, as in
  Adafruit Uncanny Eyes and the photo reference; *Skin* and *Metal* make the lids
  visible. **Catchlight** turns the rendered window-shaped highlight on or off.
- **Glass dome look** is a CSS-only overlay (bezel ring, gloss, rim shading) that
  previews the module behind a glass cabochon. It never touches the canvas
  pixels, which stay exactly what the panel would show. Turn it off to see the
  raw 240×240 output.
- **RGB565 preview** quantizes every frame to 5-6-5 bits so you see banding the
  way the panel will show it. The color pickers also print the RGB565 value you
  would pass to TFT_eSPI.
- `window.__eye` in DevTools exposes the live state, input and settings.

Stats in the top bar: actual FPS / cap, logic time per frame, render time per
frame, and the total.

## How the logic works

Everything lives in one `EyeState` object, updated by
`updateEye(state, input, dtMs)`. The eye gets its drawing parameters from
`computeEyeView(state, eyeIndex, eyeCount, view)`, which writes into a
preallocated `EyeView`. The renderer only reads `EyeView`. The page shows one
eye (`eyeIndex 0, eyeCount 1`).

### Gaze
Gaze is a normalized vector (−1..1, +y = down) kept inside the unit circle.
Each frame the current gaze moves toward the target with **exponential
easing**:

```
k = 1 - exp(-dt / tau)
gaze += (target - gaze) * k
```

`tau` is a time constant, so the motion looks the same at 20, 30 or 60 FPS.
Following input uses `tau = 90 ms`; saccades use `26 ms`, which reads as a snap.
The eye-speed slider divides `tau`.

Because each step blends two points that are inside the circle, the gaze can
never leave it (a circle is convex), so no per-frame clamp is needed on the gaze
itself; only the target is clamped.

**Iris clamp.** Normalized gaze is scaled by
`maxOffset = SCLERA_RADIUS - irisRadius - IRIS_EDGE_MARGIN`. At |gaze| = 1 the
iris edge is therefore still 4 px inside the sclera, for any iris size.
Foreshortening (the iris flattens as it moves toward the edge, like a disc on a
ball) only shrinks the iris, so the guarantee still holds.

**Convergence (for later).** With one eye the offset is zero. If you add more
eyes back (`app.eyeCount` in `main.js`), each gets a small inward offset
(`CONVERGENCE`) and shares the same gaze and blink.

### Saccades
When there's no input, a countdown runs (sped up by the saccade-frequency
slider). When it fires, `startSaccade()` picks one of three jump types:

| chance | jump |
|---|---|
| 35 % | micro-saccade: tiny correction around the current point |
| 20 % | return to roughly straight ahead |
| 45 % | random point in a disc, with vertical range ×0.7 (eyes wander more sideways) |

Random disc points use `r = sqrt(u)` so they're spread evenly over the area
rather than bunched at the center. Big jumps sometimes trigger a blink, as
human eyes often do. The pause until the next jump is random, 350–2200 ms.

### Blink state machine

```
        timer runs out / Space
OPEN ──────────────────────────► CLOSING (70 ms, amount = p²     — accelerates)
  ▲                                  │
  │                                  ▼
OPENING (170 ms, amount = (1-p)² ◄── CLOSED (35 ms hold)
         — fast start, settles)
```

- The next blink is scheduled 2–6 s later (scaled by the blink-frequency slider).
- With a 15 % chance it's scheduled 80–180 ms later instead, which gives a
  **double blink**. The second blink always returns to normal spacing.
- With `input.blinkEnabled = false` the countdown is frozen and big saccades
  don't blink. `input.blink` (Space/button) still works.
- A blink requested while the lid is still OPENING reverses smoothly: closing
  uses `p²`, so it restarts at `p = sqrt(currentAmount)` and the lid doesn't jump.

`blinkAmount` (0..1) drives both lids toward `LID_MEET_Y`. The upper lid travels
most of the way, as in a real eye. Each lid edge is an arc of a circle
(radius 135–140 px when open). Its radius grows as the lid closes, so a shut eye
is one gentle line.

### Eyelid tracking
The lids' open positions follow vertical gaze: the upper lid drops 38 px per
unit of downward gaze and lifts when looking up. The lower lid moves 18 px the
same way. With the defaults, both lids sit just outside the round display when
looking straight ahead, so the eye looks wide open. They slide into view as the
eye looks down or up. This "Uncanny Eyes" trick is a large part of what makes the eye look
alive.

### Pupil
`target = pupilBase × lightScale × (1 + noise)`, clamped to 15–80 % of the iris.

- `lightScale` blends linearly from 1.45 (dark) to 0.6 (bright).
- `noise` is a slow random drift of ±8 %, re-targeted every 0.8–2.5 s (hippus,
  the natural pupil "breathing").
- The pupil eases toward the target faster when constricting (220 ms) than
  when dilating (900 ms), like a real pupil.

### Cyberpunk glitches

A glitch is a short **burst**. The logic decides *when*, *how strong* and *which
effects*; the renderer turns that into pixels.

```
IDLE ──timer (1.5–7 s ÷ freq) or G──► BURST ──duration over──► IDLE
                                       │  every 25–90 ms: new pattern seed,
                                       │  new strength (15 % chance: a clean
                                       │  frame => the burst stutters)
                                       └─ 25 % chance of an aftershock 120–400 ms later
```

- **55 % micro glitches** (50–140 ms, weaker) and **45 % big ones** (220–700 ms).
  Peak strength is scaled by the Intensity slider.
- Each burst picks an **effect mix**, stored as a bitmask in `glitchKinds`
  (C++: `uint8_t` flags). Tearing or RGB split is always included:

| bit | effect | where |
|---|---|---|
| `GLITCH_SLICE` | thin bands torn sideways, sometimes one big chunk jumps | renderer |
| `GLITCH_RGB` | red and blue channels pulled apart (chromatic aberration) | renderer |
| `GLITCH_BLOCKS` | rectangles: neon fill, bit-crushed + red/blue swapped, or data-moshed (copied from elsewhere in the row) | renderer |
| `GLITCH_NEON` | magenta/cyan tint weighted by brightness (blacks stay black) + scanlines | renderer |
| `GLITCH_NOISE` | lines of static | renderer |
| `GLITCH_DROPOUT` | signal loss: frame drops to ~10 % brightness | renderer |
| `GLITCH_JITTER` | the gaze twitches and the pupil snaps ±35 % | logic (added before the iris clamp, so the iris still can't leave the sclera) |

- The logic gives the renderer `glitchSeed`. The renderer seeds its own tiny
  xorshift with it, so every corrupted frame is fully determined by the state.
- With glitches disabled and idle, the glitch code makes **no PRNG calls**, so
  the rest of the animation is identical to a build without the feature.

### Randomness and determinism
`xorshift32` keeps 4 bytes of state in `EyeState.rng`. The logic never calls
`Math.random()`, never reads the clock and never touches the DOM. The same seed
and the same input/dt sequence give a bit-identical animation, so a C++ port
can be checked against the JS version frame by frame.

## How the renderer works

`eye-render.js` is written the way the ESP32 version will be: precomputed tables
plus one tight per-pixel loop, with no canvas drawing calls per frame. It writes
into an RGBA buffer and calls `putImageData`. On the MCU the buffer is the
sprite's RGB565 memory.

**Built once** (or when a color/slider changes):

| table | size | what it is |
|---|---|---|
| sclera texture | 416×416 RGB | cool white, pinker toward the "back" of the ball, faint mottling, thin branching veins near the periphery |
| iris texture | 512 angles × 64 radii RGB | **polar**: row 0 = pupil edge, row 63 = limbus. Fibres, a warm ring around the pupil, a wavy collarette, crypts, contraction furrows, a dark limbal ring and the pupillary ruff |
| shade | 240×240 float | Lambert lighting on a sphere, light from upper-left; darkens the rim so the flat panel reads as a ball |
| circle spans | 240 × (start, end) | the x range inside the round display for each row; pixels outside are never written and stay black |

**Every frame, per eye:**
1. **Lid tables:** the upper and lower lid edge y for each of the 240 columns
   (one `sqrt` per column).
2. For each pixel inside the circle:
   - **Sclera:** read the sclera texture, offset by the iris position, so veins
     turn with the eyeball. `TEX.SCLERA_SCROLL = 0` keeps the sclera static.
   - **Iris:** inside the iris box, undo foreshortening, compute distance `d`
     and angle. Then look up `iris[(d - pupilR)/(irisR - pupilR)][angle]`.
     Because the pupil edge always maps to row 0, a dilating pupil squeezes the
     whole iris pattern like a real one does.
   - **Pupil and limbus:** 1 px soft pupil edge, 1.5 px soft limbus.
   - **Shading:** multiply by `shade[]`, plus a soft shadow under each lid.
   - **Catchlight:** a soft wedge on the cornea, moving slightly less than the
     iris (parallax).
   - **Lids** on top, then optional RGB565 quantization.
3. **Glitch pass** (only while `glitchAmount > 0`). Every effect is
   **horizontal**, so the pass needs just **one 240-pixel line buffer**:
   - Plan the frame by filling three per-row tables from the seed:
     `rowShift[y]` (tear offset), `rowSplit[y]` (R/B offset) and `rowNoise[y]`.
   - For each touched row: copy it to the line buffer, then write back
     `R = line[x - shift + split]`, `G = line[x - shift]`,
     `B = line[x - shift - split]`. Anything sampled from outside the circle
     reads as black bezel. Then apply static, tint, scanlines and dropout.
   - Draw the blocks.
   - Quantize to RGB565 last, if enabled.
   Pixels outside the circle are never written, so they stay black even mid-glitch.

## Porting to ESP32-S3

### Logic → C++ (mechanical)

| JS | C++ |
|---|---|
| `CONFIG` object | `namespace Config { constexpr float ...; }` |
| `MODE_*`, `BLINK_*` | `enum class Mode : uint8_t`, `enum class BlinkPhase : uint8_t` |
| `createEyeState()` | `EyeState state;` global + `resetEyeState(state, seed)` in `setup()` |
| `updateEye(s, input, dt)` | `void updateEye(EyeState& s, const EyeInput& in, float dtMs)` |
| `computeEyeView(...)` | `void computeEyeView(const EyeState&, int i, int n, EyeView& out)` |
| numbers | `float` (the S3 has a single-precision FPU; avoid `double`, write `1.0f`, use `expf`/`sqrtf`/`cosf`) |
| `rng >>> 0`, `x >>> 17` | `uint32_t`, plain `>>` |
| `rngNextU32(s) / 4294967296` | `rngNextU32(s) * (1.0f / 4294967296.0f)` |

```cpp
struct EyeState {
  uint32_t rng;
  float timeMs, irisRadius;
  float gazeX, gazeY, targetX, targetY;
  bool  saccadeActive;
  float saccadeTimerMs, idleMs;
  BlinkPhase blinkPhase;
  float blinkPhaseMs, blinkAmount, blinkTimerMs;
  bool  doubleBlinkPending;
  float pupil, pupilNoise, pupilNoiseTarget, pupilNoiseTimerMs;
  // glitch
  float glitchTimerMs;
  bool  glitchActive, glitchManual;
  float glitchMs, glitchDurMs, glitchStrength, glitchAmount;
  uint8_t  glitchKinds;      // GLITCH_* bit flags
  uint32_t glitchSeed;
  float glitchReseedMs, glitchJitterX, glitchJitterY, glitchPupil;
};

static uint32_t rngNextU32(EyeState& s) {
  uint32_t x = s.rng;
  x ^= x << 13; x ^= x >> 17; x ^= x << 5;
  return s.rng = x;
}
```

Input mapping: `analogRead()` is 12-bit (0–4095). Use
`x = (raw - centerRaw) / 2048.0f`, measuring `centerRaw` at boot because sticks
are rarely centered at exactly 2048. The deadzone is already applied in the
logic. Map a button to `input.blink` with edge detection (true for one frame),
and another one to `input.glitch` the same way. Switches or a config flag set
`input.blinkEnabled` / `input.glitchEnabled`. A light sensor, such as an LDR on
an ADC pin, maps to `input.light`.

### Main loop

```cpp
TFT_eSPI    tft;
TFT_eSprite spr(&tft);         // one 240x240 frame buffer

const int CS_PINS[] = {10};    // one CS per display; add pins here for more eyes later
const int EYES = 1;
EyeState state; EyeInput input; EyeView view;

void setup() {
  for (int i = 0; i < EYES; i++) { pinMode(CS_PINS[i], OUTPUT); digitalWrite(CS_PINS[i], LOW); }
  tft.init();                  // all CS low => every panel receives the init sequence
  for (int i = 0; i < EYES; i++) digitalWrite(CS_PINS[i], HIGH);

  spr.setColorDepth(16);
  spr.createSprite(240, 240);  // 115 200 bytes; TFT_eSPI uses PSRAM if it's enabled
  resetEyeState(state, 1234);
}

void loop() {
  static uint32_t last = millis();
  const uint32_t FRAME_MS = 33;             // ~30 FPS
  uint32_t now = millis();
  if (now - last < FRAME_MS) return;
  float dt = now - last; last = now;

  readInputs(input);                        // joystick, button, light sensor
  updateEye(state, input, dt);

  for (int i = 0; i < EYES; i++) {
    computeEyeView(state, i, EYES, view);
    renderEye(spr, view);                   // your port of eye-render.js
    digitalWrite(CS_PINS[i], LOW);
    spr.pushSprite(0, 0);
    digitalWrite(CS_PINS[i], HIGH);
  }
}
```

TFT_eSPI notes:
- In `User_Setup.h`, set `TFT_CS -1` so the library doesn't toggle a CS pin, and
  drive each panel's CS yourself as above.
- Enable PSRAM in the board menu (e.g. "OPI PSRAM" on N8R8 / N16R8 modules).
  A sprite in internal RAM is faster to push, so with one eye try internal
  first; one 240×240×16-bit sprite is 115 KB.
- If you write pixels directly into the sprite buffer (`spr.getPointer()`),
  colors must be byte-swapped compared with `drawPixel`.
- TFT_eSPI's DMA push path needs DMA-capable internal RAM. The usual pattern is
  to render the frame in strips (e.g. 240×40) and push each strip with DMA
  while drawing the next one.
- TFT_eSPI ships `Animated_Eyes` examples (a port of Adafruit Uncanny Eyes) that
  are worth reading for the bitmap approach.

Minimal `User_Setup.h` for the wiring below:

```cpp
#define GC9A01_DRIVER
#define TFT_WIDTH  240
#define TFT_HEIGHT 240
#define TFT_MISO   -1      // GC9A01 modules have no MISO
#define TFT_MOSI   11
#define TFT_SCLK   12
#define TFT_CS     -1      // driven manually, one pin per display
#define TFT_DC      9
#define TFT_RST     8
#define LOAD_GLCD
#define SPI_FREQUENCY 40000000   // try 80 MHz once it's stable with short wires
```

### What is expensive on a microcontroller and how to make it cheap

**1. SPI bandwidth is the real limit, not the CPU.**
A full frame is 240×240×16 bit ≈ 0.92 Mbit. That's about 23 ms at 40 MHz SPI
and about 12 ms at 80 MHz. One eye at 40 MHz fits the 33 ms budget at 30 FPS,
but leaves only ~10 ms for rendering. Adding a second eye later won't fit
without the fixes below, from cheapest:

- **Push only the changed region.** Between frames only the iris box and the lid
  bands change. Keep last frame's bounding box (iris rect ∪ lid bands), union it
  with this frame's box, and push just that rectangle. TFT_eSPI has a
  `pushSprite` overload that takes a source rectangle. While the eye is fixating
  and not blinking, nothing changes, so push nothing.
- Raise SPI to 80 MHz (short wires, good ground).
- Run a separate SPI bus per eye (if you add more eyes). The S3 has two usable
  SPI hosts.
- Glitch frames change most rows, so they always need a full push. That's fine:
  they're short bursts, and a dropped frame during a glitch only adds to the
  effect.

The sclera turns with the eye, so every gaze movement changes the whole frame.
With `TEX.SCLERA_SCROLL = 0` only the iris box and lid bands change, which makes
partial pushes much more effective. Try both on the real panels.

**2. The per-pixel loop: move the remaining math into tables.**
The renderer already avoids gradients and drawing calls. What's left per pixel
inside the iris box is one `sqrt` and one `atan2`.

- **Iris distance/angle:** precompute a table over a (2·irisR)² box holding
  `(distance, angle)` per pixel, as Uncanny Eyes does. The loop then becomes two
  lookups. With foreshortening, keep the `sqrtf`; about 10k per frame is affordable on the S3.
  Alternatively set `CONFIG.FORESHORTEN = 0` and use the table.
- **Textures:** generate the sclera and iris tables offline, for example from
  this page via `__eye` in DevTools, and store them in flash as RGB565 arrays.
  The sclera at 416×416×2 = 346 KB fits in flash, and in PSRAM if you copy it.
  Or keep a smaller texture and drop the veins.
- **Shade table:** store it as `uint8_t` (0–255), and multiply in integer:
  `(c * shade) >> 8`, per 5- or 6-bit channel.
- **Write RGB565 directly:** pack each pixel as
  `((r & 0xF8) << 8) | ((g & 0xFC) << 3) | (b >> 3)` and byte-swap it for the
  sprite buffer, or let `pushSprite` handle the swap.

**3. Lids:** the per-column tables are already cheap (240 sqrt). For black lids,
fill the covered spans with `drawFastVLine` and skip those pixels in the main
loop.

**4. The round mask:** the row-span table means the corners (21 % of the
screen) are never touched.

**5. Integer and fixed-point math in per-pixel loops.**
The logic runs once per frame (about 75 ns per update in Node on a laptop; even
100× slower on the MCU is negligible), so `float` is fine there. Inside
per-pixel loops, use integers or fixed point (e.g. 8.8). Precompute colors as
RGB565 constants with `rgb888to565()`.

**6. Glitch pass:** per touched row it's one `memcpy` into the line buffer plus
one pass of shifts and integer math. Use `rgb565` packing directly. The R/B
split then means reading the 5-bit red field from `x+split` and the 5-bit blue
field from `x-split`. For noise, use a cheap xorshift per pixel. It needs no
extra framebuffer.

**7. Optional: use both cores.**
Pin rendering and the SPI push to different FreeRTOS tasks on core 0 / core 1,
with two half-height strip buffers ping-ponging between them.

## Pin wiring reference

GC9A01 module pins are usually labeled `VCC GND SCL SDA DC CS RST` (+ `BLK` on
some boards). `SCL` = SPI clock, `SDA` = MOSI (it's SPI, not I²C).

| Signal | ESP32-S3 GPIO (suggestion) | Display 1 | Display 2 | Display 3 |
|---|---|---|---|---|
| 3V3 | 3V3 | VCC | VCC | VCC |
| GND | GND | GND | GND | GND |
| SCK | 12 | SCL | SCL | SCL |
| MOSI | 11 | SDA | SDA | SDA |
| DC | 9 | DC | DC | DC |
| RST | 8 | RST | RST | RST |
| CS | — | **GPIO 10** | **GPIO 7** | **GPIO 6** |
| Backlight (if present) | 3V3, or a PWM GPIO for dimming | BLK | BLK | BLK |

For the single eye, wire only **Display 1**. The other columns are for adding
eyes later.

**Shared by all displays:** SCK, MOSI, DC, RST, 3V3, GND. **One per display:** CS.

Pins to avoid on ESP32-S3 dev boards:
- GPIO 0, 3, 45, 46 — strapping pins
- GPIO 19 and 20 — native USB
- GPIO 26–32 — connected to flash
- GPIO 35–37 — used by octal PSRAM on N8R8 / N16R8 modules

Check your exact board's pinout, as dev boards differ.

Keep SPI wires short, especially at 80 MHz. With 3 displays, a 100 nF capacitor
near each module's VCC helps, and if the backlights are bright, check that
your 3V3 regulator can supply ~60–100 mA extra.
