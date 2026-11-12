import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:net';
import { once } from 'node:events';
import { createApp } from '../server/app.js';
import { createIssuerApp } from '../server/issuer-app.js';
import * as sd from '../public/lib/sdjwt.js';
import { EMPLOYEE_VCT, HOLDER_PROOF, decodeOffer, signProof } from '../public/lib/protocol.js';

async function port() {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const result = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return result;
}

async function listen(t, app, number) {
  const server = app.listen(number, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return server;
}

async function json(base, route, { body, offerToken, adminToken, origin } = {}) {
  const response = await fetch(`${base}/api${route}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(offerToken ? { 'X-Offer-Token': offerToken } : {}),
      ...(adminToken ? { 'X-Admin-Token': adminToken } : {}),
      ...(origin ? { Origin: origin } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { status: response.status, data: await response.json(), headers: response.headers };
}

test('Issuer trust is established during setup, phone enters the private issuance code, kiosk records only disclosed data', { timeout: 30000 }, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-workshop-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const hubPort = await port();
  const issuerPort = await port();
  const hub = `http://127.0.0.1:${hubPort}`;
  const issuer = `http://127.0.0.1:${issuerPort}`;
  const hubApp = await createApp({
    publicUrl: hub, dataDirectory: path.join(directory, 'hub'),
  });
  await listen(t, hubApp.app, hubPort);
  const issuerApp = await createIssuerApp({
    publicUrl: issuer, workshopUrl: hub, dataDirectory: path.join(directory, 'issuer'),
  });
  const issuerServer = await listen(t, issuerApp.app, issuerPort);
  const management = (route, body) => json(issuer, `/issuer${route}`, { body, adminToken: issuerApp.adminToken });
  assert.ok([200, 201].includes((await management('/setup', { name: 'Erikas Ausweisstelle', employeeName: 'Erika Müller' })).status));
  const registered = await management('/register', {});
  assert.ok([200, 201].includes(registered.status), JSON.stringify(registered.data));
  const identity = (await management('/status')).data;
  const registry = (await json(hub, '/issuers')).data;
  assert.equal(registry.length, 1);
  assert.equal(registry[0].did, identity.did);
  assert.equal(registry[0].proofVerified, true);
  assert.equal(registry[0].trusted, false);
  const offerBody = { claims: {
    given_name: 'Erika', family_name: 'Müller', organisation: 'Geheime Demo-Organisation', role: 'Mitarbeitende',
  } };
  assert.equal((await management('/offers', offerBody)).status, 409);
  const approvalPath = `/admin/issuers/${encodeURIComponent(identity.did)}/trust`;
  assert.equal((await json(hub, approvalPath, {
    body: { trusted: true, ownerName: 'Erika Müller' }, adminToken: hubApp.adminToken,
  })).status, 200);
  const created = await management('/offers', offerBody);
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.data));
  const link = decodeOffer(new URL(created.data.url).hash);
  assert.equal(new URL(created.data.url).origin, hub);
  const remote = (suffix = '', body) => json(issuer, `/offers/${link.id}${suffix}`, {
    body, offerToken: link.token, origin: hub,
  });
  const offered = await remote();
  assert.equal(offered.headers.get('access-control-allow-origin'), hub);
  assert.equal(offered.data.status, 'offered');
  assert.equal(offered.data.transactionCode, undefined);
  const wallet = await sd.generateKeyPair();
  const makeProof = () => signProof(HOLDER_PROOF, {
    iss: wallet.did, jwk: wallet.publicJwk, aud: issuer, nonce: offered.data.nonce,
  }, wallet.privateJwk);
  const wrongCode = created.data.transactionCode === '000000' ? '111111' : '000000';
  const wrong = await remote('/claim', { proof: await makeProof(), transactionCode: wrongCode });
  assert.equal(wrong.status, 400);
  assert.match(wrong.data.error, /Ausgabecode ist falsch/);
  const bound = await remote('/claim', { proof: await makeProof(), transactionCode: created.data.transactionCode });
  assert.equal(bound.status, 200);
  const managementOffer = (await management(`/offers/${link.id}`)).data;
  assert.equal(managementOffer.holderDid, wallet.did);
  assert.equal(managementOffer.transactionCode, undefined);
  assert.equal((await management(`/offers/${link.id}/approve`, {})).status, 200);
  const received = await remote('/credential', { proof: await makeProof() });
  assert.equal(received.status, 200);
  const credential = sd.describeCredential(received.data.sdjwt);
  assert.equal(credential.payload.vct, EMPLOYEE_VCT);
  assert.equal(sd.didFromJwk(credential.payload.cnf.jwk), wallet.did);
  assert.equal((await remote('/ack', { proof: await makeProof() })).status, 200);
  assert.equal((await remote('/credential', { proof: await makeProof() })).data.sdjwt, received.data.sdjwt);
  const kiosk = (await json(hub, '/requests', { body: { mode: 'kiosk' } })).data;
  async function checkIn(reveal = ['given_name', 'family_name']) {
    const session = await json(hub, `/requests/${kiosk.id}/sessions`, { body: {} });
    assert.equal(session.status, 201);
    const request = session.data;
    const presentation = await sd.createPresentation({
      sdjwt: received.data.sdjwt, reveal, holderPrivateJwk: wallet.privateJwk, aud: request.aud, nonce: request.nonce,
    });
    return json(hub, `/requests/${request.id}/response`, { body: { presentation } });
  }
  assert.equal((await json(hub, approvalPath, {
    body: { trusted: false }, adminToken: hubApp.adminToken,
  })).status, 200);
  const denied = await checkIn();
  assert.equal(denied.data.ok, false);
  assert.match(denied.data.error, /Vertrauensliste/);
  assert.equal((await json(hub, approvalPath, {
    body: { trusted: true, ownerName: 'Erika Müller' }, adminToken: hubApp.adminToken,
  })).status, 200);
  const checked = await checkIn();
  assert.equal(checked.data.ok, true, checked.data.error);
  assert.equal(checked.data.steps.length, 8);
  let attendee = (await json(hub, '/attendees')).data[0];
  assert.equal(attendee.issuerOwner, 'Erika Müller');
  assert.equal(JSON.stringify(attendee).includes('Geheime Demo-Organisation'), false);
  assert.equal(attendee.checkins.length, 1);
  assert.equal((await checkIn(['given_name', 'family_name', 'organisation'])).data.ok, true);
  attendee = (await json(hub, '/attendees')).data[0];
  assert.equal(attendee.checkins.length, 2);
  assert.equal(attendee.checkins[0].claims.organisation, undefined);
  assert.equal(attendee.checkins[1].claims.organisation, 'Geheime Demo-Organisation');
  assert.equal(attendee.checkins[0].credentialId, attendee.checkins[1].credentialId);
  assert.equal(JSON.stringify(attendee).includes('sdjwt'), false);
  assert.equal(JSON.stringify(attendee).includes('privateJwk'), false);
  const dashboard = (await json(hub, '/dashboard')).data;
  assert.deepEqual(dashboard.stats, { registered: 1, checkins: 2 });
  assert.equal(dashboard.attempts.length, 3);
  assert.equal(dashboard.attempts.filter((attempt) => attempt.identityVerified).length, 2);
  const failed = dashboard.attempts.find((attempt) => attempt.status === 'error');
  assert.equal(failed.name, 'Erika Müller');
  assert.equal(failed.failedAt, 'Issuer-Vertrauen');
  assert.equal(JSON.stringify(dashboard).includes('Geheime Demo-Organisation'), false);
  assert.equal((await json(hub, `/requests/${kiosk.id}`)).data.status, 'pending');
  const issued = (await management('/credentials')).data;
  assert.equal(issued.length, 1);
  assert.equal(issued[0].id, attendee.checkins[0].credentialId);
  const revoked = await management(`/credentials/${issued[0].id}/revoke`, {});
  assert.equal(revoked.status, 200);
  assert.ok(revoked.data.revokedAt);
  const rejected = await checkIn();
  assert.equal(rejected.data.ok, false);
  assert.equal(rejected.data.failedAt, 'Widerrufsstatus');
  assert.match(rejected.data.error, /widerrufen/);
  assert.deepEqual((await json(hub, '/dashboard')).data.stats, { registered: 1, checkins: 2 });
  await new Promise((resolve) => issuerServer.close(resolve));
  const offline = await checkIn();
  assert.equal(offline.data.ok, false);
  assert.equal(offline.data.failedAt, 'Widerrufsstatus');
  assert.match(offline.data.error, /nicht erreichbar/);
});
