import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-tunnel-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all(['scripts', 'bin'].map((name) => mkdir(path.join(directory, name))));
  const script = path.join(directory, 'scripts', 'demo.sh');
  await writeFile(script, await readFile(new URL('../scripts/demo.sh', import.meta.url)));
  const originals = new Map([
    ['.env.workshop', 'PORT=3000\nPUBLIC_URL=https://untouched-workshop.example.org\n'],
    ['.env.issuer', 'PORT=3001\nPUBLIC_URL=https://untouched-issuer.example.org\nWORKSHOP_URL=https://untouched-hub.example.org\n'],
  ]);
  for (const [name, contents] of originals) await writeFile(path.join(directory, name), contents);
  for (const name of ['compose.yaml', 'compose.issuer.yaml', 'compose.tunnel.yaml']) {
    await writeFile(path.join(directory, name), 'services: {}\n');
  }
  const trace = path.join(directory, 'trace.jsonl');
  await writeFile(path.join(directory, 'bin', 'docker'), `#!/usr/bin/env node
const fs = require('node:fs');
const args = process.argv.slice(2);
const env = process.env;
fs.appendFileSync(env.MOCK_TRACE, JSON.stringify({args,publicUrl:env.PUBLIC_URL,workshopUrl:env.WORKSHOP_URL})+'\\n');
if (args[0] === 'info') {
  if (env.MOCK_DOCKER_UNAVAILABLE === '1') {console.error('permission denied'); process.exit(1);}
  process.exit(0);
}
if (args[0] === 'inspect') {
  if (args.includes('{{.State.Running}}')) console.log(env.MOCK_TUNNEL_EXITED === '1' ? 'false' : 'true');
  else console.log(args.includes('{{.State.StartedAt}}') ? '2026-11-12T10:00:00Z' : '3001');
  process.exit(0);
}
const projectIndex = args.indexOf('--project-name');
const role = projectIndex < 0 ? 'workshop' : args[projectIndex + 1].replace('eudi-', '');
const operation = args.find(arg => ['build','up','ps','logs','stop'].includes(arg));
const service = args[args.length-1];
if (operation === 'build' && env.MOCK_BUILD_FAIL === '1') { console.error('build failed'); process.exit(1); }
if (operation === 'ps' && args.includes('-q')) {
  if (service === 'app') console.log('app-'+role);
  else if (!args.includes('--status') || env.MOCK_EXISTING === '1') console.log('tunnel-'+role);
}
if (operation === 'logs') {
  if (service === 'tunnel') {
    console.log(JSON.stringify({message:env.MOCK_NO_URL === '1' ? 'Connecting' : 'Tunnel: https://'+role+'-session.trycloudflare.com'}));
  } else if (env.MOCK_OMIT_LINK !== '1') {
    console.log('Verwaltung per Tunnel (privater Freischalt-Link): '+env.PUBLIC_URL+(role === 'issuer' ? '/issuer.html' : '/admin.html')+'#admin-token=only-a-test-value');
  }
}
`, { mode: 0o755 });
  await writeFile(path.join(directory, 'bin', 'curl'), `#!/usr/bin/env node
const args = process.argv.slice(2);
const url = args[args.length-1];
if (process.env.MOCK_PUBLIC_FAIL === '1' && url.includes('trycloudflare.com')) process.exit(22);
let role = url.includes('issuer-session') ? 'issuer' : 'workshop';
if (process.env.MOCK_HUB_WRONG_ROLE === '1' && url.includes('hub.example.org')) role = 'issuer';
console.log(JSON.stringify({ok:true,role}));
`, { mode: 0o755 });
  return {
    directory, originals,
    run(args, extra = {}) {
      return spawnSync('bash', [script, ...args], {
        cwd: tmpdir(), encoding: 'utf8', timeout: 15000,
        env: {
          ...process.env, PATH: `${path.join(directory, 'bin')}:${process.env.PATH}`,
          WORKSHOP_URL: '', PUBLIC_URL: 'https://stale-shell-value.example.org',
          MOCK_TRACE: trace, ...extra,
        },
      });
    },
    async calls() { return (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line)); },
  };
}

test('Workshop startup discovers HTTPS, preserves env files, verifies health and stores no management token', async (t) => {
  const f = await fixture(t);
  const result = f.run(['workshop']);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Bereit: workshop/);
  assert.match(result.stdout, /https:\/\/workshop-session.trycloudflare.com\/kiosk.html/);
  assert.match(result.stdout, /NUR FÜR DICH/);
  const state = await readFile(path.join(f.directory, '.demo', 'workshop.env'), 'utf8');
  assert.equal(state, 'PUBLIC_URL=https://workshop-session.trycloudflare.com\n');
  assert.doesNotMatch(state, /admin-token|only-a-test-value/);
  for (const [name, value] of f.originals) assert.equal(await readFile(path.join(f.directory, name), 'utf8'), value);
  const calls = await f.calls();
  const app = calls.find(({ args }) => args.includes('up') && args.includes('app'));
  assert.equal(app.publicUrl, 'https://workshop-session.trycloudflare.com');
  assert.ok(app.args.includes('--wait'));
  assert.ok(calls.filter(({ args }) => args.includes('logs')).every(({ args }) => args.includes('--since')));
  assert.equal(calls.some(({ args }) => args.includes('stop')), false);
});

test('Issuer startup remembers the central address and stopping never removes volumes', async (t) => {
  const f = await fixture(t);
  const started = f.run(['issuer', '--workshop-url', 'https://hub.example.org/']);
  assert.equal(started.status, 0, started.stderr);
  assert.match(started.stdout, /Bereit: issuer/);
  assert.match(started.stdout, /http:\/\/localhost:3001\/issuer.html/);
  const state = await readFile(path.join(f.directory, '.demo', 'issuer.env'), 'utf8');
  assert.match(state, /WORKSHOP_URL=https:\/\/hub.example.org\n/);
  const repeated = f.run(['issuer'], { MOCK_EXISTING: '1' });
  assert.equal(repeated.status, 0, repeated.stderr);
  const stopped = f.run(['issuer', 'stop']);
  assert.equal(stopped.status, 0, stopped.stderr);
  const calls = await f.calls();
  assert.ok(calls.some(({ args }) => args.includes('stop') && args.includes('app') && args.includes('tunnel')));
  assert.equal(calls.some(({ args }) => args.includes('down') || args.includes('-v')), false);
  const app = calls.find(({ args }) => args.includes('up') && args.includes('app'));
  assert.equal(app.workshopUrl, 'https://hub.example.org');
});

test('Invalid input, a missing central address or a non-workshop server cannot start an issuer', async (t) => {
  const f = await fixture(t);
  for (const args of [
    ['issuer'], ['issuer', '--workshop-url', 'http://hub.example.org'],
    ['issuer', '--workshop-url', 'https://hub.example.org/path'], ['issuer', '--timeout', '0'],
    ['issuer', '--workshop-url', 'https://hub.example.org', '--unknown'],
  ]) {
    const result = f.run(args);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Fehler:/);
  }
  const wrongRole = f.run(['issuer', '--workshop-url', 'https://hub.example.org'], { MOCK_HUB_WRONG_ROLE: '1' });
  assert.notEqual(wrongRole.status, 0);
  assert.match(wrongRole.stderr, /nicht zu einer Workshop-Zentrale/);
  assert.equal((await f.calls()).some(({ args }) => args.includes('up')), false);
});

test('Docker access and build failures are explicit and cannot create an orphan tunnel', async (t) => {
  const f = await fixture(t);
  const denied = f.run(['workshop'], { MOCK_DOCKER_UNAVAILABLE: '1' });
  assert.notEqual(denied.status, 0);
  assert.match(denied.stderr, /Docker-Daemon ist nicht erreichbar/);
  const build = f.run(['workshop'], { MOCK_BUILD_FAIL: '1' });
  assert.notEqual(build.status, 0);
  assert.match(build.stderr, /build failed/);
  assert.equal((await f.calls()).some(({ args }) => args.includes('up')), false);
});

test('A failed public health check stops only a newly started tunnel, not an already running session', async (t) => {
  for (const existing of [false, true]) {
    const f = await fixture(t);
    const result = f.run(['workshop', '--timeout', '1'], {
      MOCK_PUBLIC_FAIL: '1', MOCK_EXISTING: existing ? '1' : '',
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /öffentliche HTTPS-Tunnel/);
    assert.doesNotMatch(result.stdout, /Bereit:/);
    const stopped = (await f.calls()).filter(({ args }) => args.includes('stop'));
    assert.equal(stopped.length, existing ? 0 : 1);
    if (!existing) assert.equal(stopped[0].args.at(-1), 'tunnel');
  }
});

test('Missing tunnel URLs time out explicitly; status requires the matching live server', async (t) => {
  const f = await fixture(t);
  const timeout = f.run(['workshop', '--timeout', '1'], { MOCK_NO_URL: '1' });
  assert.notEqual(timeout.status, 0);
  assert.match(timeout.stderr, /keine Tunnel-Adresse/);
  assert.equal(f.run(['workshop']).status, 0);
  const status = f.run(['workshop', 'status']);
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /Öffentlich erreichbar und passende Rolle geprüft: workshop/);
  const unavailable = f.run(['workshop', 'status'], { MOCK_PUBLIC_FAIL: '1' });
  assert.notEqual(unavailable.status, 0);
  assert.match(unavailable.stderr, /derzeit nicht erreichbar/);
});

test('A cloudflared process that exits even with status zero is not reported as a successful tunnel', async (t) => {
  const f = await fixture(t);
  const result = f.run(['workshop'], { MOCK_TUNNEL_EXITED: '1' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cloudflared-Prozess wurde beendet/);
  assert.doesNotMatch(result.stdout, /Bereit:/);
  assert.ok((await f.calls()).some(({ args }) => args.includes('stop') && args.at(-1) === 'tunnel'));
});
