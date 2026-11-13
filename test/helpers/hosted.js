import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../../server/app.js';
import * as sd from '../../public/lib/sdjwt.js';
import { HOLDER_PROOF, decodeOffer, signProof } from '../../public/lib/protocol.js';

export const claims = { given_name: 'Erika', family_name: 'Muster', role: 'Mitarbeitende' };
export async function fixture(t, options = {}) {
  const directory = await mkdtemp(path.join(tmpdir(), 'eudi-hosted-'));
  let handler;
  const server = createServer((req, res) => handler(req, res)).listen(0, '127.0.0.1');
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  let now = Date.now();
  const config = { publicUrl: base, dataDirectory: directory, clock: () => now, ...options };
  let created;
  const restart = async () => { created = await createApp(config); handler = created.app; return created; };
  t.after(async () => {
    await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); });
    await rm(directory, { recursive: true, force: true });
  });
  await restart();
  const call = async (route, { body, cookie, offerToken, admin = false, headers = {}, method } = {}) => {
    const response = await fetch(base + route, {
      method: method || (body === undefined ? 'GET' : 'POST'),
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(cookie ? { Cookie: cookie } : {}),
        ...(offerToken ? { 'X-Offer-Token': offerToken } : {}),
        ...(admin ? { 'X-Admin-Token': created.adminToken } : {}),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const type = response.headers.get('content-type') || '';
    return { status: response.status, headers: response.headers,
      data: type.includes('application/json') ? await response.json() : await response.text() };
  };
  const organisation = async (name = 'Workshop GmbH') => {
    const response = await call('/api/organisations', { body: { name } });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    const cookie = response.headers.get('set-cookie').split(';')[0];
    return { org: response.data.organisation, cookie,
      owner: (route, body) => call(`/api/issuer${route}`, { body, cookie }) };
  };
  const trust = (org, trusted = true) => call(`/api/admin/issuers/${encodeURIComponent(org.did)}/trust`, { admin: true, body: { trusted } });
  const offer = async (tenant, offeredClaims = claims) => {
    const response = await tenant.owner('/offers', { claims: offeredClaims });
    assert.equal(response.status, 201, JSON.stringify(response.data));
    return { ...response.data, token: decodeOffer(new URL(response.data.url).hash).token };
  };
  const proof = (offer, holder, changes = {}, type = HOLDER_PROOF) => signProof(type, {
    iss: holder.did, aud: config.publicUrl, nonce: offer.nonce, jwk: holder.publicJwk, ...changes,
  }, holder.privateJwk);
  const wallet = (offer, suffix = '', body) => call(`/api/offers/${offer.id}${suffix}`, { body, offerToken: offer.token });
  const issue = async (tenant, holder = null) => {
    holder ||= await sd.generateKeyPair();
    assert.equal((await trust(tenant.org)).status, 200);
    const offered = await offer(tenant);
    const claimed = await wallet(offered, '/claim', { proof: await proof(offered, holder), transactionCode: offered.transactionCode });
    assert.equal(claimed.status, 200, JSON.stringify(claimed.data));
    assert.equal(claimed.data.status, 'issued');
    const received = await wallet(offered, '/credential', { proof: await proof(offered, holder) });
    assert.equal(received.status, 200, JSON.stringify(received.data));
    return { offer: offered, holder, sdjwt: received.data.sdjwt };
  };
  const checkIn = async (credential, reveal = ['given_name', 'family_name'], request = null) => {
    request ||= (await call('/api/requests', { body: {} })).data;
    request = (await call(`/api/requests/${request.id}`)).data;
    const presentation = await sd.createPresentation({
      sdjwt: credential.sdjwt, reveal, holderPrivateJwk: credential.holder.privateJwk,
      aud: request.aud, nonce: request.nonce,
    });
    const result = await call(`/api/requests/${request.id}/response`, { body: { presentation } });
    return { request, presentation, result };
  };
  return { call, base, directory, config, restart, organisation, trust, offer, proof, wallet, issue, checkIn,
    get adminToken() { return created.adminToken; },
    advance(milliseconds) { now += milliseconds; } };
}

export function noSecrets(value) {
  assert.doesNotMatch(JSON.stringify(value), /"(?:privateJwk|publicJwk|accessHash|accessExpires|recovery|codeHash|tokenHash|sdjwt|employeeName|ownerName|issuerOwner)"\s*:/);
}
