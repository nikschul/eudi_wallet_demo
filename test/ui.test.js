import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, currentRequestId, readWalletFor, updateRequestLinks } from '../public/lib/ui.js';

// Node 20 exposes fetch through a lazy getter that must resolve before mocking.
void globalThis.fetch;

function mockGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

test('Check-in IDs work with QR fragments and preserved navigation queries', () => {
  for (const [path, expected] of [
    ['/wallet.html#req=qr-id', 'qr-id'],
    ['/wallet.html?req=query-id', 'query-id'],
    ['/wallet.html?req=query-id#offer', 'query-id'],
    ['/wallet.html?req=query-id#req=qr-id', 'qr-id'],
    ['/wallet.html', null],
  ]) {
    assert.equal(currentRequestId(new URL(path, 'https://wallet.example.org')), expected);
  }
});

test('Navigation carries the current request and clears it after leaving check-in', (t) => {
  const links = ['/wallet.html', '/issuer.html', '/kiosk.html'].map((path) => new URL(path, 'https://wallet.example.org'));
  mockGlobal(t, 'document', { querySelectorAll: () => links });
  mockGlobal(t, 'location', { href: 'https://wallet.example.org/wallet.html#req=test-id' });
  updateRequestLinks();
  assert.equal(links[0].searchParams.get('req'), 'test-id');
  assert.equal(links[1].searchParams.get('req'), 'test-id');
  assert.equal(links[2].search, '');
  globalThis.location.href = 'https://wallet.example.org/wallet.html';
  updateRequestLinks();
  assert.equal(links[0].search, '');
  assert.equal(links[1].search, '');
});

test('Wallet actions read the latest credentials and reject a reset or replaced wallet', (t) => {
  let wallet = { did: 'did:test', publicJwk: {}, privateJwk: {}, credentials: [{ id: 'latest' }] };
  mockGlobal(t, 'localStorage', { getItem: () => wallet && JSON.stringify(wallet) });
  assert.equal(readWalletFor('did:test').credentials[0].id, 'latest');
  assert.throws(() => readWalletFor('did:other'), /geändert oder zurückgesetzt/);
  wallet = null;
  assert.throws(() => readWalletFor('did:test'), /geändert oder zurückgesetzt/);
});

test('API errors preserve their HTTP status and successful requests do not cache', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/example');
    assert.equal(options.cache, 'no-store');
    assert.equal(options.headers['X-Admin-Token'], 'test-token');
    assert.equal(options.method, 'POST');
    return new Response(JSON.stringify({ error: 'Abgelaufen' }), { status: 410 });
  });
  await assert.rejects(api('/example', { body: {}, token: 'test-token' }), (error) => (
    error instanceof ApiError && error.status === 410 && error.message === 'Abgelaufen'
  ));
});

test('API timeouts cover both a stalled connection and a stalled response body', async (t) => {
  for (const stallBody of [false, true]) {
    t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
      const stalled = () => new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
      return stallBody ? { json: stalled } : stalled();
    });
    await assert.rejects(api('/config', { timeoutMs: 10 }), /nicht rechtzeitig/);
    t.mock.restoreAll();
  }
});

test('API network failures and unreadable responses are explicit', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('Network failure'); });
  await assert.rejects(api('/config'), /nicht erreichbar/);
  t.mock.restoreAll();
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Proxy error</html>'));
  await assert.rejects(api('/config'), /keine lesbare Antwort/);
});

test('Issuer requests carry only the offer capability and use the registered origin', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://issuer.example.org/api/offers/example/claim');
    assert.equal(options.headers['X-Offer-Token'], 'offer-capability');
    assert.equal(options.headers['X-Admin-Token'], undefined);
    assert.equal(options.credentials, 'omit');
    return new Response(JSON.stringify({ status: 'bound' }));
  });
  assert.equal((await api('/offers/example/claim', {
    baseUrl: 'https://issuer.example.org', offerToken: 'offer-capability', body: { proof: 'public-proof' },
  })).status, 'bound');
});
