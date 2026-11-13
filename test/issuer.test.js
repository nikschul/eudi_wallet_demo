import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rename, rmdir } from 'node:fs/promises';
import path from 'node:path';
import * as sd from '../public/lib/sdjwt.js';
import { ROLES, decodeOffer } from '../public/lib/protocol.js';
import { verifyStatusList, isRevoked } from '../public/lib/credential-status.js';
import { fixture, claims, noSecrets } from './helpers/hosted.js';

test('Browser organisation creation is immutable, bounded, pending and keeps only hashed access', async (t) => {
  const f = await fixture(t);
  assert.deepEqual((await f.call('/api/issuer/session')).data, { organisation: null, roles: ROLES });
  assert.deepEqual((await f.call('/api/issuer/status')).data, { organisation: null, roles: ROLES });
  for (const body of [{}, { name: '' }, { name: 'x'.repeat(121) }, { name: 'A', ownerName: 'No' },
    { name: 'A', employeeName: 'No' }, { name: 'A', did: 'did:forged' }]) {
    assert.equal((await f.call('/api/organisations', { body })).status, 400);
  }
  const tenant = await f.organisation('  Example Organisation  ');
  assert.equal(tenant.org.name, 'Example Organisation');
  assert.equal(tenant.org.state, 'pending');
  assert.equal(tenant.org.proofVerified, true);
  assert.equal(tenant.org.trusted, false);
  assert.equal(tenant.org.approvedAt, null);
  assert.equal(tenant.org.statusListUrl, `${f.base}/api/status-lists/${tenant.org.id}`);
  assert.equal((await tenant.owner('/status')).data.organisation.id, tenant.org.id);
  assert.equal((await f.call('/api/organisations', { cookie: tenant.cookie, body: { name: 'Replacement' } })).status, 409);
  assert.equal((await tenant.owner('/offers', { claims })).status, 409);
  assert.equal((await tenant.owner('/setup', { name: 'New' })).status, 404);
  noSecrets((await f.call('/api/issuers')).data);
  const state = await readFile(path.join(f.directory, 'hosted-state.json'), 'utf8');
  assert.equal(state.includes(tenant.cookie.split('=')[1]), false);
  const response = await f.call('/api/organisations', { body: { name: 'Cookie flags' } });
  assert.match(response.headers.get('set-cookie'), /HttpOnly/);
  assert.match(response.headers.get('set-cookie'), /SameSite=Strict/);
  assert.match(response.headers.get('set-cookie'), /Max-Age=2592000/);
  assert.doesNotMatch(response.headers.get('set-cookie'), /; Secure/);
});

test('HTTPS origin sets Secure behind a tunnel; forged cookie and cross-site JSON cannot manage an organisation', async (t) => {
  const f = await fixture(t, { publicUrl: 'https://workshop.example.org' });
  const created = await f.call('/api/organisations', { body: { name: 'Tunnel org' } });
  assert.match(created.headers.get('set-cookie'), /; Secure/);
  assert.equal((await f.call('/api/issuer/credentials', { headers: { 'X-Admin-Token': f.adminToken } })).status, 401);
  assert.equal((await f.call('/api/issuer/credentials', { cookie: 'eudi_org_access=bad' })).status, 401);
  assert.equal((await f.call('/api/organisations', { body: { name: 'Foreign' }, headers: { Origin: 'https://attacker.example' } })).status, 403);
  assert.equal((await f.call('/api/organisations', { body: { name: 'Foreign' }, headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  const response = await fetch(`${f.base}/api/organisations`, {
    method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"name":"Forged"}',
  });
  assert.equal(response.status, 415);
  assert.equal((await f.call('/api/issuers')).data.length, 1);
});

test('Two tenants have unique persistent key/DID binding and isolated offers and credential ledgers', async (t) => {
  const f = await fixture(t);
  const a = await f.organisation('Organisation A');
  const b = await f.organisation('Organisation B');
  assert.notEqual(a.org.did, b.org.did);
  assert.notEqual(a.org.fingerprint, b.org.fingerprint);
  assert.equal(a.org.publicUrl, b.org.publicUrl);
  const issued = await f.issue(a);
  const records = (await a.owner('/credentials')).data;
  assert.equal(records.length, 1);
  assert.deepEqual((await b.owner('/credentials')).data, []);
  assert.equal((await b.owner(`/offers/${issued.offer.id}`)).status, 404);
  assert.equal((await b.owner(`/offers/${issued.offer.id}/cancel`, {})).status, 404);
  assert.equal((await b.owner(`/credentials/${records[0].id}/revoke`, {})).status, 404);
  const jwt = sd.parseSdJwt(issued.sdjwt).jwt;
  assert.equal((await sd.verifyJwt(jwt, sd.jwkFromDid(a.org.did))).payload.iss, a.org.did);
  await assert.rejects(sd.verifyJwt(jwt, sd.jwkFromDid(b.org.did)), /Signatur/);
  assert.deepEqual(sd.describeCredential(issued.sdjwt).claims, { ...claims, organisation: a.org.name });
  const oldAdmin = f.adminToken;
  await f.restart();
  assert.notEqual(f.adminToken, oldAdmin);
  assert.equal((await a.owner('/session')).data.organisation.did, a.org.did);
  assert.equal((await b.owner('/session')).data.organisation.did, b.org.did);
  assert.deepEqual((await a.owner('/credentials')).data, records);
  assert.equal((await f.wallet(issued.offer, '/credential', { proof: await f.proof(issued.offer, issued.holder) })).data.sdjwt, issued.sdjwt);
});

test('Signed claims reject forged organisation and issuer inputs, arbitrary roles, and invalid names', async (t) => {
  const f = await fixture(t);
  const a = await f.organisation();
  await f.trust(a.org);
  for (const body of [
    { claims: { ...claims, organisation: 'Forged' } },
    { claims: { ...claims, issuerDid: a.org.did } },
    { claims, organisation: a.org.name }, { claims, issuer: a.org.did },
    { claims: { ...claims, role: 'Administrator' } }, { claims: { ...claims, role: undefined } },
    { claims: { ...claims, given_name: '' } }, { claims: { ...claims, family_name: 'x'.repeat(121) } },
  ]) assert.equal((await a.owner('/offers', body)).status, 400, JSON.stringify(body));
  for (const role of ROLES) {
    const offer = await f.offer(a, { ...claims, role });
    assert.equal(offer.claims.organisation, a.org.name);
    assert.equal(offer.claims.role, role);
  }
  assert.equal((await f.call(`/api/admin/issuers/${encodeURIComponent(a.org.did)}/trust`, {
    admin: true, body: { trusted: true, ownerName: 'Unwanted attribution' },
  })).status, 400);
});

test('A capability plus correct issuer-only code and wallet proof immediately signs once with idempotent retry', async (t) => {
  const f = await fixture(t);
  const a = await f.organisation();
  await f.trust(a.org);
  const offer = await f.offer(a);
  assert.match(offer.transactionCode, /^\d{6}$/);
  const link = decodeOffer(new URL(offer.url).hash);
  assert.equal(link.issuer, a.org.did);
  assert.equal(new URL(offer.url).origin, f.base);
  assert.equal((await f.call(`/api/offers/${offer.id}`)).status, 401);
  const metadata = (await f.wallet(offer)).data;
  assert.equal(metadata.transactionCode, undefined);
  assert.equal(metadata.holderDid, undefined);
  assert.equal(metadata.issuerDid, a.org.did);
  const holder = await sd.generateKeyPair();
  const proof = await f.proof(offer, holder);
  for (const suffix of ['/credential', '/ack']) assert.equal((await f.wallet(offer, suffix, { proof })).status, 409);
  const results = await Promise.all(Array.from({ length: 3 }, () => f.wallet(offer, '/claim', { proof, transactionCode: offer.transactionCode })));
  assert.ok(results.every((result) => result.status === 200 && result.data.status === 'issued'));
  assert.equal((await a.owner('/credentials')).data.length, 1);
  assert.equal((await a.owner(`/offers/${offer.id}/approve`, {})).status, 404);
  const received = await f.wallet(offer, '/credential', { proof });
  assert.equal(received.status, 200);
  assert.equal(sd.describeCredential(received.data.sdjwt).payload.iss, a.org.did);
  assert.equal(sd.didFromJwk(sd.describeCredential(received.data.sdjwt).payload.cnf.jwk), holder.did);
  assert.equal((await a.owner(`/offers/${offer.id}`)).data.transactionCode, undefined);
  assert.equal((await f.wallet(offer, '/ack', { proof })).data.status, 'accepted');
  assert.equal((await f.wallet(offer, '/ack', { proof })).data.status, 'accepted');
  assert.equal((await f.wallet(offer, '/claim', { proof })).data.status, 'accepted');
  assert.equal((await f.wallet(offer, '/credential', { proof })).data.sdjwt, received.data.sdjwt);
  const other = await sd.generateKeyPair();
  for (const suffix of ['/claim', '/credential', '/ack']) {
    assert.equal((await f.wallet(offer, suffix, { proof: await f.proof(offer, other),
      ...(suffix === '/claim' ? { transactionCode: offer.transactionCode } : {}) })).status, 409);
  }
});

test('Proof purpose, audience, issuer and nonce are checked; five wrong codes permanently cancel', async (t) => {
  const f = await fixture(t);
  const a = await f.organisation();
  await f.trust(a.org);
  const offer = await f.offer(a);
  const holder = await sd.generateKeyPair();
  for (const [changes, type] of [[{ nonce: 'wrong' }], [{ aud: 'https://other.example' }], [{ iss: a.org.did }], [{}, 'wrong+jwt']]) {
    assert.equal((await f.wallet(offer, '/claim', {
      proof: await f.proof(offer, holder, changes, type), transactionCode: offer.transactionCode,
    })).status, 400);
  }
  const proof = await f.proof(offer, holder);
  for (const code of [undefined, '12345', 123456]) {
    assert.equal((await f.wallet(offer, '/claim', { proof, transactionCode: code })).status, 400);
  }
  const wrong = offer.transactionCode === '000000' ? '111111' : '000000';
  for (let index = 0; index < 5; index++) {
    assert.equal((await f.wallet(offer, '/claim', { proof, transactionCode: wrong })).status, index === 4 ? 429 : 400);
  }
  await f.restart();
  assert.equal((await f.wallet(offer, '/claim', { proof, transactionCode: offer.transactionCode })).status, 410);
  assert.equal((await a.owner(`/offers/${offer.id}`)).data.status, 'cancelled');
  assert.deepEqual((await a.owner('/credentials')).data, []);
});

test('Suspension stops open claims, issuance withdrawn during signing and credential pickup', async (t) => {
  const f = await fixture(t);
  const a = await f.organisation();
  await f.trust(a.org);
  const offer = await f.offer(a);
  const holder = await sd.generateKeyPair();
  const body = { proof: await f.proof(offer, holder), transactionCode: offer.transactionCode };
  await f.trust(a.org, false);
  assert.equal((await f.wallet(offer, '/claim', body)).status, 409);
  await f.trust(a.org);
  const original = crypto.subtle.sign;
  let withdrew = false;
  t.mock.method(crypto.subtle, 'sign', async function (...args) {
    const input = new TextDecoder().decode(args[2]);
    if (!withdrew && sd.parseB64Json(input.split('.')[0]).typ === 'dc+sd-jwt') {
      withdrew = true;
      await f.trust(a.org, false);
    }
    return original.apply(this, args);
  });
  assert.equal((await f.wallet(offer, '/claim', body)).status, 409);
  assert.equal(withdrew, true);
  assert.deepEqual((await a.owner('/credentials')).data, []);
  t.mock.restoreAll();
  await f.trust(a.org);
  assert.equal((await f.wallet(offer, '/claim', body)).data.status, 'issued');
  await f.trust(a.org, false);
  assert.equal((await f.wallet(offer, '/credential', { proof: body.proof })).status, 409);
  assert.equal((await a.owner('/credentials')).status, 200);
  assert.equal((await a.owner('/offers', { claims })).status, 409);
});

test('Revocation remains available while suspended, is permanent, signed, tenant-specific and durable', async (t) => {
  const f = await fixture(t);
  const a = await f.organisation();
  const b = await f.organisation('Other Organisation');
  const credential = await f.issue(a);
  const record = (await a.owner('/credentials')).data[0];
  assert.equal(record.claims.organisation, a.org.name);
  assert.equal(record.holderDid, credential.holder.did);
  assert.equal(record.issuerDid, a.org.did);
  assert.equal(record.revokedAt, null);
  const getList = async (org) => verifyStatusList((await f.call(`/api/status-lists/${org.id}`)).data, {
    issuerDid: org.did, uri: org.statusListUrl,
  });
  assert.equal(isRevoked(await getList(a.org), record.statusIndex), false);
  await f.trust(a.org, false);
  const revoked = await a.owner(`/credentials/${record.id}/revoke`, {});
  assert.equal(revoked.status, 200);
  assert.ok(revoked.data.revokedAt);
  f.advance(1000);
  assert.equal((await a.owner(`/credentials/${record.id}/revoke`, {})).data.revokedAt, revoked.data.revokedAt);
  assert.equal((await a.owner(`/credentials/${record.id}/revoke`, { revoked: false })).status, 400);
  await f.restart();
  assert.equal(isRevoked(await getList(a.org), record.statusIndex), true);
  assert.equal(isRevoked(await getList(b.org), record.statusIndex), false);
  await f.trust(a.org);
  assert.equal((await f.wallet(credential.offer, '/credential', { proof: await f.proof(credential.offer, credential.holder) })).status, 410);
  const checked = await f.checkIn(credential);
  assert.equal(checked.result.data.ok, false);
  assert.equal(checked.result.data.failedAt, 'Widerrufsstatus');
  noSecrets((await f.call('/api/dashboard')).data);
});

test('Recovery is host-only, short lived, one time, persistent, and invalidates previous owner access', async (t) => {
  const f = await fixture(t);
  const a = await f.organisation();
  const b = await f.organisation('Other Organisation');
  const route = `/api/admin/organisations/${a.org.id}/recovery`;
  assert.equal((await f.call(route, { body: {}, cookie: a.cookie })).status, 401);
  const recovery = await f.call(route, { admin: true, body: {} });
  assert.equal(recovery.status, 200);
  const token = new URL(recovery.data.url).hash.slice('#org-access='.length);
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(recovery.data.url, `${f.base}/issuer.html#org-access=${token}`);
  assert.notEqual(token, f.adminToken);
  assert.equal((await a.owner('/credentials')).status, 200, 'Creating a recovery link must not revoke the existing browser');
  assert.equal((await f.call('/api/issuer/recover', { cookie: b.cookie, body: { token } })).status, 409);
  assert.equal((await readFile(path.join(f.directory, 'hosted-state.json'), 'utf8')).includes(token), false);
  await f.restart();
  const restored = await f.call('/api/issuer/recover', { body: { token } });
  assert.equal(restored.status, 200);
  assert.equal(restored.data.organisation.id, a.org.id);
  const cookie = restored.headers.get('set-cookie').split(';')[0];
  assert.notEqual(cookie, a.cookie);
  assert.equal((await a.owner('/credentials')).status, 401);
  assert.equal((await a.owner('/session')).data.organisation, null);
  assert.equal((await f.call('/api/issuer/credentials', { cookie })).status, 200);
  assert.equal((await f.call('/api/issuer/recover', { body: { token } })).status, 410);
  const expired = await f.call(route, { admin: true, body: {} });
  const expiredToken = new URL(expired.data.url).hash.slice('#org-access='.length);
  f.advance(10 * 60 * 1000);
  assert.equal((await f.call('/api/issuer/recover', { body: { token: expiredToken } })).status, 410);
  assert.equal((await f.call('/api/issuer/credentials', { cookie })).status, 200);
  noSecrets((await f.call('/api/issuers')).data);
  noSecrets((await f.call('/api/dashboard')).data);
  f.advance(30 * 24 * 60 * 60 * 1000);
  assert.equal((await f.call('/api/issuer/credentials', { cookie })).status, 401);
});

test('Cancelled and expired offers do not issue and do not expose issuer code in wallet metadata', async (t) => {
  const f = await fixture(t);
  const a = await f.organisation();
  await f.trust(a.org);
  const cancelled = await f.offer(a);
  assert.equal((await a.owner(`/offers/${cancelled.id}/cancel`, {})).data.status, 'cancelled');
  assert.equal((await f.wallet(cancelled)).status, 410);
  const offer = await f.offer(a);
  f.advance(10 * 60 * 1000);
  assert.equal((await f.wallet(offer)).status, 410);
  assert.equal((await a.owner(`/offers/${offer.id}`)).data.status, 'expired');
  assert.equal((await a.owner(`/offers/${offer.id}`)).data.transactionCode, undefined);
  assert.equal((await f.call('/api/status-lists/unknown')).status, 404);
});

test('A failed durable write never releases a credential or binds the wallet, and a later retry issues exactly once', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  await f.trust(tenant.org);
  const offer = await f.offer(tenant);
  const holder = await sd.generateKeyPair();
  const proof = await f.proof(offer, holder);
  const target = path.join(f.directory, 'hosted-state.json');
  const backup = path.join(f.directory, 'saved-state.json');
  const original = crypto.subtle.sign;
  let blocked = false;
  let logged = false;
  t.mock.method(console, 'error', () => { logged = true; });
  t.mock.method(crypto.subtle, 'sign', async function (...args) {
    const signed = await original.apply(this, args);
    if (!blocked && sd.parseB64Json(new TextDecoder().decode(args[2]).split('.')[0]).typ === 'dc+sd-jwt') {
      blocked = true;
      await rename(target, backup);
      await mkdir(target);
    }
    return signed;
  });
  const failed = await f.wallet(offer, '/claim', { proof, transactionCode: offer.transactionCode });
  assert.equal(failed.status, 500);
  assert.equal(logged, true);
  assert.equal(failed.data.sdjwt, undefined);
  assert.deepEqual((await tenant.owner('/credentials')).data, []);
  assert.equal((await tenant.owner(`/offers/${offer.id}`)).data.status, 'offered');
  assert.equal((await f.wallet(offer, '/credential', { proof })).status, 409);
  t.mock.restoreAll();
  await rmdir(target);
  await rename(backup, target);
  assert.equal((await f.wallet(offer, '/claim', { proof, transactionCode: offer.transactionCode })).data.status, 'issued');
  await f.restart();
  assert.equal((await tenant.owner('/credentials')).data.length, 1);
});

test('Changing the hosted origin preserves organisation keys and revocation history but invalidates old offers and credentials', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  const credential = await f.issue(tenant);
  const record = (await tenant.owner('/credentials')).data[0];
  await tenant.owner(`/credentials/${record.id}/revoke`, {});
  f.config.publicUrl = 'https://new-workshop.example.org';
  await f.restart();
  assert.equal((await tenant.owner('/session')).data.organisation.did, tenant.org.did);
  assert.ok((await tenant.owner('/credentials')).data[0].revokedAt);
  assert.equal((await f.wallet(credential.offer)).status, 410);
  assert.equal((await tenant.owner(`/offers/${credential.offer.id}`)).data.status, 'expired');
  const next = await f.issue(tenant);
  assert.equal(new URL(next.offer.url).origin, f.config.publicUrl);
  assert.equal(sd.describeCredential(next.sdjwt).payload.status.status_list.uri,
    `${f.config.publicUrl}/api/status-lists/${tenant.org.id}`);
  assert.equal((await f.checkIn(next)).result.data.ok, true);
});
