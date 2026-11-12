import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createIssuerApp } from '../server/issuer-app.js';
import * as sd from '../public/lib/sdjwt.js';
import {
  EMPLOYEE_VCT, HOLDER_PROOF, REGISTRATION_PROOF, decodeOffer, signProof, verifyProof,
} from '../public/lib/protocol.js';
import { verifyStatusList, isRevoked } from '../public/lib/credential-status.js';

const claims = { given_name: 'Erika', family_name: 'Muster', organisation: 'Workshop GmbH', role: 'Mitarbeitende' };

async function listen(app) {
  const server = createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}

async function close(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  });
}

async function request(url, route, { body, token, method, headers = {} } = {}) {
  const response = await fetch(url + route, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { 'X-Offer-Token': token } : {}), ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const contentType = response.headers.get('content-type') || '';
  return { status: response.status, headers: response.headers,
    data: contentType.includes('application/json') ? await response.json() : await response.text() };
}

async function fixture(t) {
  const dataDirectory = path.join(process.cwd(), `.issuer-test-${randomUUID()}`);
  await mkdir(dataDirectory);
  t.after(() => rm(dataDirectory, { recursive: true, force: true }));
  const registry = new Map();
  const challenges = new Map();
  const state = { fail: false, delay: false, lastRegistration: null, wrongRecord: false };
  const hub = express();
  hub.use(express.json());
  let workshopUrl;
  hub.post('/api/issuers/challenge', (req, res) => {
    if (state.fail) return res.status(503).json({ error: 'Zentrale im Wartungsmodus.' });
    const challenge = {
      id: randomUUID(), nonce: randomUUID(), aud: workshopUrl,
      expiresAt: new Date(Date.now() + 120000).toISOString(),
    };
    challenges.set(challenge.id, challenge);
    res.json(challenge);
  });
  hub.post('/api/issuers', async (req, res) => {
    try {
      const { payload } = sd.decodeJwt(req.body.proof);
      const challenge = challenges.get(req.body.challengeId);
      assert.ok(challenge);
      await verifyProof(req.body.proof, {
        type: REGISTRATION_PROOF, publicJwk: sd.jwkFromDid(payload.iss),
        audience: workshopUrl, nonce: challenge.nonce, issuer: payload.iss,
      });
      challenges.delete(challenge.id);
      state.lastRegistration = payload;
      const record = {
        did: payload.iss, name: payload.name, employeeName: payload.employeeName,
        publicUrl: payload.publicUrl, trusted: false, proofVerified: true, ownerName: null,
        fingerprint: '12:34:56:78', createdAt: new Date().toISOString(),
        privateJwk: { d: 'must-never-be-forwarded' },
      };
      registry.set(payload.iss, record);
      res.json(state.wrongRecord ? { ...record, publicUrl: workshopUrl } : record);
    } catch (error) {
      res.status(400).json({ error: error.message });
    }
  });
  hub.get('/api/issuers', async (req, res) => {
    if (state.fail) return res.status(503).json({ error: 'Zentrale im Wartungsmodus.' });
    if (state.delay) await new Promise((resolve) => setTimeout(resolve, 30));
    res.json([...registry.values()]);
  });
  const workshop = await listen(hub);
  workshopUrl = workshop.url;
  t.after(() => close(workshop.server));
  let now = Date.now();
  const wrapper = express();
  const issuer = await listen(wrapper);
  t.after(() => close(issuer.server));
  const options = { publicUrl: issuer.url, workshopUrl, dataDirectory, clock: () => now };
  const created = await createIssuerApp(options);
  wrapper.use(created.app);
  const call = (route, options) => request(issuer.url, route, options);
  const admin = (route, options = {}) => call(`/api/issuer${route}`, {
    ...options, headers: { 'X-Admin-Token': created.adminToken, ...options.headers },
  });
  const setup = () => admin('/setup', { body: { name: 'Meine Test-Ausweisstelle', employeeName: 'Anna Ausstellung' } });
  const register = () => admin('/register', { body: {} });
  async function ready() {
    assert.equal((await setup()).status, 200);
    assert.equal((await register()).status, 200);
    const record = [...registry.values()][0];
    record.trusted = true;
    record.ownerName = 'Anna Ausstellung';
  }
  async function offer() {
    const response = await admin('/offers', { body: { claims } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const capability = decodeOffer(new URL(response.data.url).hash);
    return { ...response.data, token: capability.token };
  }
  async function proof(offer, holder, changes = {}, type = HOLDER_PROOF) {
    return signProof(type, { iss: holder.did, aud: issuer.url, nonce: offer.nonce,
      jwk: holder.publicJwk, ...changes }, holder.privateJwk);
  }
  const wallet = (offer, route = '', options = {}) => call(`/api/offers/${offer.id}${route}`, { token: offer.token, ...options });
  return { call, admin, setup, register, ready, offer, proof, wallet, registry, state,
    options, created, issuerUrl: issuer.url, workshopUrl, dataDirectory,
    advance: (milliseconds) => { now += milliseconds; } };
}

function noKeys(value) {
  const serialized = JSON.stringify(value);
  assert.doesNotMatch(serialized, /"(?:privateJwk|publicJwk|jwk|d|token|sdjwt)"\s*:/);
}

test('Issuer-Konfiguration, geschützte Demo-Verwaltung und getrennte Seiten ohne Schlüsseldaten', async (t) => {
  const f = await fixture(t);
  assert.deepEqual(Object.keys(f.created), ['app', 'adminToken']);
  assert.deepEqual((await f.call('/api/health')).data, { ok: true, role: 'issuer' });
  const config = await f.call('/api/config');
  assert.deepEqual(config.data, {
    role: 'issuer', publicUrl: f.issuerUrl, workshopUrl: f.workshopUrl, eventTitle: 'Meine Ausweisstelle',
  });
  noKeys(config.data);
  for (const route of ['/status', '/trust']) {
    assert.equal((await f.call(`/api/issuer${route}`)).status, 401);
  }
  assert.equal((await f.call('/api/issuer/setup', { body: {} })).status, 401);
  assert.equal((await f.call('/api/issuer/register', { body: {} })).status, 401);
  assert.equal((await f.call('/api/issuer/offers', { body: { claims } })).status, 401);
  assert.equal((await f.call('/api/issuer/offers/unknown')).status, 401);
  for (const route of ['/offers/unknown/approve', '/offers/unknown/cancel']) {
    assert.equal((await f.call(`/api/issuer${route}`, { body: {} })).status, 401);
  }
  const status = await f.admin('/status');
  assert.deepEqual(status.data, { publicUrl: f.issuerUrl, workshopUrl: f.workshopUrl });
  noKeys(status.data);
  assert.equal(status.headers.get('cache-control'), 'no-store');
  for (const route of ['/', '/issuer.html']) {
    const page = await f.call(route);
    assert.equal(page.status, 200);
    assert.match(page.data, /Desktop-Verwaltung/);
    assert.match(page.data, /Geschützte Demo-Verwaltung/);
    assert.match(page.data, /Freischalt-Link aus den Server-Logs/);
    assert.match(page.data, /Nur Demo-Daten verwenden/);
    assert.doesNotMatch(page.data, /Ausstellen, nicht aufbewahren/);
    assert.doesNotMatch(page.data, /manifest\.webmanifest|wallet\.html|serviceWorker/);
    assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
    assert.match(page.headers.get('content-security-policy'), /worker-src 'none'/);
  }
  for (const route of ['/wallet.html', '/wallet.js', '/admin.html', '/kiosk.html', '/sw.js',
    '/manifest.webmanifest', '/identity.json', '/data/identity.json']) {
    assert.equal((await f.call(route)).status, 404, route);
  }
  const script = await f.call('/issuer.js');
  assert.equal(script.status, 200);
  assert.equal(script.headers.get('cache-control'), 'no-cache');
  for (const route of ['/issuer.css', '/lib/ui.js', '/lib/protocol.js']) {
    assert.equal((await f.call(route)).headers.get('cache-control'), 'no-cache');
  }
  assert.doesNotMatch(script.data, /localStorage|sessionStorage|setupPage|readStored|writeStored|X-Admin-Token|showLogin|Verwaltung sperren/);
  assert.doesNotMatch(script.data, /Getrennte Systeme, klarer Weg/);
  assert.match(script.data, /sha256b64\(status\.did\)/);
});

test('Issuer speichert genau eine dauerhafte private Identität und aktualisiert Namen atomisch', async (t) => {
  const f = await fixture(t);
  assert.equal((await f.register()).status, 409);
  assert.equal((await f.admin('/setup', { body: { name: ' ', employeeName: 'Anna' } })).status, 400);
  const responses = await Promise.all([f.setup(), f.setup(), f.setup()]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(new Set(responses.map((response) => response.data.did)).size, 1);
  noKeys(responses[0].data);
  const stored = JSON.parse(await readFile(path.join(f.dataDirectory, 'identity.json'), 'utf8'));
  assert.ok(stored.privateJwk.d);
  assert.equal(stored.did, sd.didFromJwk(stored.publicJwk));
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(f.dataDirectory, 'identity.json'))).mode & 0o777, 0o600);
  }
  const restart = await createIssuerApp(f.options);
  const restarted = await listen(restart.app);
  t.after(() => close(restarted.server));
  assert.notEqual(restart.adminToken, f.created.adminToken);
  assert.equal((await request(restarted.url, '/api/issuer/status', {
    headers: { 'X-Admin-Token': f.created.adminToken },
  })).status, 401);
  const loaded = await request(restarted.url, '/api/issuer/status', {
    headers: { 'X-Admin-Token': restart.adminToken },
  });
  assert.equal(loaded.data.did, stored.did);
  const changed = await f.admin('/setup', { body: { name: 'Neue Stelle', employeeName: 'Berta' } });
  assert.equal(changed.data.did, stored.did);
  assert.equal(changed.data.name, 'Neue Stelle');
  const saved = JSON.parse(await readFile(path.join(f.dataDirectory, 'identity.json'), 'utf8'));
  assert.equal(saved.privateJwk.d, stored.privateJwk.d);
});

test('Registrierung beweist Issuer-Schlüsselbesitz, Trust ist ausschließlich remote und lesend', async (t) => {
  const f = await fixture(t);
  await f.setup();
  assert.equal((await f.admin('/trust')).data.status, 'unregistered');
  assert.equal((await f.admin('/offers', { body: { claims } })).status, 409);
  const registration = await f.register();
  assert.equal(registration.status, 200);
  assert.equal(registration.data.trusted, false);
  assert.equal(registration.data.employeeName, 'Anna Ausstellung');
  assert.equal(f.state.lastRegistration.aud, f.workshopUrl);
  assert.equal(f.state.lastRegistration.exp - f.state.lastRegistration.iat, 120);
  noKeys(registration.data);
  const did = registration.data.did;
  const record = f.registry.get(did);
  assert.equal((await f.admin('/trust')).data.trusted, false);
  const blocked = await f.admin('/offers', { body: { claims } });
  assert.equal(blocked.status, 409);
  assert.match(blocked.data.error, /Setup.*vertrauenswürdig/);
  record.trusted = true;
  record.ownerName = 'Empfang';
  const trusted = await f.admin('/trust');
  assert.equal(trusted.data.trusted, true);
  assert.equal(trusted.data.ownerName, 'Empfang');
  noKeys(trusted.data);
  assert.equal((await f.admin('/trust', { body: { trusted: false } })).status, 404);
  assert.equal((await f.admin('/setup', { body: {
    name: 'Meine Test-Ausweisstelle', employeeName: 'Andere Person',
  } })).status, 200);
  assert.equal((await f.admin('/status')).data.registration, undefined);
  assert.equal((await f.admin('/trust')).data.status, 'unregistered');
  assert.equal((await f.admin('/offers', { body: { claims } })).status, 409);
  await f.register();
  assert.equal((await f.admin('/trust')).data.trusted, false);
  assert.equal((await f.admin('/offers', { body: { claims } })).status, 409);
  Object.assign(f.registry.get(did), { trusted: true, ownerName: 'Andere Person' });
  assert.equal((await f.offer()).status, 'offered');
});

test('Registry-Ausfälle und unpassende Registrierungsantworten werden deutsch sichtbar', async (t) => {
  const f = await fixture(t);
  f.state.fail = true;
  assert.equal((await f.admin('/trust')).status, 502);
  f.state.fail = false;
  await f.setup();
  f.state.fail = true;
  for (const response of [await f.register(), await f.admin('/trust'),
    await f.admin('/offers', { body: { claims } })]) {
    assert.equal(response.status, 502);
    assert.match(response.data.error, /Workshop-Zentrale.*Wartungsmodus/);
  }
  f.state.fail = false;
  f.state.wrongRecord = true;
  assert.equal((await f.register()).status, 502);
  assert.equal((await f.admin('/status')).data.registration, undefined);
});

test('Angebote validieren Pflichtattribute, bleiben unsigniert und tragen nur eine Capability im Wallet-Hash', async (t) => {
  const f = await fixture(t);
  await f.ready();
  for (const invalid of [{}, { ...claims, given_name: '' }, { ...claims, organisation: undefined },
    { ...claims, role: 'x'.repeat(121) }, { ...claims, family_name: 123 },
    { ...claims, extra: 'nicht erlaubt' }]) {
    assert.equal((await f.admin('/offers', { body: { claims: invalid } })).status, 400);
  }
  const response = await f.admin('/offers', { body: { claims: {
    given_name: ' Erika ', family_name: ' Muster ', organisation: ' Workshop GmbH ',
  } } });
  assert.equal(response.status, 201);
  const offer = response.data;
  assert.deepEqual(offer.claims, claims);
  assert.match(offer.qrDataUrl, /^data:image\/png;base64,/);
  assert.ok(offer.url.startsWith(`${f.workshopUrl}/wallet.html#offer=`));
  const decoded = decodeOffer(new URL(offer.url).hash);
  assert.equal(decoded.issuer, offer.issuerDid);
  assert.equal(decoded.id, offer.id);
  assert.equal(Buffer.from(decoded.token, 'base64url').length, 32);
  assert.equal(offer.holderDid, null);
  assert.equal(offer.status, 'offered');
  assert.match(offer.transactionCode, /^\d{6}$/);
  for (let poll = 0; poll < 3; poll++) {
    assert.equal((await f.admin(`/offers/${offer.id}`)).data.transactionCode, offer.transactionCode);
  }
  const capability = { ...offer, token: decoded.token };
  const publicInfo = await f.wallet(capability);
  assert.equal(publicInfo.status, 200);
  assert.equal(publicInfo.data.status, 'offered');
  assert.equal(publicInfo.data.holderDid, undefined);
  assert.equal(publicInfo.data.aud, f.issuerUrl);
  assert.ok(Date.parse(publicInfo.data.expiresAt) > Date.now());
  noKeys(publicInfo.data);
  assert.equal(publicInfo.data.transactionCode, undefined);
  assert.equal(decoded.transactionCode, undefined);
  assert.equal((await f.admin(`/offers/${offer.id}/approve`, { body: {} })).status, 409);
  assert.equal((await f.wallet(capability)).data.status, 'offered');
});

test('Public CORS erlaubt nur die konfigurierte Workshop-Origin und ersetzt keine Capability-Authentifizierung', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const offer = await f.offer();
  const preflight = await f.wallet(offer, '', { method: 'OPTIONS', headers: {
    Origin: f.workshopUrl, 'Access-Control-Request-Method': 'POST',
    'Access-Control-Request-Headers': 'Content-Type,X-Offer-Token',
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), f.workshopUrl);
  assert.match(preflight.headers.get('access-control-allow-headers'), /X-Offer-Token/);
  for (const origin of ['https://evil.example', 'null', `${f.workshopUrl}.evil.example`]) {
    const response = await f.wallet(offer, '', { headers: { Origin: origin } });
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.status, 200);
  }
  const missing = await f.call(`/api/offers/${offer.id}`, { headers: { Origin: f.workshopUrl } });
  assert.equal(missing.status, 401);
  assert.equal(missing.headers.get('access-control-allow-origin'), f.workshopUrl);
  assert.equal((await f.wallet(offer, '', { token: 'falsch' })).status, 401);
  assert.equal((await f.call(`/api/offers/${offer.id}?token=${offer.token}`)).status, 401);
  assert.equal((await f.call('/api/offers/unknown', { token: offer.token })).status, 404);
});

test('Wallet-Beweise prüfen Typ, Signatur, aud, nonce, iss, Zeit und strikt öffentliche JWK', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const offer = await f.offer();
  const holder = await sd.generateKeyPair();
  const other = await sd.generateKeyPair();
  const invalid = [
    'kein.jwt.beweis',
    await f.proof(offer, holder, { aud: f.workshopUrl }),
    await f.proof(offer, holder, { nonce: 'falsch' }),
    await f.proof(offer, holder, { iss: other.did }),
    await f.proof(offer, holder, { jwk: holder.privateJwk }),
    await f.proof(offer, holder, { jwk: { ...holder.publicJwk, kid: 'extra' } }),
    await f.proof(offer, holder, { jwk: other.publicJwk }),
    await f.proof(offer, holder, {}, REGISTRATION_PROOF),
    await sd.signJwt({ alg: 'ES256', typ: HOLDER_PROOF }, {
      iss: holder.did, aud: f.issuerUrl, nonce: offer.nonce, jwk: holder.publicJwk,
      iat: Math.floor(Date.now() / 1000) - 200, exp: Math.floor(Date.now() / 1000) - 80,
    }, holder.privateJwk),
  ];
  for (const proof of invalid) {
    const response = await f.wallet(offer, '/claim', { body: { proof } });
    assert.equal(response.status, 400, JSON.stringify(response.data));
    assert.match(response.data.error, /Schlüsselbeweis/);
  }
  const identity = JSON.parse(await readFile(path.join(f.dataDirectory, 'identity.json'), 'utf8'));
  const issuerAsHolder = await f.proof(offer, identity);
  assert.equal((await f.wallet(offer, '/claim', { body: { proof: issuerAsHolder } })).status, 400);
  assert.equal((await f.wallet(offer)).data.status, 'offered');
});

test('Gleichzeitige Wallet-Claims binden atomisch nur einen Holder und sind für diesen idempotent', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const offer = await f.offer();
  const holders = await Promise.all([sd.generateKeyPair(), sd.generateKeyPair()]);
  const proofs = await Promise.all(holders.map((holder) => f.proof(offer, holder)));
  const results = await Promise.all(proofs.map((proof) => f.wallet(offer, '/claim', {
    body: { proof, transactionCode: offer.transactionCode },
  })));
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  const winner = results.findIndex((result) => result.status === 200);
  const bound = results[winner].data;
  assert.equal(bound.status, 'bound');
  assert.equal(bound.transactionCode, undefined);
  const repeated = await Promise.all([1, 2, 3].map(() => f.wallet(offer, '/claim', { body: { proof: proofs[winner] } })));
  assert.ok(repeated.every((result) => result.status === 200 && result.data.transactionCode === undefined));
  const management = await f.admin(`/offers/${offer.id}`);
  assert.equal(management.data.holderDid, holders[winner].did);
  noKeys(management.data);
  assert.equal((await f.wallet(offer, '/credential', { body: { proof: proofs[winner] } })).status, 409);
  assert.equal((await f.wallet(offer, '/ack', { body: { proof: proofs[winner] } })).status, 409);
});

test('Ausgabecode bindet die Wallet; bewusste Signatur, Abholung, Claim und Ack sind wiederholbar', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const offer = await f.offer();
  const holder = await sd.generateKeyPair();
  const other = await sd.generateKeyPair();
  const proof = await f.proof(offer, holder);
  const otherProof = await f.proof(offer, other);
  const wrongCode = offer.transactionCode === '000000' ? '111111' : '000000';
  const wrong = await f.wallet(offer, '/claim', { body: { proof, transactionCode: wrongCode } });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /Ausgabecode ist falsch/);
  assert.equal((await f.wallet(offer)).data.status, 'offered');
  const bound = await f.wallet(offer, '/claim', { body: { proof, transactionCode: offer.transactionCode } });
  assert.equal(bound.status, 200);
  assert.equal((await f.wallet(offer)).data.status, 'bound');
  const approvals = await Promise.all([1, 2, 3].map(() => f.admin(`/offers/${offer.id}/approve`, {
    body: {},
  })));
  assert.deepEqual(approvals.map((response) => response.status).sort(), [200, 409, 409]);
  approvals.forEach((response) => noKeys(response.data));
  const delivery = await f.wallet(offer, '/credential', { body: { proof } });
  assert.equal(delivery.status, 200);
  assert.deepEqual(Object.keys(delivery.data).sort(), ['issuerDid', 'issuerName', 'sdjwt']);
  const described = sd.describeCredential(delivery.data.sdjwt);
  assert.equal(described.payload.vct, EMPLOYEE_VCT);
  assert.deepEqual(described.claims, claims);
  assert.equal(described.payload.iss, offer.issuerDid);
  assert.equal(described.payload.exp - described.payload.iat, 86400);
  assert.deepEqual(described.payload.cnf.jwk, holder.publicJwk);
  assert.notDeepEqual(described.payload.cnf.jwk, sd.jwkFromDid(offer.issuerDid));
  await sd.verifyJwt(sd.parseSdJwt(delivery.data.sdjwt).jwt, sd.jwkFromDid(offer.issuerDid));
  for (const route of ['/credential', '/ack', '/claim']) {
    assert.equal((await f.wallet(offer, route, { body: { proof: otherProof } })).status, 409);
  }
  const reClaim = await f.wallet(offer, '/claim', { body: { proof } });
  assert.equal(reClaim.data.status, 'issued');
  assert.equal((await f.wallet(offer, '/credential', { body: { proof } })).data.sdjwt, delivery.data.sdjwt);
  assert.equal((await f.wallet(offer, '/ack', { body: { proof } })).data.status, 'accepted');
  assert.equal((await f.wallet(offer, '/ack', { body: { proof } })).data.status, 'accepted');
  assert.equal((await f.wallet(offer, '/claim', { body: { proof } })).data.status, 'accepted');
  assert.equal((await f.wallet(offer, '/credential', { body: { proof } })).data.sdjwt, delivery.data.sdjwt);
  assert.equal((await f.admin(`/offers/${offer.id}/approve`, {
    body: {},
  })).status, 409);
  assert.equal((await f.admin(`/offers/${offer.id}/cancel`, { body: {} })).status, 409);
  noKeys((await f.wallet(offer)).data);
  noKeys((await f.admin(`/offers/${offer.id}`)).data);
});

test('Gleichzeitige Claims und Signatur setzen einen signierten Zustand nicht zurück', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const offer = await f.offer();
  const holder = await sd.generateKeyPair();
  const proof = await f.proof(offer, holder);
  await f.wallet(offer, '/claim', { body: { proof, transactionCode: offer.transactionCode } });
  const responses = await Promise.all([
    f.admin(`/offers/${offer.id}/approve`, { body: {} }),
    f.wallet(offer, '/claim', { body: { proof } }),
    f.wallet(offer, '/claim', { body: { proof } }),
  ]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal((await f.wallet(offer)).data.status, 'issued');
});

test('Expiry entfernt Angebote und Credential-Daten; Capability bleibt auch bei Ablauf erforderlich', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const offer = await f.offer();
  const holder = await sd.generateKeyPair();
  const proof = await f.proof(offer, holder);
  f.advance(10 * 60 * 1000);
  assert.equal((await f.wallet(offer)).status, 410);
  assert.equal((await f.wallet(offer, '', { token: 'falsch' })).status, 401);
  assert.equal((await f.admin(`/offers/${offer.id}`)).status, 410);
  for (const route of ['/claim', '/credential', '/ack']) {
    assert.equal((await f.wallet(offer, route, { body: { proof } })).status, 410);
  }
  const newOffer = await f.offer();
  assert.notEqual(newOffer.id, offer.id);
  assert.equal((await f.wallet(newOffer)).data.status, 'offered');
});

test('Abbruch ist vor der Signatur möglich und beendet den öffentlichen Zugriff', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const offer = await f.offer();
  assert.equal((await f.admin(`/offers/${offer.id}/cancel`, { body: {} })).data.status, 'cancelled');
  assert.equal((await f.wallet(offer)).status, 410);
  assert.equal((await f.admin(`/offers/${offer.id}`)).data.status, 'cancelled');
  assert.equal((await f.admin(`/offers/${offer.id}/approve`, { body: {} })).status, 410);
});

test('Ausgabecodes fehlen im öffentlichen Angebot, Fehlversuche binden keine Wallet und sperren nach fünf Versuchen', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const offer = await f.offer();
  const holder = await sd.generateKeyPair();
  const proof = await f.proof(offer, holder);
  for (const transactionCode of [undefined, '', '12', 'abcdef']) {
    const result = await f.wallet(offer, '/claim', { body: { proof, transactionCode } });
    assert.equal(result.status, 400);
    assert.match(result.data.error, /sechsstelligen Ausgabecode/);
  }
  const wrongCode = offer.transactionCode === '000000' ? '111111' : '000000';
  for (let attempt = 1; attempt <= 5; attempt++) {
    const response = await f.wallet(offer, '/claim', { body: { proof, transactionCode: wrongCode } });
    assert.equal(response.status, attempt === 5 ? 429 : 400);
    assert.match(response.data.error, attempt === 5 ? /neues Angebot/ : /Ausgabecode ist falsch/);
    const management = (await f.admin(`/offers/${offer.id}`)).data;
    assert.equal(management.holderDid, null);
    assert.equal(management.status, attempt === 5 ? 'cancelled' : 'offered');
    assert.equal(management.sdjwt, undefined);
  }
  assert.equal((await f.wallet(offer, '/claim', { body: { proof, transactionCode: offer.transactionCode } })).status, 410);
  const replacement = await f.offer();
  assert.equal((await f.wallet(replacement, '/claim', { body: {
    proof: await f.proof(replacement, holder), transactionCode: replacement.transactionCode,
  } })).status, 200);
});

test('Entzogenes Issuer-Vertrauen verhindert auch die Signatur eines zuvor erstellten Angebots', async (t) => {
  const f = await fixture(t);
  await f.ready();
  const offer = await f.offer();
  const holder = await sd.generateKeyPair();
  await f.wallet(offer, '/claim', { body: {
    proof: await f.proof(offer, holder), transactionCode: offer.transactionCode,
  } });
  const record = f.registry.get(offer.issuerDid);
  record.trusted = false;
  const denied = await f.admin(`/offers/${offer.id}/approve`, { body: {} });
  assert.equal(denied.status, 409);
  assert.match(denied.data.error, /Setup/);
  assert.equal((await f.wallet(offer)).data.status, 'bound');
  record.trusted = true;
  assert.equal((await f.admin(`/offers/${offer.id}/approve`, { body: {} })).status, 200);
});

test('Öffentliche Origins erfordern HTTPS außer Loopback und strikt getrennte Issuer-/Workshop-Adressen', async () => {
  const base = { publicUrl: 'https://issuer.example', workshopUrl: 'https://workshop.example',
    dataDirectory: path.join(process.cwd(), '.issuer-test-invalid') };
  for (const patch of [
    { publicUrl: 'http://issuer.example' }, { workshopUrl: 'http://192.168.1.1:3000' },
    { publicUrl: 'https://user:pass@issuer.example' }, { publicUrl: 'https://issuer.example/path' },
    { publicUrl: 'https://issuer.example#fragment' }, { workshopUrl: 'https://issuer.example' },
  ]) {
    await assert.rejects(createIssuerApp({ ...base, ...patch }));
  }
});

async function issuedCredential(f) {
  const offer = await f.offer();
  const holder = await sd.generateKeyPair();
  assert.equal((await f.wallet(offer, '/claim', { body: {
    proof: await f.proof(offer, holder), transactionCode: offer.transactionCode,
  } })).status, 200);
  assert.equal((await f.admin(`/offers/${offer.id}/approve`, { body: {} })).status, 200);
  const received = await f.wallet(offer, '/credential', { body: { proof: await f.proof(offer, holder) } });
  assert.equal(received.status, 200);
  return { offer, holder, sdjwt: received.data.sdjwt };
}

test('Ausgestellte Credentials und unumkehrbarer Widerruf sind dauerhaft; öffentliche Listen enthalten keine Personendaten', async (t) => {
  const f = await fixture(t);
  await f.ready();
  assert.deepEqual((await f.admin('/credentials')).data, []);
  const issued = await issuedCredential(f);
  const records = (await f.admin('/credentials')).data;
  assert.equal(records.length, 1);
  const record = records[0];
  assert.equal(record.id, await sd.sha256b64(sd.parseSdJwt(issued.sdjwt).jwt));
  assert.equal(record.holderDid, issued.holder.did);
  assert.equal(record.revokedAt, null);
  assert.deepEqual(record.claims, claims);
  noKeys(records);
  const reference = sd.describeCredential(issued.sdjwt).payload.status.status_list;
  assert.equal(reference.idx, record.statusIndex);
  assert.equal(reference.uri, `${f.issuerUrl}/api/status-list`);
  const readList = async () => {
    const response = await f.call('/api/status-list', { headers: { Origin: f.workshopUrl } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/statuslist\+jwt/);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('access-control-allow-origin'), f.workshopUrl);
    const payload = sd.decodeJwt(response.data).payload;
    for (const hidden of ['claims', 'holderDid', 'given_name', 'family_name', record.id]) {
      assert.equal(JSON.stringify(payload).includes(hidden), false);
    }
    return verifyStatusList(response.data, { issuerDid: record.issuerDid, uri: reference.uri });
  };
  assert.equal(isRevoked(await readList(), record.statusIndex), false);
  const revoked = await f.admin(`/credentials/${record.id}/revoke`, { body: {} });
  assert.equal(revoked.status, 200);
  assert.ok(revoked.data.revokedAt);
  assert.equal(isRevoked(await readList(), record.statusIndex), true);
  f.advance(10);
  const repeated = await f.admin(`/credentials/${record.id}/revoke`, { body: {} });
  assert.equal(repeated.data.revokedAt, revoked.data.revokedAt);
  assert.equal((await f.admin(`/credentials/${record.id}/revoke`, { body: { revoked: false } })).status, 400);
  assert.equal((await f.admin(`/credentials/${'x'.repeat(43)}/revoke`, { body: {} })).status, 404);
  assert.equal((await f.wallet(issued.offer, '/credential', {
    body: { proof: await f.proof(issued.offer, issued.holder) },
  })).status, 410);
  const restart = await createIssuerApp(f.options);
  const restarted = await listen(restart.app);
  t.after(() => close(restarted.server));
  const loaded = await request(restarted.url, '/api/issuer/credentials', {
    headers: { 'X-Admin-Token': restart.adminToken },
  });
  assert.deepEqual(loaded.data, [revoked.data]);
  const signedList = (await request(restarted.url, '/api/status-list')).data;
  assert.equal(isRevoked(await verifyStatusList(signedList, {
    issuerDid: record.issuerDid, uri: reference.uri,
  }), record.statusIndex), true);
  if (process.platform !== 'win32') {
    assert.equal((await stat(path.join(f.dataDirectory, 'credentials.json'))).mode & 0o777, 0o600);
  }
});

test('Parallele Ausstellungen erhalten eigene Statusindizes; beschädigte oder verlorene Widerrufsdaten verhindern den Neustart', async (t) => {
  const f = await fixture(t);
  await f.ready();
  await Promise.all([issuedCredential(f), issuedCredential(f), issuedCredential(f)]);
  const records = (await f.admin('/credentials')).data;
  assert.equal(records.length, 3);
  assert.equal(new Set(records.map((record) => record.id)).size, 3);
  assert.equal(new Set(records.map((record) => record.statusIndex)).size, 3);
  const file = path.join(f.dataDirectory, 'credentials.json');
  await writeFile(file, 'broken');
  await assert.rejects(createIssuerApp(f.options), /Credentials.*nicht sicher geladen/);
  await rm(file);
  await assert.rejects(createIssuerApp(f.options), /Credentials.*nicht sicher geladen/);
});
