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
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

import { ROOT, startServer, OFFLINE_CLOCK } from './harness.mjs';
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
  await page.addInitScript(OFFLINE_CLOCK);

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
    // A silent cue serialises its dB as null; the table still has to print.
    const n = (v, digits, suffix = '') => (Number.isFinite(v) ? v.toFixed(digits) + suffix : '-inf');
    rows.push([cue.id, cue.key || '-', n(m.duration, 3, 's'), n(m.peakDb, 1), n(m.rmsDb, 1),
      Number.isFinite(m.centroid) ? `${Math.round(m.centroid)}Hz` : '-',
      (m.bands || []).filter((b) => b.frac > 0.15).map((b) => b.name).join('+') || '-']);
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

  // 5. A cue that schedules before t0 renders live and throws under
  //    measurement, so the board has to say which happened and keep the
  //    bake-off verdict on the same story as the measurement under it.
  const early = await page.evaluate(async () => {
    const cue = {
      name: 'Early Ramp', code: `
        const o = ctx.createOscillator();
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t0);
        g.gain.linearRampToValueAtTime(0.4, t0 - 0.05 * p.early);
        g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.2);
        o.connect(g); g.connect(out); o.start(t0); o.stop(t0 + 0.2);
        return t0 + 0.2;`,
      params: [{ key: 'early', label: 'Early', min: 0, max: 1, step: 1, default: 0, unit: '' }],
      values: { early: 0 }, gain: 1, _verdict: 'pass', _warnings: [],
    };
    const r = {};
    await window.__piezo.remeasure(cue);
    r.goodVerdict = cue._verdict;

    cue.values = { early: 1 };                       // now it wants t0 - 0.05
    try { await window.__piezo.remeasure(cue); r.threw = false; }
    catch (err) { r.threw = true; r.message = err.message; }
    r.badVerdict = cue._verdict;
    r.badMeasure = cue.measure;

    cue.values = { early: 0 };                       // and back again
    await window.__piezo.remeasure(cue);
    r.recoveredVerdict = cue._verdict;

    // A call that never returned a cue is not a measurement: its empty body
    // renders as silence, which must not be allowed to become the verdict.
    const failed = {
      name: 'failed', code: '', params: [], values: {}, gain: 1,
      _verdict: 'api-error', _error: 'rate limited by the Anthropic API',
    };
    await window.__piezo.remeasure(failed);
    r.apiVerdict = failed._verdict;
    return r;
  });
  if (early.goodVerdict !== 'pass') fail(`negative-time check: expected pass, got ${early.goodVerdict}`);
  if (!early.threw) fail('negative-time check: scheduling before t0 rendered without throwing');
  if (!/scheduled an event before t0/.test(early.message || '')) {
    fail(`negative-time check: unexplained message ${JSON.stringify(early.message)}`);
  }
  if (early.badVerdict !== 'threw') fail(`negative-time check: verdict stayed ${early.badVerdict} after a failed render`);
  if (early.badMeasure !== null) fail('negative-time check: a failed render left a measurement behind');
  if (early.recoveredVerdict !== 'pass') fail(`negative-time check: verdict stuck at ${early.recoveredVerdict}`);
  if (early.apiVerdict !== 'api-error') fail(`negative-time check: api-error became ${early.apiVerdict} on a re-measure`);

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
