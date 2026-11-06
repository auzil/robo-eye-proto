/*
 * eye-render.js — draws one EyeView onto a 240x240 canvas, pixel by pixel.
 *
 * This renderer works the way the ESP32 version will:
 *   1. At startup (or when a color/slider changes) it PRECOMPUTES tables:
 *        - sclera texture   (bigger than the screen; it scrolls as the eyeball turns)
 *        - iris texture     (in POLAR form: angle x radius, so the pupil can dilate)
 *        - sphere shading   (one brightness factor per screen pixel)
 *        - circle spans     (first/last pixel of each row inside the round display)
 *   2. Every frame it computes two tiny per-column tables for the lids, then runs
 *      ONE loop over the pixels inside the circle, doing only lookups + a little
 *      arithmetic per pixel, and writes the result into a framebuffer.
 *
 * The framebuffer here is an ImageData (RGBA). On the MCU it's the TFT_eSprite
 * buffer (RGB565). Everything else maps 1:1.
 *
 * The renderer never reads EyeState — only the EyeView from computeEyeView().
 */
'use strict';

var TEX = {
  SCLERA_SIZE: 416,   // sclera texture is 416x416: 240 + room to scroll ±88 px
  IRIS_ANG: 512,      // iris texture: 512 samples around the circle...
  IRIS_RAD: 64,       // ...x 64 samples from pupil edge (0) to iris edge (63)
  SPHERE_RADIUS: 134, // shading sphere radius in px (a bit larger than the 120px screen)
  SCLERA_SCROLL: 1,   // 1 = sclera/veins turn with the eye; 0 = static sclera (cheaper partial updates on the MCU)
  LIGHT_X: -0.22, LIGHT_Y: -0.32, LIGHT_Z: 0.92   // light from upper-left-front
};

var tables = {
  ready: false,
  shade: null,                    // Float32Array(240*240) brightness per pixel
  spanStart: null, spanEnd: null, // Int16Array(240): x range inside the circle per row
  upperY: null, lowerY: null,     // Float32Array(240): lid edge y per column (per frame)
  sclera: null, scleraKey: '',    // Uint8ClampedArray RGBA, SCLERA_SIZE^2
  iris: null, irisKey: -1         // Uint8Array RGB, IRIS_ANG * IRIS_RAD
};

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------
function colorToCss(c, alpha) {
  var r = (c >> 16) & 0xff, g = (c >> 8) & 0xff, b = c & 0xff;
  if (alpha === undefined) return 'rgb(' + r + ',' + g + ',' + b + ')';
  return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
}

// Deterministic generator for texture building (separate from the eye's PRNG,
// so changing a color never changes the animation).
var texSeed = 1;
function texRand() {
  texSeed = (Math.imul(texSeed, 1103515245) + 12345) & 0x7fffffff;
  return texSeed / 0x7fffffff;
}

// Periodic 1D value noise: random values on a ring of n points, smoothly
// interpolated. Used for iris fibres (which must wrap around 360°).
function makeNoise(n) {
  var a = new Float32Array(n);
  for (var i = 0; i < n; i++) a[i] = texRand();
  return a;
}
function noise1(arr, x) {
  var n = arr.length;
  var i = Math.floor(x);
  var f = x - i;
  i = ((i % n) + n) % n;
  var j = (i + 1) % n;
  f = f * f * (3 - 2 * f);             // smoothstep: no visible kinks between points
  return arr[i] + (arr[j] - arr[i]) * f;
}

function smoothstep(e0, e1, x) {
  var t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  return t * t * (3 - 2 * t);
}

// ---------------------------------------------------------------------------
// Static tables (built once)
// ---------------------------------------------------------------------------
function buildStaticTables() {
  var S = CONFIG.SCREEN_SIZE, C = CONFIG.CENTER;
  tables.shade = new Float32Array(S * S);
  tables.spanStart = new Int16Array(S);
  tables.spanEnd = new Int16Array(S);
  tables.upperY = new Float32Array(S);
  tables.lowerY = new Float32Array(S);

  var lLen = Math.sqrt(TEX.LIGHT_X * TEX.LIGHT_X + TEX.LIGHT_Y * TEX.LIGHT_Y + TEX.LIGHT_Z * TEX.LIGHT_Z);
  var lx = TEX.LIGHT_X / lLen, ly = TEX.LIGHT_Y / lLen, lz = TEX.LIGHT_Z / lLen;

  for (var y = 0; y < S; y++) {
    // Row span: pixels whose CENTER lies inside the 120 px circle.
    var dy = y + 0.5 - C;
    var half = Math.sqrt(Math.max(0, C * C - dy * dy));
    tables.spanStart[y] = Math.max(0, Math.ceil(C - half - 0.5));
    tables.spanEnd[y] = Math.min(S, Math.floor(C + half - 0.5) + 1);

    for (var x = 0; x < S; x++) {
      // Lambert lighting on a sphere: surface normal n = (x, y, z) / radius,
      // brightness ~ dot(n, light). Plus some ambient so the rim isn't black.
      var nx = (x + 0.5 - C) / TEX.SPHERE_RADIUS;
      var ny = dy / TEX.SPHERE_RADIUS;
      var nz2 = 1 - nx * nx - ny * ny;
      var nz = nz2 > 0 ? Math.sqrt(nz2) : 0;
      var diff = nx * lx + ny * ly + nz * lz;
      if (diff < 0) diff = 0;
      tables.shade[y * S + x] = 0.3 + 0.62 * diff + 0.14 * nz;
    }
  }
  tables.ready = true;
}

// ---------------------------------------------------------------------------
// Sclera texture: base white, pinkish toward the "back" of the eyeball,
// soft mottling and thin veins near the periphery. Drawn once with canvas 2D
// (on the MCU you'd generate it offline and store it in flash as RGB565).
// ---------------------------------------------------------------------------
function buildScleraTexture(color, veins) {
  var N = TEX.SCLERA_SIZE, c = N / 2;
  var cvs = document.createElement('canvas');
  cvs.width = N; cvs.height = N;
  var g = cvs.getContext('2d', { willReadFrequently: true });
  texSeed = 4242;

  // Base: the texture center is the front of the eyeball (where the iris sits);
  // farther out the sclera gets a touch warmer/pinker, like a real eye's corners.
  var pinkish = mixColor(color, 0xe7b9b0, 0.45);
  var base = g.createRadialGradient(c, c, 0, c, c, c);
  base.addColorStop(0, colorToCss(color));
  base.addColorStop(0.45, colorToCss(color));
  base.addColorStop(0.8, colorToCss(mixColor(color, pinkish, 0.5)));
  base.addColorStop(1, colorToCss(pinkish));
  g.fillStyle = base;
  g.fillRect(0, 0, N, N);

  // Mottling: big faint blobs of slightly different tints.
  var tints = [0xf3d6d0, 0xf2ead2, 0xd9e3f1, 0xffffff];
  for (var i = 0; i < 46; i++) {
    var bx = texRand() * N, by = texRand() * N, br = 18 + texRand() * 55;
    var tint = tints[i % tints.length];
    var bg = g.createRadialGradient(bx, by, 0, bx, by, br);
    bg.addColorStop(0, colorToCss(tint, 0.09));
    bg.addColorStop(1, colorToCss(tint, 0));
    g.fillStyle = bg;
    g.fillRect(bx - br, by - br, br * 2, br * 2);
  }

  // Veins: random walks from the rim inward, getting thinner and fainter,
  // occasionally branching. Drawn on a separate layer and slightly blurred.
  var layer = document.createElement('canvas');
  layer.width = N; layer.height = N;
  var v = layer.getContext('2d');
  v.lineCap = 'round';
  var count = Math.round(34 * veins);
  for (var k = 0; k < count; k++) {
    var ang = texRand() * Math.PI * 2;
    var r0 = c - 4 - texRand() * 30;
    drawVein(v, c + Math.cos(ang) * r0, c + Math.sin(ang) * r0, ang + Math.PI,
             1.3 + texRand() * 0.9, 0.5, 2, c, 80 + texRand() * 70);
  }
  g.filter = 'blur(0.6px)';
  g.globalAlpha = Math.min(1, 0.35 + veins * 0.65);
  g.drawImage(layer, 0, 0);
  g.filter = 'none';
  g.globalAlpha = 1;

  return g.getImageData(0, 0, N, N).data;
}

// One vein: walk inward in short wiggly steps. `depth` limits branching.
function drawVein(g, x, y, dir, width, alpha, depth, center, stopRadius) {
  var steps = 22 + Math.floor(texRand() * 22);
  for (var s = 0; s < steps; s++) {
    var len = 3 + texRand() * 5;
    dir += (texRand() - 0.5) * 0.7;           // wiggle
    var nx = x + Math.cos(dir) * len;
    var ny = y + Math.sin(dir) * len;
    g.strokeStyle = 'rgba(176,52,52,' + alpha.toFixed(3) + ')';
    g.lineWidth = width;
    g.beginPath(); g.moveTo(x, y); g.lineTo(nx, ny); g.stroke();
    x = nx; y = ny;
    width *= 0.95;
    alpha *= 0.94;
    var dx = x - center, dy = y - center;
    if (dx * dx + dy * dy < stopRadius * stopRadius || width < 0.25) break;
    if (depth > 0 && texRand() < 0.12) {       // branch off to the side
      drawVein(g, x, y, dir + (texRand() < 0.5 ? -0.7 : 0.7), width * 0.7, alpha * 0.8,
               depth - 1, center, stopRadius);
    }
  }
}

function mixColor(a, b, t) {
  var ar = (a >> 16) & 0xff, ag = (a >> 8) & 0xff, ab = a & 0xff;
  var br = (b >> 16) & 0xff, bg = (b >> 8) & 0xff, bb = b & 0xff;
  return (Math.round(ar + (br - ar) * t) << 16) |
         (Math.round(ag + (bg - ag) * t) << 8) |
          Math.round(ab + (bb - ab) * t);
}

// ---------------------------------------------------------------------------
// Iris texture in POLAR coordinates: tex[radius][angle].
// radius 0 = pupil edge, 63 = iris edge. Because the renderer maps the pupil
// edge to row 0 whatever the pupil size, dilation squeezes/stretches the whole
// pattern like a real iris (the "Uncanny Eyes" trick).
// ---------------------------------------------------------------------------
function buildIrisTexture(color) {
  var A = TEX.IRIS_ANG, R = TEX.IRIS_RAD;
  var out = new Uint8Array(A * R * 3);
  texSeed = 777;

  var fine = makeNoise(110);     // thin radial fibres (kept below ~1 cycle per 2 px so they don't alias)
  var med = makeNoise(28);       // broader light/dark streaks
  var coll = makeNoise(20);      // wobble of the collarette ring
  var ruffN = makeNoise(64);     // pupil-edge ruff irregularity

  // Crypts: small dark pits in the mid zone.
  var cryptA = new Float32Array(26), cryptU = new Float32Array(26), cryptS = new Float32Array(26);
  for (var k = 0; k < 26; k++) {
    cryptA[k] = texRand();
    cryptU[k] = 0.35 + texRand() * 0.4;
    cryptS[k] = 0.03 + texRand() * 0.03;
  }

  var cr = (color >> 16) & 0xff, cg = (color >> 8) & 0xff, cb = color & 0xff;
  // A warm (amber/hazel) tint around the pupil — most real irises have it.
  var warm = mixColor(color, 0xa88757, 0.55);
  var wr = (warm >> 16) & 0xff, wg = (warm >> 8) & 0xff, wb = warm & 0xff;

  for (var ri = 0; ri < R; ri++) {
    var u = ri / (R - 1);                        // 0 at pupil, 1 at limbus
    for (var ai = 0; ai < A; ai++) {
      var a = ai / A;                            // 0..1 around the circle

      // Fibres run radially; a slight shear with u makes them curve a little.
      var fib = 0.55 * noise1(fine, a * 110 + u * 3) + 0.45 * noise1(med, a * 28 + u * 1.2);

      // Collarette: bright wavy ring at about a third of the way out.
      var cu = 0.3 + 0.07 * (noise1(coll, a * 20) - 0.5);
      var collar = Math.exp(-((u - cu) * (u - cu)) / 0.004);

      // Base color: warm inside the collarette, the chosen color outside.
      var inner = 1 - smoothstep(cu - 0.06, cu + 0.08, u);
      var r = cr + (wr - cr) * inner * 0.6;
      var gg = cg + (wg - cg) * inner * 0.6;
      var b = cb + (wb - cb) * inner * 0.6;

      // Brightness: fibres, collarette highlight.
      var bright = 0.66 + 0.5 * (fib - 0.5) + 0.14 * collar;

      // Concentric contraction furrows (faint dark rings, broken by noise).
      var furrow = Math.exp(-((u - 0.66) * (u - 0.66)) / 0.00012) * (fib > 0.5 ? 1 : 0.3);
      furrow += Math.exp(-((u - 0.79) * (u - 0.79)) / 0.0001) * (fib > 0.55 ? 1 : 0.2);
      bright *= 1 - 0.14 * furrow;

      // Crypts (dark pits). Angular distance wraps around.
      for (var k2 = 0; k2 < 26; k2++) {
        var da = Math.abs(a - cryptA[k2]);
        if (da > 0.5) da = 1 - da;
        var du = u - cryptU[k2];
        var dd = (da * 2.2) * (da * 2.2) + du * du;   // pits are a bit wider than tall
        if (dd < 0.02) bright *= 1 - 0.18 * Math.exp(-dd / (cryptS[k2] * cryptS[k2]));
      }

      // Limbal ring: darkens strongly toward the outer edge.
      var limb = smoothstep(0.72, 1.0, u);
      bright *= 1 - 0.78 * limb * limb;

      // Pupillary ruff: dark brownish fringe right at the pupil edge.
      var ruffW = 0.05 + 0.04 * noise1(ruffN, a * 64);
      var ruff = 1 - smoothstep(0, ruffW, u);
      r = r * bright; gg = gg * bright; b = b * bright;
      r += (40 - r) * ruff * 0.85; gg += (30 - gg) * ruff * 0.85; b += (26 - b) * ruff * 0.85;

      var o = (ri * A + ai) * 3;
      out[o] = r < 0 ? 0 : (r > 255 ? 255 : r);
      out[o + 1] = gg < 0 ? 0 : (gg > 255 ? 255 : gg);
      out[o + 2] = b < 0 ? 0 : (b > 255 ? 255 : b);
    }
  }
  return out;
}

function ensureTextures(style) {
  if (!tables.ready) buildStaticTables();
  var sKey = style.scleraColor + ':' + style.veins.toFixed(2);
  if (tables.scleraKey !== sKey) {
    tables.sclera = buildScleraTexture(style.scleraColor, style.veins);
    tables.scleraKey = sKey;
  }
  if (tables.irisKey !== style.irisColor) {
    tables.iris = buildIrisTexture(style.irisColor);
    tables.irisKey = style.irisColor;
  }
}

// ---------------------------------------------------------------------------
// Per-frame render
// style: { irisColor, scleraColor, veins, lidColor, lidShaded, catchlight, rgb565 }
// ---------------------------------------------------------------------------
function renderEye(ctx, view, style) {
  ensureTextures(style);
  var S = CONFIG.SCREEN_SIZE, C = CONFIG.CENTER;

  // One RGBA framebuffer per canvas, allocated once and pre-filled with black.
  // Pixels outside the circle are never written, so they stay black forever.
  var img = ctx.__frame;
  if (!img) {
    img = ctx.createImageData(S, S);
    for (var i = 3; i < img.data.length; i += 4) img.data[i] = 255;
    ctx.__frame = img;
  }
  var data = img.data;

  var shade = tables.shade, spanStart = tables.spanStart, spanEnd = tables.spanEnd;
  var upperY = tables.upperY, lowerY = tables.lowerY;
  var sclera = tables.sclera, iris = tables.iris;
  var SN = TEX.SCLERA_SIZE, IA = TEX.IRIS_ANG, IR = TEX.IRIS_RAD;

  // --- Lid edges per column. Each edge is an arc of a circle of radius Rl that
  // passes through (120, mid):  y(x) = mid + Rl - sqrt(Rl^2 - dx^2)  (upper lid;
  // the lower lid is the mirror image). 240 sqrt's per frame — on the MCU too.
  var ur = view.upperRadius, lr2 = view.lowerRadius;
  for (var x0 = 0; x0 < S; x0++) {
    var dxl = x0 + 0.5 - C;
    var dd2 = dxl * dxl;
    upperY[x0] = dd2 < ur * ur ? view.upperLidY + ur - Math.sqrt(ur * ur - dd2) : 1e4;   // beyond the arc: all lid
    lowerY[x0] = dd2 < lr2 * lr2 ? view.lowerLidY - lr2 + Math.sqrt(lr2 * lr2 - dd2) : -1e4;
  }

  // --- Eyeball rotation: the sclera texture scrolls with the iris, so veins move
  // with the eye. Screen pixel (x,y) reads texture pixel (x - offX + base, y - offY + base).
  var offX = view.irisX - C, offY = view.irisY - C;
  var texBase = SN / 2 - C;
  var tOffX = Math.round(texBase - offX * TEX.SCLERA_SCROLL), tOffY = Math.round(texBase - offY * TEX.SCLERA_SCROLL);

  // --- Iris frame (foreshortening): rotate into the gaze direction, stretch back
  // the squashed axis, then it's a plain circle of radius irisR.
  var ix = view.irisX, iy = view.irisY;
  var R = view.irisR, pr = view.pupilR;
  var dirX = view.dirX, dirY = view.dirY;
  var invSquash = 1 / view.squash;
  var baseAngle = Math.atan2(dirY, dirX);
  var irisSpan = R - pr;
  var invIrisSpan = irisSpan > 0.5 ? 1 / irisSpan : 2;
  var Rout = R + 1.5, Rout2 = Rout * Rout;
  var bx0 = ix - Rout, bx1 = ix + Rout, by0 = iy - Rout, by1 = iy + Rout;
  var INV_2PI = 1 / (Math.PI * 2);
  var pupR = (CONFIG.PUPIL_COLOR >> 16) & 0xff, pupG = (CONFIG.PUPIL_COLOR >> 8) & 0xff, pupB = CONFIG.PUPIL_COLOR & 0xff;

  // --- Catchlight: a soft "window" wedge on the cornea, up-right of the pupil.
  // It sits on the cornea, so it moves a bit less than the iris (parallax).
  var useCatch = style.catchlight;
  var clX = C + offX * 0.82 + R * 0.08, clY = C + offY * 0.82 - R * 0.1;
  var clCos = Math.cos(-0.82), clSin = Math.sin(-0.82);   // pointing up and to the right
  var clLen = R * 0.6, clW0 = R * 0.06, clW1 = R * 0.2;
  var clSoft = 2.6;                                          // edge softness in px
  var clReach = clLen + clW1 + clSoft + 2;

  var lidR = (style.lidColor >> 16) & 0xff, lidG = (style.lidColor >> 8) & 0xff, lidB = style.lidColor & 0xff;
  var lidShaded = style.lidShaded;
  var glitching = view.glitchAmount > 0;
  var q565 = style.rgb565 && !glitching;     // when glitching, quantize after the glitch pass

  for (var y = 0; y < S; y++) {
    var py = y + 0.5;
    var xs = spanStart[y], xe = spanEnd[y];
    var rowIn = py >= by0 && py <= by1;          // does this row cross the iris box?
    var row = y * S;

    for (var x = xs; x < xe; x++) {
      var px = x + 0.5;
      var up = upperY[x], lo = lowerY[x];

      // Lid coverage with a 1 px soft edge (0 = eye visible, 1 = lid).
      var cu = up - py + 0.5; cu = cu < 0 ? 0 : (cu > 1 ? 1 : cu);
      var cl = py - lo + 0.5; cl = cl < 0 ? 0 : (cl > 1 ? 1 : cl);
      var lidCov = cu > cl ? cu : cl;

      var r = 0, g = 0, b = 0;

      if (lidCov < 1) {
        // 1) Sclera from the scrolling texture.
        var tx = x + tOffX, ty = y + tOffY;
        if (tx < 0) tx = 0; else if (tx >= SN) tx = SN - 1;
        if (ty < 0) ty = 0; else if (ty >= SN) ty = SN - 1;
        var ti = (ty * SN + tx) << 2;
        r = sclera[ti]; g = sclera[ti + 1]; b = sclera[ti + 2];

        // 2) Iris + pupil (only inside the iris bounding box).
        if (rowIn && px >= bx0 && px <= bx1) {
          var dx = px - ix, dy = py - iy;
          var along = (dx * dirX + dy * dirY) * invSquash;  // undo foreshortening
          var perp = -dx * dirY + dy * dirX;
          var d2 = along * along + perp * perp;
          if (d2 < Rout2) {
            var d = Math.sqrt(d2);
            // Polar lookup: radius -> texture row, angle -> texture column.
            var u = (d - pr) * invIrisSpan;
            if (u < 0) u = 0; else if (u > 1) u = 1;
            var rIdx = (u * (IR - 1) + 0.5) | 0;
            var ang = Math.atan2(perp, along) + baseAngle;
            var aF = ang * INV_2PI;
            aF -= Math.floor(aF);                            // wrap to 0..1
            var aIdx = (aF * IA) | 0;
            if (aIdx >= IA) aIdx = IA - 1;
            var ii = (rIdx * IA + aIdx) * 3;
            var ir = iris[ii], ig = iris[ii + 1], ib = iris[ii + 2];

            // Pupil with a 1 px soft edge.
            var pm = pr + 0.5 - d; pm = pm < 0 ? 0 : (pm > 1 ? 1 : pm);
            ir += (pupR - ir) * pm; ig += (pupG - ig) * pm; ib += (pupB - ib) * pm;

            // Soft limbus: blend iris into sclera over ~1.5 px.
            var ic = (R + 0.5 - d) / 1.5; ic = ic < 0 ? 0 : (ic > 1 ? 1 : ic);
            r += (ir - r) * ic; g += (ig - g) * ic; b += (ib - b) * ic;
          }
        }

        // 3) Sphere shading (darker toward the rim, light from upper-left).
        var sh = shade[row + x];

        // 4) Ambient occlusion: the lids cast soft shadows onto the eyeball.
        var du = py - up;
        if (du < 16) { var k1 = du < 0 ? 1 : 1 - du / 16; sh *= 1 - 0.55 * k1 * k1; }
        var dl = lo - py;
        if (dl < 8) { var k2 = dl < 0 ? 1 : 1 - dl / 8; sh *= 1 - 0.3 * k2 * k2; }
        r *= sh; g *= sh; b *= sh;

        // 5) Catchlight: additive blend toward white inside a soft wedge.
        if (useCatch) {
          var lx = px - clX, ly = py - clY;
          if (lx > -clReach && lx < clReach && ly > -clReach && ly < clReach) {
            var la = lx * clCos + ly * clSin;      // along the wedge
            var lp = -lx * clSin + ly * clCos;     // across it
            if (la > -clSoft && la < clLen + clSoft) {
              var t = la / clLen; t = t < 0 ? 0 : (t > 1 ? 1 : t);
              var hw = clW0 + (clW1 - clW0) * t;   // wedge widens outward
              var ea = la < clLen - la ? la : clLen - la;
              var ep = hw - (lp < 0 ? -lp : lp);
              var e = ea < ep ? ea : ep;           // distance to the nearest edge
              var al = e / clSoft + 0.5; al = al < 0 ? 0 : (al > 1 ? 1 : al);
              al = al * al * (3 - 2 * al);         // smoothstep: soft, glassy edge
              al *= 0.5 + 0.35 * t;                // brighter toward the outer end
              r += (255 - r) * al; g += (255 - g) * al; b += (255 - b) * al;
            }
          }
        }
      }

      // 6) Lids on top.
      if (lidCov > 0) {
        var lr = lidR, lg = lidG, lb = lidB;
        if (lidShaded) {
          // Darker away from the edge, and a dark lash line right at it.
          var dist = cu >= cl ? up - py : py - lo;
          var f = 0.55 + 0.45 * Math.exp(-(dist < 0 ? 0 : dist) / 18);
          if (dist < 2.5) f *= 0.55;
          lr *= f; lg *= f; lb *= f;
        }
        r += (lr - r) * lidCov; g += (lg - g) * lidCov; b += (lb - b) * lidCov;
      }

      // 7) Clamp to 8 bit, optionally quantize to RGB565 exactly like the panel.
      r = r > 255 ? 255 : r | 0;
      g = g > 255 ? 255 : g | 0;
      b = b > 255 ? 255 : b | 0;
      if (q565) {
        r = ((r >> 3) << 3) | (r >> 5);   // keep 5 bits, expand back by repeating top bits
        g = ((g >> 2) << 2) | (g >> 6);   // keep 6 bits
        b = ((b >> 3) << 3) | (b >> 5);
      }
      var o = (row + x) << 2;
      data[o] = r; data[o + 1] = g; data[o + 2] = b;
    }
  }

  if (glitching) {
    applyGlitch(data, view);
    if (style.rgb565) quantizeSpans(data);
  }

  ctx.putImageData(img, 0, 0);
}

// Quantize every pixel inside the circle to RGB565 (used after the glitch pass).
function quantizeSpans(data) {
  var S = CONFIG.SCREEN_SIZE;
  for (var y = 0; y < S; y++) {
    for (var x = tables.spanStart[y]; x < tables.spanEnd[y]; x++) {
      var o = (y * S + x) << 2;
      var r = data[o], g = data[o + 1], b = data[o + 2];
      data[o] = ((r >> 3) << 3) | (r >> 5);
      data[o + 1] = ((g >> 2) << 2) | (g >> 6);
      data[o + 2] = ((b >> 3) << 3) | (b >> 5);
    }
  }
}

// ---------------------------------------------------------------------------
// Cyberpunk glitch pass — runs on the finished frame, only while a glitch is active.
//
// Every effect is HORIZONTAL (rows shifted / channels offset along x), so the
// whole pass needs only ONE 240-pixel line buffer: copy a row out, write it back
// displaced. That's important on the ESP32: no second full framebuffer needed.
// All randomness comes from view.glitchSeed, so a given seed always gives the
// same corrupted frame. Pixels outside the circle are never written => stay black.
// ---------------------------------------------------------------------------
var glitchBuf = {
  line: null,        // Uint8Array(240*3): one row, RGB
  rowShift: null,    // Int16Array(240): sideways tear per row (px)
  rowSplit: null,    // Int16Array(240): red/blue channel offset per row (px)
  rowNoise: null     // Uint8Array(240): 1 = this row is static noise
};
var gRng = 1;
function gRand() {                      // renderer-local xorshift32, seeded per frame
  var x = gRng | 0;
  x ^= x << 13; x ^= x >>> 17; x ^= x << 5;
  gRng = x >>> 0;
  return gRng / 4294967296;
}

function applyGlitch(data, view) {
  var S = CONFIG.SCREEN_SIZE;
  if (!glitchBuf.line) {
    glitchBuf.line = new Uint8Array(S * 3);
    glitchBuf.rowShift = new Int16Array(S);
    glitchBuf.rowSplit = new Int16Array(S);
    glitchBuf.rowNoise = new Uint8Array(S);
  }
  var line = glitchBuf.line, rowShift = glitchBuf.rowShift;
  var rowSplit = glitchBuf.rowSplit, rowNoise = glitchBuf.rowNoise;
  var spanStart = tables.spanStart, spanEnd = tables.spanEnd;
  var amt = view.glitchAmount, kinds = view.glitchKinds;
  var i, k, y, x, y0, h;

  gRng = view.glitchSeed >>> 0;
  if (gRng === 0) gRng = 1;
  for (i = 0; i < S; i++) { rowShift[i] = 0; rowSplit[i] = 0; rowNoise[i] = 0; }

  // --- Plan the frame: fill the per-row tables ---
  var baseSplit = (kinds & GLITCH_RGB) ? Math.round(1 + 6 * amt) : 0;
  for (i = 0; i < S; i++) rowSplit[i] = baseSplit;

  if (kinds & GLITCH_SLICE) {
    // Several thin bands torn sideways...
    var bands = 1 + Math.floor(gRand() * (2 + 7 * amt));
    for (k = 0; k < bands; k++) {
      y0 = Math.floor(gRand() * S);
      h = 1 + Math.floor(gRand() * gRand() * (6 + 34 * amt));    // mostly thin, some thick
      var shift = Math.round((gRand() * 2 - 1) * (6 + 46 * amt));
      var extraSplit = Math.round(gRand() * 4 * amt);
      for (y = y0; y < y0 + h && y < S; y++) { rowShift[y] += shift; rowSplit[y] += extraSplit; }
    }
    // ...and sometimes one big chunk of the eye jumps sideways.
    if (gRand() < 0.35 * amt + 0.1) {
      y0 = Math.floor(gRand() * (S - 40));
      h = 14 + Math.floor(gRand() * 50);
      var big = Math.round((gRand() < 0.5 ? -1 : 1) * (18 + 50 * amt));
      for (y = y0; y < y0 + h && y < S; y++) rowShift[y] += big;
    }
  }
  if (kinds & GLITCH_NOISE) {
    var lines = 1 + Math.floor(gRand() * (1 + 5 * amt));
    for (k = 0; k < lines; k++) {
      y0 = Math.floor(gRand() * S);
      h = 1 + Math.floor(gRand() * 3);
      for (y = y0; y < y0 + h && y < S; y++) rowNoise[y] = 1;
    }
  }

  // Neon tint + scanlines, signal dropout.
  var neon = (kinds & GLITCH_NEON) !== 0;
  var tint = gRand() < 0.5 ? CONFIG.GLITCH_NEON_COLOR_A : CONFIG.GLITCH_NEON_COLOR_B;
  var tR = (tint >> 16) & 0xff, tG = (tint >> 8) & 0xff, tB = tint & 0xff;
  var tintK = neon ? 0.15 + 0.3 * amt : 0;        // how far bright colors are pulled toward the neon color
  var scan = neon ? 1 - (0.15 + 0.28 * amt) : 1;  // brightness of every other row (scanlines)
  var dropout = (kinds & GLITCH_DROPOUT) && gRand() < 0.6;
  var dim = dropout ? 0.08 + 0.12 * gRand() : 1;

  // --- Row pass: shift + RGB split + noise + tint + scanlines + dropout ---
  for (y = 0; y < S; y++) {
    var xs = spanStart[y], xe = spanEnd[y];
    var sh = rowShift[y], sp = rowSplit[y], noisy = rowNoise[y];
    var odd = (y & 1) === 1;
    if (sh === 0 && sp === 0 && !noisy && !neon && !dropout) continue;   // row untouched

    // Copy this row's visible pixels into the line buffer.
    var row = y * S;
    for (x = xs; x < xe; x++) {
      var o0 = (row + x) << 2, l0 = x * 3;
      line[l0] = data[o0]; line[l0 + 1] = data[o0 + 1]; line[l0 + 2] = data[o0 + 2];
    }

    for (x = xs; x < xe; x++) {
      var src = x - sh;                       // content moves right by `sh`
      var sr = src + sp, sb = src - sp;       // red pulled one way, blue the other
      // Anything sampled from outside the circle is the black bezel.
      var r = (sr >= xs && sr < xe) ? line[sr * 3] : 0;
      var g = (src >= xs && src < xe) ? line[src * 3 + 1] : 0;
      var b = (sb >= xs && sb < xe) ? line[sb * 3 + 2] : 0;

      if (noisy) {
        // Static: random brightness, slightly tinted, mixed over the image.
        var n = gRand() * 255;
        r = r * 0.25 + n * 0.75; g = g * 0.25 + n * 0.8; b = b * 0.25 + n * 0.9;
      }
      if (neon) {
        // Tint weighted by brightness: highlights glow neon, blacks (lids, pupil) stay black.
        var tk = tintK * (r + g + b) * (1 / 765);
        r += (tR - r) * tk; g += (tG - g) * tk; b += (tB - b) * tk;
        if (odd) { r *= scan; g *= scan; b *= scan; }
      }
      if (dropout && !noisy) { r *= dim; g *= dim; b *= dim; }

      var o = (row + x) << 2;
      data[o] = r > 255 ? 255 : r;
      data[o + 1] = g > 255 ? 255 : g;
      data[o + 2] = b > 255 ? 255 : b;
    }
  }

  // --- Corrupted blocks ---
  if (kinds & GLITCH_BLOCKS) {
    var blocks = 1 + Math.floor(gRand() * (1 + 4 * amt));
    for (k = 0; k < blocks; k++) {
      var bw = 6 + Math.floor(gRand() * (12 + 60 * amt));
      var bh = 3 + Math.floor(gRand() * (6 + 24 * amt));
      var bx = Math.floor(gRand() * (S - bw));
      var by = Math.floor(gRand() * (S - bh));
      var mode = gRand();
      var bc = gRand() < 0.5 ? CONFIG.GLITCH_NEON_COLOR_A : CONFIG.GLITCH_NEON_COLOR_B;
      var cR = (bc >> 16) & 0xff, cG = (bc >> 8) & 0xff, cB = bc & 0xff;
      var alpha = 0.55 + 0.4 * gRand();
      var copyDx = Math.round((gRand() * 2 - 1) * 50);

      for (y = by; y < by + bh; y++) {
        var bxs = spanStart[y] > bx ? spanStart[y] : bx;
        var bxe = spanEnd[y] < bx + bw ? spanEnd[y] : bx + bw;
        if (bxe <= bxs) continue;
        var brow = y * S;
        if (mode >= 0.7) {                     // displaced copy: needs the row in the line buffer
          for (x = spanStart[y]; x < spanEnd[y]; x++) {
            var oc = (brow + x) << 2, lc = x * 3;
            line[lc] = data[oc]; line[lc + 1] = data[oc + 1]; line[lc + 2] = data[oc + 2];
          }
        }
        for (x = bxs; x < bxe; x++) {
          var ob = (brow + x) << 2;
          if (mode < 0.4) {
            // Solid neon block with a stripe every other row.
            var a = (y & 1) ? alpha : alpha * 0.6;
            data[ob] += (cR - data[ob]) * a;
            data[ob + 1] += (cG - data[ob + 1]) * a;
            data[ob + 2] += (cB - data[ob + 2]) * a;
          } else if (mode < 0.7) {
            // Bit-crush: keep only the top 2 bits per channel and swap red/blue.
            var rr = data[ob] & 0xc0, gg = data[ob + 1] & 0xc0, bb = data[ob + 2] & 0xc0;
            data[ob] = bb | 0x20; data[ob + 1] = gg | 0x20; data[ob + 2] = rr | 0x20;
          } else {
            // Data-mosh: a piece of the same row from elsewhere.
            var sx = x + copyDx;
            if (sx >= spanStart[y] && sx < spanEnd[y]) {
              data[ob] = line[sx * 3]; data[ob + 1] = line[sx * 3 + 1]; data[ob + 2] = line[sx * 3 + 2];
            } else {
              data[ob] = 0; data[ob + 1] = 0; data[ob + 2] = 0;
            }
          }
        }
      }
    }
  }
}
