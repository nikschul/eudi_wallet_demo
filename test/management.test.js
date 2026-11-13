import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './helpers/hosted.js';
import { consumeAdminToken } from '../public/lib/management.js';

test('Only host management uses the rotating admin token; tenant browser access cannot administer trust or recovery', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation();
  assert.match(f.adminToken, /^[A-Za-z0-9_-]{43}$/);
  for (const [route, body] of [
    ['/session'], ['/reset', {}], ['/replay', {}], ['/trust-mode', { mode: 'manual' }],
    [`/issuers/${encodeURIComponent(tenant.org.did)}/trust`, { trusted: true }],
    [`/organisations/${tenant.org.id}/recovery`, {}],
  ]) {
    for (const value of [undefined, 'wrong-token', `${f.adminToken.slice(0, -1)}!`]) {
      const response = await f.call(`/api/admin${route}`, {
        body, cookie: tenant.cookie, headers: value ? { 'X-Admin-Token': value } : {},
      });
      assert.equal(response.status, 401, route);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.match(response.data.error, /aktuellen Freischalt-Link/);
      assert.equal(JSON.stringify(response.data).includes(f.adminToken), false);
    }
  }
  for (const suffix of [`?admin-token=${f.adminToken}`, `?token=${f.adminToken}`]) {
    assert.equal((await f.call(`/api/admin/session${suffix}`)).status, 401);
  }
  assert.equal((await f.call('/api/admin/session', { admin: true })).status, 200);
  assert.equal((await f.call('/api/issuer/credentials', { admin: true })).status, 401);
  assert.equal((await f.call('/api/issuer/session', { admin: true })).data.organisation, null);
  for (const route of ['/api/health', '/api/config', '/api/dashboard', '/admin.html', '/issuer.html', '/lib/management.js']) {
    const response = await f.call(route);
    assert.equal(response.status, 200, route);
    assert.equal(JSON.stringify(response.data).includes(f.adminToken), false, route);
  }
  const old = f.adminToken;
  await f.restart();
  assert.notEqual(f.adminToken, old);
  assert.equal((await f.call('/api/admin/session', { headers: { 'X-Admin-Token': old } })).status, 401);
  assert.equal((await tenant.owner('/session')).data.organisation.id, tenant.org.id);
});

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
