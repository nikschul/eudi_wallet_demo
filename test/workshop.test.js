import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture, noSecrets } from './helpers/hosted.js';

test('Central workshop end-to-end: two browser organisations, host approval, automatic code issuance and selective kiosk visits', async (t) => {
  const f = await fixture(t);
  const tenant = await f.organisation('Example Organisation');
  const second = await f.organisation('Other Organisation');
  const credential = await f.issue(tenant);
  const otherCredential = await f.issue(second);
  const kiosk = (await f.call('/api/requests', { body: { mode: 'kiosk' } })).data;
  async function visit(item, reveal) {
    const session = (await f.call(`/api/requests/${kiosk.id}/sessions`, { body: {} })).data;
    return f.checkIn(item, reveal, session);
  }
  await f.trust(tenant.org, false);
  assert.equal((await visit(credential)).result.data.ok, false);
  await f.trust(tenant.org);
  assert.equal((await visit(credential)).result.data.ok, true);
  assert.equal((await visit(credential, ['given_name', 'family_name', 'organisation'])).result.data.ok, true);
  assert.equal((await visit(otherCredential)).result.data.ok, true);
  const dashboard = (await f.call('/api/dashboard')).data;
  assert.deepEqual(dashboard.stats, { registered: 2, checkins: 3 });
  assert.equal(dashboard.issuers.find((org) => org.id === tenant.org.id).checkinCount, 2);
  assert.equal(dashboard.issuers.find((org) => org.id === second.org.id).checkinCount, 1);
  assert.equal(dashboard.attendees.length, 2);
  const history = dashboard.attendees.find((entry) => entry.holderDid === credential.holder.did).checkins;
  assert.equal(history[0].claims.organisation, undefined);
  assert.equal(history[1].claims.organisation, tenant.org.name);
  noSecrets(dashboard);
  const record = (await tenant.owner('/credentials')).data[0];
  await tenant.owner(`/credentials/${record.id}/revoke`, {});
  assert.equal((await visit(credential)).result.data.ok, false);
  assert.equal((await visit(otherCredential)).result.data.ok, true);
  await f.restart();
  assert.equal((await tenant.owner('/session')).data.organisation.id, tenant.org.id);
  assert.equal((await second.owner('/credentials')).data.length, 1);
  assert.deepEqual((await f.call('/api/dashboard')).data.stats, { registered: 2, checkins: 4 });
});
