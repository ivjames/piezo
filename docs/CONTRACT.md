# The cue contract

Everything in this tool — the generator, the board, the measurement pass, the
exported module — agrees on one thing: **a cue is the body of a function.**

```js
(ctx, t0, out, p) => endTime
```

| argument | what it is |
|---|---|
| `ctx`  | a `BaseAudioContext`. Live playback passes an `AudioContext`; measurement, WAV export and the test harness pass an `OfflineAudioContext`. Code that works in one must work in the other. |
| `t0`   | absolute start time, in `ctx`'s clock. **Every** scheduled event must be expressed relative to `t0`. |
| `out`  | the destination `AudioNode`. The cue connects its output here and nowhere else. |
| `p`    | a plain object of the cue's declared parameters, always fully populated. |
| return | the absolute time the cue has finished sounding (`>= t0`). |

## Rules

1. **Self-contained.** No imports, no globals, no helpers from outside the body.
   Everything the cue needs, it builds.
2. **Schedule, don't wait.** Never read `ctx.currentTime`, never use timers.
   Times come from `t0` and `p` only. The same call rendered offline at 100×
   real time must produce the same samples as live playback.
3. **Deterministic apart from explicit noise.** `Math.random()` is allowed *only*
   for filling noise buffers. Pitches, times, levels and envelopes must be a
   pure function of `p`.
4. **Everything stops.** Every source node gets both `.start(t)` and `.stop(t)`,
   with the stop time at or before the returned end time (plus release tail).
5. **Connect to `out`.** Not to `ctx.destination`. The board puts a per-cue gain
   and a master gain downstream of `out`.
6. **Stay under 10 seconds** and **under 0 dBFS.** Aim for a peak around
   −6 dBFS; the board measures and will tell you when you missed.
7. **Return the end time.** The board uses it for scheduling, the exporter for
   its `duration` field.

## Allowed API surface

`createOscillator`, `createGain`, `createBiquadFilter`, `createWaveShaper`,
`createDelay`, `createConvolver`, `createDynamicsCompressor`,
`createStereoPanner`, `createPanner`, `createChannelMerger`,
`createChannelSplitter`, `createConstantSource`, `createIIRFilter`,
`createPeriodicWave`, `createBuffer`, `createBufferSource`; the `AudioParam`
methods (`setValueAtTime`, `linearRampToValueAtTime`,
`exponentialRampToValueAtTime`, `setTargetAtTime`, `setValueCurveAtTime`,
`cancelScheduledValues`); `Math`, `Float32Array`, `Array`, `Number`, `String`,
`JSON`.

## Forbidden

Network (`fetch`, `XMLHttpRequest`, `WebSocket`), the DOM (`document`,
`window`, `navigator`, `location`), storage, timers (`setTimeout`,
`setInterval`, `requestAnimationFrame`), `Worker` / `AudioWorklet` /
`postMessage`, `new Function`, dynamic `import`, `require`, `MediaElement` and
`MediaStream` sources.

These names are shadowed with `undefined` when the body is compiled, so a cue
that reaches for one gets a `TypeError` rather than an effect. This is hazard
reduction, not a sandbox — see the security note in the README.

## Parameters

A cue declares 0–6 parameters. Each is:

```json
{ "key": "thump", "label": "Thump", "min": 40, "max": 220,
  "step": 1, "default": 90, "unit": "Hz" }
```

`key` must be a valid JS identifier. The body reads `p.thump`. The board turns
each declaration into a slider, so a saved cue is tweakable without going back
to the model. Parameters should be the two or three knobs that actually matter
for the cue — pitch, body, brightness, decay — not every constant in the code.

## The cue record

A saved cue is one JSON file in `library/`:

```json
{
  "id": "pc-boot",
  "name": "BIOS Boot Beep",
  "description": "The single 784 Hz post beep of an IBM PC.",
  "prompt": "the one beep a PC makes at power-on",
  "code": "const osc = ctx.createOscillator(); ... return t0 + dur;",
  "params": [ ... ],
  "values": { "freq": 784, "dur": 0.13 },
  "gain": 1,
  "key": "1",
  "measure": { "peak": 0.42, "peakDb": -7.5, "rms": 0.09, "rmsDb": -20.9,
               "duration": 0.14, "declaredDuration": 0.13,
               "centroid": 2870, "peakFreq": 3210,
               "bands": [ { "name": "sub", "lo": 0, "hi": 80, "frac": 0.001 }, ... ] },
  "createdAt": "2026-09-07T00:00:00.000Z",
  "updatedAt": "2026-09-07T00:00:00.000Z"
}
```

`values` holds the current slider positions (defaults until you move them).
`gain` is the level-matching trim applied downstream of the cue body — that is
what "normalise" writes, so normalising never rewrites the model's code.
`measure` is filled in by the measurement pass (`npm run measure`) and is what
the pad displays.

## Worked example

```js
// "1-bit PC-speaker alert beep"
const osc = ctx.createOscillator();
osc.type = 'square';
const clip = ctx.createWaveShaper();
const curve = new Float32Array(1024);
for (let i = 0; i < curve.length; i++) {
  const x = (i / (curve.length - 1)) * 2 - 1;
  curve[i] = Math.max(-1, Math.min(1, x * 12));
}
clip.curve = curve;
const gate = ctx.createGain();
gate.gain.value = 0;                       // the speaker is a switch, not a fader
const lp = ctx.createBiquadFilter();
lp.type = 'lowpass'; lp.frequency.value = 7200;

osc.connect(clip); clip.connect(gate); gate.connect(lp); lp.connect(out);

let t = t0;
for (let i = 0; i < 2; i++) {
  osc.frequency.setValueAtTime(p.freq * (i ? 1.5 : 1), t);
  gate.gain.setValueAtTime(p.level, t);
  gate.gain.setValueAtTime(0, t + p.dur);
  t += p.dur + 0.02;
}
osc.start(t0);
osc.stop(t + 0.01);
return t;
```
