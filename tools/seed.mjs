#!/usr/bin/env node
/* Seeds library/ with the PC-speaker cues from ivjames/forest, ported to the
   cue contract. They are a real, already-balanced corpus: one voice, 1-bit,
   and every one of them measurable -- so the board has something honest on it
   the first time you open it, and the tool starts out tied to a real game.

   Idempotent: rewrites the seed files, leaves anything else in library/ alone.
   Re-run with `npm run seed`. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'library');

/* The hardware, rebuilt per cue so each one stays self-contained. */
const SPEAKER = `// IBM PC speaker: one 1-bit square wave through a ~1 inch piezo disc.
//
// Source: channel 2 of the 8253 divides a 1.193182 MHz clock by an integer, so
// the speaker cannot hit an arbitrary pitch -- it snaps to 1193182/n, and the
// error grows with pitch. One hard square: no volume, no timbre, no second voice.
//
// Transducer: the disc has almost no output below ~400 Hz, a loud resonance
// near 3 kHz and nothing above ~7 kHz. Low notes arrive as harmonics with the
// fundamental missing, which is why a PC-speaker footstep is a buzz, not a thud.
const PIT = 1193182;
const pitch = (f) => PIT / Math.min(65535, Math.max(1, Math.round(PIT / f)));

const osc = ctx.createOscillator();
osc.type = 'square';
osc.frequency.value = 1000;

const drive = ctx.createGain();               // slam the clipper, so the
drive.gain.value = 12;                        // band-limited oscillator gets
const clip = ctx.createWaveShaper();          // real square edges back
const curve = new Float32Array(1024);
for (let i = 0; i < curve.length; i++) {
  const x = (i / (curve.length - 1)) * 2 - 1;
  curve[i] = Math.max(-1, Math.min(1, x * 12));
}
clip.curve = curve;
clip.oversample = '4x';

const gate = ctx.createGain();                // the speaker is a switch: the
gate.gain.value = 0;                          // hardware cannot fade

const hp1 = ctx.createBiquadFilter(); hp1.type = 'highpass'; hp1.frequency.value = 380; hp1.Q.value = 0.7;
const hp2 = ctx.createBiquadFilter(); hp2.type = 'highpass'; hp2.frequency.value = 380; hp2.Q.value = 0.7;
const res = ctx.createBiquadFilter(); res.type = 'peaking'; res.frequency.value = 3300; res.Q.value = 3.2; res.gain.value = 13;
const body = ctx.createBiquadFilter(); body.type = 'peaking'; body.frequency.value = 1050; body.Q.value = 1.4; body.gain.value = 5;
const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 7200; lp.Q.value = 0.8;

const comp = ctx.createDynamicsCompressor();  // a small element, over-driven
comp.threshold.value = -14; comp.knee.value = 6; comp.ratio.value = 10;
comp.attack.value = 0.002; comp.release.value = 0.08;

osc.connect(drive); drive.connect(clip); clip.connect(gate);
gate.connect(hp1); hp1.connect(hp2); hp2.connect(res); res.connect(body);
body.connect(lp); lp.connect(comp); comp.connect(out);

// One note: pitch set, speaker on, speaker off. No ramps anywhere.
const tone = (f, t, d, v) => {
  osc.frequency.setValueAtTime(pitch(f), t);
  gate.gain.setValueAtTime(v, t);
  gate.gain.setValueAtTime(0, t + d);
};
`;

const cue = (id, name, description, params, code, key) => ({
  id, name, description, key,
  prompt: `PC speaker: ${description}`,
  params,
  code: `${SPEAKER}\n${code}\nosc.start(t0);\nosc.stop(end + 0.02);\nreturn end;\n`,
  gain: 1,
});

const P = (key, label, min, max, step, def, unit = '') =>
  ({ key, label, min, max, step, default: def, unit });

const LEVEL = (def) => P('level', 'Level', 0.02, 0.4, 0.005, def, '');

const SEEDS = [
  cue('pc-boot', 'BIOS Boot Beep', 'the single POST beep at power-on',
    [P('freq', 'Pitch', 300, 2000, 1, 784, 'Hz'), P('dur', 'Length', 0.03, 0.5, 0.005, 0.13, 's'), LEVEL(0.10)],
    `tone(p.freq, t0, p.dur, p.level);\nconst end = t0 + p.dur;`, '1'),

  cue('pc-key', 'Key Click', 'the tick a command entry makes',
    [P('freq', 'Pitch', 400, 3000, 10, 1200, 'Hz'), P('dur', 'Length', 0.002, 0.04, 0.001, 0.006, 's'), LEVEL(0.035)],
    `tone(p.freq, t0, p.dur, p.level);\nconst end = t0 + p.dur;`, '2'),

  cue('pc-move', 'Footstep', 'a step taken, buzzing because the disc eats the bottom',
    [P('freq', 'Pitch', 120, 700, 5, 300, 'Hz'), P('dur', 'Length', 0.008, 0.08, 0.002, 0.022, 's'), LEVEL(0.09)],
    `tone(p.freq, t0, p.dur, p.level);\nconst end = t0 + p.dur;`, '3'),

  cue('pc-bump', 'Blocked', 'walking into something solid',
    [P('freq', 'Pitch', 70, 300, 2, 140, 'Hz'), P('dur', 'Length', 0.02, 0.25, 0.005, 0.09, 's'), LEVEL(0.13)],
    `tone(p.freq, t0, p.dur, p.level);\nconst end = t0 + p.dur;`, '4'),

  cue('pc-take', 'Pick Up', 'two rising notes: something acquired',
    [P('freq', 'Pitch', 300, 1200, 5, 659, 'Hz'), P('interval', 'Interval', 1.05, 2.5, 0.01, 1.5, 'x'),
     P('dur', 'Note length', 0.02, 0.2, 0.005, 0.045, 's'), LEVEL(0.07)],
    `tone(p.freq, t0, p.dur, p.level);\ntone(p.freq * p.interval, t0 + p.dur, p.dur, p.level);\nconst end = t0 + p.dur * 2;`, '5'),

  cue('pc-hurt', 'Took Damage', 'a downward sweep, stepped the way a rewritten divisor steps',
    [P('from', 'From', 100, 500, 5, 200, 'Hz'), P('to', 'To', 40, 300, 5, 90, 'Hz'),
     P('dur', 'Length', 0.05, 0.5, 0.01, 0.16, 's'), LEVEL(0.16)],
    `// A sweep on this hardware is the divisor being rewritten every few ms, so
// the pitch climbs in audible steps and the level never moves.
const steps = Math.max(6, Math.round(p.dur / 0.010));
gate.gain.setValueAtTime(p.level, t0);
for (let i = 0; i <= steps; i++) {
  osc.frequency.setValueAtTime(pitch(p.from * Math.pow(p.to / p.from, i / steps)), t0 + p.dur * (i / steps));
}
gate.gain.setValueAtTime(0, t0 + p.dur);
const end = t0 + p.dur;`, '6'),

  cue('pc-bear', 'Bear Roar', 'a falling sweep into a scribble of random divisors',
    [P('from', 'Sweep from', 120, 400, 5, 210, 'Hz'), P('to', 'Sweep to', 40, 200, 5, 70, 'Hz'),
     P('dur', 'Sweep length', 0.1, 0.8, 0.01, 0.34, 's'), P('grains', 'Growl grains', 3, 24, 1, 9, ''),
     LEVEL(0.16)],
    `const steps = Math.max(6, Math.round(p.dur / 0.010));
gate.gain.setValueAtTime(p.level, t0);
for (let i = 0; i <= steps; i++) {
  osc.frequency.setValueAtTime(pitch(p.from * Math.pow(p.to / p.from, i / steps)), t0 + p.dur * (i / steps));
}
gate.gain.setValueAtTime(0, t0 + p.dur);

// "Noise": speaker held on while the divisor is scribbled over at random.
// The randomness is the noise source itself, which is the one place the
// contract allows it.
let t = t0 + p.dur;
gate.gain.setValueAtTime(p.level * 0.7, t);
for (let i = 0; i < p.grains; i++) {
  osc.frequency.setValueAtTime(pitch(60 + Math.random() * 110), t);
  t += 0.03;
}
gate.gain.setValueAtTime(0, t);
const end = t;`, '7'),

  cue('pc-fire', 'Fire Crackle', 'gated random divisors: spits and ticks, not a growl',
    [P('grains', 'Grains', 4, 40, 1, 14, ''), P('lo', 'Low', 200, 1500, 10, 500, 'Hz'),
     P('hi', 'High', 600, 4000, 10, 1500, 'Hz'), P('step', 'Grain spacing', 0.008, 0.06, 0.001, 0.022, 's'),
     LEVEL(0.05)],
    `let t = t0;
for (let i = 0; i < p.grains; i++) {
  // 70% duty: the gaps are what make it read as crackle rather than noise.
  if (Math.random() < 0.7) tone(p.lo + Math.random() * Math.max(0, p.hi - p.lo), t, p.step * 0.6, p.level);
  t += p.step;
}
const end = t;`, '8'),

  cue('pc-flare', 'Flare Launch', 'a long rising sweep',
    [P('from', 'From', 150, 800, 5, 320, 'Hz'), P('to', 'To', 800, 4000, 10, 1900, 'Hz'),
     P('dur', 'Length', 0.1, 1.0, 0.01, 0.42, 's'), LEVEL(0.05)],
    `const steps = Math.max(6, Math.round(p.dur / 0.010));
gate.gain.setValueAtTime(p.level, t0);
for (let i = 0; i <= steps; i++) {
  osc.frequency.setValueAtTime(pitch(p.from * Math.pow(p.to / p.from, i / steps)), t0 + p.dur * (i / steps));
}
gate.gain.setValueAtTime(0, t0 + p.dur);
const end = t0 + p.dur;`, '9'),

  cue('pc-win', 'Victory Fanfare', 'C-E-G-C, the reward arpeggio',
    [P('root', 'Root', 200, 900, 1, 523, 'Hz'), P('dur', 'Note length', 0.05, 0.3, 0.005, 0.12, 's'),
     P('gap', 'Gap', 0, 0.05, 0.001, 0.008, 's'), LEVEL(0.08)],
    `const ratios = [1, 1.26, 1.5, 2];       // major third, fifth, octave
let t = t0;
for (let i = 0; i < ratios.length; i++) {
  const d = i === ratios.length - 1 ? p.dur * 2 : p.dur;   // land on the octave
  tone(p.root * ratios[i], t, d, p.level);
  t += d + p.gap;
}
const end = t;`, '0'),

  cue('pc-lose', 'Death March', 'four descending notes, the last one held',
    [P('root', 'Root', 150, 700, 1, 392, 'Hz'), P('dur', 'Note length', 0.06, 0.4, 0.005, 0.16, 's'),
     P('gap', 'Gap', 0, 0.05, 0.001, 0.008, 's'), LEVEL(0.11)],
    `const ratios = [1, 0.84, 0.67, 0.45];
let t = t0;
for (let i = 0; i < ratios.length; i++) {
  const d = i === ratios.length - 1 ? p.dur * 2.25 : p.dur;
  tone(p.root * ratios[i], t, d, p.level);
  t += d + p.gap;
}
const end = t;`, 'q'),
];

const now = new Date().toISOString();

await fs.mkdir(DIR, { recursive: true });
for (const [i, seed] of SEEDS.entries()) {
  const file = path.join(DIR, `${seed.id}.json`);
  let existing = null;
  try { existing = JSON.parse(await fs.readFile(file, 'utf8')); } catch { /* new */ }
  const record = {
    ...seed,
    order: i,
    values: Object.fromEntries(seed.params.map((p) => [p.key, p.default])),
    measure: existing?.measure || null,     // npm run measure fills these in
    createdAt: existing?.createdAt || now,
    updatedAt: now,
  };
  await fs.writeFile(file, JSON.stringify(record, null, 2) + '\n');
}
console.log(`seeded ${SEEDS.length} cues into ${path.relative(process.cwd(), DIR)}/`);
