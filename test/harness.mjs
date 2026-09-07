/* Shared plumbing for anything that has to drive the real page: start the real
   server on an OS-chosen port, and give Chromium an offline clock in place of
   an audio device. Used by test/verify.mjs and tools/bakeoff.mjs so both
   measure through exactly the same path the UI uses. */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Boot server.mjs on PORT=0 and resolve the URL it prints. */
export async function startServer(env = {}) {
  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: ROOT,
    env: { ...process.env, PORT: '0', HOST: '127.0.0.1', ANTHROPIC_API_KEY: '', ...env },
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

/** Replace window.AudioContext with an OfflineAudioContext subclass. */
export const OFFLINE_CLOCK = () => {
  class OfflineStandIn extends OfflineAudioContext {
    constructor() { super(1, 44100 * 10, 44100); }
  }
  Object.defineProperty(window, 'AudioContext', { value: OfflineStandIn, configurable: true });
  Object.defineProperty(window, 'webkitAudioContext', { value: OfflineStandIn, configurable: true });
};
