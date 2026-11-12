import { test } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../server/app.js';
import { createIssuerApp } from '../server/issuer-app.js';
import { consumeAdminToken } from '../public/lib/management.js';

for (const role of ['workshop', 'issuer']) {
  test(`${role}: management requires its runtime token; public flows never reveal it`, async (t) => {
    const directory = await mkdtemp(path.join(tmpdir(), 'eudi-management-'));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const factory = role === 'workshop' ? createApp : createIssuerApp;
    const { app, adminToken } = await factory({
      publicUrl: 'https://app.example.org', workshopUrl: 'https://hub.example.org', dataDirectory: directory,
    });
    assert.match(adminToken, /^[A-Za-z0-9_-]{43}$/u);
    const server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const base = `http://127.0.0.1:${server.address().port}`;
    const prefix = role === 'workshop' ? '/api/admin' : '/api/issuer';
    const routes = role === 'workshop'
      ? [['/session'], ['/reset', {}], ['/replay', {}], ['/trust-mode', { mode: 'manual' }],
        ['/issuers/unknown/trust', { trusted: true, ownerName: 'Unbefugt' }]]
      : [['/session'], ['/status'], ['/trust'], ['/setup', { name: 'Unbefugt', employeeName: 'Unbefugt' }],
        ['/register', {}], ['/offers', { claims: {} }], ['/offers/unknown'],
        ['/offers/unknown/approve', {}], ['/offers/unknown/cancel', {}],
        ['/credentials'], ['/credentials/unknown/revoke', {}]];
    for (const [route, body] of routes) {
      for (const value of [undefined, 'wrong-token', `${adminToken.slice(0, -1)}!`]) {
        const response = await fetch(`${base}${prefix}${route}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: { ...(value ? { 'X-Admin-Token': value } : {}),
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        assert.equal(response.status, 401, `${role}${route}`);
        assert.equal(response.headers.get('cache-control'), 'no-store');
        const error = await response.text();
        assert.match(error, /aktuellen Freischalt-Link/);
        assert.equal(error.includes(adminToken), false);
      }
    }
    for (const suffix of [`?admin-token=${adminToken}`, `?token=${adminToken}`]) {
      assert.equal((await fetch(`${base}${prefix}/session${suffix}`)).status, 401);
    }
    assert.equal((await fetch(`${base}${prefix}/session`, {
      headers: { 'X-Admin-Token': adminToken },
    })).status, 200);
    for (const route of ['/api/health', '/api/config',
      role === 'workshop' ? '/api/dashboard' : '/issuer.html',
      role === 'workshop' ? '/admin.html' : '/lib/management.js']) {
      const response = await fetch(`${base}${route}`);
      assert.equal(response.status, 200, route);
      assert.equal((await response.text()).includes(adminToken), false, route);
    }
    if (role === 'workshop') {
      assert.equal((await fetch(`${base}/api/requests`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"mode":"kiosk"}',
      })).status, 201);
    } else {
      const status = await (await fetch(`${base}/api/issuer/status`, {
        headers: { 'X-Admin-Token': adminToken },
      })).json();
      assert.equal(status.did, undefined, 'Unauthenticated setup must not create an identity');
      assert.equal((await fetch(`${base}/api/offers/unknown`)).status, 404);
    }
  });
}

test('Unlock link removes its secret from the address and history before validation', () => {
  const replacements = [];
  const browserHistory = { replaceState: (...args) => replacements.push(args) };
  assert.equal(consumeAdminToken(
    new URL('https://demo.example.org/admin.html?view=trust#admin-token=secret&section=issuers'), browserHistory,
  ), 'secret');
  assert.deepEqual(replacements, [[null, '', '/admin.html?view=trust#section=issuers']]);
  assert.equal(consumeAdminToken(new URL('https://demo.example.org/admin.html'), browserHistory), null);
  assert.equal(replacements.length, 1);
});
