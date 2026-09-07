#!/usr/bin/env node
/* The check.
 *
 * Nobody involved in writing these cues can hear them -- not the model, and
 * not the agent driving this repo -- so the board is verified by measurement
 * instead. This starts the real server, opens the real page in headless
 * Chromium with window.AudioContext replaced by an OfflineAudioContext
 * subclass, renders every cue through the same engine the UI uses, and
 * asserts that each one is audible, unclipped and the right sort of length.
 *
 *   node test/verify.mjs           check
 *   node test/verify.mjs --write   check, then write measurements back to library/
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const WRITE = process.argv.includes('--write');

const LIMITS = {
  minPeak: 0.005,      // anything quieter than -46 dBFS is a silent pad
  maxPeak: 0.99,       // 0 dBFS is clipping
  minDuration: 0.004,
  maxDuration: 8,
  declaredSlack: 0.3,  // how far a cue may misreport its own end time
};

const failures = [];
const warnings = [];
const fail = (msg) => { failures.push(msg); };
const warn = (msg) => { warnings.push(msg); };

const server = await startServer();
let browser;
try {
  browser = await chromium.launch({ args: ['--mute-audio'] });
  const page = await browser.newPage();

  const pageErrors = [];
  page.on('pageerror', (err) => pageErrors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') pageErrors.push(`console: ${msg.text()}`); });
  page.on('requestfailed', (req) => pageErrors.push(`request failed: ${req.url()}`));

  // Headless Chromium has no audio device; give the page a deterministic,
  // offline clock instead. Everything the board does to a live context --
  // create nodes, schedule, resume -- has to work against this.
  await page.addInitScript(() => {
    class OfflineStandIn extends OfflineAudioContext {
      constructor() { super(1, 44100 * 10, 44100); }
    }
    Object.defineProperty(window, 'AudioContext', { value: OfflineStandIn, configurable: true });
    Object.defineProperty(window, 'webkitAudioContext', { value: OfflineStandIn, configurable: true });
  });

  await page.goto(server.url, { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => window.__piezo.ready);

  // 1. The measurement engine itself, against a signal whose numbers are known.
  const selfCheck = await page.evaluate(async () => {
    const A = await import('/audio.mjs');
    const cue = {
      code: `const o = ctx.createOscillator(); o.frequency.value = 1000;
             const g = ctx.createGain(); g.gain.value = 0.5;
             o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + 0.5);
             return t0 + 0.5;`,
      params: [], values: {}, gain: 1,
    };
    const { measure } = await A.renderAndMeasure(cue);
    return measure;
  });
  approx('self-check peak', selfCheck.peak, 0.5, 0.02);
  approx('self-check duration', selfCheck.duration, 0.5, 0.02);
  approx('self-check centroid', selfCheck.centroid, 1000, 60);
  approx('self-check band sum', selfCheck.bands.reduce((a, b) => a + b.frac, 0), 1, 0.02);

  // 2. Every cue in the library, rendered offline through the page's engine.
  const cues = await page.evaluate(() => window.__piezo.state.cues.map((c) => ({ id: c.id, name: c.name, key: c.key })));
  if (!cues.length) fail('library is empty - nothing to verify');

  const measurements = await page.evaluate(() => window.__piezo.measureAll());

  const rows = [];
  for (const cue of cues) {
    const m = measurements[cue.id];
    if (!m) { fail(`${cue.id}: did not render`); continue; }
    if (!(m.peak > LIMITS.minPeak)) fail(`${cue.id}: silent (peak ${m.peakDb} dBFS)`);
    if (m.peak > LIMITS.maxPeak) fail(`${cue.id}: clipping (peak ${m.peakDb} dBFS)`);
    if (m.duration < LIMITS.minDuration) fail(`${cue.id}: too short (${m.duration}s)`);
    if (m.duration > LIMITS.maxDuration) fail(`${cue.id}: too long (${m.duration}s)`);
    if (m.declaredDuration == null) fail(`${cue.id}: did not return an end time`);
    else if (m.duration - m.declaredDuration > LIMITS.declaredSlack) {
      warn(`${cue.id}: sounds ${(m.duration - m.declaredDuration).toFixed(2)}s past its declared end`);
    }
    rows.push([cue.id, cue.key || '-', `${m.duration.toFixed(3)}s`,
      `${m.peakDb.toFixed(1)}`, `${m.rmsDb.toFixed(1)}`, `${Math.round(m.centroid)}Hz`,
      m.bands.filter((b) => b.frac > 0.15).map((b) => b.name).join('+') || '—']);
  }

  // 3. The live path: firing a pad must build a graph without throwing.
  for (const cue of cues) {
    const ok = await page.evaluate((id) => window.__piezo.fire(id), cue.id);
    if (!ok) fail(`${cue.id}: fire() found no cue`);
  }
  await page.waitForTimeout(150);

  // 4. The exported module must be valid, importable JavaScript.
  const exported = await page.evaluate(async () => {
    const r = await fetch('/api/export', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    return r.json();
  });
  const mod = await import(pathToFileURL(path.join(ROOT, 'export', 'cues.js')).href + `?t=${Date.now()}`);
  if (mod.CUE_NAMES.length !== cues.length) {
    fail(`export/cues.js has ${mod.CUE_NAMES.length} cues, library has ${cues.length}`);
  }
  for (const cue of cues) {
    if (typeof mod.CUES[cue.id]?.render !== 'function') fail(`export/cues.js: ${cue.id} has no render()`);
  }

  if (pageErrors.length) for (const e of pageErrors) fail(e);

  if (WRITE) {
    const res = await page.evaluate(async (m) => {
      const r = await fetch('/api/measure', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ measurements: m }),
      });
      return r.json();
    }, measurements);
    console.log(`wrote measurements for ${res.written.length} cues into library/`);
  }

  print(rows, exported);
} finally {
  if (browser) await browser.close();
  server.stop();
}

if (failures.length) {
  console.error(`\nFAIL — ${failures.length} problem(s):`);
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`\nPASS — every cue renders, sounds, and stays under 0 dBFS.`);

/* ------------------------------------------------------------------------ */

function approx(what, got, want, tol) {
  if (!(Math.abs(got - want) <= tol)) fail(`${what}: got ${got}, expected ${want} ±${tol}`);
}

function print(rows, exported) {
  const head = ['cue', 'key', 'dur', 'peak dB', 'rms dB', 'centroid', 'energy'];
  const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log('\n' + line(head));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) console.log(line(r));
  if (exported) console.log(`\nexport/cues.js: ${exported.cues} cues, ${exported.bytes} bytes`);
  for (const w of warnings) console.log(`  ! ${w}`);
}

async function startServer() {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ANTHROPIC_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const url = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start within 15s')), 15000);
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d.toString();
      const m = buf.match(/http:\/\/[\d.]+:\d+/);
      if (m) { clearTimeout(timer); resolve(m[0]); }
    });
    child.on('exit', (code) => { clearTimeout(timer); reject(new Error(`server exited with ${code}`)); });
  });
  return { url, stop: () => child.kill() };
}
