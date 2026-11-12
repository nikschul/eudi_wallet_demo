import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as sd from '../public/lib/sdjwt.js';
import { HOLDER_PROOF, publicOrigin, validatePublicJwk, signProof, verifyProof, decodeOffer, offerTransactionCode } from '../public/lib/protocol.js';

test('Public origins require HTTPS except local loopback and reject path or credentials', () => {
  assert.equal(publicOrigin('https://workshop.example.org/'), 'https://workshop.example.org');
  assert.equal(publicOrigin('http://localhost:3001'), 'http://localhost:3001');
  for (const url of ['http://192.168.1.1:3000', 'https://example.org/path', 'https://user:pass@example.org', 'https://example.org?x=y', 'invalid']) {
    assert.throws(() => publicOrigin(url));
  }
});

test('Only public P-256 keys are accepted and proofs are bound to purpose, audience and nonce', async () => {
  const wallet = await sd.generateKeyPair();
  await assert.rejects(validatePublicJwk(wallet.privateJwk), /öffentlicher/);
  const context = {
    type: HOLDER_PROOF, publicJwk: wallet.publicJwk, audience: 'https://issuer.example.org',
    nonce: 'random-challenge', issuer: wallet.did,
  };
  const proof = await signProof(HOLDER_PROOF, {
    iss: wallet.did, aud: context.audience, nonce: context.nonce, jwk: wallet.publicJwk,
  }, wallet.privateJwk);
  assert.equal((await verifyProof(proof, context)).iss, wallet.did);
  for (const change of [{ audience: 'https://other.example.org' }, { nonce: 'old' }, { type: 'wrong+jwt' }, { issuer: 'other' }]) {
    await assert.rejects(verifyProof(proof, { ...context, ...change }), /ungültig/);
  }
});

test('Offer links contain a capability but no private data and malformed links are rejected', () => {
  const offer = { issuer: 'did:jwk:public', id: crypto.randomUUID(), token: sd.b64url(crypto.getRandomValues(new Uint8Array(32))) };
  assert.deepEqual(decodeOffer(`#offer=${sd.jsonB64(offer)}`), offer);
  assert.equal(decodeOffer('#req=other'), null);
  assert.throws(() => decodeOffer('#offer=broken'));
  assert.throws(() => decodeOffer(`#offer=${sd.jsonB64({ ...offer, token: 'short' })}`));
});

test('Issuer display requires a six-digit code for every open offer, preserving leading zeros', () => {
  for (const transactionCode of ['000001', '123456']) {
    assert.equal(offerTransactionCode({ status: 'offered', transactionCode }), transactionCode);
  }
  for (const transactionCode of [undefined, null, '', 123456, '12345', '1234567', 'abcdef']) {
    assert.throws(() => offerTransactionCode({ status: 'offered', transactionCode }), /keinen gültigen Ausgabecode/);
  }
  for (const status of ['bound', 'issued', 'accepted', 'cancelled']) {
    assert.equal(offerTransactionCode({ status }), null);
  }
});
