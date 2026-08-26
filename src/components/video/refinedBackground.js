// Refined background processor — the "Approach 2" self-managed pipeline.
//
// LiveKit's stock @livekit/track-processors composites a low-res MediaPipe mask
// with no edge refinement, which reads as "blobby". This runs our OWN pipeline
// and publishes the result as the camera track, packaged as a LiveKit
// TrackProcessor so it still plugs into `localVideoTrack.setProcessor()`:
//
//   camera MediaStreamTrack
//     -> <video>  -> MediaPipe ImageSegmenter (person confidence mask)
//     -> WebGL2:  joint-bilateral edge refine (mask snapped to image edges,
//                 the Google-Meet trick) + temporal smoothing + gaussian blur
//                 (blur mode) + light wrap
//     -> <canvas>.captureStream()  -> processedTrack  -> published by LiveKit
//
// Everything is fail-safe: if WebGL2 / the model / a frame errors, we leave the
// raw camera untouched so the call never breaks — you just don't get the effect.
//
// This is a first pass that needs in-browser tuning. Likely tuning points are
// flagged with [TUNE]: mask polarity (foreground vs background), vertical
// orientation, blur strength, and the bilateral edge weight.

import { createRvmMatter } from "./rvmMatting";

const WASM_BASE = "https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm";
const MODEL_URL =
  "https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/latest/selfie_segmenter.tflite";

// Optional high-quality matting (Robust Video Matting). Used when the model is
// hosted (set VITE_RVM_MODEL_URL to your Supabase Storage URL) AND the device
// runs it fast enough; otherwise we fall back to the MediaPipe selfie mask.
const RVM_MODEL_URL =
  (typeof import.meta !== "undefined" && import.meta.env && import.meta.env.VITE_RVM_MODEL_URL) || "";
// Cap on the frame we send RVM. This sets inference COST, which (since render is
// decoupled) equals matte FRESHNESS, i.e. how far the matte trails you on motion.
// 384/0.35 ran ~27ms (≈37fps matte) on 8 threads vs 512/0.5's ~60-90ms (≈12-16fps);
// the lower-lag config is the one that feels responsive when you move. Edge
// sharpness barely suffers because the bilateral pass re-snaps this matte onto the
// live 960px frame anyway. [TUNE] up only if you want crisper edges over freshness.
const RVM_INPUT_WIDTH = 384;
// RVM's internal ENCODER downscale. 0.35 (~134px encoder) is the floor that still
// catches limbs (0.25 dropped arms); lower = faster/fresher but starts missing the
// person. [TUNE].
const RVM_DOWNSAMPLE = 0.35;
// [TUNE] disable RVM above this avg. Now that rendering is decoupled from
// inference, this latency only affects matte FRESHNESS (the render stays ~60fps),
// so it can be lenient: a ~120ms matte snapped onto the live frame still beats
// MediaPipe. Set well above the threaded 512/0.5 cost so a threaded machine keeps
// RVM; a single-thread one (Safari/iOS) still blows past it and falls back.
const RVM_SLOW_MS = 160;

// Sticky, per-page verdict: once RVM proves too slow on this machine we stop
// even *trying* it. A new processor is built on every camera mute/unmute (the
// track identity changes — see EffectsController), so a per-instance flag reset
// every toggle and re-ran the whole probe: re-download the model, 12 slow frames,
// then flip back to MediaPipe. Hoisting the verdict to the module makes it learn
// once. (We tested WebGPU — RVM's recurrent ops fall back to CPU on the heavier
// asyncify build, so it ran *slower*, 113ms vs 82ms. WASM single-thread is the
// wall; the gate is the right answer.)
let rvmDisabledForSession = false;

const PROC_WIDTH_CAP = 960; // cap the processing resolution for perf

// ── tiny WebGL helpers ───────────────────────────────────────
function compile(gl, type, src) {
  const sh = gl.createShader(type);
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh);
    gl.deleteShader(sh);
    throw new Error("shader compile failed: " + log);
  }
  return sh;
}
function makeProgram(gl, vsrc, fsrc) {
  const p = gl.createProgram();
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error("program link failed: " + gl.getProgramInfoLog(p));
  }
  return { program: p, a_pos: gl.getAttribLocation(p, "a_pos"), u: {} };
}
function uni(gl, prog, name) {
  if (!(name in prog.u)) prog.u[name] = gl.getUniformLocation(prog.program, name);
  return prog.u[name];
}
function makeTex(gl, filter) {
  const t = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}
function makeFBO(gl, w, h, internal, format, type) {
  const tex = makeTex(gl, gl.LINEAR);
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, internal, w, h, 0, format, type, null);
  const fbo = gl.createFramebuffer();
  gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
  gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
  gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  return { fbo, tex, w, h };
}

const VERT = `#version 300 es
in vec2 a_pos; out vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

// Joint-bilateral upsample of the raw mask, guided by the camera image so the
// alpha snaps to real edges, blended with the previous frame for stability.
const FRAG_REFINE = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_mask;   // raw person-confidence mask (R8, low-res)
uniform sampler2D u_guide;  // camera image (edge guide)
uniform sampler2D u_prev;   // previous frame's refined alpha
uniform vec2 u_texel;       // 1.0 / processing size
uniform float u_hasPrev;    // 1.0 once we have a previous frame
float luma(vec3 c){ return dot(c, vec3(0.299, 0.587, 0.114)); }
void main(){
  float cg = luma(texture(u_guide, v_uv).rgb);
  float msum = 0.0, wsum = 0.0;
  const int R = 2;                                  // 5x5 neighbourhood
  for (int dy = -R; dy <= R; dy++) {
    for (int dx = -R; dx <= R; dx++) {
      vec2 off = vec2(float(dx), float(dy)) * u_texel;
      float m = texture(u_mask, v_uv + off).r;
      float g = luma(texture(u_guide, v_uv + off).rgb);
      float ws = exp(-float(dx*dx + dy*dy) / 4.0);   // spatial weight
      float dc = cg - g;
      float wc = exp(-(dc*dc) / 0.015);              // [TUNE] edge sensitivity
      float w = ws * wc;
      msum += m * w; wsum += w;
    }
  }
  float refined = wsum > 0.0 ? msum / wsum : texture(u_mask, v_uv).r;
  // Asymmetric soft curve: background below ~0.30 is forced to 0 so the
  // replacement stays FULLY OPAQUE, but smoothstep gives a gentle foreground
  // falloff (vs the old hard linear clamp) so soft detail — hair, glasses arms —
  // keeps a feathered edge instead of a paper cutout. [TUNE] raise 0.30 if any
  // background haze returns; lower 0.62 to keep more wispy hair.
  refined = smoothstep(0.30, 0.62, refined);
  float a = refined;
  // Motion-adaptive temporal. Where the matte is steady (|refined-prev| tiny) we
  // lean on history to kill the edge shimmer you get standing still; where it's
  // changing (you moved) we snap to the current matte so a stale frame can't
  // trail into a smear. One fixed blend can't do both — this picks per-pixel.
  if (u_hasPrev > 0.5) {
    float prev = texture(u_prev, v_uv).r;
    float motion = abs(refined - prev);
    float k = mix(0.35, 1.0, smoothstep(0.04, 0.25, motion)); // weight on the CURRENT matte
    a = mix(prev, refined, k);
  }
  o = vec4(a, 0.0, 0.0, 1.0);
}`;

// Separable gaussian (run once horizontally, once vertically) for blur mode.
const FRAG_BLUR = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_src; uniform vec2 u_dir;
void main(){
  float w0 = 0.227027, w1 = 0.194595, w2 = 0.121622, w3 = 0.054054, w4 = 0.016216;
  vec4 sum = texture(u_src, v_uv) * w0;
  sum += texture(u_src, v_uv + u_dir * 1.0) * w1;
  sum += texture(u_src, v_uv - u_dir * 1.0) * w1;
  sum += texture(u_src, v_uv + u_dir * 2.0) * w2;
  sum += texture(u_src, v_uv - u_dir * 2.0) * w2;
  sum += texture(u_src, v_uv + u_dir * 3.0) * w3;
  sum += texture(u_src, v_uv - u_dir * 3.0) * w3;
  sum += texture(u_src, v_uv + u_dir * 4.0) * w4;
  sum += texture(u_src, v_uv - u_dir * 4.0) * w4;
  o = sum;
}`;

// Build a premultiplied BACKGROUND for the blur: rgb = video × (1-alpha),
// a = (1-alpha). Blurring this (then dividing rgb/a in the composite) averages
// ONLY background pixels, so the foreground's colour doesn't smear into a halo
// at the edge — the big visible gap vs a true depth blur.
const FRAG_PREMULT = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_video;
uniform sampler2D u_alpha;
void main(){
  vec3 c = texture(u_video, v_uv).rgb;
  float a = texture(u_alpha, v_uv).r;   // foreground alpha
  float bgw = 1.0 - a;                  // background weight
  o = vec4(c * bgw, bgw);
}`;

// Composite foreground over background with a light wrap at the edge band, and
// flip vertically so the captured canvas is upright.
const FRAG_COMPOSITE = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 o;
uniform sampler2D u_video;
uniform sampler2D u_bg;
uniform sampler2D u_alpha;
uniform float u_lightWrap;
void main(){
  vec2 uv = vec2(v_uv.x, 1.0 - v_uv.y);     // [TUNE] flip for upright output
  vec3 fg = texture(u_video, uv).rgb;
  vec4 bgs = texture(u_bg, uv);
  vec3 bg = bgs.a > 0.001 ? bgs.rgb / bgs.a : bgs.rgb;   // un-premultiply (bleed-free blur)
  float a = texture(u_alpha, uv).r;
  float edge = smoothstep(0.0, 0.5, a) * (1.0 - smoothstep(0.5, 1.0, a)); // mid-alpha band
  fg = mix(fg, bg, edge * u_lightWrap);
  o = vec4(mix(bg, fg, a), 1.0);
}`;

async function createSegmenter() {
  const { FilesetResolver, ImageSegmenter } = await import("@mediapipe/tasks-vision");
  const fileset = await FilesetResolver.forVisionTasks(WASM_BASE);
  return ImageSegmenter.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
    runningMode: "VIDEO",
    outputCategoryMask: false,
    outputConfidenceMasks: true,
  });
}

function waitForVideo(v) {
  return new Promise((resolve) => {
    if (v.videoWidth > 0) return resolve();
    const done = () => resolve();
    v.addEventListener("loadeddata", done, { once: true });
    setTimeout(done, 2500); // never hang the call on a stuck camera
  });
}

function normalize(opts) {
  return {
    mode: opts?.mode === "image" ? "image" : "blur",
    blurRadius: Number.isFinite(opts?.blurRadius) ? opts.blurRadius : 12,
    imageUrl: opts?.imageUrl || null,
  };
}

// Implements the livekit-client TrackProcessor interface (init/restart/destroy +
// processedTrack). LiveKit calls init(opts) with the raw camera MediaStreamTrack
// and publishes whatever we expose as `processedTrack`.
class RefinedBackgroundProcessor {
  constructor(opts) {
    this.name = "refined-background";
    this.opts = normalize(opts);
    this._running = false;
    this._busy = false;     // an inference (RVM or MediaPipe) is in flight
    this._ts = 0;
    this._lastRender = 0;   // throttles the render loop to ~display rate
    this._haveMask = 0;     // a matte exists in texMask → safe to composite
    this._hasPrev = 0;
    this._rvm = null;       // RVM matter handle (when available)
    this._rvmSlow = false;  // disabled after the perf gate trips
    this._rvmMs = [];       // recent inference timings
    this._rvmBatches = 0;   // completed perf batches (1st is warmup, ignored)
    this._rvmSlowStreak = 0;// consecutive over-budget batches (need 2 to bail)
    this._backend = null;   // "RVM" | "MediaPipe" — logged when it changes
  }

  async init(processorOptions) {
    const track = processorOptions?.track;
    if (!track) throw new Error("no source track");
    this._haveMask = 0;
    this._hasPrev = 0;
    this._busy = false;
    this.source = track;

    this.video = document.createElement("video");
    this.video.muted = true;
    this.video.autoplay = true;
    this.video.playsInline = true;
    this.video.srcObject = new MediaStream([track]);
    await this.video.play().catch(() => {});
    await waitForVideo(this.video);

    const vw = this.video.videoWidth || 640;
    const vh = this.video.videoHeight || 480;
    const scale = Math.min(1, PROC_WIDTH_CAP / vw);
    this.W = Math.max(2, Math.round(vw * scale));
    this.H = Math.max(2, Math.round(vh * scale));

    this.canvas = document.createElement("canvas");
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    const gl = this.canvas.getContext("webgl2", { alpha: false, premultipliedAlpha: false, desynchronized: true });
    if (!gl) throw new Error("webgl2 unavailable");
    this.gl = gl;
    this._setupGL();

    this.segmenter = await createSegmenter();
    // High-quality matting in the background; MediaPipe (above) runs immediately
    // and stays as the fallback. We switch to RVM once it's loaded + proven fast.
    if (RVM_MODEL_URL && !rvmDisabledForSession) {
      try {
        console.info("[bg] RVM model loading…", RVM_MODEL_URL);
        this._rvm = createRvmMatter({
          modelUrl: RVM_MODEL_URL,
          inputWidth: RVM_INPUT_WIDTH,
          downsample: RVM_DOWNSAMPLE,
          onReady: (ep, threads) => console.info(
            `[bg] RVM ready (${ep || "wasm"}, ${threads > 1 ? `${threads} threads` : "single-thread"}) — switching in`
          ),
          onError: (msg) => { console.warn("[bg] RVM unavailable, staying on MediaPipe:", msg); this._rvm = null; },
        });
      } catch (e) {
        console.warn("[rvm] init failed", e);
        this._rvm = null;
      }
    }
    if (this.opts.imageUrl) await this._loadBg(this.opts.imageUrl);

    // 60fps so the decoupled render loop's smoothness reaches the call (capped by
    // the camera's own rate + LiveKit's adaptive encode; harmless if the source is 30).
    this.processedTrack = this.canvas.captureStream(60).getVideoTracks()[0];
    this._running = true;
    this._loop();
  }

  async restart(processorOptions) {
    const track = processorOptions?.track;
    // Fast path: LiveKit calls restart() with a brand-new raw MediaStreamTrack on
    // every camera mute/unmute AND device switch (unmute() re-acquires the
    // device) — NOT just on a genuine effect change. The GL pipeline, MediaPipe
    // segmenter, and RVM worker are all still warm; only the source track
    // changed. Previously this fell through to destroy()+init(), which tore down
    // and rebuilt everything from scratch INCLUDING an RVM model re-fetch over
    // the network — leaving the self-view blank (_haveMask resets to 0) for the
    // whole multi-second reinit on every single toggle. _uploadVideo() uploads
    // the video element at its own native size each frame, and the FBOs/canvas
    // are a fixed processing resolution independent of the source, so rebinding
    // a differently-sized replacement camera here is still safe.
    if (track && this.gl && this.video) {
      this._haveMask = 0;
      this._hasPrev = 0;
      this._busy = false;
      this.source = track;
      this.video.srcObject = new MediaStream([track]);
      await this.video.play().catch(() => {});
      await waitForVideo(this.video);
      return;
    }
    await this.destroy();
    await this.init(processorOptions);
  }

  updateOptions(opts) {
    const next = normalize(opts);
    const imgChanged = next.imageUrl !== this.opts.imageUrl;
    this.opts = next;
    if (next.mode === "image" && next.imageUrl && imgChanged) {
      this._loadBg(next.imageUrl).catch(() => {});
    }
  }

  async destroy() {
    this._running = false;
    this._haveMask = 0;
    this._hasPrev = 0;
    this._busy = false;
    if (this._raf) cancelAnimationFrame(this._raf);
    try { this._rvm?.close(); } catch { /* */ }
    this._rvm = null;
    try { this.segmenter?.close(); } catch { /* */ }
    try { this.processedTrack?.stop(); } catch { /* */ }
    if (this.video) { this.video.srcObject = null; this.video = null; }
    this.segmenter = null;
    this.gl = null;
    this.canvas = null;
  }

  _setupGL() {
    const gl = this.gl;
    this.quad = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

    this.pRefine = makeProgram(gl, VERT, FRAG_REFINE);
    this.pBlur = makeProgram(gl, VERT, FRAG_BLUR);
    this.pPremult = makeProgram(gl, VERT, FRAG_PREMULT);
    this.pComposite = makeProgram(gl, VERT, FRAG_COMPOSITE);

    this.texVideo = makeTex(gl, gl.LINEAR);
    this.texMask = makeTex(gl, gl.LINEAR);
    this.texBg = makeTex(gl, gl.LINEAR);
    // 1x1 placeholder background until an image loads.
    gl.bindTexture(gl.TEXTURE_2D, this.texBg);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array([30, 41, 59, 255]));

    this.alphaA = makeFBO(gl, this.W, this.H, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    this.alphaB = makeFBO(gl, this.W, this.H, gl.R8, gl.RED, gl.UNSIGNED_BYTE);
    // Blur at quarter res: the wide blur comes from ITERATING a small-step blur
    // (below), not from one wide-tap pass, so low res + linear filtering keeps it
    // smooth and cheap.
    this.bw = Math.max(1, this.W >> 2);
    this.bh = Math.max(1, this.H >> 2);
    this.blur1 = makeFBO(gl, this.bw, this.bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
    this.blur2 = makeFBO(gl, this.bw, this.bh, gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE);
  }

  async _loadBg(url) {
    // Cover-fit the image onto a W×H canvas up front so the shader can sample it
    // 1:1 (no aspect math in the composite).
    const img = await new Promise((res, rej) => {
      const im = new Image();
      im.crossOrigin = "anonymous";
      im.onload = () => res(im);
      im.onerror = rej;
      im.src = url;
    });
    const c = document.createElement("canvas");
    c.width = this.W; c.height = this.H;
    const ctx = c.getContext("2d");
    const ir = img.width / img.height, cr = this.W / this.H;
    let dw, dh;
    if (ir > cr) { dh = this.H; dw = dh * ir; } else { dw = this.W; dh = dw / ir; }
    ctx.drawImage(img, (this.W - dw) / 2, (this.H - dh) / 2, dw, dh);
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texBg);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, c);
  }

  _drawQuad(prog) {
    const gl = this.gl;
    gl.useProgram(prog.program);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.quad);
    gl.enableVertexAttribArray(prog.a_pos);
    gl.vertexAttribPointer(prog.a_pos, 2, gl.FLOAT, false, 0, 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  _uploadVideo() {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.video);
  }

  _uploadMask(mask) {
    const f32 = mask.getAsFloat32Array();
    const mw = mask.width, mh = mask.height;
    const u8 = this._maskBuf && this._maskBuf.length === f32.length ? this._maskBuf : (this._maskBuf = new Uint8Array(f32.length));
    for (let i = 0; i < f32.length; i++) u8[i] = (f32[i] * 255) | 0;
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texMask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, mw, mh, 0, gl.RED, gl.UNSIGNED_BYTE, u8);
  }

  // RVM gives a clean float alpha — solidify the body here, then it flows through
  // the same _render(true) refine (bilateral edge-snap + adaptive temporal + the
  // opacity curve) as the MediaPipe mask.
  _uploadAlpha(alpha, w, h) {
    const u8 = this._maskBuf && this._maskBuf.length === alpha.length ? this._maskBuf : (this._maskBuf = new Uint8Array(alpha.length));
    // Firm up semi-transparent foreground: RVM can read a hand as ~0.5–0.7 alpha,
    // so the background bleeds through it ("see-through hand"). A smoothstep
    // pushes mid/high alpha to solid while keeping a soft edge, and drops faint
    // halos toward 0. [TUNE] LO/HI — raise LO to kill more halo, lower HI to
    // firm harder (risk: thinning fine hair).
    const LO = 0.05, HI = 0.6, span = HI - LO;
    for (let i = 0; i < alpha.length; i++) {
      let a = (alpha[i] - LO) / span;
      a = a <= 0 ? 0 : a >= 1 ? 1 : a * a * (3 - 2 * a); // smoothstep
      u8[i] = (a * 255) | 0;
    }
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.texMask);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, u8);
  }

  // Which model is actually rendering frames right now. Logs once when it
  // changes, and is readable as `processor.activeBackend` for any debug UI.
  _setBackend(name) {
    if (this._backend === name) return;
    this._backend = name;
    console.info(`%c[bg] matting backend → ${name}`, "color:#22d3ee;font-weight:bold");
  }

  get activeBackend() {
    return this._backend;
  }

  // "Where supported": if RVM is consistently too slow, drop back to MediaPipe.
  // Guarded against false trips: the FIRST batch is warmup (model load + cold
  // threads — always slow) and ignored, and it takes TWO consecutive over-budget
  // batches to bail. A single transient batch used to sticky-disable RVM for the
  // whole session, which is what dumped us onto MediaPipe.
  _trackRvmPerf(ms) {
    this._rvmMs.push(ms);
    if (this._rvmMs.length < 12) return;
    const avg = this._rvmMs.reduce((a, b) => a + b, 0) / this._rvmMs.length;
    this._rvmMs = [];
    this._rvmBatches++;
    if (this._rvmBatches === 1) return; // warmup batch — don't judge it
    if (!this._rvmLoggedPerf) {
      this._rvmLoggedPerf = true;
      console.info(`[bg] RVM avg inference ${avg.toFixed(0)}ms (render is decoupled — this is matte freshness, not fps)`);
    }
    if (avg > RVM_SLOW_MS) {
      this._rvmSlowStreak++;
      if (this._rvmSlowStreak >= 2) {
        console.warn(`[rvm] sustained ${avg.toFixed(0)}ms > ${RVM_SLOW_MS}ms — MediaPipe for the rest of this session`);
        this._rvmSlow = true;
        rvmDisabledForSession = true; // don't re-probe on the next camera toggle
        try { this._rvm?.close(); } catch { /* */ }
      }
    } else {
      this._rvmSlowStreak = 0;
    }
  }

  _render(refineMask = true) {
    const gl = this.gl;

    // Alpha source. Both backends now go through the bilateral edge-snap: it
    // pulls the matte onto the CURRENT frame's edges, which is what re-aligns a
    // matte that's a few frames stale (inference trails the live video) so the
    // background can't bleed through a moving edge. The temporal blend used to
    // ghost a fast hand when it ran at the ~18fps inference rate; now that we
    // render every frame (~60fps) the inter-frame motion is tiny, so it just
    // smooths edge shimmer. RVM passes a clean matte in; MediaPipe a rough one —
    // the same refine suits both.
    let alphaTex;
    if (refineMask) {
      const curr = this.alphaA, prev = this.alphaB;
      gl.bindFramebuffer(gl.FRAMEBUFFER, curr.fbo);
      gl.viewport(0, 0, this.W, this.H);
      gl.useProgram(this.pRefine.program);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texMask);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
      gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, prev.tex);
      gl.uniform1i(uni(gl, this.pRefine, "u_mask"), 0);
      gl.uniform1i(uni(gl, this.pRefine, "u_guide"), 1);
      gl.uniform1i(uni(gl, this.pRefine, "u_prev"), 2);
      gl.uniform2f(uni(gl, this.pRefine, "u_texel"), 1 / this.W, 1 / this.H);
      gl.uniform1f(uni(gl, this.pRefine, "u_hasPrev"), this._hasPrev);
      this._drawQuad(this.pRefine);
      alphaTex = curr.tex;
      this.alphaA = prev;
      this.alphaB = curr;
      this._hasPrev = 1;
    } else {
      alphaTex = this.texMask; // RVM alpha, used directly
    }

    // 2) background source
    let bgTex;
    if (this.opts.mode === "image") {
      bgTex = this.texBg;
    } else {
      // Bleed-free blur. First build a PREMULTIPLIED background (rgb=video×(1-α),
      // a=1-α) so the blur averages only background pixels — the foreground's
      // colour no longer smears into a halo around the person (the main thing
      // that looked worse than a depth blur). Then iterate a small-step separable
      // gaussian at quarter res (tap spacing fixed + small + low res = smooth, no
      // banding; the composite un-premultiplies rgb/a).
      const STEP = 1.25;
      const iters = Math.min(12, Math.max(1, Math.round(this.opts.blurRadius / 3)));
      gl.viewport(0, 0, this.bw, this.bh);

      // premult (video + alpha) → blur2 (1/4 res, downsampled by linear sampling)
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.blur2.fbo);
      gl.useProgram(this.pPremult.program);
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
      gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, alphaTex);
      gl.uniform1i(uni(gl, this.pPremult, "u_video"), 0);
      gl.uniform1i(uni(gl, this.pPremult, "u_alpha"), 1);
      this._drawQuad(this.pPremult);

      gl.useProgram(this.pBlur.program);
      gl.uniform1i(uni(gl, this.pBlur, "u_src"), 0);
      let read = this.blur2.tex;
      for (let i = 0; i < iters; i++) {
        // horizontal: read → blur1
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.blur1.fbo);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, read);
        gl.uniform2f(uni(gl, this.pBlur, "u_dir"), STEP / this.bw, 0);
        this._drawQuad(this.pBlur);
        // vertical: blur1 → blur2
        gl.bindFramebuffer(gl.FRAMEBUFFER, this.blur2.fbo);
        gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.blur1.tex);
        gl.uniform2f(uni(gl, this.pBlur, "u_dir"), 0, STEP / this.bh);
        this._drawQuad(this.pBlur);
        read = this.blur2.tex;
      }
      bgTex = this.blur2.tex; // RGBA premultiplied; composite divides rgb/a
    }

    // 3) composite → canvas
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);
    gl.useProgram(this.pComposite.program);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texVideo);
    gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, bgTex);
    gl.activeTexture(gl.TEXTURE2); gl.bindTexture(gl.TEXTURE_2D, alphaTex);
    gl.uniform1i(uni(gl, this.pComposite, "u_video"), 0);
    gl.uniform1i(uni(gl, this.pComposite, "u_bg"), 1);
    gl.uniform1i(uni(gl, this.pComposite, "u_alpha"), 2);
    gl.uniform1f(uni(gl, this.pComposite, "u_lightWrap"), 0.15); // [TUNE] subtle now the bg is bleed-free
    this._drawQuad(this.pComposite);
  }

  // Render and inference run at INDEPENDENT rates (the Google-Meet trick):
  //   • Inference (RVM worker / MediaPipe) runs in the background, one in flight,
  //     and only refreshes the matte texture (texMask) when it finishes.
  //   • Rendering runs EVERY frame at display rate against the LIVE video, and
  //     the guided bilateral pass (_render(true)) snaps that slightly-stale matte
  //     onto the current frame's edges.
  // Coupling them (the old code) meant the whole output ran at the ~15–20fps
  // inference rate (the lag) AND composited a frame-N matte over the frame-N+4
  // live video (the background bleeding through a moving head). Decoupling fixes
  // both: the picture moves at 60fps and the matte re-aligns to where you are now.
  _loop() {
    if (!this._running) return;
    this._raf = requestAnimationFrame(() => this._loop());
    const v = this.video;
    if (!v || v.readyState < 2) return;
    const now = performance.now();

    // 1) Kick a fresh matte in the background — only when none is in flight, so
    //    it runs as fast as the backend allows without ever blocking the render.
    if (!this._busy) {
      if (this._rvm && this._rvm.ready && !this._rvmSlow) {
        this._busy = true;
        this._rvm.infer(v).then((res) => {
          this._busy = false;
          if (!this._running) return;
          if (res) {
            this._trackRvmPerf(res.ms);
            try { this._uploadAlpha(res.alpha, res.width, res.height); this._haveMask = 1; this._setBackend("RVM"); } catch { /* */ }
          } else if (this._rvm?.dead) {
            this._rvm = null; // worker fell over → MediaPipe takes over below
          }
        }).catch(() => { this._busy = false; });
      } else if (this.segmenter) {
        this._busy = true;
        this._ts = Math.max(this._ts + 1, Math.round(now));
        try {
          this.segmenter.segmentForVideo(v, this._ts, (result) => {
            this._busy = false;
            try {
              if (!this._running) return;
              const mask = result?.confidenceMasks?.[0];
              if (mask) { this._uploadMask(mask); this._haveMask = 1; this._setBackend("MediaPipe"); }
            } catch { /* skip */ } finally {
              try { result?.close?.(); } catch { /* */ }
            }
          });
        } catch { this._busy = false; }
      }
    }

    // 2) Render at ~display rate (≤~60fps; guards against 120Hz ProMotion). Live
    //    video each frame; _render(true) edge-snaps the latest matte onto it.
    if (this._haveMask && now - this._lastRender >= 15) {
      this._lastRender = now;
      try { this._uploadVideo(); this._render(true); } catch { /* skip this frame */ }
    }
  }
}

export function createRefinedBackgroundProcessor(opts) {
  return new RefinedBackgroundProcessor(opts);
}
