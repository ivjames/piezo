#!/usr/bin/env node
/* piezo -- the agent bridge and static server.
 *
 * Local dev tool: binds to 127.0.0.1 by default, holds the Anthropic API key
 * server-side, and keeps the cue library on disk as one JSON file per cue.
 */
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Library, HttpError } from './lib/library.mjs';
import { generate, DEFAULT_MODEL } from './lib/agent.mjs';
import { buildModule } from './lib/exporter.mjs';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

try { process.loadEnvFile(path.join(ROOT, '.env')); }
catch { /* no .env: everything but /api/generate still works */ }

const PORT = Number(process.env.PORT || 8971);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(ROOT, 'public');
const EXPORT_DIR = path.join(ROOT, 'export');
const BAKEOFF_DIR = path.join(ROOT, 'bakeoff');
const library = new Library(path.join(ROOT, 'library'));

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wav': 'audio/wav',
};

const server = http.createServer((req, res) => {
  handle(req, res).catch((err) => {
    const status = err instanceof HttpError ? err.status : 500;
    if (status >= 500) console.error('[error]', err);
    send(res, status, { error: err.message });
  });
});

async function handle(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const route = `${req.method} ${url.pathname}`;

  if (url.pathname.startsWith('/api/')) {
    // Same-origin only. This server has an API key behind it; a page on
    // another origin should not be able to spend it.
    const origin = req.headers.origin;
    if (origin && new URL(origin).host !== req.headers.host) {
      throw new HttpError(403, 'cross-origin requests are not accepted');
    }
  }

  switch (route) {
    case 'GET /api/health':
      return send(res, 200, { ok: true, model: DEFAULT_MODEL, hasKey: !!process.env.ANTHROPIC_API_KEY });

    case 'GET /api/library':
      return send(res, 200, { cues: await library.list() });

    case 'POST /api/generate': {
      const body = await readJson(req);
      const result = await generate(body);
      return send(res, 200, result);
    }

    case 'POST /api/save': {
      const cue = await library.save(await readJson(req));
      return send(res, 200, { cue });
    }

    case 'POST /api/measure': {
      const { measurements } = await readJson(req);
      if (!measurements || typeof measurements !== 'object') {
        throw new HttpError(400, 'measurements object is required');
      }
      const written = [];
      for (const [id, measure] of Object.entries(measurements)) {
        if (await library.putMeasure(id, measure)) written.push(id);
      }
      return send(res, 200, { written });
    }

    // Bake-off runs are local artefacts (gitignored). Listing and reading them
    // is what turns a table of numbers into something you can audition.
    case 'GET /api/bakeoff': {
      let names = [];
      try {
        names = (await fs.readdir(BAKEOFF_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
      } catch { /* no runs yet */ }
      return send(res, 200, { runs: names });
    }

    case 'POST /api/export': {
      const cues = await library.list();
      const code = buildModule(cues);
      await fs.mkdir(EXPORT_DIR, { recursive: true });
      await fs.writeFile(path.join(EXPORT_DIR, 'cues.js'), code);
      return send(res, 200, { path: 'export/cues.js', bytes: Buffer.byteLength(code), cues: cues.length, code });
    }
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/bakeoff/')) {
    const name = decodeURIComponent(url.pathname.slice('/api/bakeoff/'.length));
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) throw new HttpError(400, `bad run name: ${name}`);
    try {
      return send(res, 200, JSON.parse(await fs.readFile(path.join(BAKEOFF_DIR, name), 'utf8')));
    } catch { throw new HttpError(404, `no such run: ${name}`); }
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/cue/')) {
    const id = decodeURIComponent(url.pathname.slice('/api/cue/'.length));
    const gone = await library.remove(id);
    return send(res, gone ? 200 : 404, gone ? { deleted: id } : { error: `no such cue: ${id}` });
  }

  if (req.method === 'GET' || req.method === 'HEAD') {
    if (url.pathname === '/export/cues.js') return sendFile(res, path.join(EXPORT_DIR, 'cues.js'));
    return sendFile(res, resolveStatic(url.pathname));
  }

  throw new HttpError(404, `no route for ${route}`);
}

/** Map a URL path into public/, refusing anything that escapes it. */
function resolveStatic(pathname) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');
  const file = path.resolve(PUBLIC, rel);
  if (file !== PUBLIC && !file.startsWith(PUBLIC + path.sep)) throw new HttpError(403, 'forbidden');
  return file;
}

async function sendFile(res, file) {
  let data;
  try { data = await fs.readFile(file); }
  catch { throw new HttpError(404, `not found: ${path.basename(file)}`); }
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'cache-control': 'no-store',
  });
  res.end(data);
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 2_000_000) { reject(new HttpError(413, 'request body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new HttpError(400, 'request body is not JSON')); }
    });
    req.on('error', reject);
  });
}

server.listen(PORT, HOST, () => {
  const key = process.env.ANTHROPIC_API_KEY ? 'key loaded' : 'NO API KEY - generation disabled';
  // Print the bound port, not the requested one: PORT=0 (the test harness)
  // asks the OS to pick.
  console.log(`piezo on http://${HOST}:${server.address().port}  (${DEFAULT_MODEL}, ${key})`);
});

export { server };
