// The entry point: bind an ephemeral port, register it with the env, serve
// until the env reports done, then exit. The env's origin arrives in
// MAKEFUN_ENV_URL and the suite's bearer token in MAKEFUN_SHOP_TOKEN; both
// are the trial harness's to provide, and without the env URL there is
// nothing to register with, so the process exits 1.
//
// Registration retries with backoff on anything but a fatal refusal (400 /
// 405) or a 409, which means an earlier register already won. The done poll
// answers at once and is never held open, so it polls with backoff too. A
// failure anywhere in the lifecycle is written to stderr and exits non-zero
// only when the trial cannot proceed; request-level failures never reach
// this file — the server answers them and keeps serving.

import type { AddressInfo } from 'node:net';
import { createForgeServer } from './src/server.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
const TOKEN = process.env.MAKEFUN_SHOP_TOKEN ?? '';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(line: string): void {
  process.stderr.write(`[entry] ${line}\n`);
}

async function register(port: number): Promise<boolean> {
  let delay = 250;
  const started = Date.now();
  for (;;) {
    try {
      const response = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(5000),
      });
      if (response.status === 200 || response.status === 409) return true;
      if (response.status === 400 || response.status === 405) {
        log(`register refused with HTTP ${response.status}`);
        return false;
      }
      log(`register answered HTTP ${response.status}; retrying`);
    } catch (err) {
      log(`register failed (${(err as Error).message}); retrying`);
    }
    if (Date.now() - started > 60_000) {
      log('register gave up after 60 s');
      return false;
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function waitForDone(): Promise<void> {
  let delay = 250;
  for (;;) {
    try {
      const response = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const data = (await response.json()) as { done?: unknown };
        if (data.done === true) return;
      }
    } catch (err) {
      log(`done poll failed (${(err as Error).message}); retrying`);
    }
    await sleep(delay);
    delay = Math.min(delay * 2, 2000);
  }
}

async function main(): Promise<number> {
  if (ENV_URL === '') {
    log('MAKEFUN_ENV_URL is not set: there is no env to register with');
    return 1;
  }
  const { server } = createForgeServer({ token: TOKEN });
  process.on('uncaughtException', (err) => {
    log(`uncaught exception (staying up): ${err.stack ?? err.message}`);
  });
  process.on('unhandledRejection', (reason) => {
    log(`unhandled rejection (staying up): ${String(reason)}`);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address() as AddressInfo;
  log(`listening on port ${address.port}`);
  if (!(await register(address.port))) {
    server.close();
    return 1;
  }
  log('registered; waiting for the suite to finish');
  await waitForDone();
  log('suite done; shutting down');
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
    server.closeAllConnections();
  });
  return 0;
}

const code = await main();
process.exit(code);
