/* ---------------------------------------------------------------------------
   The cue engine: compile, render, measure, encode.

   Shared, unchanged, by three callers:
     - the board (live playback + the pad readouts)
     - the WAV exporter
     - test/verify.mjs, which drives this file in a headless browser

   so the numbers on a pad and the numbers a test asserts on come from exactly
   the same code path. See docs/CONTRACT.md for the function contract.
   ------------------------------------------------------------------------ */

export const MAX_SECONDS = 10;
export const RENDER_RATE = 44100;

/* Names shadowed inside a cue body. `eval` and `arguments` cannot legally be
   parameter names in strict mode, and reserved words (`import`) cannot either,
   so those two are out of reach -- which is the honest reason this is hazard
   reduction and not a sandbox (README, "Running model-written code"). */
const SHADOWED = [
  'window', 'document', 'self', 'globalThis', 'top', 'parent', 'frames',
  'navigator', 'location', 'history', 'screen', 'localStorage',
  'sessionStorage', 'indexedDB', 'caches', 'crypto',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'sendBeacon',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask',
  'requestAnimationFrame', 'requestIdleCallback',
  'Function', 'Worker', 'SharedWorker', 'AudioWorklet', 'AudioWorkletNode',
  'postMessage', 'importScripts', 'require', 'process', 'module', 'exports',
];

const compiled = new WeakMap();   // cue object -> { code, fn }

/** Compile a cue body into (ctx, t0, out, p) => endTime. Throws on syntax error. */
export function compile(code) {
  const fn = new Function(
    'ctx', 't0', 'out', 'p', ...SHADOWED,
    '"use strict";\n' + code + '\n',
  );
  return (ctx, t0, out, p) => fn(ctx, t0, out, p);
}

/** Compile with a per-cue cache keyed on the code text. */
export function compileCue(cue) {
  const hit = compiled.get(cue);
  if (hit && hit.code === cue.code) return hit.fn;
  const fn = compile(cue.code);
  compiled.set(cue, { code: cue.code, fn });
  return fn;
}

/** Declared params merged with saved values -- what the body sees as `p`. */
export function paramValues(cue, override) {
  const p = {};
  for (const d of cue.params || []) p[d.key] = d.default;
  Object.assign(p, cue.values || {}, override || {});
  return p;
}

/**
 * Schedule one firing of a cue onto a live context.
 * Returns the end time; the caller owns `out`.
 */
export function fire(cue, ctx, out, opts = {}) {
  const fn = compileCue(cue);
  const t0 = opts.when ?? ctx.currentTime + 0.015;
  const end = fn(ctx, t0, out, paramValues(cue, opts.params));
  const n = Number(end);
  return Number.isFinite(n) && n >= t0 ? n : t0 + 0.25;
}

/**
 * Render a cue offline. Always renders MAX_SECONDS and then trims: a cue that
 * lies about its end time still gets measured on what it actually produced.
 * Applies cue.gain, so what you measure is what you hear.
 */
export async function render(cue, opts = {}) {
  const rate = opts.sampleRate || RENDER_RATE;
  const seconds = Math.min(MAX_SECONDS, opts.seconds || MAX_SECONDS);
  const Offline = opts.OfflineAudioContext || globalThis.OfflineAudioContext;
  const ctx = new Offline(1, Math.ceil(rate * seconds), rate);

  const trim = ctx.createGain();
  trim.gain.value = opts.gain ?? cue.gain ?? 1;
  trim.connect(ctx.destination);

  const fn = compile(cue.code);
  const declaredEnd = fn(ctx, 0, trim, paramValues(cue, opts.params));
  const buffer = await ctx.startRendering();
  return {
    buffer,
    declaredDuration: Number.isFinite(declaredEnd) ? Math.max(0, declaredEnd) : null,
  };
}

/* --- measurement --------------------------------------------------------- */

export const BANDS = [
  { name: 'sub',  lo: 0,    hi: 80 },
  { name: 'low',  lo: 80,   hi: 250 },
  { name: 'body', lo: 250,  hi: 800 },
  { name: 'mid',  lo: 800,  hi: 2500 },
  { name: 'high', lo: 2500, hi: 8000 },
  { name: 'air',  lo: 8000, hi: Infinity },
];

export const dB = (x) => (x > 1e-9 ? 20 * Math.log10(x) : -Infinity);
export const fromDb = (db) => Math.pow(10, db / 20);

/**
 * Peak, RMS, audible duration and where the energy sits.
 *
 * `duration` is the audible length: the last sample above -60 dB relative to
 * the peak, not the length of the buffer and not what the cue claimed.
 */
export function measure(buffer, declaredDuration = null) {
  const x = buffer.getChannelData(0);
  const rate = buffer.sampleRate;

  let peak = 0;
  for (let i = 0; i < x.length; i++) { const a = Math.abs(x[i]); if (a > peak) peak = a; }

  const floor = peak * fromDb(-60);
  let last = -1, first = -1;
  for (let i = 0; i < x.length; i++) {
    if (Math.abs(x[i]) > floor) { if (first < 0) first = i; last = i; }
  }
  const duration = last < 0 ? 0 : (last + 1) / rate;
  const onset = first < 0 ? 0 : first / rate;

  // RMS over the audible part only, so a long silent tail cannot flatter a cue.
  const end = last < 0 ? 0 : last + 1;
  let sum = 0;
  for (let i = 0; i < end; i++) sum += x[i] * x[i];
  const rms = end ? Math.sqrt(sum / end) : 0;

  const spec = spectrum(x, rate, end || x.length);

  return {
    peak, peakDb: round(dB(peak), 2),
    rms, rmsDb: round(dB(rms), 2),
    duration: round(duration, 4),
    onset: round(onset, 4),
    declaredDuration: declaredDuration == null ? null : round(declaredDuration, 4),
    centroid: Math.round(spec.centroid),
    peakFreq: Math.round(spec.peakFreq),
    bands: spec.bands,
    sampleRate: rate,
    clipped: peak >= 0.999,
  };
}

const round = (v, n) => (Number.isFinite(v) ? Number(v.toFixed(n)) : v);

/** Welch-averaged magnitude spectrum -> centroid, peak bin, band fractions. */
export function spectrum(x, rate, length = x.length) {
  const N = 2048;
  const hop = N / 2;
  const mag = new Float64Array(N / 2);
  const win = new Float64Array(N);
  for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

  const re = new Float64Array(N), im = new Float64Array(N);
  let frames = 0;
  for (let start = 0; start + N <= Math.max(length, N); start += hop) {
    for (let i = 0; i < N; i++) { re[i] = (x[start + i] || 0) * win[i]; im[i] = 0; }
    fft(re, im);
    for (let k = 0; k < N / 2; k++) mag[k] += Math.hypot(re[k], im[k]);
    frames++;
    if (start + N > length) break;
  }
  if (!frames) frames = 1;

  let total = 0, weighted = 0, peakFreq = 0, peakMag = 0;
  const bandSums = BANDS.map(() => 0);
  for (let k = 1; k < N / 2; k++) {
    const m = mag[k] / frames;
    const f = (k * rate) / N;
    total += m;
    weighted += m * f;
    if (m > peakMag) { peakMag = m; peakFreq = f; }
    for (let b = 0; b < BANDS.length; b++) {
      if (f >= BANDS[b].lo && f < BANDS[b].hi) { bandSums[b] += m; break; }
    }
  }
  return {
    centroid: total ? weighted / total : 0,
    peakFreq,
    // Averaged magnitudes, for drawing. measure() keeps only the summary.
    mag, frames, binHz: rate / N,
    bands: BANDS.map((b, i) => ({
      name: b.name, lo: b.lo, hi: b.hi === Infinity ? null : b.hi,
      frac: round(total ? bandSums[i] / total : 0, 4),
    })),
  };
}

/** In-place iterative radix-2 FFT. `re.length` must be a power of two. */
export function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const vr = re[i + k + len / 2] * cr - im[i + k + len / 2] * ci;
        const vi = re[i + k + len / 2] * ci + im[i + k + len / 2] * cr;
        re[i + k] = ur + vr; im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr; im[i + k + len / 2] = ui - vi;
        const nr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = nr;
      }
    }
  }
}

/** The averaged magnitude spectrum of a rendered buffer, for the spectrum view. */
export function spectrumOf(buffer) {
  return spectrum(buffer.getChannelData(0), buffer.sampleRate);
}

/** Render + measure in one step. */
export async function renderAndMeasure(cue, opts = {}) {
  const { buffer, declaredDuration } = await render(cue, opts);
  return { buffer, measure: measure(buffer, declaredDuration) };
}

/* --- level matching ------------------------------------------------------ */

/**
 * The gain that would put this cue at `targetRmsDb`, clamped so the peak stays
 * below `ceilingDb`. Returns the absolute cue.gain to store, given that `m`
 * was measured with `currentGain` already applied.
 */
export function matchGain(m, targetRmsDb = -20, currentGain = 1, ceilingDb = -1) {
  if (!(m.rms > 0)) return currentGain;
  const wanted = currentGain * (fromDb(targetRmsDb) / m.rms);
  const ceiling = m.peak > 0 ? currentGain * (fromDb(ceilingDb) / m.peak) : wanted;
  return round(Math.min(wanted, ceiling), 4);
}

/* --- WAV ----------------------------------------------------------------- */

/** 16-bit mono PCM WAV of the audible part of a rendered buffer. */
export function toWav(buffer, { seconds = null, padding = 0.03 } = {}) {
  const rate = buffer.sampleRate;
  const src = buffer.getChannelData(0);
  const n = seconds
    ? Math.min(src.length, Math.ceil((seconds + padding) * rate))
    : src.length;

  const bytes = new ArrayBuffer(44 + n * 2);
  const view = new DataView(bytes);
  const ascii = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };

  ascii(0, 'RIFF');
  view.setUint32(4, 36 + n * 2, true);
  ascii(8, 'WAVE');
  ascii(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);          // PCM
  view.setUint16(22, 1, true);          // mono
  view.setUint32(24, rate, true);
  view.setUint32(28, rate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) {
    const s = Math.max(-1, Math.min(1, src[i]));
    view.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true);
  }
  return bytes;
}
