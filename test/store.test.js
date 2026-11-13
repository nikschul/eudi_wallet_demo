import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore, HOSTED_SCHEMA, LEGACY_FILES } from '../server/store.js';
import { createApp } from '../server/app.js';
import { fixture } from './helpers/hosted.js';

async function directory(t) {
  const target = await mkdtemp(path.join(tmpdir(), 'eudi-store-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  return target;
}

test('Legacy two-server data is explicitly rejected, never imported, overwritten or purged', async (t) => {
  const target = await directory(t);
  const purge = fileURLToPath(new URL('../server/purge.js', import.meta.url));
  for (const file of LEGACY_FILES) {
    const filename = path.join(target, file);
    await writeFile(filename, '{ old data');
    assert.throws(() => createStore(target), /Alte Zwei-Server-Daten/);
    assert.throws(() => execFileSync(process.execPath, [purge], {
      env: { ...process.env, DATA_DIR: target }, stdio: 'pipe',
    }));
    assert.equal(await readFile(filename, 'utf8'), '{ old data');
    await rm(filename);
  }
});

test('Versioned hosted files are private; missing state or schema fails closed instead of resetting', async (t) => {
  const target = await directory(t);
  createStore(target);
  for (const file of ['hosted-schema.json', 'hosted-state.json']) {
    if (process.platform !== 'win32') assert.equal((await stat(path.join(target, file))).mode & 0o777, 0o600);
  }
  const state = await readFile(path.join(target, 'hosted-state.json'), 'utf8');
  await rm(path.join(target, 'hosted-state.json'));
  assert.throws(() => createStore(target), /nicht sicher geladen/);
  await writeFile(path.join(target, 'hosted-state.json'), state);
  await rm(path.join(target, 'hosted-schema.json'));
  assert.throws(() => createStore(target), /Speichermarker fehlt/);
  assert.equal(await readFile(path.join(target, 'hosted-state.json'), 'utf8'), state);
});

test('Corrupt state and incompatible schema fail without modifying data', async (t) => {
  const target = await directory(t);
  createStore(target);
  const filename = path.join(target, 'hosted-state.json');
  for (const contents of ['{broken', '[]', '{}', JSON.stringify({ schema: HOSTED_SCHEMA, organisations: null, attendees: [] })]) {
    await writeFile(filename, contents);
    assert.throws(() => createStore(target), /nicht sicher geladen/);
    assert.equal(await readFile(filename, 'utf8'), contents);
  }
  await writeFile(path.join(target, 'hosted-schema.json'), '{"schema":"future-version"}');
  assert.throws(() => createStore(target), /nicht sicher geladen/);
});

test('Credential ledger, key binding, permanent revocation data and check-in history are validated on restart', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  const issued = await f.issue(tenant);
  await f.checkIn(issued);
  const filename = path.join(f.directory, 'hosted-state.json');
  const original = JSON.parse(await readFile(filename, 'utf8'));
  for (const mutate of [
    (state) => { delete state.organisations[0].credentials; },
    (state) => { state.organisations[0].credentials = []; },
    (state) => { state.organisations[0].credentials[0].claims.organisation = 'Forged'; },
    (state) => { state.organisations[0].credentials[0].claims.role = 'Admin'; },
    (state) => { delete state.organisations[0].credentials[0].revokedAt; },
    (state) => { state.organisations[0].credentials.push(state.organisations[0].credentials[0]); },
    (state) => { state.organisations[0].credentials[0].statusIndex = -1; },
    (state) => { state.organisations[0].privateJwk.d = 'broken'; },
    (state) => { state.organisations[0].did = 'did:jwk:broken'; },
    (state) => { state.organisations.push(state.organisations[0]); },
    (state) => { state.organisations[0].offers[0].sdjwt = 'broken'; },
    (state) => { state.organisations[0].ownerName = 'Unwanted personal attribution'; },
    (state) => { state.attendees[0].checkins[0].trustedAtCheckin = false; },
    (state) => { state.attendees[0].issuerOwner = 'Unwanted personal attribution'; },
    (state) => { state.attendees.push(state.attendees[0]); },
  ]) {
    const state = structuredClone(original);
    mutate(state);
    const contents = JSON.stringify(state);
    await writeFile(filename, contents);
    await assert.rejects(createApp(f.config));
    assert.equal(await readFile(filename, 'utf8'), contents);
  }
  await writeFile(filename, JSON.stringify(original));
  await f.restart();
  assert.equal((await tenant.owner('/credentials')).data.length, 1);
});

test('The store enforces immutable organisation identity even for internal mutations', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  const store = createStore(f.directory);
  for (const [field, value] of [['name', 'Renamed'], ['did', 'did:jwk:other'], ['id', crypto.randomUUID()]]) {
    assert.throws(() => store.updateOrganisation(tenant.org.id, (org) => { org[field] = value; }), /darf nicht geändert/);
  }
  const clone = store.getOrganisation(tenant.org.id);
  clone.name = 'Not persisted';
  assert.equal(store.getOrganisation(tenant.org.id).name, tenant.org.name);
});

test('The store rejects changes to existing receipts and never permits revocation rollback', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  await f.issue(tenant);
  const record = (await tenant.owner('/credentials')).data[0];
  await tenant.owner(`/credentials/${record.id}/revoke`, {});
  const store = createStore(f.directory);
  for (const mutate of [
    (org) => { org.credentials = []; },
    (org) => { org.credentials[0].claims.given_name = 'Changed'; },
    (org) => { org.credentials[0].holderDid = org.did; },
    (org) => { org.credentials[0].revokedAt = null; },
    (org) => { org.credentials[0].revokedAt = new Date(Date.now() + 1000).toISOString(); },
  ]) assert.throws(() => store.updateOrganisation(tenant.org.id, mutate), /dürfen nicht geändert/);
});

test('Purge removes only named new hosted files and is repeatable, without touching unrelated data', async (t) => {
  const target = await directory(t);
  createStore(target);
  await writeFile(path.join(target, 'unrelated.txt'), 'keep');
  await writeFile(path.join(target, '.env.issuer'), 'keep private env');
  const purge = fileURLToPath(new URL('../server/purge.js', import.meta.url));
  const env = { ...process.env, DATA_DIR: target };
  delete env.APP_ROLE;
  for (let index = 0; index < 2; index++) execFileSync(process.execPath, [purge], { env });
  assert.equal(await readFile(path.join(target, 'unrelated.txt'), 'utf8'), 'keep');
  assert.equal(await readFile(path.join(target, '.env.issuer'), 'utf8'), 'keep private env');
  assert.deepEqual(createStore(target).listIssuers(), []);
  assert.deepEqual(createStore(target).listAttendees(), []);
});
