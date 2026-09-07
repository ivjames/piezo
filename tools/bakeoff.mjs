#!/usr/bin/env node
/* Head-to-head: the same prompts, several models, every result measured.
 *
 * The point is that "which model should write my cues" is answerable here
 * rather than arguable. A cue either renders or throws; it is audible or
 * silent; it clips or it doesn't; its energy lands where the prompt implies or
 * it doesn't. So this generates the same prompt set on each model, renders
 * every candidate through the same OfflineAudioContext engine the board uses,
 * and prints cost against measured outcome.
 *
 *   node tools/bakeoff.mjs                       # the three current models
 *   node tools/bakeoff.mjs --dry-run             # plan and cost estimate only
 *   node tools/bakeoff.mjs --models claude-opus-5 --effort low,high
 *   node tools/bakeoff.mjs --from bakeoff/<run>.json    # re-measure, no API calls
 *
 * Costs real money: every run is models x prompts x efforts API calls. The
 * estimate is printed before anything is sent.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';

import { generate } from '../lib/agent.mjs';
import { PRICES } from '../lib/pricing.mjs';
import { ROOT, startServer, OFFLINE_CLOCK } from '../test/harness.mjs';

const DEFAULT_MODELS = ['claude-opus-5', 'claude-sonnet-5', 'claude-haiku-4-5'];

/* Chosen to span the space the tool is actually used for: a heavy physical
   impact, a bright metallic scatter, a 1-bit constraint, a soft noisy
   transient, a short UI blip, and something long and low. */
const DEFAULT_PROMPTS = [
  'heavy oak door slamming shut, heard from down a corridor',
  'coins landing on stone',
  '1-bit PC-speaker alert beep',
  'wet footstep in shallow mud',
  'short warm UI confirmation blip',
  'distant thunder rolling in over hills',
];

const args = parseArgs(process.argv.slice(2));
// resolve, not join: an absolute --out must not land inside the repo.
const OUT = path.resolve(ROOT, args.out || 'bakeoff');

const main = async () => {
  let run;

  if (args.from) {
    run = JSON.parse(await fs.readFile(path.resolve(args.from), 'utf8'));
    console.log(`re-measuring ${run.results.length} candidates from ${args.from} (no API calls)\n`);
  } else {
    const models = (args.models || DEFAULT_MODELS.join(',')).split(',').map((s) => s.trim());
    const efforts = (args.effort || '').split(',').map((s) => s.trim()).filter(Boolean);
    const prompts = args.prompts
      ? (await fs.readFile(path.resolve(args.prompts), 'utf8')).split('\n').map((s) => s.trim()).filter(Boolean)
      : DEFAULT_PROMPTS.slice(0, Number(args.n) || DEFAULT_PROMPTS.length);

    const plan = [];
    for (const model of models) {
      for (const effort of efforts.length ? efforts : [null]) {
        // Haiku rejects `effort`; running it once, unset, is the honest cell.
        if (effort && /haiku/.test(model)) continue;
        for (const prompt of prompts) plan.push({ model, effort, prompt });
      }
    }

    printPlan(plan, models);
    if (args['dry-run']) return;
    if (!process.env.ANTHROPIC_API_KEY) {
      console.error('\nANTHROPIC_API_KEY is not set — nothing to run. (--dry-run works without one.)');
      process.exit(1);
    }

    run = { startedAt: new Date().toISOString(), results: [] };
    for (const [i, cell] of plan.entries()) {
      process.stdout.write(`[${i + 1}/${plan.length}] ${cell.model}${cell.effort ? ` @${cell.effort}` : ''}  ${cell.prompt.slice(0, 42)}… `);
      const t0 = Date.now();
      try {
        const res = await generate({ prompt: cell.prompt, model: cell.model, effort: cell.effort });
        run.results.push({ ...cell, ok: true, ms: Date.now() - t0, cue: res.cue, warnings: res.warnings, usage: res.usage });
        console.log(`ok  $${res.usage.costUsd.toFixed(4)}  ${((Date.now() - t0) / 1000).toFixed(1)}s`);
      } catch (err) {
        run.results.push({ ...cell, ok: false, ms: Date.now() - t0, error: String(err.message || err) });
        console.log(`FAILED  ${err.message}`);
      }
    }
  }

  await measure(run);
  await report(run);
};

/* --- measurement: the same engine the board and the tests use ------------ */

async function measure(run) {
  const live = run.results.filter((r) => r.ok && r.cue);
  if (!live.length) return;

  const server = await startServer();
  const browser = await chromium.launch({ args: ['--mute-audio'] });
  try {
    const page = await browser.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(e.message));
    await page.addInitScript(OFFLINE_CLOCK);
    await page.goto(server.url, { waitUntil: 'domcontentloaded' });
    await page.evaluate(() => window.__piezo.ready);

    for (const r of live) {
      r.measure = await page.evaluate(async (cue) => {
        const A = await import('/audio.mjs');
        try {
          const { measure } = await A.renderAndMeasure(cue);
          return measure;
        } catch (err) {
          return { error: String(err && err.message || err) };
        }
      }, { code: r.cue.code, params: r.cue.params, values: r.cue.values, gain: 1 });
    }
    if (pageErrors.length) console.warn(`page errors during measurement: ${pageErrors.join('; ')}`);
  } finally {
    await browser.close();
    server.stop();
  }
}

/* A cue passes if it is something you could actually put on a pad. */
function verdict(r) {
  if (!r.ok) return 'api-error';
  const m = r.measure;
  if (!m || m.error) return 'threw';
  if (!(m.peak > 0.005)) return 'silent';
  if (m.peak > 0.99) return 'clipped';
  if (m.duration < 0.004 || m.duration > 8) return 'bad-length';
  if (m.declaredDuration == null) return 'no-end-time';
  if (r.warnings?.length) return 'lint';
  return 'pass';
}

/* --- reporting ----------------------------------------------------------- */

async function report(run) {
  const rows = run.results.map((r) => [
    r.model.replace('claude-', ''),
    r.effort || '-',
    r.prompt.slice(0, 28),
    verdict(r),
    r.measure && !r.measure.error ? `${r.measure.duration.toFixed(2)}s` : '-',
    r.measure && Number.isFinite(r.measure.peakDb) ? r.measure.peakDb.toFixed(1) : '-',
    r.measure && Number.isFinite(r.measure.rmsDb) ? r.measure.rmsDb.toFixed(1) : '-',
    r.measure && Number.isFinite(r.measure.centroid) ? `${Math.round(r.measure.centroid)}Hz` : '-',
    r.usage ? `${r.usage.output}` : '-',
    r.usage ? `$${r.usage.costUsd.toFixed(4)}` : '-',
    r.ms ? `${(r.ms / 1000).toFixed(1)}s` : '-',
  ]);
  table(['model', 'effort', 'prompt', 'verdict', 'dur', 'peak', 'rms', 'centroid', 'out tok', 'cost', 'time'], rows);

  // Per-model summary: the line that actually answers the question.
  const groups = new Map();
  for (const r of run.results) {
    const key = `${r.model}${r.effort ? ` @${r.effort}` : ''}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const summary = [...groups.entries()].map(([key, rs]) => {
    const pass = rs.filter((r) => verdict(r) === 'pass').length;
    const usable = rs.filter((r) => ['pass', 'lint'].includes(verdict(r))).length;
    const spend = rs.reduce((a, r) => a + (r.usage?.costUsd || 0), 0);
    return [
      key,
      `${pass}/${rs.length}`,
      `${usable}/${rs.length}`,
      `$${spend.toFixed(4)}`,
      `$${(spend / Math.max(1, usable)).toFixed(4)}`,
      `${(rs.reduce((a, r) => a + (r.ms || 0), 0) / rs.length / 1000).toFixed(1)}s`,
    ];
  });
  console.log();
  table(['model', 'clean', 'usable', 'total', 'per usable cue', 'mean time'], summary);
  console.log('\nclean = renders, audible, unclipped, sane length, no lint warning.'
    + '\nusable = the same but tolerating a lint warning. Both are measurements, not taste:'
    + '\nwhether a "thud" sounds like a thud is the centroid column and your ears.');

  await fs.mkdir(OUT, { recursive: true });
  const file = path.join(OUT, `${(run.startedAt || new Date().toISOString()).replace(/[:.]/g, '-')}.json`);
  await fs.writeFile(file, JSON.stringify(run, null, 2) + '\n');
  console.log(`\nfull run: ${path.relative(ROOT, file)}`);
  console.log('re-measure it without spending anything:  node tools/bakeoff.mjs --from '
    + path.relative(ROOT, file));
}

function printPlan(plan, models) {
  console.log(`${plan.length} calls: ${models.length} model(s) x ${plan.length / Math.max(1, models.length)} cell(s) each\n`);
  // ~2.1k input (mostly cached after the first call per model) and ~1.2k
  // visible output, plus thinking, which is the part that varies most.
  let lo = 0, hi = 0;
  for (const c of plan) {
    const p = PRICES[c.model] || PRICES['claude-opus-5'];
    lo += (2100 * p.in * 0.15 + 1200 * p.out) / 1e6;
    hi += (2100 * p.in + 3500 * p.out) / 1e6;
  }
  console.log(`estimated cost: $${lo.toFixed(2)} - $${hi.toFixed(2)} (thinking tokens dominate the spread)`);
}

function table(head, rows) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (cells) => cells.map((c, i) => String(c).padEnd(w[i])).join('  ');
  console.log(line(head));
  console.log(w.map((n) => '-'.repeat(n)).join('  '));
  for (const r of rows) console.log(line(r));
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) out[key] = true;
    else { out[key] = next; i++; }
  }
  return out;
}

await main();
