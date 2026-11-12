import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import * as sd from '../public/lib/sdjwt.js';
import { EMPLOYEE_VCT, REGISTRATION_PROOF, signProof } from '../public/lib/protocol.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const start = async () => {
    const { app, adminToken } = await createApp({
      publicUrl: 'https://wallet.example.org', dataDirectory: directory, ...options,
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (route, body) => {
      const response = await fetch(`${base}/api${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json',
          ...(route.startsWith('/admin/') ? { 'X-Admin-Token': adminToken } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    return { api, base, server };
  };
  return { ...await start(), start };
}

async function register(api, issuer, updates = {}) {
  const challenge = (await api('/issuers/challenge', {})).data;
  const proof = await signProof(REGISTRATION_PROOF, {
    iss: issuer.did, aud: challenge.aud, nonce: challenge.nonce,
    name: 'Meine Ausweisstelle', employeeName: 'Erika', publicUrl: 'https://issuer.example.org', ...updates,
  }, issuer.privateJwk);
  return api('/issuers', { challengeId: challenge.id, proof });
}

async function person(api, name = 'Erika', extra = {}, approved = true) {
  const issuer = await sd.generateKeyPair();
  const holder = await sd.generateKeyPair();
  const registered = await register(api, issuer, { name: `${name}s Ausweisstelle`, employeeName: name });
  assert.equal(registered.status, 201);
  assert.equal(registered.data.trusted, false);
  if (approved) {
    assert.equal((await api(`/admin/issuers/${encodeURIComponent(issuer.did)}/trust`, { trusted: true, ownerName: name })).status, 200);
  }
  const credential = await sd.issueSdJwt({
    issuerDid: issuer.did, issuerPrivateJwk: issuer.privateJwk, holderPublicJwk: holder.publicJwk,
    vct: EMPLOYEE_VCT, claims: {
      given_name: name, family_name: 'Müller', organisation: 'ISST', role: 'Mitarbeitende',
    },
    ...extra,
  });
  return {
    issuer, holder, credential,
    async checkIn(reveal = ['given_name', 'family_name']) {
      const created = await api('/requests', {});
      assert.equal(created.status, 201);
      const request = (await api(`/requests/${created.data.id}`)).data;
      const presentation = await sd.createPresentation({
        sdjwt: credential, reveal, holderPrivateJwk: holder.privateJwk, aud: request.aud, nonce: request.nonce,
      });
      return { request, presentation, result: await api(`/requests/${request.id}/response`, { presentation }) };
    },
  };
}

test('Public config includes HTTPS QR codes and static pages are served', async (t) => {
  const { api, base } = await fixture(t);
  const { data } = await api('/config');
  assert.equal(data.publicUrl, 'https://wallet.example.org');
  assert.match(data.startQrDataUrl, /^data:image\/png;base64,/);
  const created = (await api('/requests', {})).data;
  assert.equal(created.url, `https://wallet.example.org/wallet.html#req=${created.id}`);
  assert.match(created.qrDataUrl, /^data:image\/png;base64,/);
  const page = await fetch(`${base}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /EUDI/);
});

test('PWA manifest, offline shell and real PNG icons are available without caching APIs', async (t) => {
  const { base } = await fixture(t);
  const manifest = await (await fetch(`${base}/manifest.webmanifest`)).json();
  assert.equal(manifest.display, 'standalone');
  assert.equal(manifest.start_url, '/wallet.html');
  for (const icon of manifest.icons) {
    const response = await fetch(`${base}${icon.src}`);
    assert.equal(response.headers.get('content-type'), 'image/png');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    const size = Number(icon.sizes.split('x')[0]);
    assert.equal(bytes.readUInt32BE(16), size);
    assert.equal(bytes.readUInt32BE(20), size);
  }
  const sw = await (await fetch(`${base}/sw.js`)).text();
  const shell = sw.match(/const SHELL = \[([\s\S]*?)\];/)[1];
  const paths = [...shell.matchAll(/'([^']+)'/g)].map((match) => match[1]);
  assert.equal(paths.some((route) => route.startsWith('/api')), false);
  for (const route of paths) {
    assert.equal((await fetch(`${base}${route}`)).status, 200, route);
  }
  const config = await fetch(`${base}/api/config`);
  assert.equal(config.headers.get('cache-control'), 'no-store');
});

test('Ten check-ins, selective disclosure, deduplication and restart persistence', async (t) => {
  const { api, start } = await fixture(t);
  const guest = await person(api);
  for (let index = 0; index < 10; index++) {
    const { request, presentation, result } = await guest.checkIn();
    assert.equal(result.data.ok, true);
    assert.equal(result.data.steps.length, 7);
    assert.deepEqual(Object.keys(result.data.claims).sort(), ['family_name', 'given_name']);
    assert.equal((await api(`/requests/${request.id}`)).data.status, 'done');
    assert.equal((await api(`/requests/${request.id}/response`, { presentation })).status, 409);
  }
  assert.equal((await api('/attendees')).data.length, 1);
  assert.equal((await api('/attendees')).data[0].checkins.length, 10);
  assert.equal('organisation' in (await api('/attendees')).data[0], false);
  const optional = await guest.checkIn(['given_name', 'family_name', 'organisation', 'role']);
  assert.equal(optional.result.data.claims.organisation, 'ISST');
  assert.equal((await api('/attendees')).data[0].organisation, 'ISST');
  const history = (await api('/attendees')).data[0].checkins;
  assert.equal(history.length, 11);
  assert.deepEqual(Object.keys(history[0].claims).sort(), ['family_name', 'given_name']);
  assert.equal(history[10].claims.role, 'Mitarbeitende');
  assert.equal(history[0].credentialId, history[10].credentialId);
  const optionalGuest = await person(api, 'Ada');
  await optionalGuest.checkIn(['given_name', 'family_name', 'organisation', 'role']);
  const restarted = await start();
  assert.equal((await restarted.api('/issuers')).data[0].did, guest.issuer.did);
  assert.equal((await restarted.api('/attendees')).data.find((entry) => entry.name === 'Ada Müller').organisation, 'ISST');
  assert.equal((await restarted.api(`/requests/${optional.request.id}`)).status, 404);
});

test('Manual trust, authenticated moderation, replay and reset', async (t) => {
  const { api } = await fixture(t, { trustMode: 'manual' });
  const guest = await person(api, 'Erika', {}, false);
  assert.equal((await api('/admin/replay', {})).status, 409);
  const denied = await guest.checkIn();
  assert.equal(denied.result.data.ok, false);
  assert.match(denied.result.data.error, /Vertrauensliste/);
  assert.equal((await api(`/requests/${denied.request.id}`)).data.status, 'error');
  const trustPath = `/admin/issuers/${encodeURIComponent(guest.issuer.did)}/trust`;
  assert.equal((await api(trustPath, { trusted: true })).status, 400);
  assert.equal((await api(trustPath, { trusted: true, ownerName: 'Erika Müller' })).status, 200);
  assert.equal((await guest.checkIn()).result.data.ok, true);
  const replay = await api('/admin/replay', {});
  assert.equal(replay.data.ok, false);
  assert.match(replay.data.error, /Nonce/);
  assert.equal((await api('/attendees')).data.length, 1);
  assert.equal((await api('/admin/trust-mode', { mode: 'auto' })).status, 400);
  assert.equal((await api('/config')).data.trustMode, 'manual');
  assert.equal((await api('/admin/reset', {})).status, 200);
  assert.deepEqual((await api('/attendees')).data, []);
  assert.deepEqual((await api('/dashboard')).data.attempts, []);
  assert.equal((await api('/issuers')).data.length, 1);
  assert.equal((await api(`/requests/${denied.request.id}`)).status, 404);
});

test('Requests expire after five minutes and unknown requests return 404', async (t) => {
  let time = Date.now();
  const { api } = await fixture(t, { clock: () => time });
  const { data } = await api('/requests', {});
  time += 300000;
  assert.equal((await api(`/requests/${data.id}`)).data.status, 'expired');
  assert.equal((await api(`/requests/${data.id}/response`, { presentation: 'invalid' })).status, 410);
  assert.equal((await api('/requests/missing')).status, 404);
});

test('Concurrent responses consume a QR exactly once', async (t) => {
  const { api } = await fixture(t);
  const guest = await person(api);
  const created = (await api('/requests', {})).data;
  const request = (await api(`/requests/${created.id}`)).data;
  const presentation = await sd.createPresentation({
    sdjwt: await sd.issueSdJwt({
      issuerDid: guest.issuer.did, issuerPrivateJwk: guest.issuer.privateJwk,
      holderPublicJwk: guest.holder.publicJwk, vct: request.vct,
      claims: { given_name: 'Erika', family_name: 'Müller' },
    }),
    reveal: request.required, holderPrivateJwk: guest.holder.privateJwk, aud: request.aud, nonce: request.nonce,
  });
  const responses = await Promise.all([
    api(`/requests/${request.id}/response`, { presentation }),
    api(`/requests/${request.id}/response`, { presentation }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await api('/attendees')).data.length, 1);
});

test('Twenty phones share a kiosk QR but get unique single-use nonces and identifiable results', async (t) => {
  const { api, start } = await fixture(t);
  const people = await Promise.all(Array.from({ length: 20 }, (_, index) => (
    person(api, `Person ${index + 1}`, {}, index < 10)
  )));
  const kiosk = (await api('/requests', { mode: 'kiosk' })).data;
  assert.equal((await api(`/requests/${kiosk.id}/response`, { presentation: 'invalid' })).status, 409);
  const sessions = await Promise.all(people.map(() => api(`/requests/${kiosk.id}/sessions`, {})));
  assert.ok(sessions.every((session) => session.status === 201));
  assert.equal(new Set(sessions.map((session) => session.data.nonce)).size, 20);
  const before = (await api('/dashboard')).data;
  assert.deepEqual(before.stats, { registered: 20, trusted: 10, checkedIn: 0 });
  assert.deepEqual(before.attempts, []);
  const results = await Promise.all(sessions.map(async ({ data: request }, index) => {
    const presentation = await sd.createPresentation({
      sdjwt: people[index].credential, reveal: request.required, holderPrivateJwk: people[index].holder.privateJwk,
      aud: request.aud, nonce: request.nonce,
    });
    const result = await api(`/requests/${request.id}/response`, { presentation });
    assert.equal((await api(`/requests/${request.id}/response`, { presentation })).status, 409);
    return result;
  }));
  assert.equal(results.filter((result) => result.data.ok).length, 10);
  assert.equal((await api(`/requests/${kiosk.id}`)).data.status, 'pending');
  const dashboard = (await api('/dashboard')).data;
  assert.deepEqual(dashboard.stats, { registered: 20, trusted: 10, checkedIn: 10 });
  assert.equal(dashboard.attempts.length, 20);
  assert.equal(new Set(dashboard.attempts.map((attempt) => attempt.id)).size, 20);
  for (const [index, session] of sessions.entries()) {
    const attempt = dashboard.attempts.find((entry) => entry.id === session.data.id);
    assert.equal(attempt.name, `Person ${index + 1} Müller`);
    assert.equal(attempt.issuerName, `Person ${index + 1}s Ausweisstelle`);
    assert.equal(attempt.identityVerified, index < 10);
    assert.equal(attempt.status, index < 10 ? 'done' : 'error');
    if (index >= 10) {
      assert.equal(attempt.failedAt, 'Issuer-Vertrauen');
      assert.match(attempt.error, /Vertrauensliste/);
    }
  }
  for (const hidden of ['privateJwk', 'sdjwt', 'presentation', 'nonce', '"organisation"', '"role"']) {
    assert.equal(JSON.stringify(dashboard).includes(hidden), false, hidden);
  }
  const restarted = (await (await start()).api('/dashboard')).data;
  assert.deepEqual(restarted.stats, dashboard.stats);
  assert.deepEqual(restarted.attempts, []);
});

test('Rejected identities remain explicitly unverified and expose the exact failing step, not hidden claims', async (t) => {
  const { api } = await fixture(t);
  const guest = await person(api);
  const { request, presentation } = await guest.checkIn();
  const parts = presentation.split('~');
  parts[1] = sd.jsonB64(['salt', 'given_name', 'Ungeprüfter Name']);
  const changedRequest = (await api('/requests', {})).data;
  const result = await api(`/requests/${changedRequest.id}/response`, { presentation: parts.join('~') });
  assert.equal(result.data.ok, false);
  assert.equal(result.data.failedAt, 'Geteilte Angaben');
  let latest = (await api('/dashboard')).data.attempts[0];
  assert.equal(latest.identityVerified, false);
  assert.equal(latest.name, 'Ungeprüfter Name Müller');
  assert.match(latest.error, /Disclosure/);
  assert.notEqual(latest.id, request.id);
  const unreadable = (await api('/requests', {})).data;
  await api(`/requests/${unreadable.id}/response`, { presentation: 'not-a-credential' });
  latest = (await api('/dashboard')).data.attempts[0];
  assert.equal(latest.name, 'Unbekannte Wallet');
  assert.equal(latest.failedAt, 'Nachweis lesen');
  assert.match(latest.identityNote, /nicht.*gelesen/);
});

test('Kiosk sessions respect expiry and attempt history is bounded and resettable', async (t) => {
  let time = Date.now();
  const { api } = await fixture(t, { clock: () => time });
  assert.equal((await api('/requests', { mode: 'invalid' })).status, 400);
  const single = (await api('/requests', {})).data;
  assert.equal((await api(`/requests/${single.id}/sessions`, {})).status, 400);
  const kiosk = (await api('/requests', { mode: 'kiosk' })).data;
  await Promise.all(Array.from({ length: 102 }, async () => {
    const session = (await api(`/requests/${kiosk.id}/sessions`, {})).data;
    await api(`/requests/${session.id}/response`, { presentation: 'invalid' });
  }));
  assert.equal((await api('/dashboard')).data.attempts.length, 100);
  time += 300000;
  assert.equal((await api(`/requests/${kiosk.id}/sessions`, {})).status, 410);
  assert.equal((await api('/admin/reset', {})).status, 200);
  assert.deepEqual((await api('/dashboard')).data.attempts, []);
});

test('Wrong credential type and missing required names are rejected', async (t) => {
  const { api } = await fixture(t);
  const wrongType = await person(api, 'Typ', { vct: 'urn:other' });
  assert.match((await wrongType.checkIn()).result.data.error, /Mitarbeiterausweis/);
  const missing = await person(api, 'Feld', { claims: { given_name: 'Erika' } });
  assert.match((await missing.checkIn()).result.data.error, /erforderlichen/);
  assert.deepEqual((await api('/attendees')).data, []);
});

test('Signed issuer URL updates preserve approval; identity updates require renewed trust', async (t) => {
  const { api, base } = await fixture(t, { trustMode: 'manual' });
  const guest = await person(api);
  const update = await register(api, guest.issuer, {
    name: 'Erikas Ausweisstelle', employeeName: 'Erika', publicUrl: 'https://new-issuer.example.org',
  });
  assert.equal(update.status, 200);
  assert.equal(update.data.trusted, true);
  const renamed = await register(api, guest.issuer, { name: 'Neuer Name' });
  assert.equal(renamed.data.trusted, false);
  assert.equal(renamed.data.ownerName, null);
  assert.equal((await api('/issuers', { did: 'did:jwk:broken', name: 'Invalid' })).status, 400);
  assert.equal((await api('/issuers', { did: guest.issuer.did, name: 'Name', privateJwk: {} })).status, 400);
  assert.equal((await api('/admin/trust-mode', { mode: 'invalid' })).status, 400);
  const invalid = await fetch(`${base}/api/issuers`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{',
  });
  assert.equal(invalid.status, 400);
  assert.match((await invalid.json()).error, /JSON/);
});

test('Short page links preserve the check-in query across redirects', async (t) => {
  const { base } = await fixture(t);
  for (const page of ['wallet', 'issuer', 'kiosk', 'admin']) {
    const response = await fetch(`${base}/${page}?req=example&other=value`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), `/${page}.html?req=example&other=value`);
  }
});

test('Registration proves key ownership, binds the hub audience and rejects replay', async (t) => {
  const { api, base } = await fixture(t);
  const issuer = await sd.generateKeyPair();
  const challenge = (await api('/issuers/challenge', {})).data;
  const payload = {
    iss: issuer.did, aud: challenge.aud, nonce: challenge.nonce,
    name: 'Erikas Issuer', employeeName: 'Erika', publicUrl: 'https://issuer.example.org',
  };
  const proof = await signProof(REGISTRATION_PROOF, payload, issuer.privateJwk);
  const wrongAudience = await signProof(REGISTRATION_PROOF, { ...payload, aud: 'https://elsewhere.example.org' }, issuer.privateJwk);
  assert.equal((await api('/issuers', { challengeId: challenge.id, proof: wrongAudience })).status, 400);
  const stranger = await sd.generateKeyPair();
  const wrongKey = await signProof(REGISTRATION_PROOF, payload, stranger.privateJwk);
  assert.equal((await api('/issuers', { challengeId: challenge.id, proof: wrongKey })).status, 400);
  const results = await Promise.all([
    api('/issuers', { challengeId: challenge.id, proof }),
    api('/issuers', { challengeId: challenge.id, proof }),
  ]);
  assert.equal(results.filter((result) => result.status === 201).length, 1);
  assert.equal(results.filter((result) => [409, 410].includes(result.status)).length, 1);
  assert.equal((await api('/issuers', { challengeId: challenge.id, proof })).status, 410);
  assert.equal((await api('/issuers')).data[0].trusted, false);
  const page = await fetch(`${base}/wallet.html`);
  assert.match(page.headers.get('content-security-policy'), /https:\/\/issuer\.example\.org/);
  assert.match(await page.text(), /name="issuer-origins" content="\[&quot;https:\/\/issuer.example.org&quot;\]"/);
});

test('Revocation rejects an existing credential and history contains only disclosed claims', async (t) => {
  const { api } = await fixture(t);
  const guest = await person(api);
  const first = await guest.checkIn();
  assert.equal(first.result.data.ok, true);
  const attendee = (await api('/attendees')).data[0];
  assert.equal(attendee.issuerOwner, 'Erika');
  assert.equal(attendee.credentialType, EMPLOYEE_VCT);
  assert.equal(JSON.stringify(attendee).includes('ISST'), false);
  assert.equal(JSON.stringify(attendee).includes('privateJwk'), false);
  assert.equal(JSON.stringify(attendee).includes('sdjwt'), false);
  assert.equal((await api(`/admin/issuers/${encodeURIComponent(guest.issuer.did)}/trust`, { trusted: false })).status, 200);
  const second = await guest.checkIn();
  assert.equal(second.result.data.ok, false);
  assert.match(second.result.data.error, /Vertrauensliste/);
  assert.equal((await api('/attendees')).data[0].checkins.length, 1);
});

test('Invalid deployment configuration fails before serving requests', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const options of [
    { trustMode: 'invalid' },
    { publicUrl: 'https://wallet.example.org/subpath' },
    { publicUrl: 'https://user:password@wallet.example.org/' },
    { publicUrl: 'ftp://wallet.example.org/' },
  ]) {
    await assert.rejects(createApp({ dataDirectory: directory, ...options }), /TRUST_MODE|PUBLIC_URL/);
  }
});
