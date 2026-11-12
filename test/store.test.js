import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createStore } from '../server/store.js';

async function directory(t) {
  const target = await mkdtemp(path.join(tmpdir(), 'eudi-store-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  return target;
}

test('Broken persistent data is reported instead of silently overwritten', async (t) => {
  const target = await directory(t);
  await writeFile(path.join(target, 'issuers.json'), '{ broken');
  assert.throws(() => createStore(target), /konnte nicht geladen/);
  assert.equal(await readFile(path.join(target, 'issuers.json'), 'utf8'), '{ broken');
});

test('A repeated guest only updates the check-in time', async (t) => {
  const store = createStore(await directory(t));
  store.putAttendee('erika', { name: 'Erika', issuerName: 'First issuer', time: '2026-11-12T10:00:00Z' });
  store.putAttendee('erika', {
    name: 'ERIKA', organisation: 'Not added later', issuerName: 'Other issuer', time: '2026-11-12T11:00:00Z',
  });
  assert.deepEqual(store.listAttendees(), [{
    name: 'Erika', issuerName: 'First issuer', time: '2026-11-12T11:00:00Z',
  }]);
});

test('Malformed and duplicate persistent entries fail without modifying the file', async (t) => {
  const target = await directory(t);
  for (const [file, entries] of [
    ['issuers', [null]],
    ['issuers', [{ did: 'did:test', name: 'Test', trusted: 'yes' }]],
    ['issuers', Array(2).fill({ did: 'did:test', name: 'Test', trusted: true })],
    ['attendees', [{ key: 'erika', name: 'Erika', time: 'not-a-date' }]],
    ['attendees', Array(2).fill({ key: 'erika', name: 'Erika', time: '2026-11-12T10:00:00Z' })],
  ]) {
    const filename = path.join(target, `${file}.json`);
    const contents = JSON.stringify(entries);
    await writeFile(filename, contents);
    assert.throws(() => createStore(target), /konnte nicht geladen/);
    assert.equal(await readFile(filename, 'utf8'), contents);
    await rm(filename);
  }
});

test('Purge removes only demo files and works repeatedly', async (t) => {
  const target = await directory(t);
  const store = createStore(target);
  store.putIssuer({ did: 'did:test', name: 'Test', trusted: true });
  store.putAttendee('erika', { name: 'Erika', time: new Date().toISOString() });
  await writeFile(path.join(target, 'unrelated.txt'), 'keep');
  const purge = fileURLToPath(new URL('../server/purge.js', import.meta.url));
  for (let index = 0; index < 2; index++) {
    execFileSync(process.execPath, [purge], { env: { ...process.env, DATA_DIR: target } });
  }
  assert.deepEqual(createStore(target).listIssuers(), []);
  assert.deepEqual(createStore(target).listAttendees(), []);
  assert.equal(await readFile(path.join(target, 'unrelated.txt'), 'utf8'), 'keep');
});

test('Issuer purge resets identity and credential status together without deleting workshop or unrelated data', async (t) => {
  const target = await directory(t);
  for (const name of ['identity.json', 'credentials.json', 'attendees.json', 'unrelated.txt']) {
    await writeFile(path.join(target, name), 'keep');
  }
  const purge = fileURLToPath(new URL('../server/purge.js', import.meta.url));
  for (let index = 0; index < 2; index++) {
    execFileSync(process.execPath, [purge], { env: { ...process.env, APP_ROLE: 'issuer', DATA_DIR: target } });
  }
  for (const name of ['identity.json', 'credentials.json']) {
    await assert.rejects(readFile(path.join(target, name)), { code: 'ENOENT' });
  }
  for (const name of ['attendees.json', 'unrelated.txt']) {
    assert.equal(await readFile(path.join(target, name), 'utf8'), 'keep');
  }
});
