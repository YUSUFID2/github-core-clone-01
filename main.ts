// Entry lifecycle: bind a free port, tell the trial env about it, then wait
// until the env reports the trial is finished.
//
// The env is reached through MAKEFUN_ENV_URL. The app itself lives in app.ts;
// this file only drives the handshake with the env:
//   - listen on port 0 (the OS picks a free port; never 8080, the env owns it)
//   - POST /register with the bound port (200 ok, 409 means another entry won)
//   - GET /done until the env answers {"done": true}
//   - close the server and exit 0
// A request that fails or times out is retried with exponential backoff.

import { createApp } from './app.ts';

const ENV = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (ENV === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const TIMEOUT_MS = 30_000;
const BACKOFF_START_MS = 250;
const BACKOFF_MAX_MS = 2_000;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoff(attempt: number): number {
  const step = Math.min(attempt, 8);
  return Math.min(BACKOFF_MAX_MS, BACKOFF_START_MS * 2 ** step);
}

async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register failed: HTTP ${res.status} ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register failed:')) throw err;
    }
    await wait(backoff(attempt));
  }
}

async function untilDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV}/done`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) {
        const data = (await res.json()) as { done?: unknown };
        if (data.done === true) return;
      }
    } catch {
      // The env is not answering yet — keep polling.
    }
    await wait(backoff(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('no ephemeral TCP port bound');
  }
  process.stdout.write(`[entry] listening on ${addr.port}\n`);
  await announce(addr.port);
  process.stdout.write('[entry] registered; waiting for done\n');
  await untilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
