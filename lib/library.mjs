/* On-disk cue library. One JSON file per cue under library/, so the library is
   a git-diffable artefact and survives a restart with no database. */
import fs from 'node:fs/promises';
import path from 'node:path';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

export class Library {
  constructor(dir) { this.dir = dir; }

  async ensure() { await fs.mkdir(this.dir, { recursive: true }); }

  file(id) {
    if (!ID_RE.test(id)) throw new HttpError(400, `bad cue id: ${JSON.stringify(id)}`);
    return path.join(this.dir, `${id}.json`);
  }

  async list() {
    await this.ensure();
    const names = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const cues = [];
    for (const name of names.sort()) {
      try {
        cues.push(JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')));
      } catch (err) {
        console.warn(`[library] skipping ${name}: ${err.message}`);
      }
    }
    return cues.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)
      || String(a.createdAt).localeCompare(String(b.createdAt))
      || String(a.id).localeCompare(String(b.id)));
  }

  async get(id) {
    try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }

  async save(input) {
    await this.ensure();
    const cue = validate(input);
    const existing = cue.id ? await this.get(cue.id) : null;
    if (!cue.id) cue.id = await this.uniqueId(slug(cue.name || cue.prompt || 'cue'));
    const now = new Date().toISOString();
    const record = {
      ...existing, ...cue,
      // A save that says nothing about values or measurements is not a save
      // that clears them -- validate() cannot tell "absent" from "empty".
      values: input.values ? cue.values : (existing?.values ?? cue.values),
      measure: cue.measure ?? existing?.measure ?? null,
      order: cue.order ?? existing?.order,
      createdAt: existing?.createdAt || cue.createdAt || now,
      updatedAt: now,
    };
    await fs.writeFile(this.file(record.id), JSON.stringify(record, null, 2) + '\n');
    return record;
  }

  /** Merge measurements in without touching updatedAt -- measuring is not editing. */
  async putMeasure(id, measure) {
    const cue = await this.get(id);
    if (!cue) return null;
    cue.measure = measure;
    await fs.writeFile(this.file(id), JSON.stringify(cue, null, 2) + '\n');
    return cue;
  }

  async remove(id) {
    try { await fs.unlink(this.file(id)); return true; }
    catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  }

  async uniqueId(base) {
    let id = base, n = 2;
    while (await this.get(id)) id = `${base}-${n++}`;
    return id;
  }
}

export class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function slug(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return out || 'cue';
}

const IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** Reject anything that would not survive a round trip through the contract. */
export function validate(cue) {
  if (!cue || typeof cue !== 'object') throw new HttpError(400, 'cue must be an object');
  if (typeof cue.code !== 'string' || !cue.code.trim()) throw new HttpError(400, 'cue.code is required');
  if (cue.code.length > 100_000) throw new HttpError(400, 'cue.code is implausibly large');
  if (cue.id != null && !ID_RE.test(cue.id)) throw new HttpError(400, `bad cue id: ${cue.id}`);

  const params = Array.isArray(cue.params) ? cue.params : [];
  if (params.length > 12) throw new HttpError(400, 'too many parameters');
  for (const p of params) {
    if (!p || !IDENT_RE.test(String(p.key || ''))) {
      throw new HttpError(400, `parameter key ${JSON.stringify(p?.key)} is not an identifier`);
    }
    for (const f of ['min', 'max', 'default']) {
      if (!Number.isFinite(Number(p[f]))) throw new HttpError(400, `parameter ${p.key}.${f} must be a number`);
    }
  }

  return {
    id: cue.id || null,
    name: String(cue.name || 'Untitled').slice(0, 80),
    description: String(cue.description || '').slice(0, 500),
    prompt: String(cue.prompt || '').slice(0, 2000),
    code: cue.code,
    params: params.map((p) => ({
      key: String(p.key), label: String(p.label || p.key).slice(0, 40),
      min: Number(p.min), max: Number(p.max),
      step: Number.isFinite(Number(p.step)) ? Number(p.step) : 0.01,
      default: Number(p.default), unit: p.unit ? String(p.unit).slice(0, 8) : '',
    })),
    values: plainNumbers(cue.values),
    gain: Number.isFinite(Number(cue.gain)) ? clamp(Number(cue.gain), 0, 64) : 1,
    key: cue.key ? String(cue.key).slice(0, 1) : '',
    order: Number.isFinite(Number(cue.order)) ? Number(cue.order) : undefined,
    measure: cue.measure && typeof cue.measure === 'object' ? cue.measure : null,
    createdAt: cue.createdAt,
  };
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

function plainNumbers(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (IDENT_RE.test(k) && Number.isFinite(Number(v))) out[k] = Number(v);
  }
  return out;
}
