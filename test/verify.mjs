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
import fs from 'node:fs/promises';
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

  // 5. Playlists. A set is a file of cue ids, so the things worth asserting
  //    are the round trip, that the export of a set is exactly that set in
  //    that order, that a dangling id is skipped rather than emitted, and
  //    that deleting a cue takes it out of every set holding it.
  const PL = 'zz-verify-set';
  const PL_FILE = path.join(ROOT, 'export', `${PL}.cues.js`);
  const TMP_CUE = 'zz-verify-cue';
  const picked = cues.slice(0, 2).map((c) => c.id);
  if (picked.length < 2) fail('playlist check: need at least two cues in the library');
  else {
    // A well-formed id for a cue that does not exist: allowed on disk (the cue
    // may be saved later), and skipped by the exporter rather than emitted.
    const wanted = [picked[1], 'zz-no-such-cue', picked[0]];
    const saved = await api(page, 'POST', '/api/playlist',
      { id: PL, name: 'Verify Set', description: 'written by npm test', cues: wanted });
    if (saved.playlist?.id !== PL) fail(`playlist check: save returned ${JSON.stringify(saved.playlist?.id)}`);
    if (String(saved.playlist?.cues) !== String(wanted)) {
      fail(`playlist check: cues came back as ${JSON.stringify(saved.playlist?.cues)}`);
    }

    const listed = (await api(page, 'GET', '/api/playlists')).playlists.find((p) => p.id === PL);
    if (!listed) fail('playlist check: the saved playlist is not in GET /api/playlists');

    // The whole-library module gains a PLAYLISTS map; it keeps every cue.
    await api(page, 'POST', '/api/export', {});
    const whole = await freshImport(path.join(ROOT, 'export', 'cues.js'));
    if (whole.CUE_NAMES.length !== cues.length) {
      fail(`playlist check: whole-library export dropped to ${whole.CUE_NAMES.length} cues`);
    }
    if (String(whole.PLAYLISTS?.[PL]) !== String(wanted)) {
      fail(`playlist check: PLAYLISTS.${PL} is ${JSON.stringify(whole.PLAYLISTS?.[PL])}`);
    }

    // The per-playlist module is that set alone, in the playlist's order.
    const res = await api(page, 'POST', '/api/export', { playlist: PL });
    if (res.path !== `export/${PL}.cues.js`) fail(`playlist check: exported to ${res.path}`);
    const only = await freshImport(PL_FILE);
    const expect = wanted.filter((id) => cues.some((c) => c.id === id));
    if (String(only.CUE_NAMES) !== String(expect)) {
      fail(`playlist check: ${PL}.cues.js holds ${JSON.stringify(only.CUE_NAMES)}, expected ${JSON.stringify(expect)}`);
    }
    if ('PLAYLISTS' in only) fail('playlist check: a per-playlist module should not carry a PLAYLISTS map');
    for (const id of expect) {
      if (typeof only.CUES[id]?.render !== 'function') fail(`playlist check: ${id} has no render() in ${PL}.cues.js`);
    }

    // The board filters to the set, and the search box narrows within it.
    const scoped = await page.evaluate(async (id) => {
      await window.__piezo.loadPlaylists();
      const inSet = window.__piezo.setScope(id);
      const name = window.__piezo.state.cues.find((c) => c.id === inSet[0]).name;
      const searched = window.__piezo.setSearch(name);
      window.__piezo.setSearch('');
      const all = window.__piezo.setScope('');
      return { inSet, searched, all };
    }, PL);
    if (String(scoped.inSet) !== String(expect)) {
      fail(`playlist check: the board shows ${JSON.stringify(scoped.inSet)} for the set, expected ${JSON.stringify(expect)}`);
    }
    if (!scoped.searched.length || scoped.searched.length >= scoped.inSet.length) {
      fail(`playlist check: searching within the set returned ${scoped.searched.length} of ${scoped.inSet.length}`);
    }
    if (scoped.all.length !== cues.length) fail('playlist check: clearing the filter did not restore the library');

    // Deleting a cue clears it out of the sets holding it. Done on a cue made
    // for the purpose, so the library the rest of this run measured is intact.
    const tmp = await api(page, 'POST', '/api/save', {
      id: TMP_CUE, name: 'Verify Cue', code: 'const o = ctx.createOscillator();'
        + ' o.connect(out); o.start(t0); o.stop(t0 + 0.05); return t0 + 0.05;',
      params: [], values: {},
    });
    if (tmp.cue?.id !== TMP_CUE) fail(`playlist check: temp cue saved as ${JSON.stringify(tmp.cue?.id)}`);
    await api(page, 'POST', '/api/playlist', { id: PL, name: 'Verify Set', cues: [...wanted, TMP_CUE] });
    const del = await api(page, 'DELETE', `/api/cue/${TMP_CUE}`);
    if (!del.playlists?.includes(PL)) fail(`playlist check: deleting a cue did not prune ${PL} (pruned ${JSON.stringify(del.playlists)})`);
    const after = (await api(page, 'GET', '/api/playlists')).playlists.find((p) => p.id === PL);
    if (after?.cues.includes(TMP_CUE)) fail('playlist check: the deleted cue is still in the playlist');

    await api(page, 'DELETE', `/api/playlist/${PL}`);
    if ((await api(page, 'GET', '/api/playlists')).playlists.some((p) => p.id === PL)) {
      fail('playlist check: the playlist survived its own delete');
    }
    await fs.rm(PL_FILE, { force: true });

    // Leave export/cues.js as the library's own, not this check's.
    await api(page, 'POST', '/api/export', {});
    const clean = await freshImport(path.join(ROOT, 'export', 'cues.js'));
    if (PL in (clean.PLAYLISTS || {})) fail('playlist check: the test set is still in export/cues.js');
  }

  // 6. The zip a playlist downloads as. Nobody here can open a zip by ear
  //    either, so it is taken back apart: every entry's CRC recomputed, and
  //    the WAV that comes out compared byte for byte with the one that went
  //    in. A download that no unzipper accepts is exactly the sort of thing
  //    that ships broken and stays broken.
  const archive = await page.evaluate(async (ids) => {
    const files = await window.__piezo.wavsOf(ids);
    files.push({ name: 'manifest.txt', data: 'two cues\n' });
    const bytes = window.__piezo.zip(files);
    return {
      zip: [...bytes],
      files: files.map((f) => ({ name: f.name, bytes: [...new Uint8Array(f.data instanceof ArrayBuffer ? f.data : new TextEncoder().encode(f.data))] })),
    };
  }, picked);
  checkZip(Buffer.from(archive.zip), archive.files);

  // 7. A cue that schedules before t0 renders live and throws under
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

/** Call the API from inside the page, so it is the same origin the board uses. */
function api(page, method, path, body) {
  return page.evaluate(async ([m, p, b]) => {
    const r = await fetch(p, {
      method: m,
      headers: b === null ? {} : { 'content-type': 'application/json' },
      body: b === null ? undefined : JSON.stringify(b),
    });
    const json = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`${m} ${p}: ${json.error || r.status}`);
    return json;
  }, [method, path, body === undefined ? null : body]);
}

/** import() a generated module, past the ESM cache, since it is rewritten. */
function freshImport(file) {
  return import(pathToFileURL(file).href + `?t=${Date.now()}-${Math.random()}`);
}

/**
 * Take a zip back apart and check it against what went into it: the end-of-
 * central-directory record, one central header and one local header per entry,
 * stored (never compressed), a CRC recomputed here bit by bit rather than with
 * the archive's own table, and the payload byte for byte.
 */
function checkZip(buf, expected) {
  const at = buf.length - 22;                       // no archive comment
  if (at < 0 || buf.readUInt32LE(at) !== 0x06054b50) { fail('zip: no end-of-central-directory record'); return; }
  const count = buf.readUInt16LE(at + 10);
  const dirSize = buf.readUInt32LE(at + 12);
  const dirAt = buf.readUInt32LE(at + 16);
  if (count !== expected.length) fail(`zip: says ${count} entries, ${expected.length} went in`);
  if (dirAt + dirSize !== at) fail(`zip: the central directory does not end where the EOCD begins`);

  let p = dirAt;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) { fail(`zip: entry ${i} has no central header`); return; }
    const nameLen = buf.readUInt16LE(p + 28);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    const local = buf.readUInt32LE(p + 42);
    p += 46 + nameLen + buf.readUInt16LE(p + 30) + buf.readUInt16LE(p + 32);

    const want = expected[i];
    if (name !== want.name) { fail(`zip: entry ${i} is ${JSON.stringify(name)}, expected ${JSON.stringify(want.name)}`); continue; }
    if (buf.readUInt32LE(local) !== 0x04034b50) { fail(`zip: ${name} has no local header`); continue; }
    if (buf.readUInt16LE(local + 8) !== 0) { fail(`zip: ${name} is not stored`); continue; }
    const size = buf.readUInt32LE(local + 18);
    const localName = buf.readUInt16LE(local + 26);
    const data = buf.subarray(local + 30 + localName + buf.readUInt16LE(local + 28),
      local + 30 + localName + buf.readUInt16LE(local + 28) + size);

    const bytes = Buffer.from(want.bytes);
    if (size !== bytes.length) fail(`zip: ${name} is ${size} bytes, ${bytes.length} went in`);
    else if (!data.equals(bytes)) fail(`zip: ${name} does not survive the round trip`);
    const crc = buf.readUInt32LE(local + 14);
    if (crc !== crc32(data)) fail(`zip: ${name} has crc ${crc.toString(16)}, computed ${crc32(data).toString(16)}`);
  }
}

/* Bit by bit, and deliberately not the table-driven one in public/zip.mjs: a
   checksum checked against itself checks nothing. */
function crc32(bytes) {
  let c = 0xffffffff;
  for (const b of bytes) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

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
