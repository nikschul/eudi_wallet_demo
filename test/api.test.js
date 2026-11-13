import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as sd from '../public/lib/sdjwt.js';
import { fixture, noSecrets } from './helpers/hosted.js';
import { ROLES, EMPLOYEE_VCT } from '../public/lib/protocol.js';
import { createApp } from '../server/app.js';

test('Hosted public config has shared-origin setup QR, pages, verifier name and safe static package routes', async (t) => {
  const f = await fixture(t, { publicUrl: 'https://workshop.example.org' });
  assert.deepEqual((await f.call('/api/health')).data, { ok: true, role: 'workshop' });
  const config = (await f.call('/api/config')).data;
  assert.equal(config.publicUrl, 'https://workshop.example.org');
  assert.equal(config.issuerSetupUrl, 'https://workshop.example.org/issuer.html');
  assert.equal(config.verifierName, 'Fraunhofer ISST – Empfang');
  assert.deepEqual(config.roles, ROLES);
  for (const key of ['startQrDataUrl', 'issuerSetupQrDataUrl']) assert.match(config[key], /^data:image\/png;base64,/);
  noSecrets(config);
  const created = (await f.call('/api/requests', { body: {} })).data;
  assert.equal(created.url, `https://workshop.example.org/wallet.html#req=${created.id}`);
  assert.match(created.qrDataUrl, /^data:image\/png;base64,/);
  for (const route of ['/', '/issuer.html', '/wallet.html', '/admin.html', '/kiosk.html']) {
    const page = await f.call(route);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.doesNotMatch(page.headers.get('content-security-policy'), /https?:\/\//);
  }
  const wallet = await f.call('/wallet.html');
  assert.equal(wallet.headers.get('permissions-policy'), 'camera=(self)');
  assert.match(wallet.headers.get('content-security-policy'), /media-src 'self' blob:/);
  assert.match(wallet.headers.get('content-security-policy'), /worker-src 'self'/);
  assert.match(wallet.data, /name="wallet-origin" content="https:\/\/workshop\.example\.org"/);
  assert.deepEqual(JSON.parse(wallet.headers.get('x-workshop-issuer-origins')), [config.publicUrl]);
  for (const route of ['/vendor/qr-scanner/qr-scanner.min.js', '/vendor/qr-scanner/qr-scanner-worker.min.js']) {
    assert.equal((await f.call(route)).status, 200, route);
  }
  for (const route of ['/vendor/qr-scanner/package.json', '/vendor/qr-scanner/../../package.json',
    '/package.json', '/hosted-state.json', '/.env.issuer', '/data/identity.json']) {
    assert.equal((await f.call(route)).status, 404, route);
  }
});

test('PWA manifest, offline shell and real PNG icons are available without caching APIs', async (t) => {
  const f = await fixture(t);
  const manifest = (await f.call('/manifest.webmanifest')).data;
  const parsed = typeof manifest === 'string' ? JSON.parse(manifest) : manifest;
  assert.equal(parsed.display, 'standalone');
  assert.equal(parsed.start_url, '/wallet.html');
  for (const icon of parsed.icons) {
    const response = await fetch(`${f.base}${icon.src}`);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  const sw = (await f.call('/sw.js')).data;
  const shell = sw.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  const routes = [...shell.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.equal(routes.some((route) => route.startsWith('/api')), false);
  for (const route of routes) assert.equal((await f.call(route)).status, 200, route);
  assert.equal((await f.call('/api/config')).headers.get('cache-control'), 'no-store');
});

test('Ten check-ins preserve selective disclosure, history and distinct organisation versus visit metrics across restart', async (t) => {
  const f = await fixture(t);
  const a = await f.organisation('Example Org');
  await f.organisation('Pending org also counts');
  const credential = await f.issue(a);
  for (let index = 0; index < 10; index++) {
    const { request, presentation, result } = await f.checkIn(credential);
    assert.equal(result.data.ok, true, result.data.error);
    assert.equal(result.data.steps.length, 8);
    assert.deepEqual(Object.keys(result.data.claims).sort(), ['family_name', 'given_name']);
    assert.equal((await f.call(`/api/requests/${request.id}`)).data.status, 'done');
    assert.equal((await f.call(`/api/requests/${request.id}/response`, { body: { presentation } })).status, 409);
  }
  const attendees = (await f.call('/api/attendees')).data;
  assert.equal(attendees.length, 1);
  assert.equal(attendees[0].checkins.length, 10);
  assert.equal(attendees[0].organisation, undefined);
  assert.equal(attendees[0].claims.role, undefined);
  noSecrets(attendees);
  const dashboard = (await f.call('/api/dashboard')).data;
  assert.deepEqual(dashboard.stats, { registered: 2, checkins: 10 });
  assert.equal(dashboard.issuers.find((entry) => entry.id === a.org.id).checkinCount, 10);
  assert.equal(dashboard.attendees.length, 1);
  await f.trust(a.org, false);
  assert.deepEqual((await f.call('/api/dashboard')).data.stats, dashboard.stats);
  await f.restart();
  assert.deepEqual((await f.call('/api/dashboard')).data.stats, dashboard.stats);
  assert.deepEqual((await f.call('/api/dashboard')).data.attempts, []);
  await f.trust(a.org);
  const optional = await f.checkIn(credential, ['given_name', 'family_name', 'organisation', 'role']);
  assert.equal(optional.result.data.ok, true);
  assert.equal(optional.result.data.claims.organisation, a.org.name);
  const history = (await f.call('/api/attendees')).data[0].checkins;
  assert.equal(history[0].claims.organisation, undefined);
  assert.equal(history.at(-1).claims.organisation, a.org.name);
});

test('Manual trust, authenticated moderation, replay and reset retain organisations and credential ledger', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  assert.equal((await f.call('/api/admin/reset', { body: {} })).status, 401);
  assert.equal((await f.call('/api/admin/replay', { admin: true, body: {} })).status, 409);
  const credential = await f.issue(tenant);
  assert.equal((await f.checkIn(credential)).result.data.ok, true);
  const replay = await f.call('/api/admin/replay', { admin: true, body: {} });
  assert.equal(replay.data.ok, false);
  assert.match(replay.data.error, /Nonce/);
  assert.equal((await f.call('/api/admin/trust-mode', { admin: true, body: { mode: 'auto' } })).status, 400);
  assert.deepEqual((await f.call('/api/admin/trust-mode', { admin: true, body: { mode: 'manual' } })).data, { mode: 'manual' });
  assert.equal((await f.call('/api/admin/reset', { admin: true, body: {} })).status, 200);
  assert.deepEqual((await f.call('/api/dashboard')).data.stats, { registered: 1, checkins: 0 });
  assert.deepEqual((await f.call('/api/attendees')).data, []);
  assert.equal((await tenant.owner('/credentials')).data.length, 1);
  assert.equal((await f.call('/api/admin/replay', { admin: true, body: {} })).status, 409);
});

test('Requests expire after five minutes and unknown requests return 404', async (t) => {
  const f = await fixture(t);
  const created = (await f.call('/api/requests', { body: {} })).data;
  f.advance(300000);
  assert.equal((await f.call(`/api/requests/${created.id}`)).data.status, 'expired');
  assert.equal((await f.call(`/api/requests/${created.id}/response`, { body: { presentation: 'invalid' } })).status, 410);
  assert.equal((await f.call('/api/requests/missing')).status, 404);
});

test('Concurrent responses consume a QR exactly once', async (t) => {
  const f = await fixture(t);
  const credential = await f.issue(await f.organisation());
  const request = (await f.call('/api/requests', { body: {} })).data;
  const info = (await f.call(`/api/requests/${request.id}`)).data;
  const presentation = await sd.createPresentation({
    sdjwt: credential.sdjwt, reveal: info.required, holderPrivateJwk: credential.holder.privateJwk,
    aud: info.aud, nonce: info.nonce,
  });
  const results = await Promise.all([1, 2].map(() => f.call(`/api/requests/${request.id}/response`, { body: { presentation } })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.deepEqual((await f.call('/api/dashboard')).data.stats, { registered: 1, checkins: 1 });
});

test('Twenty phones share a kiosk QR but get unique single-use nonces and identifiable verified/unverified results', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  const people = [];
  for (let index = 0; index < 20; index++) people.push(await f.issue(tenant));
  const kiosk = (await f.call('/api/requests', { body: { mode: 'kiosk' } })).data;
  assert.equal((await f.call(`/api/requests/${kiosk.id}/response`, { body: { presentation: 'invalid' } })).status, 409);
  const sessions = await Promise.all(people.map(() => f.call(`/api/requests/${kiosk.id}/sessions`, { body: {} })));
  assert.ok(sessions.every((session) => session.status === 201));
  assert.equal(new Set(sessions.map((session) => session.data.nonce)).size, 20);
  const records = (await tenant.owner('/credentials')).data;
  for (const record of records.slice(10)) await tenant.owner(`/credentials/${record.id}/revoke`, {});
  const results = await Promise.all(sessions.map(async ({ data: request }, index) => {
    const presentation = await sd.createPresentation({
      sdjwt: people[index].sdjwt, reveal: request.required, holderPrivateJwk: people[index].holder.privateJwk,
      aud: request.aud, nonce: request.nonce,
    });
    const response = await f.call(`/api/requests/${request.id}/response`, { body: { presentation } });
    assert.equal((await f.call(`/api/requests/${request.id}/response`, { body: { presentation } })).status, 409);
    return response;
  }));
  assert.equal(results.filter((result) => result.data.ok).length, 10);
  assert.equal((await f.call(`/api/requests/${kiosk.id}`)).data.status, 'pending');
  const dashboard = (await f.call('/api/dashboard')).data;
  assert.deepEqual(dashboard.stats, { registered: 1, checkins: 10 });
  assert.equal(dashboard.attempts.length, 20);
  assert.equal(new Set(dashboard.attempts.map((entry) => entry.id)).size, 20);
  for (const [index, session] of sessions.entries()) {
    const attempt = dashboard.attempts.find((entry) => entry.id === session.data.id);
    assert.equal(attempt.name, 'Erika Muster');
    assert.equal(attempt.issuerName, tenant.org.name);
    assert.equal(attempt.identityVerified, index < 10);
    assert.equal(attempt.status, index < 10 ? 'done' : 'error');
    if (index >= 10) assert.equal(attempt.failedAt, 'Widerrufsstatus');
  }
  noSecrets(dashboard);
});

test('Rejected identities are explicitly unverified with exact failing step, without logging raw presentations', async (t) => {
  const f = await fixture(t);
  const credential = await f.issue(await f.organisation());
  const { presentation } = await f.checkIn(credential);
  const parts = presentation.split('~');
  parts[1] = sd.jsonB64(['salt', 'given_name', 'Ungeprüfter Name']);
  const request = (await f.call('/api/requests', { body: {} })).data;
  const result = await f.call(`/api/requests/${request.id}/response`, { body: { presentation: parts.join('~') } });
  assert.equal(result.data.ok, false);
  assert.equal(result.data.failedAt, 'Geteilte Angaben');
  const unreadable = (await f.call('/api/requests', { body: {} })).data;
  await f.call(`/api/requests/${unreadable.id}/response`, { body: { presentation: 'not-a-credential' } });
  const attempts = (await f.call('/api/dashboard')).data.attempts;
  assert.equal(attempts[0].name, 'Unbekannte Wallet');
  assert.equal(attempts[0].failedAt, 'Nachweis lesen');
  assert.match(attempts[0].identityNote, /nicht.*gelesen/);
  assert.equal(attempts[1].identityVerified, false);
  assert.match(attempts[1].error, /Disclosure/);
  assert.equal(JSON.stringify(attempts).includes('presentation'), false);
});

test('Kiosk sessions respect expiry and attempt history is bounded and resettable', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.call('/api/requests', { body: { mode: 'invalid' } })).status, 400);
  const single = (await f.call('/api/requests', { body: {} })).data;
  assert.equal((await f.call(`/api/requests/${single.id}/sessions`, { body: {} })).status, 400);
  const kiosk = (await f.call('/api/requests', { body: { mode: 'kiosk' } })).data;
  await Promise.all(Array.from({ length: 102 }, async () => {
    const session = (await f.call(`/api/requests/${kiosk.id}/sessions`, { body: {} })).data;
    await f.call(`/api/requests/${session.id}/response`, { body: { presentation: 'invalid' } });
  }));
  assert.equal((await f.call('/api/dashboard')).data.attempts.length, 100);
  f.advance(300000);
  assert.equal((await f.call(`/api/requests/${kiosk.id}/sessions`, { body: {} })).status, 410);
  await f.call('/api/admin/reset', { admin: true, body: {} });
  assert.deepEqual((await f.call('/api/dashboard')).data.attempts, []);
});

test('Wrong type, missing names, legacy statusless and unrecorded credentials never check in', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  const issued = await f.issue(tenant);
  const state = JSON.parse(await readFile(path.join(f.directory, 'hosted-state.json'), 'utf8'));
  const org = state.organisations[0];
  const status = sd.describeCredential(issued.sdjwt).payload.status;
  for (const [extra, expected] of [
    [{ vct: 'urn:other' }, /Mitarbeiterausweis/],
    [{ claims: { given_name: 'Erika' } }, /erforderlichen/],
    [{ status: undefined }, /Widerrufsstatus/],
    [{ status }, /Ausstellungsbeleg/],
  ]) {
    const sdjwt = await sd.issueSdJwt({
      issuerDid: org.did, issuerPrivateJwk: org.privateJwk, holderPublicJwk: issued.holder.publicJwk,
      vct: EMPLOYEE_VCT, claims: { given_name: 'Erika', family_name: 'Muster' }, status, ...extra,
    });
    const checked = await f.checkIn({ ...issued, sdjwt });
    assert.equal(checked.result.data.ok, false);
    assert.match(checked.result.data.error, expected);
  }
  assert.deepEqual((await f.call('/api/attendees')).data, []);
});

test('Issuer suspension and revocation during asynchronous verification prevent check-in; history remains', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  const credential = await f.issue(tenant);
  assert.equal((await f.checkIn(credential)).result.data.ok, true);
  const original = crypto.subtle.verify;
  let suspended = false;
  t.mock.method(crypto.subtle, 'verify', async function (...args) {
    const input = new TextDecoder().decode(args[3]);
    if (!suspended && sd.parseB64Json(input.split('.')[0]).typ === 'statuslist+jwt') {
      suspended = true;
      await f.trust(tenant.org, false);
    }
    return original.apply(this, args);
  });
  const denied = await f.checkIn(credential);
  assert.equal(suspended, true);
  assert.equal(denied.result.data.ok, false);
  assert.equal(denied.result.data.failedAt, 'Issuer-Vertrauen');
  assert.match(denied.result.data.error, /während der Prüfung/);
  t.mock.restoreAll();
  await f.trust(tenant.org);
  const record = (await tenant.owner('/credentials')).data[0];
  let revoked = false;
  t.mock.method(crypto.subtle, 'verify', async function (...args) {
    const input = new TextDecoder().decode(args[3]);
    if (!revoked && sd.parseB64Json(input.split('.')[0]).typ === 'statuslist+jwt') {
      revoked = true;
      await tenant.owner(`/credentials/${record.id}/revoke`, {});
    }
    return original.apply(this, args);
  });
  const revokedResult = await f.checkIn(credential);
  assert.equal(revoked, true);
  assert.equal(revokedResult.result.data.ok, false);
  assert.equal(revokedResult.result.data.failedAt, 'Widerrufsstatus');
  assert.deepEqual((await f.call('/api/dashboard')).data.stats, { registered: 1, checkins: 1 });
  assert.equal((await f.call('/api/attendees')).data[0].checkins.length, 1);
});

test('Page aliases preserve query; malformed JSON and obsolete APIs fail explicitly', async (t) => {
  const f = await fixture(t);
  for (const name of ['wallet', 'issuer', 'kiosk', 'admin']) {
    const response = await fetch(`${f.base}/${name}?req=example`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/${name}.html?req=example`);
  }
  for (const route of ['/api/issuers', '/api/issuers/challenge']) {
    assert.equal((await f.call(route, { body: {} })).status, 404);
  }
  const invalid = await fetch(`${f.base}/api/organisations`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /JSON/);
  const oversized = await f.call('/api/organisations', { body: { name: 'x'.repeat(70000) } });
  assert.equal(oversized.status, 413);
});

test('The internal status provider still authenticates signatures and rejects lists expiring during verification', async (t) => {
  const f = await fixture(t);
  const credential = await f.issue(await f.organisation());
  const originalSign = crypto.subtle.sign;
  t.mock.method(crypto.subtle, 'sign', async function (...args) {
    const signature = new Uint8Array(await originalSign.apply(this, args));
    if (sd.parseB64Json(new TextDecoder().decode(args[2]).split('.')[0]).typ === 'statuslist+jwt') signature[0] ^= 1;
    return signature.buffer;
  });
  const forged = await f.checkIn(credential);
  assert.equal(forged.result.data.ok, false);
  assert.equal(forged.result.data.failedAt, 'Widerrufsstatus');
  assert.match(forged.result.data.error, /Signatur/);
  t.mock.restoreAll();
  const originalVerify = crypto.subtle.verify;
  let expired = false;
  t.mock.method(crypto.subtle, 'verify', async function (...args) {
    if (!expired && sd.parseB64Json(new TextDecoder().decode(args[3]).split('.')[0]).typ === 'statuslist+jwt') {
      expired = true;
      f.advance(31000);
    }
    return originalVerify.apply(this, args);
  });
  const stale = await f.checkIn(credential);
  assert.equal(expired, true);
  assert.equal(stale.result.data.ok, false);
  assert.equal(stale.result.data.failedAt, 'Widerrufsstatus');
  assert.match(stale.result.data.error, /nicht mehr aktuell/);
  assert.deepEqual((await f.call('/api/attendees')).data, []);
});

test('Invalid deployment configuration fails before serving requests', async () => {
  await assert.rejects(createApp({ trustMode: 'auto' }), /ausschließlich/);
  for (const publicUrl of ['http://192.168.1.1:3000', 'https://example.org/path', 'not-a-url']) {
    await assert.rejects(createApp({ publicUrl }));
  }
});
