import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import * as sd from '../public/lib/sdjwt.js';
import {
  STATUS_LIST_ENTRIES, STATUS_LIST_TTL, statusReference, verifyStatusList, loadStatusList, isRevoked,
} from '../public/lib/credential-status.js';

void globalThis.fetch;
let issuer;
const publicUrl = 'https://issuer.example.org';
const id = '4278930d-50b9-4c62-9afd-088fd9434be4';
const uri = `${publicUrl}/api/status-lists/${id}`;
const seconds = () => Math.floor(Date.now() / 1000);
before(async () => { issuer = { ...await sd.generateKeyPair(), id, publicUrl, statusListUrl: uri }; });

async function token({ bytes = new Uint8Array(STATUS_LIST_ENTRIES / 8), payload = {}, header = {}, signer = issuer } = {}) {
  return sd.signJwt({ alg: 'ES256', typ: 'statuslist+jwt', ...header }, {
    iss: issuer.did, sub: uri, iat: seconds(), exp: seconds() + STATUS_LIST_TTL, ttl: STATUS_LIST_TTL,
    status_list: { bits: 1, lst: sd.b64url(deflateSync(bytes)) }, ...payload,
  }, signer.privateJwk);
}

test('Credential status references are signed indices at the registered issuer, never arbitrary callback URLs', () => {
  const reference = { idx: 17, uri };
  assert.deepEqual(statusReference({ status: { status_list: reference } }, issuer), reference);
  assert.throws(() => statusReference({}, issuer), /ältere.*neu ausstellen/);
  for (const change of [{ idx: -1 }, { idx: 0.1 }, { idx: STATUS_LIST_ENTRIES },
    { idx: '1' }, { uri: 'http://localhost:9000/private' }, { uri: `${uri}?credential=secret` }]) {
    assert.throws(() => statusReference({ status: { status_list: { ...reference, ...change } } }, issuer), /Statusreferenz/);
  }
  assert.throws(() => statusReference({ status: { status_list: reference } }, publicUrl), /Organisationskennung/);
  assert.throws(() => statusReference({ status: { status_list: reference } }, { ...issuer, id: '../private' }), /Organisationskennung/);
  assert.throws(() => statusReference({ status: { status_list: reference } }, { ...issuer, statusListUrl: `${uri}?secret` }), /Statuslisten-Adresse/);
  assert.throws(() => statusReference({ status: { status_list: reference } }, {
    ...issuer, id: '258ba4ce-8db0-4bdb-b4a2-22f9419d7e89', statusListUrl: undefined,
  }), /Statusreferenz/);
});

test('Signed fixed-size lists use least-significant-bit index order and expose no credential IDs or claims', async () => {
  const bytes = new Uint8Array(STATUS_LIST_ENTRIES / 8);
  for (const index of [0, 7, 8, STATUS_LIST_ENTRIES - 1]) bytes[Math.floor(index / 8)] |= 1 << (index % 8);
  const signed = await token({ bytes });
  const list = await verifyStatusList(signed, { issuerDid: issuer.did, uri });
  for (const index of [0, 7, 8, STATUS_LIST_ENTRIES - 1]) assert.equal(isRevoked(list, index), true);
  for (const index of [1, 6, 9, STATUS_LIST_ENTRIES - 2]) assert.equal(isRevoked(list, index), false);
  assert.throws(() => isRevoked(list, STATUS_LIST_ENTRIES), /Index/);
  assert.deepEqual(Object.keys(sd.decodeJwt(signed).payload.status_list).sort(), ['bits', 'lst']);
});

test('Status signatures, issuer, URL, token type, freshness and decompressed size must all be valid', async () => {
  const stranger = await sd.generateKeyPair();
  for (const options of [
    { signer: stranger }, { header: { typ: 'wrong+jwt' } }, { payload: { iss: stranger.did } },
    { payload: { sub: 'https://other.example.org/api/status-list' } },
    { payload: { exp: seconds() - 1 } }, { payload: { iat: seconds() + 60 } },
    { payload: { exp: seconds() + 3600 } }, { payload: { ttl: 300 } },
    { payload: { status_list: { bits: 2, lst: 'abcd' } } },
    { bytes: new Uint8Array(STATUS_LIST_ENTRIES / 8 - 1) },
    { bytes: new Uint8Array(STATUS_LIST_ENTRIES / 8 + 1) },
    { bytes: new Uint8Array(100000) },
  ]) {
    await assert.rejects(verifyStatusList(await token(options), { issuerDid: issuer.did, uri }));
  }
  const fresh = await token();
  await assert.rejects(verifyStatusList(fresh, {
    issuerDid: issuer.did, uri, now: (seconds() + STATUS_LIST_TTL + 1) * 1000,
  }), /nicht mehr aktuell/);
  const iat = seconds();
  const boundary = await token({ payload: { iat, exp: iat + STATUS_LIST_TTL } });
  await verifyStatusList(boundary, { issuerDid: issuer.did, uri, now: (iat + STATUS_LIST_TTL) * 1000 - 1 });
  await assert.rejects(verifyStatusList(boundary, {
    issuerDid: issuer.did, uri, now: (iat + STATUS_LIST_TTL) * 1000,
  }), /nicht mehr aktuell/);
});

test('List fetching sends no credential identifier, cookies or management token and never follows redirects', async (t) => {
  const signed = await token();
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, uri);
    assert.equal(options.redirect, 'error');
    assert.equal(options.credentials, 'omit');
    assert.equal(options.cache, 'no-store');
    assert.deepEqual(options.headers, { Accept: 'application/statuslist+jwt' });
    return new Response(signed, { headers: { 'Content-Type': 'application/statuslist+jwt' } });
  });
  assert.equal((await loadStatusList(issuer)).bytes.length, STATUS_LIST_ENTRIES / 8);
});

test('Unavailable, unexpected, oversized and stalled list responses are explicit failures, never active defaults', async (t) => {
  for (const response of [
    new Response('', { status: 503 }),
    new Response('{}', { headers: { 'Content-Type': 'application/json' } }),
    new Response('x'.repeat(17000), { headers: { 'Content-Type': 'application/statuslist+jwt' } }),
  ]) {
    t.mock.method(globalThis, 'fetch', async () => response);
    await assert.rejects(loadStatusList(issuer));
    t.mock.restoreAll();
  }
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  }));
  await assert.rejects(loadStatusList(issuer, { timeoutMs: 10 }), /nicht rechtzeitig/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => new Response(new ReadableStream({
    start(controller) { signal.addEventListener('abort', () => controller.error(signal.reason), { once: true }); },
  }), { headers: { 'Content-Type': 'application/statuslist+jwt' } }));
  await assert.rejects(loadStatusList(issuer, { timeoutMs: 10 }), /nicht rechtzeitig/);
});

test('A status response that expires during asynchronous work is never accepted as a cached active result', async (t) => {
  const signed = await token();
  const exp = sd.decodeJwt(signed).payload.exp * 1000;
  let time = exp - 1;
  t.mock.method(globalThis, 'fetch', async () => {
    return new Response(signed, { headers: { 'Content-Type': 'application/statuslist+jwt' } });
  });
  let reads = 0;
  await assert.rejects(loadStatusList(issuer, { now: () => { reads++; return reads === 1 ? time : time + 1; } }), /nicht mehr aktuell/);
  assert.ok(reads >= 2);
});
