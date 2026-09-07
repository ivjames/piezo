/* The agent bridge: turns a plain-English description of a sound into a cue
   program that satisfies docs/CONTRACT.md.

   The API key lives here and only here -- it is read from the environment on
   the server and never sent to the browser. */
import Anthropic from '@anthropic-ai/sdk';
import { HttpError } from './library.mjs';
import { cost } from './pricing.mjs';

export const DEFAULT_MODEL = process.env.SOUNDBOARD_MODEL || 'claude-opus-5';

const SYSTEM = `You write Web Audio synthesis programs for game sound cues.

# The contract

You return the BODY of this function:

    (ctx, t0, out, p) => endTime

- ctx  a BaseAudioContext. It may be an AudioContext (live) or an
       OfflineAudioContext (rendering to a file, or measurement). Your code
       must behave identically in both.
- t0   the absolute start time on ctx's clock. EVERY scheduled event must be
       expressed relative to t0.
- out  the destination AudioNode. Connect your output chain to it and to
       nothing else. Never touch ctx.destination.
- p    an object holding the parameters you declare, always fully populated.
- return the absolute time the cue has finished sounding (>= t0).

# Rules

1. Self-contained. No imports, no helpers from outside, no globals.
2. Schedule, never wait. Do not read ctx.currentTime. No timers of any kind.
   Nothing before t0: every time you pass to a node or an AudioParam must be
   t0 or later, at every value the parameters can take. Measurement renders
   with t0 = 0, so t0 - 0.01 is a negative time and throws.
3. Deterministic apart from explicit noise. Math.random() is allowed ONLY to
   fill a noise buffer. Pitches, times, levels and envelopes must be a pure
   function of p.
4. Every source node gets both .start(t) and .stop(t).
5. Total length under 10 seconds. Peak below 0 dBFS; aim for about -6 dBFS.
6. exponentialRampToValueAtTime can never reach or cross zero -- ramp to
   0.0001 and then setValueAtTime(0, ...), or use setTargetAtTime.
7. Return the end time, including any release tail you scheduled.

# Available

createOscillator, createGain, createBiquadFilter, createWaveShaper,
createDelay, createConvolver, createDynamicsCompressor, createStereoPanner,
createChannelMerger, createChannelSplitter, createConstantSource,
createIIRFilter, createPeriodicWave, createBuffer, createBufferSource, and the
AudioParam scheduling methods. Math, Float32Array, Array, Number, JSON.

# Forbidden (these identifiers are shadowed with undefined at compile time)

fetch, XMLHttpRequest, WebSocket, document, window, navigator, localStorage,
setTimeout, setInterval, requestAnimationFrame, Worker, AudioWorklet,
new Function, require, dynamic import, MediaElement and MediaStream sources.

# Parameters

Declare 2 to 5 parameters -- the knobs that actually matter for this sound
(fundamental pitch, body, brightness, decay, impact hardness), not every
constant in the code. Each is {key,label,min,max,step,default,unit}; key must
be a JavaScript identifier and the body reads it as p.key. Ranges must be
usable end to end: every value in [min,max] should produce a sound that still
works, not silence or a blown-out mess.

# Craft

Model the physical thing, do not just play a tone. A door slam is a mass
stopping (a low thud with a fast pitch drop) plus latch and rattle (filtered
noise transients) plus the room it happened in (a decaying tail, or a short
delay if it is down a corridor). Coins are several detuned high modes with
fast decays, scattered a few milliseconds apart, each landing dead because
stone does not ring. Comment the code the way you would comment a synth patch:
say what each stage is modelling, not what the API call does.

Prefer short cues. Most game cues are 80 to 400 ms.

# Worked example -- "1-bit PC-speaker alert beep"

    // The IBM PC speaker is one square wave through a ~1 inch piezo disc:
    // no volume control (the gate is a switch, not a fader) and almost no
    // output below 400 Hz, which is what makes it sound thin and nasal.
    const osc = ctx.createOscillator();
    osc.type = 'square';

    const drive = ctx.createGain();      // slam the clipper so the band-limited
    drive.gain.value = 12;               // oscillator gets its hard edges back
    const clip = ctx.createWaveShaper();
    const curve = new Float32Array(1024);
    for (let i = 0; i < curve.length; i++) {
      const x = (i / (curve.length - 1)) * 2 - 1;
      curve[i] = Math.max(-1, Math.min(1, x * 12));
    }
    clip.curve = curve;

    const gate = ctx.createGain();       // the speaker is on or off
    gate.gain.value = 0;

    const hp = ctx.createBiquadFilter(); // the transducer's missing bottom end
    hp.type = 'highpass'; hp.frequency.value = 380;
    const res = ctx.createBiquadFilter();// and its resonant peak
    res.type = 'peaking'; res.frequency.value = 3300; res.Q.value = 3.2;
    res.gain.value = 13;

    osc.connect(drive); drive.connect(clip); clip.connect(gate);
    gate.connect(hp); hp.connect(res); res.connect(out);

    let t = t0;
    for (let i = 0; i < p.beeps; i++) {
      osc.frequency.setValueAtTime(p.freq * (i ? 1.5 : 1), t);
      gate.gain.setValueAtTime(p.level, t);
      gate.gain.setValueAtTime(0, t + p.dur);
      t += p.dur + p.gap;
    }
    osc.start(t0);
    osc.stop(t + 0.01);
    return t;

with params: freq 400..2000 default 880 Hz, dur 0.02..0.30 default 0.09 s,
gap 0..0.20 default 0.03 s, beeps 1..4 default 2, level 0.05..0.6 default 0.25.

# Worked example -- "small wooden box dropped on a stone floor"

    // Impact = a click of broadband noise (the two surfaces meeting) plus a
    // few wooden modes that ring briefly and die. Stone gives nothing back,
    // so there is no tail beyond the box itself.
    const noise = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * 0.05), ctx.sampleRate);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;

    const src = ctx.createBufferSource();
    src.buffer = noise;
    const nbp = ctx.createBiquadFilter();          // the click's colour
    nbp.type = 'bandpass'; nbp.frequency.value = 1800 * p.hardness; nbp.Q.value = 0.8;
    const nenv = ctx.createGain();
    nenv.gain.setValueAtTime(0.9 * p.level, t0);   // a click has no attack
    nenv.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.03);
    src.connect(nbp); nbp.connect(nenv); nenv.connect(out);
    src.start(t0); src.stop(t0 + 0.05);

    // Wooden modes: inharmonic, and the higher ones die first.
    const modes = [1, 2.41, 3.77];
    let end = t0 + 0.05;
    for (let i = 0; i < modes.length; i++) {
      const osc = ctx.createOscillator();
      osc.type = 'triangle';
      osc.frequency.setValueAtTime(p.pitch * modes[i], t0);
      const g = ctx.createGain();
      const decay = p.decay / (i + 1);
      g.gain.setValueAtTime(0, t0);
      g.gain.linearRampToValueAtTime(p.level / (i + 1.5), t0 + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.002 + decay);
      osc.connect(g); g.connect(out);
      osc.start(t0); osc.stop(t0 + 0.01 + decay);
      end = Math.max(end, t0 + 0.01 + decay);
    }
    return end;

with params: pitch 60..400 default 180 Hz, decay 0.05..0.8 default 0.22 s,
hardness 0.5..2 default 1, level 0.1..0.9 default 0.5.

# Output

Return name (2-4 words, Title Case), description (one sentence saying what is
being modelled), params, and code -- the function body only. No markdown
fences, no wrapper function, no \`return function\` and no explanation outside
the JSON.`;

const SCHEMA = {
  type: 'object',
  properties: {
    name: { type: 'string', description: 'Short Title Case name, 2-4 words.' },
    description: { type: 'string', description: 'One sentence on what is modelled.' },
    params: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'JavaScript identifier, read as p.key.' },
          label: { type: 'string' },
          min: { type: 'number' },
          max: { type: 'number' },
          step: { type: 'number' },
          default: { type: 'number' },
          unit: { type: 'string', description: 'Hz, s, x, dB, or empty.' },
        },
        required: ['key', 'label', 'min', 'max', 'step', 'default', 'unit'],
        additionalProperties: false,
      },
    },
    code: { type: 'string', description: 'The function body. No fences, no wrapper.' },
  },
  required: ['name', 'description', 'params', 'code'],
  additionalProperties: false,
};

let client = null;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    // .env is read once at startup, so this also fires when a key was added
    // to a file the running process has already read past.
    throw new HttpError(503, 'ANTHROPIC_API_KEY is not set. Put one in .env '
      + '(copy .env.example), then restart the server — .env is read at startup only.');
  }
  if (!client) client = new Anthropic();
  return client;
}

/**
 * Generate or refine a cue.
 * @param {{prompt:string, refine?:string, previous?:object, model?:string}} req
 */
export async function generate(req) {
  const prompt = String(req.prompt || '').trim();
  if (!prompt) throw new HttpError(400, 'prompt is required');
  const model = req.model || DEFAULT_MODEL;

  const messages = [{ role: 'user', content: userTurn(req, prompt) }];
  const body = {
    model,
    max_tokens: 32000,
    system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
    messages,
    output_config: { format: { type: 'json_schema', schema: SCHEMA } },
  };

  // Effort is the cheapest quality lever: thinking tokens bill at the output
  // rate, and on this task they are most of the bill. Haiku 4.5 rejects the
  // parameter outright, so it never sees it.
  if (req.effort && !/haiku/.test(model)) body.output_config.effort = req.effort;

  const message = await send(getClient(), body);

  if (message.stop_reason === 'refusal') {
    throw new HttpError(422, `the model declined this prompt (${message.stop_details?.category || 'unspecified'})`);
  }
  if (message.stop_reason === 'max_tokens') {
    throw new HttpError(502, 'the model ran out of output tokens before finishing the cue');
  }

  const text = message.content.find((b) => b.type === 'text')?.text;
  if (!text) throw new HttpError(502, 'the model returned no text block');

  let data;
  try { data = JSON.parse(text); }
  catch { throw new HttpError(502, 'the model returned text that is not JSON'); }

  const cue = {
    name: String(data.name || 'Untitled').trim(),
    description: String(data.description || '').trim(),
    code: stripFences(String(data.code || '')),
    params: (Array.isArray(data.params) ? data.params : []).map(normalizeParam).filter(Boolean),
    prompt,
  };
  cue.values = Object.fromEntries(cue.params.map((p) => [p.key, p.default]));

  return {
    cue,
    warnings: lint(cue.code),
    usage: usage(message, model),
  };
}

/* Ask with server-side refusal fallbacks; if this deployment does not have the
   beta, fall back to the plain call rather than failing the request. */
async function send(anthropic, body) {
  try {
    const stream = anthropic.beta.messages.stream({
      ...body,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    });
    return await stream.finalMessage();
  } catch (err) {
    if (err?.status !== 400) throw wrap(err);
    console.warn(`[agent] retrying without server-side fallbacks: ${err.message}`);
    try {
      return await anthropic.messages.stream(body).finalMessage();
    } catch (err2) { throw wrap(err2); }
  }
}

function wrap(err) {
  if (err instanceof HttpError) return err;
  const status = err?.status;
  if (status === 401) return new HttpError(401, 'the Anthropic API rejected the key in .env');
  if (status === 429) return new HttpError(429, 'rate limited by the Anthropic API - try again in a moment');
  return new HttpError(502, `Anthropic API error: ${err?.message || err}`);
}

function userTurn(req, prompt) {
  const prev = req.previous;
  if (!req.refine || !prev?.code) {
    return `Write a cue for: ${prompt}`;
  }
  return [
    `This cue was generated for: ${prev.prompt || prompt}`,
    '',
    `Its name is ${JSON.stringify(prev.name || '')} and its current code is:`,
    '',
    prev.code,
    '',
    prev.params?.length ? `Its parameters are: ${JSON.stringify(prev.params)}` : 'It has no parameters.',
    prev.measure ? `\nMeasured offline: peak ${prev.measure.peakDb} dBFS, RMS ${prev.measure.rmsDb} dBFS, `
      + `audible duration ${prev.measure.duration}s, spectral centroid ${prev.measure.centroid} Hz, `
      + `energy by band ${JSON.stringify(
        Object.fromEntries((prev.measure.bands || []).map((b) => [b.name, b.frac])))}.` : '',
    '',
    `Revise it: ${req.refine}`,
    '',
    'Return the complete revised cue, not a diff. Keep what is working, keep the',
    'parameter keys that still apply, and stay inside the contract.',
  ].filter(Boolean).join('\n');
}

function normalizeParam(p) {
  if (!p || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(String(p.key || ''))) return null;
  const min = Number(p.min), max = Number(p.max);
  if (!Number.isFinite(min) || !Number.isFinite(max) || max <= min) return null;
  const def = Number.isFinite(Number(p.default)) ? Number(p.default) : (min + max) / 2;
  return {
    key: String(p.key),
    label: String(p.label || p.key),
    min, max,
    step: Number.isFinite(Number(p.step)) && Number(p.step) > 0 ? Number(p.step) : (max - min) / 100,
    default: Math.min(max, Math.max(min, def)),
    unit: p.unit ? String(p.unit) : '',
  };
}

function stripFences(code) {
  const fenced = code.match(/^\s*```(?:javascript|js)?\n([\s\S]*?)\n```\s*$/);
  return (fenced ? fenced[1] : code).trim();
}

/** Cheap static check for contract violations, surfaced in the UI as warnings. */
export function lint(code) {
  const checks = [
    [/\bctx\s*\.\s*currentTime\b/, 'reads ctx.currentTime - times must come from t0'],
    [/\bctx\s*\.\s*destination\b/, 'connects to ctx.destination instead of out'],
    [/\bsetTimeout|setInterval|requestAnimationFrame\b/, 'uses a timer'],
    [/\bfetch\s*\(|XMLHttpRequest|WebSocket/, 'tries to use the network'],
    [/\bdocument\b|\bwindow\b|\blocalStorage\b/, 'touches the DOM or storage'],
    [/\bnew\s+Function\b|\beval\s*\(/, 'builds code at runtime'],
    [/\bAudioWorklet|createMediaElementSource|createMediaStreamSource/, 'uses a forbidden node type'],
    [/exponentialRampToValueAtTime\s*\(\s*0\s*[,)]/, 'exponential ramp to exactly 0 - this throws'],
  ];
  const out = [];
  for (const [re, msg] of checks) if (re.test(code)) out.push(msg);
  if (!/\breturn\b/.test(code)) out.push('never returns an end time');
  return out;
}

function usage(message, model) {
  const u = message.usage || {};
  return { model, ...cost(u, model) };
}
