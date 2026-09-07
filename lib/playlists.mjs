/* On-disk playlists. One JSON file per playlist under playlists/, so the same
   properties the cue library has hold here too: git-diffable, no database,
   survives a restart.

   A playlist *references* cues by id rather than cues carrying their
   memberships, which is the whole point: a cue can be in several playlists at
   once, and putting one into a playlist writes one file -- the playlist's --
   instead of rewriting every cue's record and bumping its updatedAt. */
import fs from 'node:fs/promises';
import path from 'node:path';

import { HttpError } from './library.mjs';

const ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const MAX_CUES = 500;

export class Playlists {
  constructor(dir) { this.dir = dir; }

  async ensure() { await fs.mkdir(this.dir, { recursive: true }); }

  file(id) {
    if (!ID_RE.test(id)) throw new HttpError(400, `bad playlist id: ${JSON.stringify(id)}`);
    return path.join(this.dir, `${id}.json`);
  }

  async list() {
    await this.ensure();
    const names = (await fs.readdir(this.dir)).filter((f) => f.endsWith('.json'));
    const out = [];
    for (const name of names.sort()) {
      try {
        out.push(JSON.parse(await fs.readFile(path.join(this.dir, name), 'utf8')));
      } catch (err) {
        console.warn(`[playlists] skipping ${name}: ${err.message}`);
      }
    }
    return out.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9)
      || String(a.name).localeCompare(String(b.name))
      || String(a.id).localeCompare(String(b.id)));
  }

  async get(id) {
    try { return JSON.parse(await fs.readFile(this.file(id), 'utf8')); }
    catch (err) { if (err.code === 'ENOENT') return null; throw err; }
  }

  async save(input) {
    await this.ensure();
    const pl = validatePlaylist(input);
    const existing = pl.id ? await this.get(pl.id) : null;
    if (!pl.id) pl.id = await this.uniqueId(slugId(pl.name));
    const now = new Date().toISOString();
    const record = {
      ...existing, ...pl,
      order: pl.order ?? existing?.order,
      createdAt: existing?.createdAt || pl.createdAt || now,
      updatedAt: now,
    };
    await fs.writeFile(this.file(record.id), JSON.stringify(record, null, 2) + '\n');
    return record;
  }

  async remove(id) {
    try { await fs.unlink(this.file(id)); return true; }
    catch (err) { if (err.code === 'ENOENT') return false; throw err; }
  }

  /**
   * Drop a cue id from every playlist that holds it. Deleting a cue is the one
   * way a playlist can end up pointing at nothing, so it is also the one place
   * that has to clean up after itself.
   * @returns {Promise<string[]>} the playlists that changed
   */
  async forget(cueId) {
    const changed = [];
    for (const pl of await this.list()) {
      if (!pl.cues.includes(cueId)) continue;
      pl.cues = pl.cues.filter((id) => id !== cueId);
      pl.updatedAt = new Date().toISOString();
      await fs.writeFile(this.file(pl.id), JSON.stringify(pl, null, 2) + '\n');
      changed.push(pl.id);
    }
    return changed;
  }

  async uniqueId(base) {
    let id = base, n = 2;
    while (await this.get(id)) id = `${base}-${n++}`;
    return id;
  }
}

/** Reject anything that would not survive a round trip. */
export function validatePlaylist(input) {
  if (!input || typeof input !== 'object') throw new HttpError(400, 'playlist must be an object');
  if (input.id != null && !ID_RE.test(input.id)) throw new HttpError(400, `bad playlist id: ${input.id}`);

  const name = String(input.name || '').trim().slice(0, 80);
  if (!name) throw new HttpError(400, 'playlist.name is required');

  const cues = Array.isArray(input.cues) ? input.cues : [];
  if (cues.length > MAX_CUES) throw new HttpError(400, `a playlist holds at most ${MAX_CUES} cues`);
  const seen = new Set();
  const ids = [];
  for (const raw of cues) {
    const id = String(raw);
    // A well-formed id for a cue that does not exist is allowed through -- the
    // cue may be saved after the playlist, and export skips what it can't find.
    if (!ID_RE.test(id)) throw new HttpError(400, `bad cue id in playlist: ${JSON.stringify(raw)}`);
    if (seen.has(id)) continue;      // membership, not a sequence: no duplicates
    seen.add(id);
    ids.push(id);
  }

  return {
    id: input.id || null,
    name,
    description: String(input.description || '').slice(0, 500),
    cues: ids,
    order: Number.isFinite(Number(input.order)) ? Number(input.order) : undefined,
    createdAt: input.createdAt,
  };
}

/** A playlist id derived from its name. Same shape as a cue id. */
export function slugId(s) {
  const out = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '');
  return ID_RE.test(out) ? out : 'playlist';
}

/**
 * The cues of a playlist, in the playlist's order, skipping ids with no cue
 * behind them. A dangling id is a cue deleted out from under the playlist by
 * something that did not call forget() -- an edit to library/ by hand, say.
 */
export function cuesOf(playlist, cues) {
  const byId = new Map(cues.map((c) => [c.id, c]));
  return playlist.cues.map((id) => byId.get(id)).filter(Boolean);
}
