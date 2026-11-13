import { test } from 'node:test';
import assert from 'node:assert/strict';

void globalThis.fetch;

function mockGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

for (const existingWallet of [false, true]) {
  test(`Landing keeps organisation and wallet entry points distinct (${existingWallet ? 'existing' : 'new'} wallet)`, async (t) => {
    const nodes = {
      'wallet-hint': { hidden: true },
      'wallet-start': { textContent: 'Wallet auf dem Handy öffnen', href: '/wallet.html' },
      'organisation-start': { textContent: 'Organisation am Laptop einrichten', href: '/issuer.html' },
      error: { hidden: true, textContent: '' },
    };
    mockGlobal(t, 'document', {
      getElementById: (id) => nodes[id] || null,
      querySelectorAll: () => [],
    });
    mockGlobal(t, 'window', { addEventListener() {} });
    mockGlobal(t, 'navigator', {});
    mockGlobal(t, 'isSecureContext', false);
    mockGlobal(t, 'localStorage', {
      getItem: () => existingWallet ? JSON.stringify({
        did: 'did:test:holder', publicJwk: {}, privateJwk: {}, credentials: [],
      }) : null,
    });
    t.mock.method(globalThis, 'fetch', async (url) => {
      assert.equal(url, '/api/config');
      return new Response(JSON.stringify({
        publicUrl: 'https://workshop.example.org',
        issuerSetupUrl: 'https://workshop.example.org/issuer.html',
        eventTitle: 'Organisations-Workshop',
      }));
    });
    await import(`../public/index.js?existing-wallet=${existingWallet}`);
    const deadline = Date.now() + 1000;
    while (nodes['organisation-start'].href === '/issuer.html' && nodes.error.hidden && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    assert.equal(nodes.error.hidden, true, nodes.error.textContent);
    assert.equal(nodes['organisation-start'].href, 'https://workshop.example.org/issuer.html');
    assert.equal(nodes['organisation-start'].textContent, 'Organisation am Laptop einrichten');
    assert.equal(nodes['wallet-start'].href, 'https://workshop.example.org/wallet.html');
    assert.equal(nodes['wallet-hint'].hidden, !existingWallet);
    assert.equal(nodes['wallet-start'].textContent, existingWallet
      ? 'Vorhandene Wallet öffnen' : 'Wallet auf dem Handy öffnen');
  });
}
