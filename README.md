# piezo

A local board for designing game sound cues by prompt, auditioning them,
measuring them, and exporting them as a module a game can drop in.

You type a description — *"heavy oak door slamming shut, heard from down a
corridor"*, *"1-bit PC-speaker alert beep"*, *"coins landing on stone"* — and
Claude writes a Web Audio synthesis program for it. The page runs it, plays it,
renders it offline and shows you what it actually is: peak, RMS, duration, and
where its energy sits in frequency. You move the sliders it declared,
regenerate or refine until it's right, then save it to the library.

The point of the measurements is that you can *see* one cue is 12 dB hotter
than its neighbours, or that a "thud" has no energy below 400 Hz, instead of
guessing by ear.

```
npm install
cp .env.example .env        # then put an Anthropic API key in it
npm start                   # http://127.0.0.1:8971
```

The key stays on the server. It is read from `.env`, used only by
`POST /api/generate`, and never sent to the browser. `.env` is gitignored;
`.env.example` is the only thing committed, and the server binds to
`127.0.0.1`.

Without a key everything except generation works: the seeded library plays,
measures, normalises and exports. That is not just a degraded mode — it is
exactly how the deployed copy runs.

## Local tool, hosted board

The two halves run in different places, and only one of them needs a key:

- **Authoring is local.** You generate and refine cues here, on your own
  machine, and land the keepers in `library/` through a PR.
- **The board is hosted**, at `piezo.lab980.com`, with **no key on the box**.
  It serves what's committed: pads, measurements, sliders, level matching, WAV
  and `export/cues.js`. `/api/generate` answers `503` there and the generate
  buttons are disabled, which is the intended state rather than a fault.

So the hosted copy has nothing to spend and runs no code that isn't in this
repo. `DEPLOY.md` is the runbook.

## The board

| | |
|---|---|
| **fire a cue** | click a pad, or press the key shown on it. Firings are scheduled up front and overlap freely. |
| **generate** | describe a sound, press *generate*. ⌘/Ctrl+Enter works in the box. |
| **refine** | select a cue, type what to change, press *refine selected*. The model gets the current code *and its measurements*, and you get a diff of what changed. |
| **tweak** | every cue declares 2–5 parameters; they become sliders and re-render offline as you move them. No regeneration needed. |
| **read** | the code is on the page, editable, with *apply & re-measure*. |
| **level-match** | *normalise* trims one cue to the target RMS; *match library* does the whole board. Trim is a separate `gain` field, so matching never rewrites the model's code. |
| **export** | *export* writes `export/cues.js` and downloads it; *wav* renders the selected cue to a 16-bit WAV via `OfflineAudioContext`. |

## The contract

Everything agrees on one shape: a cue is the body of

```js
(ctx, t0, out, p) => endTime
```

scheduled entirely up front, self-contained, deterministic apart from explicit
noise, connected only to `out`. The full contract — allowed API surface,
forbidden calls, the parameter declaration, the cue record on disk — is
[`docs/CONTRACT.md`](docs/CONTRACT.md), and it is also most of the system
prompt in `lib/agent.mjs`. Change it in both places or not at all.

## Running model-written code

**The page `eval`s code the model wrote.** That is the mechanism, and it is an
acceptable trade for a tool that runs on your own machine against your own API
key — but it is worth being explicit about:

- Cue bodies are compiled with `new Function`, with the obvious hazards
  (`fetch`, `XMLHttpRequest`, `document`, `window`, `localStorage`, timers,
  `Worker`, `new Function`, …) shadowed as parameters so they evaluate to
  `undefined`. `eval` and `import` cannot be shadowed that way — they are
  reserved words in a parameter list. So this is hazard reduction, not a
  sandbox.
- The code is shown in the UI before you play it, and a cheap static lint
  flags contract violations (reading `ctx.currentTime`, connecting to
  `ctx.destination`, using a timer, network calls) on the generation itself.
- Nothing generated is executed on the server. The server writes files and
  calls the API; it never runs a cue.

If you are pasting in cue code from somewhere other than your own generations,
read it first, the same way you would read any other script you were about to
run in your browser.

## Measurement

Every cue is rendered through `OfflineAudioContext` at 44.1 kHz and measured:

- **peak** and **RMS** in dBFS. RMS is taken over the audible part only, so a
  long silent tail can't flatter a cue.
- **duration** — the last sample above −60 dB relative to peak, compared with
  the end time the cue *claimed*. A cue that under-reports its own length shows
  up as a warning.
- **spectrum** — Welch-averaged, giving a spectral centroid, the loudest bin,
  and the fraction of energy in six bands (`sub` <80 Hz, `low`, `body`, `mid`,
  `high`, `air` >8 kHz). That band strip is the coloured bar on each pad.

The same `public/audio.mjs` does this for the UI, the WAV export and the test
harness, so a number on a pad and a number in a test assertion come from one
code path.

## Verifying

Nothing involved in writing these cues can hear them, so the check is
measurement, not listening:

```
npm test         # headless Chromium, real server, real page
npm run measure  # same, then write the measurements back into library/
```

`test/verify.mjs` starts the actual server, opens the actual page in headless
Chromium with `window.AudioContext` replaced by an `OfflineAudioContext`
subclass, and then:

1. measures a known 1 kHz sine and asserts the engine reports it correctly —
   if the measurement is wrong, everything after it is worthless;
2. renders every cue in the library and asserts each is **audible** (peak above
   −46 dBFS), **unclipped** (below 0 dBFS), of plausible **duration**, and
   returns an end time;
3. fires every cue through the live playback path, which must build its graph
   without throwing;
4. regenerates `export/cues.js` and `import()`s it in Node, asserting it is
   valid JavaScript with a `render()` for every cue;
5. fails on any page error, console error or failed request.

It prints the whole library as a table, which is the fastest way to see the
level spread across the board.

## Export

`export/cues.js` is a self-contained ES module with no dependency on this tool
and no `eval` at game runtime — each cue body is written out as a real method:

```js
import { play, CUES } from './cues.js';

const ctx = new AudioContext();
play(ctx, 'pc-boot');
play(ctx, 'pc-hurt', { gain: 0.5, params: { from: 160 } });
```

`play(ctx, name, opts)` takes `when`, `gain`, `params` and `destination`, and
returns the time the cue finishes. Regenerate it; don't hand-edit it.

## The seeded library

`library/` ships with eleven cues ported from the PC-speaker sound in
[`ivjames/forest`](https://github.com/ivjames/forest): one 1-bit square through
a modelled ~1 inch piezo disc, pitches snapped to what an 8253 divisor can
actually produce. They are a real, already-balanced corpus, so the board isn't
empty on first run — and they show the tool doing its job immediately, since
`pc-key` measures about 25 dB quieter than `pc-win`.

`npm run seed` rewrites them; anything else in `library/` is left alone.

## Layout

```
server.mjs           node:http server + API. Holds the API key.
lib/agent.mjs        the system prompt, the JSON schema, the Anthropic call
lib/library.mjs      library/*.json on disk, one file per cue
lib/exporter.mjs     emits export/cues.js
public/audio.mjs     compile, render, measure, WAV — shared with the tests
public/app.js        the board
docs/CONTRACT.md     the cue contract
test/verify.mjs      the headless check
tools/seed.mjs       the forest PC-speaker corpus
```

## API

| | |
|---|---|
| `POST /api/generate` | `{prompt, refine?, previous?}` → `{cue, warnings, usage}` |
| `POST /api/save` | upsert a cue → `{cue}` |
| `GET /api/library` | `{cues}` |
| `DELETE /api/cue/:id` | remove one |
| `POST /api/measure` | `{measurements:{id: measure}}`, merged in without touching `updatedAt` |
| `POST /api/export` | writes `export/cues.js`, returns the source |
| `GET /api/health` | model, and whether a key is loaded |
