import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import * as sd from '../public/lib/sdjwt.js';

let issuer;
let holder;
const context = { aud: 'isst-empfang', nonce: 'test-nonce', isTrustedIssuer: () => true };
const claims = { given_name: 'Erika', family_name: 'Müller', organisation: 'ISST', role: 'Gast' };

before(async () => {
  issuer = await sd.generateKeyPair();
  holder = await sd.generateKeyPair();
});

async function issue(overrides = {}) {
  return sd.issueSdJwt({
    issuerDid: issuer.did,
    issuerPrivateJwk: issuer.privateJwk,
    holderPublicJwk: holder.publicJwk,
    vct: 'urn:isst:gastausweis:1',
    claims,
    ...overrides,
  });
}

async function present(sdjwt, overrides = {}) {
  return sd.createPresentation({
    sdjwt, reveal: ['given_name', 'family_name'],
    holderPrivateJwk: holder.privateJwk, ...context, ...overrides,
  });
}

test('Roundtrip reveals exactly the selected claims and seven verification steps', async () => {
  const result = await sd.verifyPresentation(await present(await issue()), context);
  assert.equal(result.ok, true);
  assert.deepEqual(result.claims, { given_name: 'Erika', family_name: 'Müller' });
  assert.equal(result.steps.length, 7);
});

test('Umlauts survive issuance and verification', async () => {
  const result = await sd.verifyPresentation(await present(await issue()), context);
  assert.equal(result.claims.family_name, 'Müller');
});

test('A substituted disclosure is rejected', async () => {
  const parts = (await issue()).split('~');
  parts[1] = sd.jsonB64(['fake-salt', 'given_name', 'Mallory']);
  const result = await sd.verifyPresentation(await present(parts.join('~')), context);
  assert.equal(result.ok, false);
  assert.match(result.error, /Disclosure/);
});

test('A different nonce is rejected', async () => {
  const result = await sd.verifyPresentation(await present(await issue()), { ...context, nonce: 'new-nonce' });
  assert.equal(result.ok, false);
  assert.match(result.error, /Nonce/);
});

test('A key binding signed by a different holder is rejected', async () => {
  const stranger = await sd.generateKeyPair();
  const result = await sd.verifyPresentation(
    await present(await issue(), { holderPrivateJwk: stranger.privateJwk }), context,
  );
  assert.equal(result.ok, false);
  assert.match(result.error, /Signatur/);
});

test('An issuer outside the trust list is rejected', async () => {
  const result = await sd.verifyPresentation(await present(await issue()), { ...context, isTrustedIssuer: () => false });
  assert.equal(result.ok, false);
  assert.match(result.error, /Vertrauensliste/);
});

test('An expired credential is rejected', async () => {
  const result = await sd.verifyPresentation(await present(await issue({ validDays: -1 })), context);
  assert.equal(result.ok, false);
  assert.match(result.error, /abgelaufen/);
});

test('DID roundtrip preserves the public key', () => {
  assert.deepEqual(sd.jwkFromDid(sd.didFromJwk(issuer.publicJwk)), issuer.publicJwk);
});

async function rewriteCredential({ header = {}, payload = {}, disclosures } = {}) {
  const original = sd.parseSdJwt(await issue());
  const decoded = sd.decodeJwt(original.jwt);
  const jwt = await sd.signJwt(
    { ...decoded.header, ...header }, { ...decoded.payload, ...payload }, issuer.privateJwk,
  );
  return `${jwt}~${(disclosures || original.disclosures.map((entry) => entry.raw)).join('~')}~`;
}

test('JWT verification rejects extra segments and unsupported algorithms', async () => {
  const { jwt } = sd.parseSdJwt(await issue());
  await assert.rejects(sd.verifyJwt(`${jwt}.extra`, issuer.publicJwk), /JWT/);
  const wrongAlg = await sd.signJwt({ alg: 'HS256' }, { test: true }, issuer.privateJwk);
  await assert.rejects(sd.verifyJwt(wrongAlg, issuer.publicJwk), /Signaturalgorithmus/);
});

test('Credential expiry must be present, numeric, and strictly later than now', async () => {
  for (const exp of [undefined, null, 0, '9999999999', Math.floor(Date.now() / 1000)]) {
    const credential = await rewriteCredential({ payload: { exp } });
    const result = await sd.verifyPresentation(await present(credential), context);
    assert.equal(result.ok, false, `exp=${exp}`);
    assert.match(result.error, /Gültigkeitsdauer|abgelaufen/);
  }
});

test('Issuance timestamps reject invalid values but tolerate small clock differences', async () => {
  const time = Math.floor(Date.now() / 1000);
  for (const iat of [undefined, 'yesterday', time + 3600]) {
    const result = await sd.verifyPresentation(await present(await rewriteCredential({ payload: { iat } })), context);
    assert.equal(result.ok, false);
    assert.match(result.error, /Gültigkeitsdauer/);
  }
  const result = await sd.verifyPresentation(
    await present(await rewriteCredential({ payload: { iat: time + 30 } })), context,
  );
  assert.equal(result.ok, true);
});

test('Credential type, digest algorithm and digest list are validated', async () => {
  for (const options of [
    { header: { typ: 'JWT' } },
    { payload: { _sd_alg: 'sha-512' } },
    { payload: { _sd: 'not-an-array' } },
    { payload: { _sd: [null] } },
    { payload: { _sd: ['duplicate', 'duplicate'] } },
  ]) {
    const result = await sd.verifyPresentation(await present(await rewriteCredential(options)), context);
    assert.equal(result.ok, false);
    assert.match(result.error, /SD-JWT-Format/);
  }
});

test('Repeated disclosures and malformed claim names are rejected', async () => {
  const original = sd.parseSdJwt(await issue());
  const repeated = [original.disclosures[0].raw, original.disclosures[0].raw];
  assert.match((await sd.verifyPresentation(
    await present(await rewriteCredential({
      disclosures: repeated, payload: { _sd: [await sd.sha256b64(repeated[0])] },
    })), context,
  )).error, /doppelte Disclosure/);
  for (const value of [
    ['salt', '__proto__', { extra: 'unexpected' }],
    ['salt', '', 'value'],
    ['salt', 'given_name'],
    ['', 'given_name', 'Erika'],
  ]) {
    const disclosure = sd.jsonB64(value);
    const credential = await rewriteCredential({
      disclosures: [disclosure], payload: { _sd: [await sd.sha256b64(disclosure)] },
    });
    const result = await sd.verifyPresentation(await present(credential, { reveal: [value[1]] }), context);
    assert.equal(result.ok, false);
    assert.match(result.error, /Disclosure/);
  }
});

test('Key-binding type and issuance time are validated', async () => {
  const presentation = await present(await issue());
  const { kb } = sd.parseSdJwt(presentation);
  const original = sd.decodeJwt(kb);
  for (const { header = {}, payload = {} } of [
    { header: { typ: 'JWT' } },
    { payload: { iat: undefined } },
    { payload: { iat: Math.floor(Date.now() / 1000) + 3600 } },
  ]) {
    const replacement = await sd.signJwt(
      { ...original.header, ...header }, { ...original.payload, ...payload }, holder.privateJwk,
    );
    const result = await sd.verifyPresentation(presentation.slice(0, -kb.length) + replacement, context);
    assert.equal(result.ok, false);
    assert.match(result.error, /Key-Binding-JWT/);
  }
});
