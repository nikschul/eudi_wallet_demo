import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sd from '../public/lib/sdjwt.js';

const entrypoint = fileURLToPath(new URL('../server/index.js', import.meta.url));

async function unusedPort() {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function start(t, directory, port) {
  const env = { ...process.env };
  for (const key of ['PORT', 'PUBLIC_URL', 'ADMIN_TOKEN', 'TRUST_MODE', 'DATA_DIR']) delete env[key];
  const child = spawn(process.execPath, [`--env-file=${path.join(directory, '.env')}`, entrypoint], {
    cwd: tmpdir(), env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (data) => { output += data; });
  child.stderr.on('data', (data) => { output += data; });
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM');
      await once(child, 'exit');
    }
  });
  const deadline = Date.now() + 10000;
  while (!output.includes('EUDI-Demo:')) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() >= deadline) {
      throw new Error(`Server did not start: ${output}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const base = `http://127.0.0.1:${port}`;
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.match(output, /Admin-Token aus der Umgebung/);
  return {
    base,
    async stop() {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const [code] = await exited;
      assert.equal(code, 0, output);
    },
  };
}

test('Configured server starts outside the project directory, stops cleanly and persists across process restarts', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const port = await unusedPort();
  await writeFile(path.join(directory, '.env'), [
    `PORT=${port}`, 'TRUST_MODE=manual', 'ADMIN_TOKEN=startup-test',
    `DATA_DIR="${path.join(directory, 'data')}"`,
  ].join('\n'));
  const server = await start(t, directory, port);
  const config = await (await fetch(`${server.base}/api/config`)).json();
  assert.equal(config.publicUrl, `http://localhost:${port}`);
  assert.equal(config.trustMode, 'manual');
  const issuer = await sd.generateKeyPair();
  const registered = await fetch(`${server.base}/api/issuers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ did: issuer.did, name: 'Process restart test' }),
  });
  assert.equal(registered.status, 201);
  await server.stop();
  const restarted = await start(t, directory, port);
  const issuers = await (await fetch(`${restarted.base}/api/issuers`)).json();
  assert.equal(issuers[0].did, issuer.did);
  assert.equal(issuers[0].trusted, false);
  assert.equal((await fetch(`${restarted.base}/wallet.html`)).status, 200);
  await restarted.stop();
});

test('Invalid ports exit with a configuration error', { timeout: 10000 }, async () => {
  for (const port of ['0', '65536', 'not-a-port']) {
    const child = spawn(process.execPath, [entrypoint], {
      env: { ...process.env, PORT: port }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let output = '';
    child.stderr.on('data', (data) => { output += data; });
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.match(output, /PORT muss zwischen 1 und 65535 liegen/);
  }
});
