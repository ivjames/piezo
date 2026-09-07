# piezo

A local board for designing game sound cues by prompt, auditioning them,
measuring them, and taking them away — as WAVs, or as a module a game can drop
in. The library is a library, not one game's sound set: cues are grouped into
named **playlists**, and any playlist downloads on its own.

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

## Hosted

It also runs at `piezo.lab980.com`, on the lab980 droplet, with its own key in
`/var/www/piezo/.env` — so the hosted board generates too. `DEPLOY.md` is the
runbook. Cues saved there live in that checkout's `library/`; cues you want in
the repo still arrive by PR.

## The board

| | |
|---|---|
| **fire a cue** | click a pad, or press the key shown on it. Firings are scheduled up front and overlap freely. |
| **generate** | describe a sound, press *generate*. ⌘/Ctrl+Enter works in the box. |
| **refine** | select a cue, type what to change, press *refine selected*. The model gets the current code *and its measurements*, and you get a diff of what changed. |
| **tweak** | every cue declares 2–5 parameters; they become sliders and re-render offline as you move them. No regeneration needed. |
| **read** | the code is on the page, editable, with *apply & re-measure*. |
| **level-match** | *normalise* trims one cue to the target RMS; *match library* does the whole board. Trim is a separate `gain` field, so matching never rewrites the model's code. |
| **group** | playlist chips above the pads filter the board; the search box narrows further. A cue's playlists are toggled in the inspector, one click each. |
| **download** | *download wavs* zips the active set as 16-bit WAVs with a manifest; *download module* writes that set as a drop-in ES module. |
| **export** | *export* writes the whole-library `export/cues.js` and downloads it; *wav* renders the selected cue to a single WAV. |

## Playlists

A playlist is a named set of cue ids in `playlists/<id>.json`:

```json
{
  "id": "pc-speaker",
  "name": "PC speaker",
  "description": "The 1-bit cues ported from ivjames/forest.",
  "cues": ["pc-boot", "pc-key", "pc-move"]
}
```

The cues do not know which sets they are in, which is the point: a cue belongs
to as many playlists as you like, adding one writes a single file — the
playlist's — and nothing about the cue record changes. Same properties as
`library/`: one file per thing, git-diffable, no database.

The chips filter one board rather than switching between boards, so the pads
stay a single grid and a key binding fires its cue whether or not the current
filter is showing it. Deleting a cue takes it out of every playlist holding
it; deleting a playlist leaves its cues alone.

Two things leave the board, and both take the active set — the playlist, or
the whole library — rather than whatever the search box is narrowing to:

- **download wavs** — a zip of 16-bit mono WAVs, one per cue, plus a
  `manifest.txt` of names, durations and levels. Rendered through the same
  `OfflineAudioContext` path the pads are measured with, so the file is what
  the numbers describe. The zip is written by `public/zip.mjs`: stored
  entries, no compression, no dependency.
- **download module** — that set as `export/<id>.cues.js`, the same drop-in
  module as `export/cues.js` with only those cues in it.

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
5. round-trips a playlist through the API and asserts the per-playlist module
   is exactly that set in that order, that a cue id with no cue behind it is
   skipped rather than emitted, that the board's filter and search agree, and
   that deleting a cue prunes it from the playlists holding it;
6. zips two rendered cues, takes the archive back apart in Node — central
   directory, local headers, a CRC recomputed bit by bit rather than with the
   writer's own table — and asserts every entry survives byte for byte;
7. renders a cue that schedules an event before `t0` — legal-looking live,
   fatal offline — and asserts the board explains the browser's message and
   drops the bake-off verdict to `threw` rather than leaving a stale `pass`
   over the top of the exception;
8. fails on any page error, console error or failed request.

It prints the whole library as a table, which is the fastest way to see the
level spread across the board.

## Choosing a model

`SOUNDBOARD_MODEL` picks the default model (`claude-opus-5`). Which one is
worth paying for is a question this tool answers by measurement and by ear,
not by opinion — and it answers it **on the board**:

Put one prompt per line in the box, tick the models, optionally pick an
effort, press **bake off**. Each cell is generated and measured as it lands,
and you get a row per prompt with a pad per model. No terminal, no round trip.

There is also a headless runner for scripted or repeatable comparisons, which
writes a JSON run the board can load with *load*:

```
npm run bakeoff -- --dry-run                  # plan and cost estimate, no calls
npm run bakeoff                               # opus 5 / sonnet 5 / haiku 4.5
npm run bakeoff -- --models claude-opus-5 --effort low,high
npm run bakeoff -- --from bakeoff/<run>.json  # re-measure a past run, free
```

It generates the same prompt set on each model, renders every candidate
through the same `OfflineAudioContext` engine the board uses, and prints cost
against outcome — plus a per-model line of clean/usable cues and dollars per
usable cue.

**Then listen to it.** A table can tell you a candidate is 6 dB hot or has
nothing below 400 Hz; it cannot tell you the door slam sounds like a stapler.
Every run is saved to `bakeoff/`, and the board loads one: pick it in the
**bake-off** panel and press *load*. You get a row per prompt and a pad per
model — `▶ all` fires that row's candidates back to back with a beat between
them, clicking one loads it into the inspector with its waveform, spectrum and
code, and *keep* promotes the winner into the library. Reviewing a comparison
by ear is the point; the numbers are there to tell you where to listen.

Two things it will not tell you: whether a "thud" *sounds* like a thud (that's
the centroid column and your ears), and anything about Haiku at a given effort
level — Haiku 4.5 rejects `effort`, so it runs unset and the grid skips those
cells rather than reporting a number it didn't measure.

Prices move. `lib/pricing.mjs` carries the per-model rates, including the
cache-read discount, which matters here: the ~1.85k-token system prompt is
cached, so most input on a warm run bills at a tenth.

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

It also carries the playlists, so a game that imports the whole library can
still address one set:

```js
import { play, PLAYLISTS } from './cues.js';

for (const name of PLAYLISTS['pc-speaker']) preload(name);
```

A playlist downloaded on its own arrives as `export/<id>.cues.js` with the
same exports minus `PLAYLISTS` — it *is* the playlist — so a game that wants
one set imports one file.

## The seeded library

`library/` ships with eleven cues ported from the PC-speaker sound in
[`ivjames/forest`](https://github.com/ivjames/forest): one 1-bit square through
a modelled ~1 inch piezo disc, pitches snapped to what an 8253 divisor can
actually produce. They are a real, already-balanced corpus, so the board isn't
empty on first run — and they show the tool doing its job immediately, since
`pc-key` measures about 25 dB quieter than `pc-win`.

They also arrive as a playlist, `PC speaker`, because that is what they are:
eleven cues from one game on one piece of hardware. It is the first thing the
board has more than one of.

`npm run seed` rewrites them and that playlist; anything else in `library/`
and `playlists/` is left alone.

## Layout

```
server.mjs           node:http server + API. Holds the API key.
lib/agent.mjs        the system prompt, the JSON schema, the Anthropic call
lib/library.mjs      library/*.json on disk, one file per cue
lib/playlists.mjs    playlists/*.json, named sets of cue ids
lib/exporter.mjs     emits export/cues.js and export/<playlist>.cues.js
public/audio.mjs     compile, render, measure, WAV — shared with the tests
public/zip.mjs       the zip writer behind "download wavs"
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
| `DELETE /api/cue/:id` | remove one, and prune it from every playlist |
| `GET /api/playlists` | `{playlists}` |
| `POST /api/playlist` | upsert a playlist → `{playlist}` |
| `DELETE /api/playlist/:id` | remove one; its cues stay |
| `POST /api/measure` | `{measurements:{id: measure}}`, merged in without touching `updatedAt` |
| `POST /api/export` | `{playlist?}` → writes `export/cues.js`, or `export/<id>.cues.js` for one playlist, and returns the source |
| `GET /api/health` | model, and whether a key is loaded |
