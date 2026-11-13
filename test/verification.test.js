import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readVerificationStream, verificationChecks } from '../public/lib/verification.js';
import { api } from '../public/lib/ui.js';
import { fixture } from './helpers/hosted.js';
import * as sd from '../public/lib/sdjwt.js';

const encode = (value) => new TextEncoder().encode(value);
const progress = (completed) => ({ type: 'progress', total: 8, completed, steps: verificationChecks.slice(0, completed) });
const success = { type: 'result', result: { ok: true, steps: verificationChecks } };
function streamResponse(frames) {
  const bytes = encode(frames.map((frame) => typeof frame === 'string' ? frame : JSON.stringify(frame)).join('\n') + '\n');
  return new Response(new ReadableStream({
    start(controller) {
      for (let index = 0; index < bytes.length; index += 7) controller.enqueue(bytes.slice(index, index + 7));
      controller.close();
    },
  }), { headers: { 'Content-Type': 'application/x-ndjson' } });
}

test('Live verification decodes split UTF-8 frames, reports actual completed checks and requires a final result', async () => {
  const observed = [];
  assert.equal((await readVerificationStream(streamResponse([progress(0), progress(3), progress(8), success]),
    (frame) => observed.push(frame.completed))).ok, true);
  assert.deepEqual(observed, [0, 3, 8]);
  await assert.rejects(readVerificationStream(streamResponse([progress(8)]), () => {}), /ohne bestätigtes Prüfergebnis/);
});

test('Malformed, backwards, oversized and success-shaped incomplete verification streams fail explicitly', async () => {
  for (const [frames, message] of [
    [[progress(3), progress(2)], /ungültigen Prüfverlauf/],
    [[{ ...progress(1), total: 9 }], /ungültigen Prüfverlauf/],
    [[{ ...progress(1), steps: [] }], /ungültigen Prüfverlauf/],
    [[{ type: 'result', result: { ok: true, steps: [] } }], /unvollständig/],
    [[progress(0), success, progress(8)], /unerwartete Nachrichten/],
    [[...Array.from({ length: 13 }, () => progress(0))], /unerwartete Nachrichten/],
    [['x'.repeat(65537)], /zu groß/],
  ]) await assert.rejects(readVerificationStream(streamResponse(frames), () => {}), message);
});

test('The shared API opts into live verification while retaining JSON errors and old-server compatibility', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    assert.equal(options.headers.Accept, 'application/x-ndjson');
    assert.equal(options.credentials, 'omit');
    return streamResponse([progress(0), progress(8), success]);
  });
  const observed = [];
  assert.equal((await api('/requests/id/response', { body: {}, onProgress: (frame) => observed.push(frame.completed) })).ok, true);
  assert.deepEqual(observed, [0, 8]);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json({ error: 'Bereits verwendet' }, { status: 409 }));
  await assert.rejects(api('/requests/id/response', { body: {}, onProgress() {} }), /Bereits verwendet/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => Response.json(success.result));
  assert.equal((await api('/requests/id/response', { body: {}, onProgress() {} })).ok, true);
});

test('A stalled live response never becomes success and explains that the check-in outcome is uncertain', async (t) => {
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(encode(JSON.stringify(progress(0)) + '\n'));
      signal.addEventListener('abort', () => controller.error(signal.reason), { once: true });
    },
  }), { headers: { 'Content-Type': 'application/x-ndjson' } }));
  const observed = [];
  await assert.rejects(api('/requests/id/response', {
    body: {}, timeoutMs: 20, onProgress: (frame) => observed.push(frame.completed),
  }), /Ergebnis kann bereits gespeichert sein.*Kiosk/);
  assert.deepEqual(observed, [0]);
});

test('The actual verifier streams exactly eight completed checks before recording success and rejects nonce reuse', async (t) => {
  const f = await fixture(t);
  const credential = await f.issue(await f.organisation());
  const request = (await f.call('/api/requests', { body: {} })).data;
  const metadata = (await f.call(`/api/requests/${request.id}`)).data;
  const presentation = await sd.createPresentation({
    sdjwt: credential.sdjwt, reveal: ['given_name', 'family_name'], holderPrivateJwk: credential.holder.privateJwk,
    aud: metadata.aud, nonce: metadata.nonce,
  });
  const response = await f.call(`/api/requests/${request.id}/response`, {
    body: { presentation }, headers: { Accept: 'application/x-ndjson' },
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/x-ndjson/);
  assert.match(response.headers.get('cache-control'), /no-store.*no-transform/);
  const frames = response.data.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(frames.filter((frame) => frame.type === 'progress').map((frame) => frame.completed), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(frames.at(-1).type, 'result');
  assert.equal(frames.at(-1).result.ok, true);
  assert.equal(frames.at(-1).result.steps.length, 8);
  assert.equal(frames.at(-1).result.claims.role, undefined);
  assert.doesNotMatch(response.data, /privateJwk|sdjwt|Teamleitung|Mitarbeitende/);
  assert.equal((await f.call('/api/dashboard')).data.stats.checkins, 1);
  assert.equal((await f.call(`/api/requests/${request.id}/response`, {
    body: { presentation }, headers: { Accept: 'application/x-ndjson' },
  })).status, 409);
});

test('A rejected issuer streams only checks that actually passed and records a failed attempt', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  const credential = await f.issue(tenant);
  await f.trust(tenant.org, false);
  const next = (await f.call('/api/requests', { body: {} })).data;
  const metadata = (await f.call(`/api/requests/${next.id}`)).data;
  const bound = await sd.createPresentation({
    sdjwt: credential.sdjwt, reveal: ['given_name', 'family_name'], holderPrivateJwk: credential.holder.privateJwk,
    aud: metadata.aud, nonce: metadata.nonce,
  });
  const response = await f.call(`/api/requests/${next.id}/response`, {
    body: { presentation: bound }, headers: { Accept: 'application/x-ndjson' },
  });
  const frames = response.data.trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(frames.filter((frame) => frame.type === 'progress').map((frame) => frame.completed), [0, 1]);
  assert.equal(frames.at(-1).result.ok, false);
  assert.equal(frames.at(-1).result.failedAt, 'Issuer-Vertrauen');
  assert.equal((await f.call('/api/dashboard')).data.stats.checkins, 0);
  const dashboard = (await f.call('/api/dashboard')).data;
  assert.equal(dashboard.attempts.length, 1);
  assert.equal(dashboard.attempts[0].status, 'error');
});

test('Real verifier progress arrives before the asynchronous signature check finishes, without accepting a second response', async (t) => {
  const f = await fixture(t);
  const credential = await f.issue(await f.organisation());
  const request = (await f.call('/api/requests', { body: {} })).data;
  const metadata = (await f.call(`/api/requests/${request.id}`)).data;
  const presentation = await sd.createPresentation({
    sdjwt: credential.sdjwt, reveal: ['given_name', 'family_name'], holderPrivateJwk: credential.holder.privateJwk,
    aud: metadata.aud, nonce: metadata.nonce,
  });
  const verify = crypto.subtle.verify.bind(crypto.subtle);
  let resume;
  let blocked = true;
  const gate = new Promise((resolve) => { resume = resolve; });
  t.after(() => resume());
  t.mock.method(crypto.subtle, 'verify', async (...args) => {
    if (blocked) { blocked = false; await gate; }
    return verify(...args);
  });
  const response = await fetch(`${f.base}/api/requests/${request.id}/response`, {
    method: 'POST', headers: { Accept: 'application/x-ndjson', 'Content-Type': 'application/json' },
    body: JSON.stringify({ presentation }),
  });
  const reader = response.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, /"type":"progress"/);
  assert.doesNotMatch(first, /"type":"result"/);
  assert.equal((await f.call(`/api/requests/${request.id}`)).data.status, 'processing');
  assert.equal((await f.call(`/api/requests/${request.id}/response`, { body: { presentation } })).status, 409);
  resume();
  let rest = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
  }
  assert.match(rest, /"type":"result","result":\{"ok":true/);
  assert.equal((await f.call('/api/dashboard')).data.stats.checkins, 1);
});
