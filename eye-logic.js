/*
 * eye-logic.js — pure state + update logic for the animated eye.
 *
 * Rules for this file (so it ports to C++ almost line by line):
 *   - No DOM, no drawing API, no timers. Only numbers and booleans.
 *   - State lives in ONE plain object (EyeState) created once at startup;
 *     updateEye() mutates it in place every frame.
 *   - No closures, no per-frame allocations, no map/filter/forEach.
 *   - All randomness comes from a tiny seeded PRNG whose state is a field of
 *     EyeState, so: same seed + same inputs + same dt sequence => same animation.
 *
 * Coordinate conventions
 *   - Gaze is NORMALIZED: x,y in -1..1, (0,0) = straight ahead,
 *     +x = right on screen, +y = DOWN on screen (same as pixel y).
 *     The gaze vector is always kept inside the unit circle.
 *   - Pixel space is the 240x240 display, (0,0) top-left, center (120,120).
 */
'use strict';

// ---------------------------------------------------------------------------
// CONFIG — every tunable constant lives here. In C++ this becomes a
// `namespace Config { constexpr float ... }` block or a const struct.
// Times are in milliseconds, distances in display pixels unless noted.
// Colors are 0xRRGGBB integers (convert once to RGB565 on the ESP32).
// ---------------------------------------------------------------------------
var CONFIG = {
  // ---- Geometry ----
  SCREEN_SIZE: 240,
  CENTER: 120,
  SCLERA_RADIUS: 118,        // sclera disc radius (slightly inside the 120px glass edge)
  IRIS_EDGE_MARGIN: 4,       // px of sclera that always stays visible past the iris edge
  IRIS_RADIUS_DEFAULT: 48,
  IRIS_RADIUS_MIN: 30,
  IRIS_RADIUS_MAX: 80,
  FORESHORTEN: 0.35,         // how much the iris flattens near the sclera edge (0 = never)

  // ---- Gaze motion ----
  GAZE_FOLLOW_TAU_MS: 90,    // easing time constant when tracking mouse/joystick
  GAZE_SACCADE_TAU_MS: 26,   // much faster easing for saccade jumps
  CONVERGENCE: 0.07,         // inward gaze offset between neighbouring eyes (normalized)
  MAX_DT_MS: 100,            // clamp huge frame gaps (debugger pause, hidden tab)

  // ---- Input ----
  JOYSTICK_DEADZONE: 0.08,   // stick values with |v| below this count as "centered"
  IDLE_TO_AUTO_MS: 2500,     // no input for this long => eye starts saccading on its own

  // ---- Saccades (automatic eye jumps) ----
  SACCADE_PAUSE_MIN_MS: 350, // fixation time between jumps (random in [min, max])
  SACCADE_PAUSE_MAX_MS: 2200,
  SACCADE_RANGE: 0.85,       // how far from center random targets may be (0..1)
  SACCADE_VERTICAL_SCALE: 0.7, // real eyes wander more horizontally than vertically
  MICRO_SACCADE_CHANCE: 0.35,  // probability a jump is a tiny correction near the current target
  MICRO_SACCADE_SIZE: 0.07,
  CENTER_RETURN_CHANCE: 0.2,   // probability a jump returns to (almost) straight ahead
  SACCADE_BLINK_MIN_JUMP: 0.9, // big gaze shifts sometimes trigger a blink, like in humans
  SACCADE_BLINK_CHANCE: 0.25,

  // ---- Blink ----
  BLINK_CLOSE_MS: 70,        // closing is fast...
  BLINK_HOLD_MS: 35,         // ...stays shut very briefly...
  BLINK_OPEN_MS: 170,        // ...and opening is slower
  BLINK_INTERVAL_MIN_MS: 2000,
  BLINK_INTERVAL_MAX_MS: 6000,
  DOUBLE_BLINK_CHANCE: 0.15,
  DOUBLE_BLINK_GAP_MIN_MS: 80,
  DOUBLE_BLINK_GAP_MAX_MS: 180,

  // ---- Pupil (sizes are fractions of the iris radius) ----
  PUPIL_BASE_DEFAULT: 0.42,
  PUPIL_MIN_FRAC: 0.15,
  PUPIL_MAX_FRAC: 0.8,
  PUPIL_SCALE_DARK: 1.45,    // pupil multiplier at light = 0 (dilated)
  PUPIL_SCALE_BRIGHT: 0.6,   // pupil multiplier at light = 1 (constricted)
  PUPIL_CONSTRICT_TAU_MS: 220, // pupils constrict faster...
  PUPIL_DILATE_TAU_MS: 900,    // ...than they dilate
  PUPIL_NOISE_AMOUNT: 0.08,  // slow random "breathing" of the pupil (hippus), +-8 %
  PUPIL_NOISE_MIN_MS: 800,
  PUPIL_NOISE_MAX_MS: 2500,
  PUPIL_NOISE_TAU_MS: 1200,

  // ---- Eyelids (pixel y positions, 0 = top of screen) ----
  // Each lid edge is an ARC of a circle (like a real lid sliding over a ball).
  // With the defaults the lids sit just outside the round display when looking
  // straight ahead, so the eye looks wide open (as behind a glass dome); they
  // slide into view when looking down/up and when blinking.
  UPPER_LID_OPEN_Y: 2,       // upper lid edge (at center column) when open, looking ahead
  UPPER_LID_TRACK: 38,       // px the upper lid moves per unit of vertical gaze
  LOWER_LID_OPEN_Y: 248,
  LOWER_LID_TRACK: 18,
  LID_MEET_Y: 146,           // where the lids meet when shut (upper lid travels most)
  UPPER_LID_RADIUS: 135,     // arc radius of the lid edge when open (>= 120 keeps it hidden)
  LOWER_LID_RADIUS: 140,
  LID_CLOSED_RADIUS: 300,    // lids flatten into a gentle line as they close

  // ---- Colors (0xRRGGBB) ----
  IRIS_COLOR_DEFAULT: 0x7a95b2,   // grey-blue
  SCLERA_COLOR_DEFAULT: 0xeaeff4, // slightly cool white
  PUPIL_COLOR: 0x07080a,
  LID_COLOR_BLACK: 0x000000,      // "Uncanny Eyes" style: lids vanish into the black bezel
  LID_COLOR_SKIN: 0xc08e78,
  LID_COLOR_METAL: 0x3a3f48,

  // ---- Cyberpunk glitches ----
  // A glitch is a short BURST. The logic only decides WHEN, HOW STRONG and
  // WHICH effects; it also hands the renderer a random seed that changes every
  // few frames so the corruption flickers. The renderer turns that into pixels.
  GLITCH_INTERVAL_MIN_MS: 1500, // quiet time between bursts (random in [min, max])
  GLITCH_INTERVAL_MAX_MS: 7000,
  GLITCH_MICRO_CHANCE: 0.55,    // most bursts are tiny flickers...
  GLITCH_MICRO_MIN_MS: 50,
  GLITCH_MICRO_MAX_MS: 140,
  GLITCH_BIG_MIN_MS: 220,       // ...some are proper meltdowns
  GLITCH_BIG_MAX_MS: 700,
  GLITCH_RESEED_MIN_MS: 25,     // a new corruption pattern this often during a burst
  GLITCH_RESEED_MAX_MS: 90,
  GLITCH_GAP_CHANCE: 0.15,      // chance a pattern is "clean" => stutter on/off inside a burst
  GLITCH_FOLLOWUP_CHANCE: 0.25, // chance of an aftershock burst right after
  GLITCH_FOLLOWUP_MIN_MS: 120,
  GLITCH_FOLLOWUP_MAX_MS: 400,
  GLITCH_JITTER: 0.08,          // gaze twitch during a glitch (normalized units)
  GLITCH_PUPIL_JITTER: 0.35,    // pupil size snaps by up to ±35 %
  GLITCH_NEON_COLOR_A: 0xff2bd6, // magenta
  GLITCH_NEON_COLOR_B: 0x00f0ff  // cyan
};

// Glitch effect bits (C++: enum : uint8_t, combined with |). Each burst picks a mix.
var GLITCH_SLICE = 1;     // horizontal bands tear sideways
var GLITCH_RGB = 2;       // red/blue channels split apart (chromatic aberration)
var GLITCH_BLOCKS = 4;    // rectangular corrupted blocks
var GLITCH_NEON = 8;      // neon magenta/cyan tint + scanlines
var GLITCH_NOISE = 16;    // lines of static
var GLITCH_DROPOUT = 32;  // brief signal loss (frame goes dark)
var GLITCH_JITTER = 64;   // gaze + pupil twitch

// Input modes (C++: enum class Mode : uint8_t)
var MODE_MOUSE = 0;
var MODE_JOYSTICK = 1;
var MODE_AUTO = 2;

// Blink state machine phases (C++: enum class BlinkPhase : uint8_t)
var BLINK_OPEN = 0;
var BLINK_CLOSING = 1;
var BLINK_CLOSED = 2;
var BLINK_OPENING = 3;

// ---------------------------------------------------------------------------
// Small math helpers
// ---------------------------------------------------------------------------
function clamp(v, lo, hi) {
  return v < lo ? lo : (v > hi ? hi : v);
}

// Frame-rate independent exponential easing factor.
// Each frame we move a fraction k of the remaining distance:  x += (target - x) * k.
// With k = 1 - e^(-dt/tau) the result after 100 ms is the same whether you ran
// 3 frames of 33 ms or 10 frames of 10 ms. tau = time to cover ~63 % of the gap.
function easeFactor(dtMs, tauMs) {
  return 1 - Math.exp(-dtMs / tauMs);
}

// ---------------------------------------------------------------------------
// Tiny PRNG: xorshift32. Fast, 4 bytes of state, identical results in C++
// (use uint32_t there; JS needs `>>> 0` to stay unsigned).
// ---------------------------------------------------------------------------
function rngNextU32(s) {
  var x = s.rng | 0;   // JS bit ops work on int32; C++: uint32_t x = s.rng;
  x ^= x << 13;
  x ^= x >>> 17;       // `>>>` is a logical shift == `>>` on uint32_t in C++
  x ^= x << 5;
  s.rng = x >>> 0;     // store back as unsigned 0..2^32-1
  return s.rng;
}

// Uniform float in [0, 1). C++: rngNextU32(s) * (1.0f / 4294967296.0f)
function rngFloat(s) {
  return rngNextU32(s) / 4294967296;
}

// Uniform float in [lo, hi)
function rngRange(s, lo, hi) {
  return lo + (hi - lo) * rngFloat(s);
}

// ---------------------------------------------------------------------------
// Data structures. Each is allocated ONCE; in C++ they are plain structs.
// ---------------------------------------------------------------------------

// EyeState: everything that changes over time. Shared by all eyes on screen.
function createEyeState(seed) {
  var s = {
    rng: 0,                 // PRNG state (uint32)
    timeMs: 0,              // total simulated time
    irisRadius: 0,          // copied from input each update (px)

    // Gaze (normalized, inside unit circle)
    gazeX: 0, gazeY: 0,     // where the eye is looking now (eased)
    targetX: 0, targetY: 0, // where it wants to look
    saccadeActive: false,   // current motion is a saccade => use the fast time constant
    saccadeTimerMs: 0,      // countdown to the next automatic jump
    idleMs: 0,              // time since the last real user input

    // Blink
    blinkPhase: BLINK_OPEN,
    blinkPhaseMs: 0,        // time spent in the current phase
    blinkAmount: 0,         // 0 = fully open, 1 = fully shut
    blinkTimerMs: 0,        // countdown to the next spontaneous blink
    doubleBlinkPending: false,

    // Pupil (fraction of iris radius)
    pupil: 0,
    pupilNoise: 0,          // current slow random offset
    pupilNoiseTarget: 0,
    pupilNoiseTimerMs: 0,

    // Glitch
    glitchTimerMs: 0,       // countdown to the next automatic burst
    glitchActive: false,
    glitchManual: false,    // burst was triggered by hand => finishes even with auto glitches off
    glitchMs: 0,            // time into the current burst
    glitchDurMs: 0,         // length of the current burst
    glitchStrength: 0,      // peak strength of this burst, 0..1
    glitchAmount: 0,        // current strength (0 between flickers)
    glitchKinds: 0,         // which GLITCH_* effects this burst uses (bitmask)
    glitchSeed: 0,          // seed the renderer uses for this frame's corruption pattern
    glitchReseedMs: 0,      // countdown to the next pattern
    glitchJitterX: 0, glitchJitterY: 0, glitchPupil: 0
  };
  resetEyeState(s, seed);
  return s;
}

// Put the state back to a known starting point (deterministic for a given seed).
function resetEyeState(s, seed) {
  s.rng = seed >>> 0;
  if (s.rng === 0) s.rng = 0x9e3779b9;   // xorshift gets stuck at 0, never seed with 0
  rngNextU32(s);                         // a couple of warm-up steps to mix small seeds
  rngNextU32(s);

  s.timeMs = 0;
  s.irisRadius = CONFIG.IRIS_RADIUS_DEFAULT;
  s.gazeX = 0; s.gazeY = 0;
  s.targetX = 0; s.targetY = 0;
  s.saccadeActive = false;
  s.saccadeTimerMs = rngRange(s, CONFIG.SACCADE_PAUSE_MIN_MS, CONFIG.SACCADE_PAUSE_MAX_MS);
  s.idleMs = CONFIG.IDLE_TO_AUTO_MS;     // start "idle" so the eye lives right away

  s.blinkPhase = BLINK_OPEN;
  s.blinkPhaseMs = 0;
  s.blinkAmount = 0;
  s.blinkTimerMs = rngRange(s, CONFIG.BLINK_INTERVAL_MIN_MS, CONFIG.BLINK_INTERVAL_MAX_MS);
  s.doubleBlinkPending = false;

  s.pupil = CONFIG.PUPIL_BASE_DEFAULT;
  s.pupilNoise = 0;
  s.pupilNoiseTarget = 0;
  s.pupilNoiseTimerMs = 0;               // pick a noise target on the first update

  s.glitchTimerMs = rngRange(s, CONFIG.GLITCH_INTERVAL_MIN_MS, CONFIG.GLITCH_INTERVAL_MAX_MS);
  s.glitchActive = false;
  s.glitchManual = false;
  s.glitchMs = 0; s.glitchDurMs = 0;
  s.glitchStrength = 0; s.glitchAmount = 0;
  s.glitchKinds = 0; s.glitchSeed = 1; s.glitchReseedMs = 0;
  s.glitchJitterX = 0; s.glitchJitterY = 0; s.glitchPupil = 0;
}

// EyeInput: what the outside world tells the eye each frame.
// On the ESP32 this is filled from analogRead()/buttons/potentiometers.
function createEyeInput() {
  return {
    mode: MODE_AUTO,
    x: 0, y: 0,             // mouse direction or joystick, -1..1
    activity: false,        // mouse mode: true on frames where the mouse moved
    blink: false,           // one-shot: true for one update => request a blink
    blinkEnabled: false,    // false => no automatic blinks (a manual `blink` still works)
    glitchEnabled: true,    // false => no automatic glitches (a running auto burst stops)
    glitch: false,          // one-shot: force a glitch burst now
    glitchRate: 1,          // glitch frequency multiplier
    glitchIntensity: 0.6,   // 0..1, scales every glitch effect
    light: 0.5,             // 0 = dark .. 1 = bright
    speed: 1,               // gaze speed multiplier
    saccadeRate: 1,         // saccade frequency multiplier
    blinkRate: 1,           // blink frequency multiplier
    irisRadius: CONFIG.IRIS_RADIUS_DEFAULT,
    pupilBase: CONFIG.PUPIL_BASE_DEFAULT
  };
}

// EyeView: per-eye, per-frame drawing parameters computed from EyeState.
// The renderer only ever reads this — it never touches EyeState directly.
function createEyeView() {
  return {
    irisX: 0, irisY: 0,     // iris center in pixels
    irisR: 0,               // iris radius in pixels
    pupilR: 0,              // pupil radius in pixels
    dirX: 1, dirY: 0,       // unit vector from screen center toward the iris
    squash: 1,              // iris scale along dir (foreshortening), 1 = round
    upperLidY: 0,           // upper lid edge y at the center column
    lowerLidY: 0,           // lower lid edge y at the center column
    upperRadius: 0,         // arc radius of the upper lid edge (circle center sits below it)
    lowerRadius: 0,         // arc radius of the lower lid edge (circle center sits above it)
    blink: 0,
    glitchAmount: 0,        // 0 = no glitch this frame, else effect strength 0..1
    glitchKinds: 0,         // GLITCH_* bitmask
    glitchSeed: 0           // renderer derives band/block positions from this
  };
}

// ---------------------------------------------------------------------------
// Update — call once per frame with the elapsed time.
// ---------------------------------------------------------------------------
function updateEye(s, input, dtMs) {
  if (dtMs > CONFIG.MAX_DT_MS) dtMs = CONFIG.MAX_DT_MS;   // don't jump after a long pause
  if (dtMs < 0) dtMs = 0;
  s.timeMs += dtMs;
  s.irisRadius = clamp(input.irisRadius, CONFIG.IRIS_RADIUS_MIN, CONFIG.IRIS_RADIUS_MAX);

  updateGazeTarget(s, input, dtMs);
  updateGaze(s, input, dtMs);
  updateBlink(s, input, dtMs);
  updatePupil(s, input, dtMs);
  updateGlitch(s, input, dtMs);
}

// Decide WHERE to look: follow the user's input, or make up saccades when idle.
function updateGazeTarget(s, input, dtMs) {
  var ix = input.x;
  var iy = input.y;
  var hasInput = false;

  if (input.mode === MODE_JOYSTICK) {
    // Deadzone: real analog sticks never rest at exactly 0, so small values = centered.
    if (ix * ix + iy * iy < CONFIG.JOYSTICK_DEADZONE * CONFIG.JOYSTICK_DEADZONE) {
      ix = 0;
      iy = 0;
    } else {
      hasInput = true;
    }
  } else if (input.mode === MODE_MOUSE) {
    hasInput = input.activity;
  }

  // Idle timer: reset on input, otherwise count up.
  if (hasInput) s.idleMs = 0;
  else if (s.idleMs < 1e9) s.idleMs += dtMs;   // cap so the float never grows forever

  var following = input.mode !== MODE_AUTO && s.idleMs < CONFIG.IDLE_TO_AUTO_MS;

  if (following) {
    s.targetX = ix;
    s.targetY = iy;
    clampTargetToUnitCircle(s);
    s.saccadeActive = false;
    // Make the first idle saccade come quickly once the user stops.
    s.saccadeTimerMs = CONFIG.SACCADE_PAUSE_MIN_MS;
    return;
  }

  // Auto: count down (faster when saccadeRate > 1) and jump when the timer runs out.
  s.saccadeTimerMs -= dtMs * clamp(input.saccadeRate, 0.05, 10);
  if (s.saccadeTimerMs <= 0) {
    startSaccade(s, input);
    s.saccadeTimerMs = rngRange(s, CONFIG.SACCADE_PAUSE_MIN_MS, CONFIG.SACCADE_PAUSE_MAX_MS);
  }
}

// Pick a new random target. Three kinds of jumps, chosen by one random number.
function startSaccade(s, input) {
  var oldX = s.targetX;
  var oldY = s.targetY;
  var r = rngFloat(s);

  if (r < CONFIG.MICRO_SACCADE_CHANCE) {
    // Micro-saccade: tiny correction around the current fixation point.
    s.targetX = oldX + rngRange(s, -CONFIG.MICRO_SACCADE_SIZE, CONFIG.MICRO_SACCADE_SIZE);
    s.targetY = oldY + rngRange(s, -CONFIG.MICRO_SACCADE_SIZE, CONFIG.MICRO_SACCADE_SIZE);
  } else if (r < CONFIG.MICRO_SACCADE_CHANCE + CONFIG.CENTER_RETURN_CHANCE) {
    // Look (almost) straight ahead again.
    s.targetX = rngRange(s, -0.1, 0.1);
    s.targetY = rngRange(s, -0.1, 0.1);
  } else {
    // Random point in a disc. sqrt() on the radius makes points uniform over the
    // AREA — without it targets would cluster near the center.
    var angle = rngFloat(s) * 6.283185307179586;
    var dist = Math.sqrt(rngFloat(s)) * CONFIG.SACCADE_RANGE;
    s.targetX = Math.cos(angle) * dist;
    s.targetY = Math.sin(angle) * dist * CONFIG.SACCADE_VERTICAL_SCALE;
  }
  clampTargetToUnitCircle(s);
  s.saccadeActive = true;

  // Large gaze shifts are often accompanied by a blink in real eyes.
  var jx = s.targetX - oldX;
  var jy = s.targetY - oldY;
  // (Only when automatic blinking is on.)
  if (input.blinkEnabled &&
      jx * jx + jy * jy > CONFIG.SACCADE_BLINK_MIN_JUMP * CONFIG.SACCADE_BLINK_MIN_JUMP &&
      rngFloat(s) < CONFIG.SACCADE_BLINK_CHANCE) {
    requestBlink(s);
  }
}

// Keep the target inside the unit circle (so a joystick corner at (1,1)
// gives length 1, not 1.41).
function clampTargetToUnitCircle(s) {
  var len2 = s.targetX * s.targetX + s.targetY * s.targetY;
  if (len2 > 1) {
    var inv = 1 / Math.sqrt(len2);
    s.targetX *= inv;
    s.targetY *= inv;
  }
}

// Move the current gaze toward the target with exponential easing.
// Because each step is a blend between two points inside the unit circle,
// the gaze can never leave the circle (circles are convex) — no extra clamp needed.
function updateGaze(s, input, dtMs) {
  var tau = s.saccadeActive ? CONFIG.GAZE_SACCADE_TAU_MS : CONFIG.GAZE_FOLLOW_TAU_MS;
  tau = tau / clamp(input.speed, 0.05, 10);   // faster speed = smaller time constant
  var k = easeFactor(dtMs, tau);
  s.gazeX += (s.targetX - s.gazeX) * k;
  s.gazeY += (s.targetY - s.gazeY) * k;
}

// ---------------------------------------------------------------------------
// Blink state machine:  OPEN -> CLOSING -> CLOSED -> OPENING -> OPEN
// ---------------------------------------------------------------------------
function requestBlink(s) {
  if (s.blinkPhase === BLINK_OPEN) {
    s.blinkPhase = BLINK_CLOSING;
    s.blinkPhaseMs = 0;
  } else if (s.blinkPhase === BLINK_OPENING) {
    // Re-close from wherever the lid currently is, without a visual jump:
    // closing uses amount = p^2, so p = sqrt(amount) gives the same lid position.
    s.blinkPhase = BLINK_CLOSING;
    s.blinkPhaseMs = Math.sqrt(s.blinkAmount) * CONFIG.BLINK_CLOSE_MS;
  }
  // CLOSING / CLOSED: already blinking, ignore.
}

function updateBlink(s, input, dtMs) {
  if (input.blink) requestBlink(s);

  if (s.blinkPhase === BLINK_OPEN) {
    // Spontaneous blink countdown, sped up/slowed down by the blink-rate slider.
    // With blinking disabled the timer is frozen (a blink already running still
    // finishes, so the eye can never get stuck half shut).
    if (input.blinkEnabled) {
      s.blinkTimerMs -= dtMs * clamp(input.blinkRate, 0.05, 10);
      if (s.blinkTimerMs <= 0) requestBlink(s);
    }
    if (s.blinkPhase === BLINK_OPEN) {
      s.blinkAmount = 0;
      return;
    }
  }

  s.blinkPhaseMs += dtMs;
  var p;

  if (s.blinkPhase === BLINK_CLOSING) {
    p = s.blinkPhaseMs / CONFIG.BLINK_CLOSE_MS;   // progress 0..1
    if (p >= 1) {
      s.blinkPhase = BLINK_CLOSED;
      s.blinkPhaseMs = 0;
      s.blinkAmount = 1;
    } else {
      s.blinkAmount = p * p;                      // ease-in: the lid accelerates as it falls
    }
  } else if (s.blinkPhase === BLINK_CLOSED) {
    s.blinkAmount = 1;
    if (s.blinkPhaseMs >= CONFIG.BLINK_HOLD_MS) {
      s.blinkPhase = BLINK_OPENING;
      s.blinkPhaseMs = 0;
    }
  } else if (s.blinkPhase === BLINK_OPENING) {
    p = s.blinkPhaseMs / CONFIG.BLINK_OPEN_MS;
    if (p >= 1) {
      s.blinkPhase = BLINK_OPEN;
      s.blinkPhaseMs = 0;
      s.blinkAmount = 0;
      scheduleNextBlink(s);
    } else {
      var q = 1 - p;
      s.blinkAmount = q * q;                      // ease-out: lifts quickly, then settles
    }
  }
}

function scheduleNextBlink(s) {
  if (s.doubleBlinkPending) {
    // This was the second blink of a double: back to normal spacing.
    s.doubleBlinkPending = false;
    s.blinkTimerMs = rngRange(s, CONFIG.BLINK_INTERVAL_MIN_MS, CONFIG.BLINK_INTERVAL_MAX_MS);
  } else if (rngFloat(s) < CONFIG.DOUBLE_BLINK_CHANCE) {
    // Occasionally blink again almost immediately.
    s.doubleBlinkPending = true;
    s.blinkTimerMs = rngRange(s, CONFIG.DOUBLE_BLINK_GAP_MIN_MS, CONFIG.DOUBLE_BLINK_GAP_MAX_MS);
  } else {
    s.blinkTimerMs = rngRange(s, CONFIG.BLINK_INTERVAL_MIN_MS, CONFIG.BLINK_INTERVAL_MAX_MS);
  }
}

// ---------------------------------------------------------------------------
// Pupil: base size x light response x slow random "breathing".
// ---------------------------------------------------------------------------
function updatePupil(s, input, dtMs) {
  // Every 0.8–2.5 s pick a new small random offset and drift toward it slowly.
  s.pupilNoiseTimerMs -= dtMs;
  if (s.pupilNoiseTimerMs <= 0) {
    s.pupilNoiseTarget = rngRange(s, -CONFIG.PUPIL_NOISE_AMOUNT, CONFIG.PUPIL_NOISE_AMOUNT);
    s.pupilNoiseTimerMs = rngRange(s, CONFIG.PUPIL_NOISE_MIN_MS, CONFIG.PUPIL_NOISE_MAX_MS);
  }
  s.pupilNoise += (s.pupilNoiseTarget - s.pupilNoise) * easeFactor(dtMs, CONFIG.PUPIL_NOISE_TAU_MS);

  // Linear blend between the dark and bright multipliers (bright => small pupil).
  var light = clamp(input.light, 0, 1);
  var lightScale = CONFIG.PUPIL_SCALE_DARK + (CONFIG.PUPIL_SCALE_BRIGHT - CONFIG.PUPIL_SCALE_DARK) * light;

  var target = input.pupilBase * lightScale * (1 + s.pupilNoise);
  target = clamp(target, CONFIG.PUPIL_MIN_FRAC, CONFIG.PUPIL_MAX_FRAC);

  // Different speeds for shrinking vs growing, like a real pupil.
  var tau = target < s.pupil ? CONFIG.PUPIL_CONSTRICT_TAU_MS : CONFIG.PUPIL_DILATE_TAU_MS;
  s.pupil += (target - s.pupil) * easeFactor(dtMs, tau);
}

// ---------------------------------------------------------------------------
// Glitch bursts:  IDLE --timer/trigger--> BURST (pattern reseeds every 25–90 ms) --> IDLE
// ---------------------------------------------------------------------------
function startGlitch(s, input, manual) {
  s.glitchActive = true;
  s.glitchManual = manual;
  s.glitchMs = 0;
  var intensity = clamp(input.glitchIntensity, 0, 1);
  if (rngFloat(s) < CONFIG.GLITCH_MICRO_CHANCE) {
    // Micro glitch: a quick flicker, weaker, usually just one or two effects.
    s.glitchDurMs = rngRange(s, CONFIG.GLITCH_MICRO_MIN_MS, CONFIG.GLITCH_MICRO_MAX_MS);
    s.glitchStrength = intensity * rngRange(s, 0.35, 0.7);
  } else {
    s.glitchDurMs = rngRange(s, CONFIG.GLITCH_BIG_MIN_MS, CONFIG.GLITCH_BIG_MAX_MS);
    s.glitchStrength = intensity * rngRange(s, 0.7, 1.0);
  }

  // Pick the effect mix: each effect has its own chance; tearing or RGB split
  // is always included so every burst reads as a "glitch".
  var kinds = 0;
  if (rngFloat(s) < 0.75) kinds |= GLITCH_SLICE;
  if (rngFloat(s) < 0.7) kinds |= GLITCH_RGB;
  if (rngFloat(s) < 0.4) kinds |= GLITCH_BLOCKS;
  if (rngFloat(s) < 0.45) kinds |= GLITCH_NEON;
  if (rngFloat(s) < 0.4) kinds |= GLITCH_NOISE;
  if (rngFloat(s) < 0.12) kinds |= GLITCH_DROPOUT;
  if (rngFloat(s) < 0.5) kinds |= GLITCH_JITTER;
  if ((kinds & (GLITCH_SLICE | GLITCH_RGB)) === 0) kinds |= GLITCH_SLICE;
  s.glitchKinds = kinds;
  s.glitchReseedMs = 0;                  // new pattern on this very frame
}

function stopGlitch(s) {
  s.glitchActive = false;
  s.glitchManual = false;
  s.glitchAmount = 0;
  s.glitchJitterX = 0; s.glitchJitterY = 0; s.glitchPupil = 0;
}

function updateGlitch(s, input, dtMs) {
  // Feature off: cancel an automatic burst. While idle and disabled no PRNG calls
  // happen, so the rest of the animation is exactly as without the feature.
  if (!input.glitchEnabled && s.glitchActive && !s.glitchManual) stopGlitch(s);

  if (!s.glitchActive) {
    if (input.glitch) {
      startGlitch(s, input, true);       // manual trigger works even with auto glitches off
    } else if (input.glitchEnabled) {
      s.glitchTimerMs -= dtMs * clamp(input.glitchRate, 0.05, 10);
      if (s.glitchTimerMs <= 0) startGlitch(s, input, false);
    }
    if (!s.glitchActive) return;
  }

  s.glitchMs += dtMs;
  if (s.glitchMs >= s.glitchDurMs) {
    // Burst over. Sometimes an aftershock follows quickly, otherwise a quiet pause.
    stopGlitch(s);
    if (rngFloat(s) < CONFIG.GLITCH_FOLLOWUP_CHANCE) {
      s.glitchTimerMs = rngRange(s, CONFIG.GLITCH_FOLLOWUP_MIN_MS, CONFIG.GLITCH_FOLLOWUP_MAX_MS);
    } else {
      s.glitchTimerMs = rngRange(s, CONFIG.GLITCH_INTERVAL_MIN_MS, CONFIG.GLITCH_INTERVAL_MAX_MS);
    }
    return;
  }

  // New corruption pattern every 25–90 ms: fresh seed, fresh strength, fresh twitch.
  s.glitchReseedMs -= dtMs;
  if (s.glitchReseedMs <= 0) {
    s.glitchReseedMs = rngRange(s, CONFIG.GLITCH_RESEED_MIN_MS, CONFIG.GLITCH_RESEED_MAX_MS);
    s.glitchSeed = (rngNextU32(s) | 1) >>> 0;  // | 1: never 0 (the renderer's xorshift needs non-zero)
    // Stutter: some patterns are clean frames, so the burst flickers on and off.
    var gap = rngFloat(s) < CONFIG.GLITCH_GAP_CHANCE;
    s.glitchAmount = gap ? 0 : s.glitchStrength * rngRange(s, 0.55, 1.0);
    if (s.glitchKinds & GLITCH_JITTER) {
      s.glitchJitterX = rngRange(s, -1, 1) * CONFIG.GLITCH_JITTER * s.glitchAmount;
      s.glitchJitterY = rngRange(s, -1, 1) * CONFIG.GLITCH_JITTER * s.glitchAmount;
      s.glitchPupil = rngRange(s, -1, 1) * CONFIG.GLITCH_PUPIL_JITTER * s.glitchAmount;
    }
  }
}

// ---------------------------------------------------------------------------
// View: turn the shared state into drawing parameters for eye #eyeIndex.
// Writes into a preallocated `view` (C++: void computeEyeView(const EyeState&, int, int, EyeView&)).
// ---------------------------------------------------------------------------
function computeEyeView(s, eyeIndex, eyeCount, view) {
  // Convergence: each eye turns slightly toward the middle of the row.
  // 2 eyes: +c/2 and -c/2.  3 eyes: +c, 0, -c.  (+x = toward the right of the screen)
  var mid = (eyeCount - 1) * 0.5;
  var gx = s.gazeX + (mid - eyeIndex) * CONFIG.CONVERGENCE + s.glitchJitterX;
  var gy = s.gazeY + s.glitchJitterY;   // glitch twitch is added BEFORE the clamp below

  // The offset may push the gaze past the unit circle — clamp it back.
  var len2 = gx * gx + gy * gy;
  if (len2 > 1) {
    var inv = 1 / Math.sqrt(len2);
    gx *= inv;
    gy *= inv;
  }

  // Map normalized gaze to pixels. maxOffset is chosen so that even at |gaze| = 1
  // the far edge of the iris stays IRIS_EDGE_MARGIN px inside the sclera:
  //   offset + irisR <= SCLERA_RADIUS - margin
  var irisR = s.irisRadius;
  var maxOffset = CONFIG.SCLERA_RADIUS - irisR - CONFIG.IRIS_EDGE_MARGIN;
  if (maxOffset < 0) maxOffset = 0;
  var offX = gx * maxOffset;
  var offY = gy * maxOffset;

  view.irisX = CONFIG.CENTER + offX;
  view.irisY = CONFIG.CENTER + offY;
  view.irisR = irisR;
  // Glitch can snap the pupil size; still clamped so it never exceeds the iris.
  var pupilFrac = clamp(s.pupil * (1 + s.glitchPupil), CONFIG.PUPIL_MIN_FRAC, CONFIG.PUPIL_MAX_FRAC);
  view.pupilR = irisR * pupilFrac;

  // Foreshortening: a disc painted on a ball looks squashed along the direction
  // it has rotated toward. Squash only ever SHRINKS the iris, so the clamp above
  // still holds.
  var d = Math.sqrt(offX * offX + offY * offY);
  if (d > 0.0001) {
    view.dirX = offX / d;
    view.dirY = offY / d;
  } else {
    view.dirX = 1;
    view.dirY = 0;
  }
  var t = d / CONFIG.SCLERA_RADIUS;
  view.squash = 1 - CONFIG.FORESHORTEN * t * t;

  // Eyelids. Tracking: looking down (gy > 0) lowers the upper lid; looking up
  // lifts it and raises the lower lid a little (gy < 0).
  var b = s.blinkAmount;
  var upperOpen = CONFIG.UPPER_LID_OPEN_Y + gy * CONFIG.UPPER_LID_TRACK;
  var lowerOpen = CONFIG.LOWER_LID_OPEN_Y + gy * CONFIG.LOWER_LID_TRACK;

  // Blink = linear blend from the open position to the meeting line.
  var upper = upperOpen + (CONFIG.LID_MEET_Y - upperOpen) * b;
  var lower = lowerOpen + (CONFIG.LID_MEET_Y - lowerOpen) * b;
  if (upper > lower) {           // never let the lids cross
    upper = (upper + lower) * 0.5;
    lower = upper;
  }
  view.upperLidY = upper;
  view.lowerLidY = lower;

  // Lid arcs get flatter (bigger radius) as they close, so a shut eye is a
  // gentle line. The arcs overlap at the corners, so a shut eye has no gaps.
  view.upperRadius = CONFIG.UPPER_LID_RADIUS + (CONFIG.LID_CLOSED_RADIUS - CONFIG.UPPER_LID_RADIUS) * b;
  view.lowerRadius = CONFIG.LOWER_LID_RADIUS + (CONFIG.LID_CLOSED_RADIUS - CONFIG.LOWER_LID_RADIUS) * b;
  view.blink = b;

  view.glitchAmount = s.glitchAmount;
  view.glitchKinds = s.glitchKinds;
  view.glitchSeed = s.glitchSeed;
}

// ---------------------------------------------------------------------------
// Color helper for porting: 0xRRGGBB -> 16-bit RGB565 (5 bits red, 6 green, 5 blue).
// This is the exact value you'd pass to TFT_eSPI fillCircle()/fillRect().
// ---------------------------------------------------------------------------
function rgb888to565(c) {
  var r = (c >> 16) & 0xff;
  var g = (c >> 8) & 0xff;
  var b = c & 0xff;
  return ((r >> 3) << 11) | ((g >> 2) << 5) | (b >> 3);
}

// Allow `require('./eye-logic.js')` from Node for tests; harmless in the browser.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONFIG: CONFIG,
    MODE_MOUSE: MODE_MOUSE, MODE_JOYSTICK: MODE_JOYSTICK, MODE_AUTO: MODE_AUTO,
    BLINK_OPEN: BLINK_OPEN, BLINK_CLOSING: BLINK_CLOSING,
    BLINK_CLOSED: BLINK_CLOSED, BLINK_OPENING: BLINK_OPENING,
    GLITCH_SLICE: GLITCH_SLICE, GLITCH_RGB: GLITCH_RGB, GLITCH_BLOCKS: GLITCH_BLOCKS,
    GLITCH_NEON: GLITCH_NEON, GLITCH_NOISE: GLITCH_NOISE, GLITCH_DROPOUT: GLITCH_DROPOUT,
    GLITCH_JITTER: GLITCH_JITTER,
    createEyeState: createEyeState, resetEyeState: resetEyeState,
    createEyeInput: createEyeInput, createEyeView: createEyeView,
    updateEye: updateEye, computeEyeView: computeEyeView,
    requestBlink: requestBlink, rgb888to565: rgb888to565,
    rngNextU32: rngNextU32
  };
}
