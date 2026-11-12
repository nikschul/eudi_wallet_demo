import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import * as sd from '../public/lib/sdjwt.js';

async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const start = async () => {
    const { app } = await createApp({
      publicUrl: 'https://wallet.example.org', dataDirectory: directory, adminToken: 'test-token', ...options,
    });
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const api = async (route, body, admin = false) => {
      const response = await fetch(`${base}/api${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(admin ? { 'X-Admin-Token': 'test-token' } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: response.status, data: await response.json() };
    };
    return { api, base, server };
  };
  return { ...await start(), start };
}

async function person(api, name = 'Erika', extra = {}) {
  const issuer = await sd.generateKeyPair();
  const holder = await sd.generateKeyPair();
  const registered = await api('/issuers', { did: issuer.did, name: `${name}s Ausweisstelle` });
  assert.equal(registered.status, 201);
  const credential = await sd.issueSdJwt({
    issuerDid: issuer.did, issuerPrivateJwk: issuer.privateJwk, holderPublicJwk: holder.publicJwk,
    vct: 'urn:isst:gastausweis:1', claims: {
      given_name: name, family_name: 'Müller', organisation: 'ISST', role: 'Gast',
    },
    ...extra,
  });
  return {
    issuer, holder,
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
  assert.equal('organisation' in (await api('/attendees')).data[0], false);
  const optional = await guest.checkIn(['given_name', 'family_name', 'organisation', 'role']);
  assert.equal(optional.result.data.claims.organisation, 'ISST');
  assert.equal('organisation' in (await api('/attendees')).data[0], false);
  const optionalGuest = await person(api, 'Ada');
  await optionalGuest.checkIn(['given_name', 'family_name', 'organisation', 'role']);
  const restarted = await start();
  assert.equal((await restarted.api('/issuers')).data[0].did, guest.issuer.did);
  assert.equal((await restarted.api('/attendees')).data.find((entry) => entry.name === 'Ada Müller').organisation, 'ISST');
  assert.equal((await restarted.api(`/requests/${optional.request.id}`)).status, 404);
});

test('Manual trust, authenticated moderation, replay and reset', async (t) => {
  const { api } = await fixture(t, { trustMode: 'manual' });
  const guest = await person(api);
  assert.equal((await api('/admin/reset', {})).status, 401);
  assert.equal((await api('/admin/replay', {}, true)).status, 409);
  const denied = await guest.checkIn();
  assert.equal(denied.result.data.ok, false);
  assert.match(denied.result.data.error, /Vertrauensliste/);
  assert.equal((await api(`/requests/${denied.request.id}`)).data.status, 'error');
  const trustPath = `/admin/issuers/${encodeURIComponent(guest.issuer.did)}/trust`;
  assert.equal((await api(trustPath, { trusted: true }, true)).status, 200);
  assert.equal((await guest.checkIn()).result.data.ok, true);
  const replay = await api('/admin/replay', {}, true);
  assert.equal(replay.data.ok, false);
  assert.match(replay.data.error, /Nonce/);
  assert.equal((await api('/attendees')).data.length, 1);
  assert.equal((await api('/admin/trust-mode', { mode: 'auto' }, true)).data.mode, 'auto');
  assert.equal((await api('/config')).data.trustMode, 'auto');
  assert.equal((await api('/admin/reset', {}, true)).status, 200);
  assert.deepEqual((await api('/attendees')).data, []);
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

test('Wrong credential type and missing required names are rejected', async (t) => {
  const { api } = await fixture(t);
  const wrongType = await person(api, 'Typ', { vct: 'urn:other' });
  assert.match((await wrongType.checkIn()).result.data.error, /Gastausweis/);
  const missing = await person(api, 'Feld', { claims: { given_name: 'Erika' } });
  assert.match((await missing.checkIn()).result.data.error, /erforderlichen/);
  assert.deepEqual((await api('/attendees')).data, []);
});

test('Issuer updates preserve trust; invalid inputs are explicit errors', async (t) => {
  const { api, base } = await fixture(t, { trustMode: 'manual' });
  const guest = await person(api);
  await api(`/admin/issuers/${encodeURIComponent(guest.issuer.did)}/trust`, { trusted: true }, true);
  const update = await api('/issuers', { did: guest.issuer.did, name: 'Neuer Name' });
  assert.equal(update.status, 200);
  assert.equal(update.data.trusted, true);
  assert.equal((await api('/issuers', { did: 'did:jwk:broken', name: 'Invalid' })).status, 400);
  assert.equal((await api('/issuers', { did: guest.issuer.did, name: 'Name', privateJwk: {} })).status, 400);
  assert.equal((await api('/admin/trust-mode', { mode: 'invalid' }, true)).status, 400);
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

test('Invalid deployment configuration fails before serving requests', async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-config-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const options of [
    { trustMode: 'invalid' },
    { publicUrl: 'https://wallet.example.org/subpath' },
    { publicUrl: 'https://user:password@wallet.example.org/' },
    { publicUrl: 'ftp://wallet.example.org/' },
    { adminToken: '' },
    { adminToken: ' ' },
    { adminToken: ' token-with-spaces ' },
    { adminToken: 'not\nvalid' },
    { adminToken: 'ü' },
  ]) {
    await assert.rejects(createApp({ dataDirectory: directory, ...options }), /TRUST_MODE|PUBLIC_URL|ADMIN_TOKEN/);
  }
});
