import { test } from 'node:test';
import assert from 'node:assert/strict';
import { api, ApiError, currentRequestId, readWalletFor, resetWalletNavigation, formAction } from '../public/lib/ui.js';
import { canonicalWalletUrl } from '../public/lib/protocol.js';

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

test('Only an explicit QR fragment starts a presentation; stale navigation queries are ignored', () => {
  for (const [path, expected] of [
    ['/wallet.html#req=qr-id', 'qr-id'],
    ['/wallet.html?req=query-id', null],
    ['/wallet.html?req=query-id#offer', null],
    ['/wallet.html?req=query-id#req=qr-id', 'qr-id'],
    ['/wallet.html', null],
  ]) {
    assert.equal(currentRequestId(new URL(path, 'https://wallet.example.org')), expected);
  }
});

test('Wallet uses the canonical workshop origin without losing an issuance or check-in link', () => {
  for (const suffix of ['#offer=confidential-offer', '#req=check-in', '?req=personal-id']) {
    const current = new URL(`http://localhost:3000/wallet.html${suffix}`);
    const canonical = canonicalWalletUrl('https://workshop.example.org', current);
    assert.equal(canonical.href, `https://workshop.example.org/wallet.html${suffix}`);
    assert.equal(current.origin, 'http://localhost:3000');
  }
  assert.throws(() => canonicalWalletUrl(
    'https://workshop.example.org/subpath', new URL('http://localhost:3000/wallet.html'),
  ), /Workshop-Adresse/);
});
test('Wallet navigation always opens the credential overview, never propagating a QR request or offer', (t) => {
  const links = ['/wallet.html?req=stale#req=old', '/issuer.html', '/kiosk.html']
    .map((path) => new URL(path, 'https://wallet.example.org'));
  mockGlobal(t, 'document', { querySelectorAll: () => links });
  mockGlobal(t, 'location', { href: 'https://wallet.example.org/wallet.html#req=test-id' });
  resetWalletNavigation();
  assert.equal(links[0].href, 'https://wallet.example.org/wallet.html');
  assert.equal(globalThis.location.href, 'https://wallet.example.org/wallet.html#req=test-id');
  assert.equal(links[1].search, '');
  assert.equal(links[2].search, '');
  globalThis.location.href = 'https://wallet.example.org/wallet.html#offer=private-offer';
  resetWalletNavigation();
  assert.equal(links[0].href, 'https://wallet.example.org/wallet.html');
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
    assert.deepEqual(options.headers, { Accept: 'application/json', 'Content-Type': 'application/json' });
    assert.equal(options.method, 'POST');
    return new Response(JSON.stringify({ error: 'Abgelaufen' }), { status: 410 });
  });
  await assert.rejects(api('/example', { body: {} }), (error) => (
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
    assert.deepEqual(Object.keys(options.headers).sort(), ['Accept', 'Content-Type', 'X-Offer-Token']);
    assert.equal(options.credentials, 'omit');
    return new Response(JSON.stringify({ status: 'bound' }));
  });
  assert.equal((await api('/offers/example/claim', {
    baseUrl: 'https://issuer.example.org', offerToken: 'offer-capability', body: { proof: 'public-proof' },
  })).status, 'bound');
});

test('Management token is sent explicitly as a header, never as a URL or request body', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/admin/session');
    assert.equal(options.headers['X-Admin-Token'], 'private-admin-token');
    assert.equal(options.body, undefined);
    assert.equal(options.credentials, 'omit');
    return new Response('{"ok":true}');
  });
  assert.deepEqual(await api('/admin/session', { adminToken: 'private-admin-token' }), { ok: true });
});

test('Form errors and native input validation are visible next to the field and retry remains possible', async (t) => {
  class Element {
    children = [];
    listeners = new Map();
    attributes = {};
    hidden = false;
    disabled = false;
    textContent = '';
    append(child) { this.children.push(child); }
    setAttribute(name, value) { this.attributes[name] = value; }
    addEventListener(name, handler) { this.listeners.set(name, handler); }
    querySelector() { return button; }
    focus() { this.focused = true; }
  }
  const globalError = new Element();
  const button = new Element();
  mockGlobal(t, 'Node', Element);
  mockGlobal(t, 'document', { createElement: () => new Element(), getElementById: () => globalError });
  mockGlobal(t, 'FormData', class {});
  const form = new Element();
  let submissions = 0;
  formAction(form, async () => {
    if (++submissions === 1) throw new ApiError('Der Ausgabecode ist falsch.', 400);
  });
  const inlineError = form.children[0];
  assert.equal(inlineError.hidden, true);
  form.listeners.get('invalid')({ target: { validationMessage: 'Bitte sechs Ziffern eingeben.' } });
  assert.equal(inlineError.textContent, 'Bitte sechs Ziffern eingeben.');
  assert.equal(inlineError.hidden, false);
  form.listeners.get('invalid')({ target: {
    dataset: { validationMessage: 'Bitte gib den sechsstelligen Ausgabecode vom Notebook ein.' },
    validationMessage: 'Generic browser error',
  } });
  assert.equal(inlineError.textContent, 'Bitte gib den sechsstelligen Ausgabecode vom Notebook ein.');
  form.listeners.get('input')();
  assert.equal(inlineError.hidden, true);
  await form.listeners.get('submit')({ preventDefault() {} });
  assert.equal(inlineError.hidden, false);
  assert.equal(inlineError.focused, true);
  assert.equal(inlineError.textContent, 'Der Ausgabecode ist falsch.');
  assert.equal(globalError.textContent, inlineError.textContent);
  assert.equal(button.disabled, false);
  await form.listeners.get('submit')({ preventDefault() {} });
  assert.equal(submissions, 2);
  assert.equal(inlineError.hidden, true);
  assert.equal(globalError.hidden, true);
  assert.equal(button.disabled, false);
});
