/* The board.
 *
 * Everything audio lives in audio.mjs, which the test harness drives directly,
 * so the numbers on a pad are the same numbers `npm test` asserts on.
 */
import * as A from '/audio.mjs';

const $ = (id) => document.getElementById(id);
const el = (tag, cls, text) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
};

const KEY_POOL = '1234567890qwertyuiopasdfghjkl'.split('');

const state = {
  cues: [],          // saved cues, as on disk
  sel: null,         // the cue in the inspector (may be the unsaved draft)
  draft: null,
  history: [],
  dirty: false,
  target: -20,
  compare: [],       // bake-off candidates, grouped for A/B
};

/* --- live audio ---------------------------------------------------------- */

let ctx = null, master = null;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = Number($('master').value);
    master.connect(ctx.destination);
  }
  // Browsers keep a context suspended until a gesture. Offline contexts (the
  // test harness) reject resume(); that is not an error worth surfacing.
  if (ctx.state === 'suspended') { try { Promise.resolve(ctx.resume()).catch(() => {}); } catch { /* ignore */ } }
  return ctx;
}

/** Fire a cue now. Each firing builds its own graph, so cues overlap freely. */
function fire(cue) {
  const c = audio();
  const trim = c.createGain();
  trim.gain.value = cue.gain ?? 1;
  trim.connect(master);
  let end;
  try {
    end = A.fire(cue, c, trim, { params: cue.values });
  } catch (err) {
    trim.disconnect();
    status(`${cue.name}: ${err.message}`, true);
    return;
  }
  setTimeout(() => trim.disconnect(), Math.max(0, end - c.currentTime) * 1000 + 250);
  flash(cue.id);
}

function flash(id) {
  const pad = document.querySelector(`.pad[data-id="${CSS.escape(String(id))}"]`);
  if (!pad) return;
  pad.classList.add('hit');
  setTimeout(() => pad.classList.remove('hit'), 110);
}

/* --- measurement --------------------------------------------------------- */

async function remeasure(cue) {
  try {
    const { buffer, measure } = await A.renderAndMeasure(cue, { params: cue.values, gain: cue.gain });
    cue.measure = measure;
    cue._buffer = buffer;
    cue._error = null;
    reverdict(cue);
    return measure;
  } catch (err) {
    cue.measure = null;
    cue._error = err.message;
    reverdict(cue);
    throw err;
  }
}

/* A bake-off verdict is a judgement about a measurement, so it has to be
   re-made whenever the measurement is. Otherwise a candidate that passed at
   its defaults and throws two slider-drags later keeps saying PASS with the
   exception printed underneath it.

   Except api-error, which is a judgement about a call that never returned a
   cue. Rendering its empty body succeeds -- ten seconds of silence -- and
   would quietly downgrade "the model never answered" to "silent". */
function reverdict(cue) {
  if (!cue._verdict || cue._verdict === 'api-error') return;
  cue._verdict = verdictOf({ ok: true, measure: cue.measure, warnings: cue._warnings });
}

/* --- board --------------------------------------------------------------- */

function renderPads() {
  const pads = $('pads');
  pads.textContent = '';
  for (const cue of state.cues) {
    const pad = el('button', 'pad');
    pad.dataset.id = cue.id;
    if (state.sel && state.sel.id === cue.id) pad.classList.add('sel');

    const line = el('div', 'n');
    line.append(el('span', 'name', cue.name));
    if (cue.key) line.append(el('span', 'key', cue.key));
    pad.append(line);

    const m = cue.measure;
    if (m) {
      const top = el('div', 'nums');
      top.append(el('span', '', `${m.duration.toFixed(2)}s`), el('span', '', fmtHz(m.centroid)));
      const bottom = el('div', 'nums');
      bottom.append(
        el('span', m.clipped ? 'clip' : '', `pk ${fmtDb(m.peakDb)}`),
        el('span', hotness(m.rmsDb), `rms ${fmtDb(m.rmsDb)}`),
      );
      pad.append(top, bottom);
    } else {
      const nums = el('div', 'nums');
      const why = el('span', cue._error ? 'clip' : '', cue._error ? 'error' : 'measuring…');
      if (cue._error) why.title = cue._error;    // the inspector prints it in full
      nums.append(why);
      pad.append(nums);
    }

    if (m) {
      const bands = el('div', 'bands');
      const colors = ['#3b5c7a', '#4a7c8c', '#5f9e86', '#8fae5f', '#c39a52', '#b96e58'];
      m.bands.forEach((b, i) => {
        const seg = el('i');
        seg.style.width = `${(b.frac * 100).toFixed(2)}%`;
        seg.style.background = colors[i];
        seg.title = `${b.name} ${b.lo}–${b.hi ?? '∞'} Hz: ${(b.frac * 100).toFixed(1)}%`;
        bands.append(seg);
      });
      pad.append(bands);
    }

    pad.addEventListener('click', () => { select(cue); fire(cue); });
    pads.append(pad);
  }
}

/** More than 4 dB off the target reads as "this one is louder than its neighbours". */
function hotness(rmsDb) {
  if (!Number.isFinite(rmsDb)) return '';
  return Math.abs(rmsDb - state.target) > 4 ? 'hotter' : '';
}

const fmtDb = (v) => (Number.isFinite(v) ? `${v.toFixed(1)}` : '−∞');
const fmtHz = (v) => (v >= 1000 ? `${(v / 1000).toFixed(1)}k` : `${Math.round(v)}`) + 'Hz';

/* --- inspector ----------------------------------------------------------- */

function select(cue) {
  state.sel = cue;
  state.dirty = false;
  $('inspector').hidden = false;
  renderPads();
  renderInspector();
}

function renderInspector() {
  const cue = state.sel;
  if (!cue) { $('inspector').hidden = true; return; }

  $('cue-name').textContent = cue.name + (cue.id ? '' : '  (unsaved)');
  $('cue-desc').textContent = cue.description || '';
  $('cue-key').value = cue.key || '';
  $('code').value = cue.code;
  $('delete').disabled = !cue.id;
  $('code-status').textContent = cue._error ? cue._error : '';
  $('code-status').className = cue._error ? 'hint err' : 'hint';

  renderParams(cue);
  renderMeasure(cue);
  draw(cue);
}

function renderParams(cue) {
  const box = $('params');
  box.textContent = '';
  if (!cue.params?.length) { box.append(el('span', 'hint', 'this cue declares no parameters')); return; }
  for (const p of cue.params) {
    const row = el('div', 'param');
    row.append(el('label', '', `${p.label}${p.unit ? ` (${p.unit})` : ''}`));
    const input = el('input');
    input.type = 'range';
    input.min = p.min; input.max = p.max; input.step = p.step || (p.max - p.min) / 100;
    input.value = cue.values?.[p.key] ?? p.default;
    const out = el('output', '', fmtVal(Number(input.value)));
    input.addEventListener('input', () => {
      cue.values = { ...cue.values, [p.key]: Number(input.value) };
      out.textContent = fmtVal(Number(input.value));
      state.dirty = true;
      scheduleRemeasure();
    });
    row.append(input, out);
    box.append(row);
  }
}

const fmtVal = (v) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(2) : v.toFixed(3));

let pending = null;
function scheduleRemeasure() {
  clearTimeout(pending);
  pending = setTimeout(() => { refreshSelected().catch(() => {}); }, 140);
}

async function refreshSelected() {
  const cue = state.sel;
  if (!cue) return;
  try {
    cue._error = null;
    await remeasure(cue);
    $('code-status').textContent = '';
    $('code-status').className = 'hint';
  } catch (err) {
    $('code-status').textContent = err.message;
    $('code-status').className = 'hint err';
  }
  renderMeasure(cue);
  draw(cue);
  renderPads();
  if (state.compare.length) renderCompare();   // the pad's verdict has moved
}

function renderMeasure(cue) {
  const t = $('measure');
  t.textContent = '';
  const m = cue.measure;
  if (!m) { t.append(rowOf('measurement', cue._error || '—', 'bad')); return; }

  const rows = [
    ['peak', `${fmtDb(m.peakDb)} dBFS`, m.clipped ? 'bad' : m.peakDb > -1 ? 'warn' : ''],
    ['rms', `${fmtDb(m.rmsDb)} dBFS`, Math.abs(m.rmsDb - state.target) > 4 ? 'warn' : ''],
    ['duration', `${m.duration.toFixed(3)} s${m.declaredDuration != null
      ? ` (declared ${m.declaredDuration.toFixed(3)})` : ''}`,
      m.declaredDuration != null && Math.abs(m.duration - m.declaredDuration) > 0.25 ? 'warn' : ''],
    ['onset', `${(m.onset * 1000).toFixed(1)} ms`, ''],
    ['centroid', fmtHz(m.centroid), ''],
    ['loudest bin', fmtHz(m.peakFreq), ''],
    ['trim', `×${(cue.gain ?? 1).toFixed(3)}`, ''],
    ['energy', m.bands.map((b) => `${b.name} ${(b.frac * 100).toFixed(0)}%`).join('  '), ''],
  ];
  for (const [k, v, cls] of rows) t.append(rowOf(k, v, cls));
}

function rowOf(k, v, cls) {
  const tr = el('tr');
  tr.append(el('td', '', k), el('td', `v ${cls || ''}`, v));
  return tr;
}

/* --- drawing ------------------------------------------------------------- */

function draw(cue) {
  const buf = cue._buffer;
  drawWave($('wave'), buf, cue.measure);
  drawSpec($('spec'), buf);
}

function fitCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(canvas.clientWidth * dpr));
  const h = Math.max(1, Math.round(canvas.clientHeight * dpr));
  if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, canvas.width, canvas.height);
  return { g, w: canvas.width, h: canvas.height, dpr };
}

function drawWave(canvas, buffer, m) {
  const { g, w, h } = fitCanvas(canvas);
  if (!buffer) return;
  const x = buffer.getChannelData(0);
  // Draw the audible part plus 20%, so the tail is visible but 10 s of silence
  // does not squash the cue into one pixel.
  const shown = Math.min(x.length, Math.ceil((m?.duration || 0.5) * 1.2 * buffer.sampleRate) || x.length);

  g.strokeStyle = '#262b33'; g.lineWidth = 1;
  g.beginPath(); g.moveTo(0, h / 2); g.lineTo(w, h / 2); g.stroke();

  g.strokeStyle = '#7fd1b9';
  g.beginPath();
  const per = shown / w;
  for (let px = 0; px < w; px++) {
    let lo = 1, hi = -1;
    const from = Math.floor(px * per), to = Math.min(shown, Math.floor((px + 1) * per) + 1);
    for (let i = from; i < to; i++) { const v = x[i]; if (v < lo) lo = v; if (v > hi) hi = v; }
    if (lo > hi) { lo = hi = 0; }
    g.moveTo(px + 0.5, (1 - hi) * h / 2);
    g.lineTo(px + 0.5, (1 - lo) * h / 2);
  }
  g.stroke();

  // 0 dBFS rails, so clipping is visible rather than inferred.
  g.strokeStyle = '#e0806a44';
  g.beginPath(); g.moveTo(0, 0.5); g.lineTo(w, 0.5); g.moveTo(0, h - 0.5); g.lineTo(w, h - 0.5); g.stroke();
}

function drawSpec(canvas, buffer) {
  const { g, w, h, dpr } = fitCanvas(canvas);
  if (!buffer) return;
  const spec = A.spectrumOf(buffer);
  const mag = spec.mag, frames = spec.frames || 1, binHz = spec.binHz;

  let max = 1e-12;
  for (let k = 1; k < mag.length; k++) max = Math.max(max, mag[k] / frames);

  const f0 = 20, f1 = Math.min(20000, binHz * mag.length);
  const xOf = (f) => (Math.log(Math.max(f, f0) / f0) / Math.log(f1 / f0)) * w;
  const yOf = (db) => h - ((db + 80) / 80) * h;   // -80..0 dB

  g.strokeStyle = '#262b33'; g.fillStyle = '#7c8798';
  g.font = `${10 * dpr}px ui-monospace, monospace`;
  for (const f of [100, 1000, 10000]) {
    if (f > f1) continue;
    const x = xOf(f);
    g.beginPath(); g.moveTo(x, 0); g.lineTo(x, h); g.stroke();
    g.fillText(f >= 1000 ? `${f / 1000}k` : `${f}`, x + 3 * dpr, h - 3 * dpr);
  }

  g.beginPath();
  g.moveTo(0, h);
  for (let px = 0; px < w; px++) {
    const f = f0 * Math.pow(f1 / f0, px / w);
    const k = Math.round(f / binHz);
    const v = k > 0 && k < mag.length ? mag[k] / frames : 0;
    const db = Math.max(-80, 20 * Math.log10(Math.max(v / max, 1e-6)));
    g.lineTo(px, yOf(db));
  }
  g.lineTo(w, h);
  g.closePath();
  g.fillStyle = '#7fd1b933';
  g.fill();
  g.strokeStyle = '#7fd1b9';
  g.stroke();
}

/* --- generation ---------------------------------------------------------- */

async function generate(refineText) {
  const promptEl = $('prompt');
  const text = promptEl.value.trim();
  if (!text) { genStatus('type a description first', true); return; }
  const previous = refineText ? state.sel : null;
  if (refineText && !previous) { genStatus('select a cue to refine', true); return; }

  setBusy(true);
  genStatus(refineText ? 'refining…' : 'generating…');
  try {
    const body = refineText
      ? { prompt: previous.prompt || text, refine: text, previous: strip(previous) }
      : { prompt: text };
    const res = await post('/api/generate', body);

    const draft = {
      id: null,
      name: res.cue.name,
      description: res.cue.description,
      prompt: res.cue.prompt,
      code: res.cue.code,
      params: res.cue.params,
      values: res.cue.values,
      gain: previous?.gain ?? 1,
      key: previous?.key || nextKey(),
      _base: previous ? previous.code : null,
      _warnings: res.warnings,
      _usage: res.usage,
    };
    state.draft = draft;
    state.history.unshift({ at: new Date(), draft, usage: res.usage, refine: refineText || null });
    renderHistory();
    select(draft);
    await refreshSelected();
    showDiff(draft);
    genStatus(`${res.usage.input}+${res.usage.output} tok · $${res.usage.costUsd.toFixed(3)}`
      + (res.warnings.length ? ` · ${res.warnings.length} warning(s)` : ''));
    if (res.warnings.length) {
      $('code-status').textContent = res.warnings.join('; ');
      $('code-status').className = 'hint warnings';
    }
  } catch (err) {
    genStatus(err.message, true);
  } finally {
    setBusy(false);
  }
}

function strip(cue) {
  return {
    name: cue.name, description: cue.description, prompt: cue.prompt,
    code: cue.code, params: cue.params, measure: cue.measure,
  };
}

function nextKey() {
  const used = new Set(state.cues.map((c) => c.key).filter(Boolean));
  return KEY_POOL.find((k) => !used.has(k)) || '';
}

function renderHistory() {
  const list = $('history');
  list.textContent = '';
  for (const h of state.history.slice(0, 12)) {
    const li = el('li');
    if (state.sel === h.draft) li.classList.add('cur');
    li.append(el('div', 't', `${h.draft.name}${h.refine ? `  ← ${h.refine}` : ''}`));
    li.append(el('div', 'm hint', `${h.at.toLocaleTimeString()} · $${h.usage.costUsd.toFixed(3)}`));
    li.addEventListener('click', async () => {
      select(h.draft);
      renderHistory();
      await refreshSelected();
      showDiff(h.draft);
    });
    list.append(li);
  }
}

function showDiff(cue) {
  const box = $('diff-box');
  if (!cue._base) { box.hidden = true; return; }
  box.hidden = false;
  box.open = true;
  const pre = $('diff');
  pre.textContent = '';
  for (const [type, line] of diffLines(cue._base, cue.code)) {
    const span = el('span', type === '+' ? 'add' : type === '-' ? 'del' : 'ctx',
      `${type} ${line}\n`);
    pre.append(span);
  }
}

/** Line diff via LCS. Bails out on very large inputs rather than stalling. */
export function diffLines(a, b) {
  const A0 = a.split('\n'), B0 = b.split('\n');
  if (A0.length * B0.length > 400_000) {
    return [['-', `${A0.length} lines replaced`], ['+', `${B0.length} lines`]];
  }
  const n = A0.length, m = B0.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = A0[i] === B0[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const out = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (A0[i] === B0[j]) { out.push([' ', A0[i]]); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { out.push(['-', A0[i++]]); }
    else { out.push(['+', B0[j++]]); }
  }
  while (i < n) out.push(['-', A0[i++]]);
  while (j < m) out.push(['+', B0[j++]]);
  return out;
}

/* --- bake-off comparison -------------------------------------------------
   A run is a table of numbers until you can hear it. This puts one row per
   prompt on the board, one pad per model, so the same description can be
   fired back to back across models and kept if it wins. */

async function loadRuns() {
  const { runs } = await get('/api/bakeoff');
  const pick = $('run-pick');
  pick.textContent = '';
  if (!runs.length) {
    pick.append(new Option('no runs yet — npm run bakeoff', ''));
    $('load-run').disabled = true;
    return;
  }
  $('load-run').disabled = false;
  for (const r of runs) pick.append(new Option(r.replace(/\.json$/, ''), r));
}

async function loadRun(name) {
  const run = await get(`/api/bakeoff/${encodeURIComponent(name)}`);
  state.compare = (run.results || []).map((r, i) => ({
    id: null,
    name: r.cue?.name || `${r.model} candidate`,
    description: r.cue?.description || '',
    prompt: r.prompt,
    code: r.cue?.code || '',
    params: r.cue?.params || [],
    values: r.cue?.values || {},
    gain: 1,
    key: '',
    measure: r.measure && !r.measure.error ? r.measure : null,
    _model: r.model.replace('claude-', '') + (r.effort ? ` @${r.effort}` : ''),
    _verdict: verdictOf(r),
    _warnings: r.warnings,      // so a re-measure can re-reach the same verdict
    _usage: r.usage,
    _i: i,
  }));
  renderCompare();
  runStatus(`${state.compare.length} candidates from ${name.replace(/\.json$/, '')}`);
}

/**
 * Run a bake-off from the board: every prompt in the box, on every ticked
 * model, generated and measured right here. The server half is just
 * /api/generate with a model — there was never a reason to make this a
 * terminal round trip and come back.
 */
async function runBakeoff() {
  const prompts = $('prompt').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!prompts.length) { runStatus('put one or more prompts in the box below, one per line', true); return; }

  const models = [...document.querySelectorAll('.bo-model:checked')].map((n) => n.value);
  if (!models.length) { runStatus('tick at least one model', true); return; }

  const effort = $('bo-effort').value || null;
  const cells = [];
  for (const prompt of prompts) {
    for (const model of models) {
      // Haiku rejects `effort`; run it unset rather than not at all.
      cells.push({ prompt, model, effort: /haiku/.test(model) ? null : effort });
    }
  }

  state.compare = [];
  renderCompare();
  setBusy(true);
  $('bake-off').disabled = true;
  let spend = 0;

  try {
    for (const [i, cell] of cells.entries()) {
      runStatus(`${i + 1}/${cells.length}  ${cell.model.replace('claude-', '')}  ${cell.prompt.slice(0, 40)}…  $${spend.toFixed(3)}`);
      const t0 = Date.now();
      let cand;
      try {
        const res = await post('/api/generate', { prompt: cell.prompt, model: cell.model, effort: cell.effort });
        spend += res.usage.costUsd;
        cand = {
          id: null, name: res.cue.name, description: res.cue.description, prompt: cell.prompt,
          code: res.cue.code, params: res.cue.params, values: res.cue.values, gain: 1, key: '',
          _model: cell.model.replace('claude-', '') + (cell.effort ? ` @${cell.effort}` : ''),
          _usage: res.usage, _warnings: res.warnings, _ms: Date.now() - t0,
        };
        try {
          await remeasure(cand);
          cand._verdict = verdictOf({ ok: true, measure: cand.measure, warnings: res.warnings });
        } catch {
          cand._verdict = 'threw';
        }
      } catch (err) {
        cand = {
          id: null, name: 'failed', prompt: cell.prompt, code: '', params: [], values: {}, gain: 1,
          _model: cell.model.replace('claude-', ''), _verdict: 'api-error', _error: err.message,
        };
      }
      state.compare.push(cand);
      renderCompare();       // results land as they arrive, not all at the end
    }
    runStatus(`${cells.length} candidates · $${spend.toFixed(4)}`);
  } finally {
    setBusy(false);
    $('bake-off').disabled = false;
  }
}

/* Same rule the CLI applies, so the pad and the table can't disagree. */
function verdictOf(r) {
  if (!r.ok) return 'api-error';
  const m = r.measure;
  if (!m || m.error) return 'threw';
  if (!(m.peak > 0.005)) return 'silent';
  if (m.peak > 0.99) return 'clipped';
  if (m.duration < 0.004 || m.duration > 8) return 'bad-length';
  if (r.warnings?.length) return 'lint';
  return 'pass';
}

function renderCompare() {
  const box = $('compare');
  box.textContent = '';
  const byPrompt = new Map();
  for (const c of state.compare) {
    if (!byPrompt.has(c.prompt)) byPrompt.set(c.prompt, []);
    byPrompt.get(c.prompt).push(c);
  }

  for (const [prompt, cands] of byPrompt) {
    const row = el('div', 'cmp-row');
    const q = el('div', 'q');
    q.append(el('span', '', prompt));
    const all = el('button', '', '▶ all');
    all.title = 'Fire every model\'s take on this prompt, back to back';
    all.addEventListener('click', () => fireSequence(cands));
    q.append(all);
    row.append(q);

    const cells = el('div', 'cmp-cells');
    for (const c of cands) {
      const pad = el('button', 'pad');
      if (state.sel === c) pad.classList.add('sel');
      const head = el('div', 'n');
      head.append(el('span', 'model', c._model));
      const cls = c._verdict === 'pass' ? 'pass' : c._verdict === 'lint' ? 'lint' : 'bad';
      head.append(el('span', `verdict ${cls}`, c._verdict));
      pad.append(head);

      const m = c.measure;
      const nums = el('div', 'nums');
      if (m) {
        nums.append(el('span', '', `${m.duration.toFixed(2)}s`), el('span', '', fmtHz(m.centroid)));
        const b = el('div', 'nums');
        b.append(el('span', '', `pk ${fmtDb(m.peakDb)}`), el('span', hotness(m.rmsDb), `rms ${fmtDb(m.rmsDb)}`));
        pad.append(nums, b);
      } else {
        nums.append(el('span', 'clip', c._error || c._verdict));
        pad.append(nums);
      }
      if (c._usage) pad.append(el('div', 'nums', `$${c._usage.costUsd.toFixed(4)}`));

      pad.addEventListener('click', () => {
        select(c);
        renderCompare();
        // A candidate with no code is a call that failed; there is nothing to
        // play and nothing to measure, and rendering its empty body would
        // overwrite the error with ten seconds of silence.
        if (!c.code) return;
        fire(c);
        refreshSelected().catch(() => {});
      });
      cells.append(pad);

      const wrap = el('div');
      wrap.append(pad);
      if (!c.code) { cells.append(wrap); continue; }   // nothing to keep

      const keep = el('button', 'keep', 'keep');
      keep.title = 'Save this candidate into the library';
      keep.addEventListener('click', guard(async (e) => {
        e.stopPropagation();
        c.key = c.key || nextKey();
        await save(c);
        await loadLibrary();
        runStatus(`kept ${c.name}`);
      }));
      wrap.append(keep);
      cells.append(wrap);
    }
    row.append(cells);
    box.append(row);
  }
}

/** Play candidates one after another, each starting where the last ended. */
function fireSequence(cands) {
  const c0 = audio();
  let when = c0.currentTime + 0.05;
  for (const c of cands) {
    if (!c.code || !c.measure) continue;
    const trim = c0.createGain();
    trim.gain.value = c.gain ?? 1;
    trim.connect(master);
    try {
      A.fire(c, c0, trim, { when, params: c.values });
    } catch (err) {
      status(`${c._model}: ${err.message}`, true);
      trim.disconnect();
      continue;
    }
    const dur = Math.max(0.15, c.measure.duration);
    setTimeout(() => trim.disconnect(), (when - c0.currentTime + dur) * 1000 + 300);
    when += dur + 0.25;      // a beat between takes, so they don't blur together
  }
}

const runStatus = (msg, bad) => { $('run-status').textContent = msg; $('run-status').className = bad ? 'hint err' : 'hint'; };

/* --- persistence --------------------------------------------------------- */

async function save(cue) {
  const saved = await post('/api/save', {
    id: cue.id, name: cue.name, description: cue.description, prompt: cue.prompt,
    code: cue.code, params: cue.params, values: cue.values, gain: cue.gain,
    key: cue.key, order: cue.order, measure: cue.measure,
  });
  const record = saved.cue;
  record._buffer = cue._buffer;
  record.measure = cue.measure;
  const at = state.cues.findIndex((c) => c.id === record.id);
  if (at >= 0) state.cues[at] = record; else state.cues.push(record);
  if (state.sel === cue) state.sel = record;
  state.draft = state.draft === cue ? null : state.draft;
  state.dirty = false;
  renderPads();
  renderInspector();
  return record;
}

async function loadLibrary() {
  const { cues } = await get('/api/library');
  state.cues = cues;
  renderPads();
  for (const cue of state.cues) {
    try { await remeasure(cue); } catch (err) { cue._error = err.message; }
  }
  renderPads();
  status(`${state.cues.length} cues`);
}

/* --- level matching ------------------------------------------------------ */

async function matchOne(cue) {
  if (!cue.measure) await remeasure(cue);
  cue.gain = A.matchGain(cue.measure, state.target, cue.gain ?? 1);
  await remeasure(cue);
  if (cue.id) await save(cue);
}

/* --- wiring -------------------------------------------------------------- */

const status = (msg, bad) => { $('status').textContent = msg; $('status').className = bad ? 'sub err' : 'sub'; };
const genStatus = (msg, bad) => { $('gen-status').textContent = msg; $('gen-status').className = bad ? 'hint err' : 'hint'; };
const setBusy = (on) => { $('generate').disabled = on; $('refine').disabled = on; };

async function get(url) {
  const r = await fetch(url);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
  return body;
}

async function post(url, data, method = 'POST') {
  const r = await fetch(url, {
    method,
    headers: { 'content-type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(body.error || `${r.status} ${r.statusText}`);
  return body;
}

const fileSlug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'cue';

function download(name, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function guard(fn) {
  return (...args) => { Promise.resolve(fn(...args)).catch((err) => status(err.message, true)); };
}

$('master').addEventListener('input', (e) => {
  const v = Number(e.target.value);
  $('master-out').textContent = v > 0 ? `${(20 * Math.log10(v)).toFixed(1)} dB` : 'off';
  if (master) master.gain.value = v;
});
$('target-rms').addEventListener('change', (e) => {
  state.target = Number(e.target.value);
  renderPads();
  if (state.sel) renderMeasure(state.sel);
});

$('bake-off').addEventListener('click', guard(runBakeoff));
$('load-run').addEventListener('click', guard(() => loadRun($('run-pick').value)));
$('clear-run').addEventListener('click', () => { state.compare = []; renderCompare(); runStatus(''); });

$('generate').addEventListener('click', guard(() => generate(null)));
$('refine').addEventListener('click', guard(() => generate($('prompt').value.trim())));
$('prompt').addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); guard(() => generate(null))(); }
});

$('play').addEventListener('click', () => state.sel && fire(state.sel));
$('save').addEventListener('click', guard(async () => {
  if (!state.sel) return;
  state.sel.key = $('cue-key').value.trim();
  await save(state.sel);
  status(`saved ${state.sel.name}`);
}));
$('normalize').addEventListener('click', guard(async () => {
  if (!state.sel) return;
  await matchOne(state.sel);
  renderInspector();
  renderPads();
  status(`trimmed to ${state.target} dBFS RMS`);
}));
$('match-all').addEventListener('click', guard(async () => {
  status('matching library…');
  for (const cue of state.cues) await matchOne(cue);
  renderPads();
  if (state.sel) renderInspector();
  status(`matched ${state.cues.length} cues to ${state.target} dBFS RMS`);
}));
$('wav').addEventListener('click', guard(async () => {
  const cue = state.sel;
  if (!cue) return;
  const { buffer, measure } = await A.renderAndMeasure(cue, { params: cue.values, gain: cue.gain });
  const wav = A.toWav(buffer, { seconds: measure.duration });
  download(`${cue.id || fileSlug(cue.name)}.wav`, new Blob([wav], { type: 'audio/wav' }));
}));
$('delete').addEventListener('click', guard(async () => {
  const cue = state.sel;
  if (!cue?.id || !confirm(`Delete "${cue.name}"?`)) return;
  await post(`/api/cue/${encodeURIComponent(cue.id)}`, undefined, 'DELETE');
  state.cues = state.cues.filter((c) => c.id !== cue.id);
  state.sel = null;
  $('inspector').hidden = true;
  renderPads();
  status(`deleted ${cue.name}`);
}));
$('apply').addEventListener('click', guard(async () => {
  if (!state.sel) return;
  state.sel.code = $('code').value;
  state.sel._buffer = null;
  state.dirty = true;
  await refreshSelected();
}));
$('revert').addEventListener('click', guard(async () => {
  if (!state.sel?.id) return;
  const fresh = await get('/api/library');
  const disk = fresh.cues.find((c) => c.id === state.sel.id);
  if (!disk) return;
  Object.assign(state.sel, disk);
  renderInspector();
  await refreshSelected();
}));
$('export').addEventListener('click', guard(async () => {
  const res = await post('/api/export', {});
  download('cues.js', new Blob([res.code], { type: 'text/javascript' }));
  status(`wrote ${res.path} — ${res.cues} cues, ${res.bytes} bytes`);
}));

document.addEventListener('keydown', (e) => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const cue = state.cues.find((c) => c.key && c.key.toLowerCase() === e.key.toLowerCase());
  if (cue) { e.preventDefault(); fire(cue); }
});

/* --- boot ---------------------------------------------------------------- */

const ready = (async () => {
  try {
    const health = await get('/api/health');
    $('model-hint').textContent = health.hasKey
      ? `${health.model}`
      : `${health.model} — no ANTHROPIC_API_KEY, generation disabled`;
    $('generate').disabled = !health.hasKey;
    $('refine').disabled = !health.hasKey;
    $('bake-off').disabled = !health.hasKey;
    if (!health.hasKey) runStatus('generation is off — a saved run can still be loaded');
  } catch { /* health is optional */ }
  $('master-out').textContent = `${(20 * Math.log10(Number($('master').value))).toFixed(1)} dB`;
  state.target = Number($('target-rms').value);
  await loadLibrary();
  await loadRuns().catch(() => {});
})();

ready.catch((err) => status(err.message, true));

/* The harness in test/verify.mjs drives exactly this state and this engine. */
window.__piezo = {
  ready,
  state,
  audio,
  fire: (id) => { const c = state.cues.find((x) => x.id === id); if (c) fire(c); return !!c; },
  remeasure,
  measureAll: async () => {
    const out = {};
    for (const cue of state.cues) {
      const { measure } = await A.renderAndMeasure(cue, { params: cue.values, gain: cue.gain });
      cue.measure = measure;
      out[cue.id] = measure;
    }
    renderPads();
    return out;
  },
};
