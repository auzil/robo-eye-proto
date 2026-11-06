/*
 * main.js — browser glue: input handling, UI, and the game loop.
 *
 * This is the only file that knows about the DOM. On the ESP32 its job is done
 * by setup()/loop(): read the joystick/buttons into EyeInput, call updateEye(),
 * then draw and push each eye.
 */
'use strict';

var MODE_NAMES = ['Mouse', 'Joystick', 'Auto'];
var BLINK_NAMES = ['open', 'closing', 'closed', 'opening'];

var app = {
  state: createEyeState(1234),
  input: createEyeInput(),
  view: createEyeView(),                 // reused for every eye, every frame
  style: {
    irisColor: CONFIG.IRIS_COLOR_DEFAULT,
    scleraColor: CONFIG.SCLERA_COLOR_DEFAULT,
    veins: 0.5,
    lidColor: CONFIG.LID_COLOR_BLACK,
    lidShaded: false,
    catchlight: true,
    rgb565: false
  },

  mode: MODE_AUTO,
  eyeCount: 1,            // single eye. computeEyeView() still supports more (convergence) if you add them back
  scale: 2,
  canvases: [],
  contexts: [],

  // raw input gathered from DOM events between frames
  mouseX: 0, mouseY: 0, mouseMoved: false,
  stickX: 0, stickY: 0, dragging: false,
  keys: { up: false, down: false, left: false, right: false },
  pendingBlink: false,
  pendingGlitch: false,

  // loop timing
  fpsCap: 30,
  lastTs: 0,
  accMs: 0,

  // stats
  frames: 0, fpsWindowStart: 0, fps: 0,
  logicMs: 0, renderMs: 0,
  lastStatsUpdate: 0
};

var $ = function (id) { return document.getElementById(id); };

// ---------------------------------------------------------------------------
// Canvases
// ---------------------------------------------------------------------------
function buildEyes() {
  var host = $('eyes');
  host.innerHTML = '';
  app.canvases.length = 0;
  app.contexts.length = 0;
  for (var i = 0; i < app.eyeCount; i++) {
    var c = document.createElement('canvas');
    c.width = CONFIG.SCREEN_SIZE;          // real resolution: exactly 240x240
    c.height = CONFIG.SCREEN_SIZE;
    c.title = 'Eye ' + (i + 1) + ' (240×240)';
    // Wrapper carries the optional CSS "glass dome + bezel" look; the canvas
    // pixels themselves are exactly what the display would show.
    var wrap = document.createElement('div');
    wrap.className = 'eye';
    wrap.appendChild(c);
    host.appendChild(wrap);
    app.canvases.push(c);
    // willReadFrequently: we call getImageData every frame in RGB565 mode.
    app.contexts.push(c.getContext('2d', { willReadFrequently: true }));
  }
  applyScale();
}

function applyScale() {
  for (var i = 0; i < app.canvases.length; i++) {
    var px = CONFIG.SCREEN_SIZE * app.scale + 'px';
    app.canvases[i].style.width = px;
    app.canvases[i].style.height = px;
  }
}

// ---------------------------------------------------------------------------
// Input: mouse
// ---------------------------------------------------------------------------
window.addEventListener('mousemove', function (e) {
  // Direction from the middle of the eye row to the cursor, normalized so that
  // moving roughly half a row-width away means "look all the way over".
  var r = $('eyes').getBoundingClientRect();
  var cx = r.left + r.width / 2;
  var cy = r.top + r.height / 2;
  var rangeX = Math.max(r.width * 0.5, 300);
  var rangeY = Math.max(r.height * 0.9, 300);
  app.mouseX = (e.clientX - cx) / rangeX;
  app.mouseY = (e.clientY - cy) / rangeY;
  app.mouseMoved = true;                 // logic clamps to the unit circle itself
});

// ---------------------------------------------------------------------------
// Input: keyboard (WASD / arrows = digital joystick, Space = blink)
// ---------------------------------------------------------------------------
var KEY_DIR = {
  ArrowUp: 'up', KeyW: 'up',
  ArrowDown: 'down', KeyS: 'down',
  ArrowLeft: 'left', KeyA: 'left',
  ArrowRight: 'right', KeyD: 'right'
};

function isTypingTarget(t) {
  if (!t || !t.tagName) return false;
  if (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA') return true;
  return t.tagName === 'INPUT' && (t.type === 'number' || t.type === 'text');
}

window.addEventListener('keydown', function (e) {
  var t = e.target;
  if (isTypingTarget(t)) return;

  if (e.code === 'Space') {
    e.preventDefault();                  // no page scroll / button activation
    if (!e.repeat) app.pendingBlink = true;
    return;
  }
  if (e.code === 'KeyG') {
    if (!e.repeat) app.pendingGlitch = true;
    return;
  }

  var dir = KEY_DIR[e.code];
  if (!dir) return;
  var isArrow = e.code.indexOf('Arrow') === 0;
  if (isArrow && t.tagName === 'INPUT' && t.type === 'range') return; // focused slider owns arrows
  e.preventDefault();
  app.keys[dir] = true;
  setMode(MODE_JOYSTICK);
});

window.addEventListener('keyup', function (e) {
  var dir = KEY_DIR[e.code];
  if (dir) app.keys[dir] = false;
});

window.addEventListener('blur', function () {   // don't get stuck with a key "held"
  app.keys.up = app.keys.down = app.keys.left = app.keys.right = false;
});

// ---------------------------------------------------------------------------
// Input: on-screen analog stick (values -1..1, springs back to center)
// ---------------------------------------------------------------------------
var KNOB_RADIUS = 24;

function stickFromPointer(e) {
  var base = $('joyBase');
  var r = base.getBoundingClientRect();
  var travel = r.width / 2 - KNOB_RADIUS;            // how far the knob center may move
  var nx = (e.clientX - (r.left + r.width / 2)) / travel;
  var ny = (e.clientY - (r.top + r.height / 2)) / travel;
  var len = Math.sqrt(nx * nx + ny * ny);
  if (len > 1) { nx /= len; ny /= len; }             // round stick: clamp to a circle
  app.stickX = nx;
  app.stickY = ny;
}

function drawKnob(nx, ny) {
  var base = $('joyBase');
  var travel = base.clientWidth / 2 - KNOB_RADIUS;
  $('joyKnob').style.transform = 'translate(' + (nx * travel) + 'px,' + (ny * travel) + 'px)';
  $('joyValues').textContent = 'x ' + nx.toFixed(2) + ' · y ' + ny.toFixed(2);
}

function initJoystick() {
  var base = $('joyBase');
  base.addEventListener('pointerdown', function (e) {
    base.setPointerCapture(e.pointerId);             // keep getting moves outside the circle
    app.dragging = true;
    base.classList.add('dragging');
    setMode(MODE_JOYSTICK);
    stickFromPointer(e);
  });
  base.addEventListener('pointermove', function (e) {
    if (app.dragging) stickFromPointer(e);
  });
  var release = function () {
    app.dragging = false;
    base.classList.remove('dragging');
    app.stickX = 0;                                   // spring back like a real stick
    app.stickY = 0;
  };
  base.addEventListener('pointerup', release);
  base.addEventListener('pointercancel', release);
}

// Combine keyboard + stick into the joystick value for this frame.
// Keys win while held; diagonal key presses are normalized to length 1.
var joy = { x: 0, y: 0 };
function readJoystick() {
  var kx = (app.keys.right ? 1 : 0) - (app.keys.left ? 1 : 0);
  var ky = (app.keys.down ? 1 : 0) - (app.keys.up ? 1 : 0);
  if (kx !== 0 || ky !== 0) {
    var len = Math.sqrt(kx * kx + ky * ky);
    joy.x = kx / len;
    joy.y = ky / len;
  } else {
    joy.x = app.stickX;
    joy.y = app.stickY;
  }
}

// ---------------------------------------------------------------------------
// UI wiring
// ---------------------------------------------------------------------------
function setMode(m) {
  if (app.mode === m) return;
  app.mode = m;
  var radios = document.querySelectorAll('input[name="mode"]');
  for (var i = 0; i < radios.length; i++) radios[i].checked = Number(radios[i].value) === m;
  $('joyWrap').classList.toggle('disabled', m !== MODE_JOYSTICK);
}

function hexToInt(h) { return parseInt(h.slice(1), 16); }
function hex565(c) { return '565 0x' + ('000' + rgb888to565(c).toString(16).toUpperCase()).slice(-4); }

// Bind a range slider to a setter and a formatted <output>.
function bindRange(id, fmt, apply) {
  var el = $(id);
  var out = $(id + 'Out');
  var update = function () {
    var v = Number(el.value);
    apply(v);
    out.textContent = fmt(v);
  };
  el.addEventListener('input', update);
  update();
}

function initUI() {
  var radios = document.querySelectorAll('input[name="mode"]');
  for (var i = 0; i < radios.length; i++) {
    radios[i].addEventListener('change', function (e) { setMode(Number(e.target.value)); });
  }
  $('joyWrap').classList.toggle('disabled', app.mode !== MODE_JOYSTICK);

  bindRange('irisSize', function (v) { return v + ' px'; }, function (v) { app.input.irisRadius = v; });
  bindRange('pupilBase', function (v) { return v.toFixed(2); }, function (v) { app.input.pupilBase = v; });
  bindRange('speed', function (v) { return v.toFixed(2) + '×'; }, function (v) { app.input.speed = v; });
  bindRange('saccadeRate', function (v) { return v.toFixed(2) + '×'; }, function (v) { app.input.saccadeRate = v; });
  bindRange('blinkRate', function (v) { return v.toFixed(2) + '×'; }, function (v) { app.input.blinkRate = v; });
  bindRange('light', function (v) { return Math.round(v * 100) + ' %'; }, function (v) { app.input.light = v; });
  bindRange('fpsCap', function (v) { return v + ' fps'; }, function (v) { app.fpsCap = v; });

  var irisEl = $('irisColor');
  var scleraEl = $('scleraColor');
  var onColor = function () {
    app.style.irisColor = hexToInt(irisEl.value);
    app.style.scleraColor = hexToInt(scleraEl.value);
    $('irisColorOut').textContent = hex565(app.style.irisColor);
    $('scleraColorOut').textContent = hex565(app.style.scleraColor);
  };
  irisEl.addEventListener('input', onColor);
  scleraEl.addEventListener('input', onColor);
  onColor();

  $('rgb565').addEventListener('change', function (e) { app.style.rgb565 = e.target.checked; });
  $('catchlight').addEventListener('change', function (e) { app.style.catchlight = e.target.checked; });
  $('dome').addEventListener('change', function (e) { $('eyes').classList.toggle('dome', e.target.checked); });

  bindRange('veins', function (v) { return Math.round(v * 100) + ' %'; }, function (v) { app.style.veins = v; });

  var LID_STYLES = {
    black: { color: CONFIG.LID_COLOR_BLACK, shaded: false },
    skin: { color: CONFIG.LID_COLOR_SKIN, shaded: true },
    metal: { color: CONFIG.LID_COLOR_METAL, shaded: true }
  };
  $('lidStyle').addEventListener('change', function (e) {
    var ls = LID_STYLES[e.target.value];
    app.style.lidColor = ls.color;
    app.style.lidShaded = ls.shaded;
  });

  app.input.blinkEnabled = $('blinkEnabled').checked;
  $('blinkEnabled').addEventListener('change', function (e) { app.input.blinkEnabled = e.target.checked; });
  $('glitchEnabled').addEventListener('change', function (e) { app.input.glitchEnabled = e.target.checked; });
  bindRange('glitchRate', function (v) { return v.toFixed(2) + '×'; }, function (v) { app.input.glitchRate = v; });
  bindRange('glitchIntensity', function (v) { return Math.round(v * 100) + ' %'; }, function (v) { app.input.glitchIntensity = v; });
  $('btnGlitch').addEventListener('click', function () { app.pendingGlitch = true; });
  $('scale').addEventListener('change', function (e) {
    app.scale = Number(e.target.value);
    applyScale();
  });

  $('btnBlink').addEventListener('click', function () { app.pendingBlink = true; });
  $('btnReset').addEventListener('click', function () {
    var seed = Math.max(1, Math.floor(Number($('seed').value) || 1));
    resetEyeState(app.state, seed);
    app.accMs = 0;
  });

  initJoystick();
}

// ---------------------------------------------------------------------------
// Game loop: requestAnimationFrame + fixed timestep.
//
// rAF fires at the monitor rate (60/120 Hz). We accumulate real time and run
// the logic in fixed steps of 1000/fpsCap ms, rendering once after each batch.
// That is exactly the behaviour you get on the ESP32 with a fixed frame budget.
// ---------------------------------------------------------------------------
function fillInput() {
  var inp = app.input;
  inp.mode = app.mode;
  inp.activity = false;
  if (app.mode === MODE_MOUSE) {
    inp.x = app.mouseX;
    inp.y = app.mouseY;
    inp.activity = app.mouseMoved;
  } else if (app.mode === MODE_JOYSTICK) {
    readJoystick();
    inp.x = joy.x;
    inp.y = joy.y;
  } else {
    inp.x = 0;
    inp.y = 0;
  }
  inp.blink = app.pendingBlink;
  inp.glitch = app.pendingGlitch;
}

function frame(ts) {
  requestAnimationFrame(frame);
  if (!app.lastTs) { app.lastTs = ts; app.fpsWindowStart = ts; }
  var elapsed = ts - app.lastTs;
  app.lastTs = ts;
  if (elapsed > 250) elapsed = 250;       // tab was in the background: don't fast-forward

  app.accMs += elapsed;
  var step = 1000 / app.fpsCap;
  // 0.5 ms tolerance absorbs rAF jitter (16.6 vs 16.7 ms) so 60 fps on a 60 Hz screen works.
  if (app.accMs + 0.5 < step) return;

  // ---- logic ----
  var t0 = performance.now();
  var steps = 0;
  while (app.accMs + 0.5 >= step && steps < 4) {
    fillInput();
    updateEye(app.state, app.input, step);
    app.pendingBlink = false;            // one-shot inputs are consumed by the first step
    app.pendingGlitch = false;
    app.mouseMoved = false;
    app.accMs -= step;
    steps++;
  }
  if (steps === 4) app.accMs = 0;        // way behind: drop the backlog instead of spiralling

  // ---- render ----
  var t1 = performance.now();
  for (var i = 0; i < app.eyeCount; i++) {
    computeEyeView(app.state, i, app.eyeCount, app.view);
    renderEye(app.contexts[i], app.view, app.style);
  }
  var t2 = performance.now();

  // Mirror the current joystick value on the on-screen knob (keys move it too).
  if (app.dragging) {
    drawKnob(app.stickX, app.stickY);
  } else if (app.mode === MODE_JOYSTICK) {
    readJoystick();
    drawKnob(joy.x, joy.y);
  } else {
    drawKnob(0, 0);
  }

  updateStats(ts, t1 - t0, t2 - t1);
}

var GLITCH_LABELS = [[GLITCH_SLICE, 'tear'], [GLITCH_RGB, 'rgb'], [GLITCH_BLOCKS, 'blocks'],
  [GLITCH_NEON, 'neon'], [GLITCH_NOISE, 'static'], [GLITCH_DROPOUT, 'dropout'], [GLITCH_JITTER, 'twitch']];

function glitchLabel(s) {
  if (!s.glitchActive) return 'idle';
  var parts = [];
  for (var i = 0; i < GLITCH_LABELS.length; i++) {
    if (s.glitchKinds & GLITCH_LABELS[i][0]) parts.push(GLITCH_LABELS[i][1]);
  }
  return parts.join(' + ');
}

function updateStats(ts, logicMs, renderMs) {
  // The glitch label changes fast; update it every frame it's active.
  if (app.state.glitchActive || app.lastGlitchShown) {
    $('glitchInfo').textContent = glitchLabel(app.state);
    app.lastGlitchShown = app.state.glitchActive;
  }
  // Exponential moving averages keep the numbers readable.
  app.logicMs += (logicMs - app.logicMs) * 0.1;
  app.renderMs += (renderMs - app.renderMs) * 0.1;
  app.frames++;
  var win = ts - app.fpsWindowStart;
  if (win >= 500) {
    app.fps = app.frames * 1000 / win;
    app.frames = 0;
    app.fpsWindowStart = ts;
  }
  if (ts - app.lastStatsUpdate < 250) return;   // touching the DOM 4×/s is plenty
  app.lastStatsUpdate = ts;

  $('statFps').textContent = app.fps.toFixed(1) + ' / ' + app.fpsCap;
  $('statLogic').textContent = (app.logicMs * 1000).toFixed(0) + ' µs';
  $('statRender').textContent = app.renderMs.toFixed(2) + ' ms';
  $('statFrame').textContent = (app.logicMs + app.renderMs).toFixed(2) + ' ms';

  var s = app.state;
  var auto = app.mode !== MODE_AUTO && s.idleMs >= CONFIG.IDLE_TO_AUTO_MS;
  $('readout').textContent =
    'mode ' + MODE_NAMES[app.mode] + (auto ? ' (idle → saccades)' : '') +
    '   gaze ' + s.gazeX.toFixed(2) + ', ' + s.gazeY.toFixed(2) +
    '   blink ' + BLINK_NAMES[s.blinkPhase] +
    '   pupil ' + s.pupil.toFixed(2) +
    (s.glitchActive ? '   GLITCH' : '') +
    '   t ' + (s.timeMs / 1000).toFixed(1) + ' s';
}

// ---------------------------------------------------------------------------
buildEyes();
initUI();
requestAnimationFrame(frame);

// Handy for poking at the state from DevTools: __eye.state, __eye.input ...
window.__eye = app;
