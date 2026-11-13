import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

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
  for (const key of ['PORT', 'HOST_PORT', 'PUBLIC_URL', 'TRUST_MODE', 'DATA_DIR', 'APP_ROLE', 'WORKSHOP_URL']) delete env[key];
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
  const adminToken = output.match(/Admin-Token: ([A-Za-z0-9_-]{43})/u)?.[1];
  assert.ok(adminToken, output);
  assert.match(output, /privater Freischalt-Link/);
  assert.ok(output.includes(`#admin-token=${adminToken}`));
  return {
    base, adminToken, output,
    async stop() {
      const exited = once(child, 'exit');
      child.kill('SIGTERM');
      const [code, signal] = await exited;
      // Windows terminates SIGTERM targets instead of dispatching a POSIX signal.
      if (process.platform === 'win32' && code === null) assert.equal(signal, 'SIGTERM', output);
      else assert.equal(code, 0, output);
    },
  };
}

test('Configured server starts outside the project directory, stops cleanly and persists across process restarts', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const port = await unusedPort();
  await writeFile(path.join(directory, '.env'), [
    `PORT=${port}`, 'TRUST_MODE=manual',
    `DATA_DIR="${path.join(directory, 'data')}"`,
  ].join('\n'));
  const server = await start(t, directory, port);
  const config = await (await fetch(`${server.base}/api/config`)).json();
  assert.equal(config.publicUrl, `http://localhost:${port}`);
  assert.equal(config.trustMode, 'manual');
  const registered = await fetch(`${server.base}/api/organisations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'Process restart test' }),
  });
  assert.equal(registered.status, 201);
  const organisation = (await registered.json()).organisation;
  const cookie = registered.headers.get('set-cookie').split(';')[0];
  await server.stop();
  const restarted = await start(t, directory, port);
  assert.notEqual(restarted.adminToken, server.adminToken);
  const session = (token) => fetch(`${restarted.base}/api/admin/session`, {
    headers: { 'X-Admin-Token': token },
  });
  assert.equal((await session(server.adminToken)).status, 401);
  assert.equal((await session(restarted.adminToken)).status, 200);
  const issuers = await (await fetch(`${restarted.base}/api/issuers`)).json();
  assert.equal(issuers[0].did, organisation.did);
  assert.equal(issuers[0].trusted, false);
  const tenantSession = await fetch(`${restarted.base}/api/issuer/session`, { headers: { Cookie: cookie } });
  assert.equal((await tenantSession.json()).organisation.id, organisation.id);
  assert.equal((await fetch(`${restarted.base}/wallet.html`)).status, 200);
  await restarted.stop();
});

test('Hosted startup prints public organisation setup and private host links, with no issuer operator runtime', { timeout: 15000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-hosted-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const port = await unusedPort();
  await writeFile(path.join(directory, '.env'), [
    `PORT=${port}`, 'HOST_PORT=8080', 'PUBLIC_URL=https://workshop.example.org',
    `DATA_DIR="${path.join(directory, 'hosted-data')}"`,
  ].join('\n'));
  const server = await start(t, directory, port);
  assert.ok(server.output.includes(`http://localhost:8080/admin.html#admin-token=${server.adminToken}`));
  assert.ok(server.output.includes(`https://workshop.example.org/admin.html#admin-token=${server.adminToken}`));
  assert.ok(server.output.includes('Organisation anlegen: https://workshop.example.org/issuer.html'));
  assert.equal(server.output.includes(`/issuer.html#admin-token=${server.adminToken}`), false);
  assert.deepEqual((await (await fetch(`${server.base}/api/health`)).json()), { ok: true, role: 'workshop' });
  assert.equal((await (await fetch(`${server.base}/api/issuer/session`)).json()).organisation, null);
  await server.stop();
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

test('Obsolete two-server runtime options fail explicitly without starting a separate issuer', { timeout: 10000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-old-startup-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const [extra, expected] of [
    [{ APP_ROLE: 'issuer' }, /separate Issuer-Modus wurde ersetzt/],
    [{ WORKSHOP_URL: 'https://workshop.example.org' }, /alten Zwei-Server-Modus/],
  ]) {
    const env = { ...process.env, DATA_DIR: directory, PORT: '3000' };
    delete env.APP_ROLE;
    delete env.WORKSHOP_URL;
    Object.assign(env, extra);
    const child = spawn(process.execPath, [entrypoint], { env, stdio: ['ignore', 'ignore', 'pipe'] });
    let output = '';
    child.stderr.on('data', (data) => { output += data; });
    const [code] = await once(child, 'exit');
    assert.notEqual(code, 0);
    assert.match(output, expected);
  }
});
