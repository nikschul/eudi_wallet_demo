import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import * as sd from '../public/lib/sdjwt.js';
import { EMPLOYEE_VCT } from '../public/lib/protocol.js';

function mockGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

class Element {
  children = [];
  listeners = new Map();
  attributes = {};
  constructor(tagName) { this.tagName = tagName; }
  append(...children) {
    for (const child of children) {
      if (child instanceof Element) child.parent = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  remove() { if (this.parent) this.parent.children = this.parent.children.filter((child) => child !== this); }
  showModal() { this.open = true; }
  close() { this.open = false; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  querySelector(selector) {
    return find(this, (node) => selector === '.card' ? node.className?.split(' ').includes('card')
      : node.tagName === 'button' && node.attributes.type === 'submit');
  }
  focus() {}
  get id() { return this.attributes.id; }
  get elements() { return { namedItem: (name) => find(this, (node) => node.attributes.name === name) }; }
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : child).join(' '); }
  set textContent(value) { this.children = [value]; }
}

function find(node, predicate) {
  if (!(node instanceof Element)) return null;
  return predicate(node) ? node : node.children.map((child) => find(child, predicate)).find(Boolean) || null;
}

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

async function until(predicate) {
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await delay(2);
  }
  assert.ok(predicate(), 'Wallet did not reach the expected state');
}

const issuerUrl = 'https://workshop.example.org';
const organisationId = 'c0d15f6d-827c-4c12-8393-80506ad16336';
const statusUri = `${issuerUrl}/api/status-lists/${organisationId}`;
let moduleId = 0;

async function signedList(issuer, revoked = [], overrides = {}) {
  const bytes = new Uint8Array(2048);
  for (const index of revoked) bytes[index >> 3] |= 1 << (index % 8);
  const now = Math.floor(Date.now() / 1000);
  const token = await sd.signJwt({ alg: 'ES256', typ: 'statuslist+jwt' }, {
    iss: issuer.did, sub: issuer.statusListUrl || statusUri, iat: now, exp: now + 30, ttl: 30,
    status_list: { bits: 1, lst: sd.b64url(deflateSync(bytes)) }, ...overrides,
  }, issuer.privateJwk);
  return new Response(token, { headers: { 'content-type': 'application/statuslist+jwt' } });
}

async function fixture(t) {
  const issuer = { ...await sd.generateKeyPair(), statusListUrl: statusUri };
  const wallet = { ...await sd.generateKeyPair(), credentials: [] };
  async function credential(id, index, options = {}) {
    return {
      id, issuerName: 'Demo-Issuer', receivedAt: Date.now(),
      sdjwt: await sd.issueSdJwt({
        issuerDid: issuer.did, issuerPrivateJwk: issuer.privateJwk, holderPublicJwk: wallet.publicJwk,
        vct: EMPLOYEE_VCT, claims: { given_name: 'Erika', family_name: 'Muster', organisation: 'Demo-Issuer', role: 'Mitarbeitende' },
        status: { status_list: { idx: index, uri: statusUri } }, ...options,
      }),
    };
  }
  wallet.credentials.push(await credential('employee-card', 0));
  const app = new Element();
  const error = new Element();
  const notice = new Element();
  const browserEvents = new Map();
  const documentEvents = new Map();
  const location = new URL('https://workshop.example.org/wallet.html');
  const navigation = new URL('/wallet.html', location);
  const requests = [];
  const timers = new Map();
  let nextTimer = 0;
  const storage = new Map([['wallet', JSON.stringify(wallet)]]);
  const state = {
    issuer, wallet, app, error, notice, browserEvents, documentEvents, location, navigation, requests, timers, storage, credential,
    walletOrigin: issuerUrl,
    issuers: [{
      id: organisationId, did: issuer.did, publicUrl: issuerUrl, statusListUrl: statusUri,
      name: 'Demo-Issuer', state: 'approved', proofVerified: true, trusted: false,
    }],
    statusResponse: () => signedList(issuer), handler: null, confirmations: [], confirmed: true,
    read: () => JSON.parse(storage.get('wallet')),
    start: () => import(`../public/wallet.js?wallet-test=${++moduleId}`),
    poll: async () => {
      await until(() => [...timers.values()].some((timer) => timer.ms <= 5000));
      const [id, timer] = [...timers.entries()].find(([, timer]) => timer.ms <= 5000);
      timers.delete(id);
      await timer.callback();
    },
  };
  t.after(async () => {
    browserEvents.get('pagehide')?.();
    for (let turn = 0; turn < 50; turn++) await settle();
  });
  mockGlobal(t, 'Node', Element);
  mockGlobal(t, 'location', location);
  mockGlobal(t, 'history', { replaceState: (historyState, title, path) => { location.href = new URL(path, location).href; } });
  mockGlobal(t, 'navigator', {});
  mockGlobal(t, 'isSecureContext', true);
  mockGlobal(t, 'FormData', class {
    constructor(form) { this.form = form; }
    get(name) { return this.form.elements.namedItem(name)?.value; }
  });
  mockGlobal(t, 'setTimeout', (callback, ms) => { const id = ++nextTimer; timers.set(id, { callback, ms }); return id; });
  mockGlobal(t, 'clearTimeout', (id) => timers.delete(id));
  mockGlobal(t, 'confirm', (message) => {
    state.confirmations.push(message);
    state.onConfirm?.();
    return state.confirmed;
  });
  mockGlobal(t, 'window', { addEventListener: (name, handler) => browserEvents.set(name, handler) });
  mockGlobal(t, 'document', {
    hidden: false,
    addEventListener: (name, handler) => documentEvents.set(name, handler),
    createElement: (tag) => new Element(tag),
    getElementById: (id) => ({ app, error, notice }[id] || null),
    querySelector: (selector) => ({ content: selector.includes('issuer-origins') ? JSON.stringify([issuerUrl]) : state.walletOrigin }),
    querySelectorAll: (selector) => selector === 'nav a' ? [navigation] : [],
  });
  mockGlobal(t, 'localStorage', {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  });
  mockGlobal(t, 'fetch', async (route, options) => {
    if (route === '/api/config') return Response.json({ eventTitle: 'Demo', publicUrl: issuerUrl, roles: ['Mitarbeitende', 'Teamleitung', 'Gast'] });
    requests.push(route);
    if (route === '/api/issuers') {
      if (state.registryError) throw new Error('offline');
      return Response.json(state.issuers);
    }
    if (route === statusUri) return state.statusResponse(options);
    if (state.handler) return state.handler(route, options);
    throw new Error(`Unexpected request: ${route}`);
  });
  return state;
}

function requestFixture(state, overrides = {}) {
  const id = crypto.randomUUID();
  const request = {
    id, status: 'pending', vct: EMPLOYEE_VCT, verifierName: 'Empfang',
    required: ['given_name', 'family_name'], optional: [], aud: state.location.origin, nonce: crypto.randomUUID(),
    ...overrides,
  };
  const presentations = [];
  state.handler = async (route, options) => {
    if (route === `/api/requests/${id}`) return Response.json(request);
    if (route === `/api/requests/${id}/response`) {
      const { presentation } = JSON.parse(options.body);
      presentations.push(presentation);
      return Response.json(await sd.verifyPresentation(presentation, {
        aud: request.aud, nonce: request.nonce, isTrustedIssuer: () => true,
      }));
    }
    throw new Error(`Unexpected request: ${route}`);
  };
  return {
    id, presentations,
    open() {
      state.location.hash = `#req=${id}`;
      state.browserEvents.get('hashchange')();
    },
  };
}

function offerFixture(state) {
  const id = crypto.randomUUID();
  const token = sd.b64url(crypto.getRandomValues(new Uint8Array(32)));
  const fragment = `#offer=${sd.jsonB64({ issuer: state.issuer.did, id, token })}`;
  const path = `${issuerUrl}/api/offers/${id}`;
  const claims = { given_name: 'Erika', family_name: 'Muster', organisation: 'Demo-Issuer', role: 'Gast' };
  const offer = {
    id, issuerDid: state.issuer.did, aud: issuerUrl, nonce: crypto.randomUUID(),
    claims, status: 'offered', expiresAt: Math.floor(Date.now() / 1000) + 600,
  };
  const calls = { claim: 0, credential: 0, ack: 0 };
  const result = { fragment, path, offer, calls, afterClaim: null };
  state.handler = async (route, options) => {
    assert.equal(options.headers['X-Offer-Token'], token);
    if (route === path) {
      if (offer.status === 'issued' && result.afterClaim) await result.afterClaim;
      return Response.json(offer);
    }
    if (route === `${path}/claim`) {
      calls.claim++;
      const { proof, transactionCode } = JSON.parse(options.body);
      if (transactionCode !== '123456' && offer.status === 'offered') {
        return Response.json({ error: 'Der Ausgabecode stimmt nicht.' }, { status: 400 });
      }
      const { payload } = await sd.verifyJwt(proof, state.read().publicJwk);
      assert.equal(payload.iss, state.read().did);
      assert.equal(payload.aud, issuerUrl);
      assert.equal(payload.nonce, offer.nonce);
      offer.status = 'issued';
      return Response.json({ status: 'issued' });
    }
    if (route === `${path}/credential`) {
      calls.credential++;
      return Response.json({
        sdjwt: await sd.issueSdJwt({
          issuerDid: state.issuer.did, issuerPrivateJwk: state.issuer.privateJwk, holderPublicJwk: state.read().publicJwk,
          vct: EMPLOYEE_VCT, claims, status: { status_list: { idx: 1, uri: statusUri } },
        }),
      });
    }
    if (route === `${path}/ack`) { calls.ack++; return Response.json({ ok: true }); }
    throw new Error(`Unexpected request: ${route}`);
  };
  return result;
}

function button(root, text) {
  return find(root, (node) => node.tagName === 'button' && node.textContent === text);
}

function card(root, id) {
  return find(root, (node) => node.className === 'card credential'
    && Boolean(find(node, (child) => child.attributes.id === `view-${id}`)));
}

function badge(root) {
  return find(root, (node) => node.className?.split(' ').includes('badge'));
}

async function submit(root) {
  const form = find(root, (node) => node.tagName === 'form' && node.listeners.has('submit'));
  let done = false;
  const pending = form.listeners.get('submit')({ preventDefault() {} }).then(() => { done = true; });
  await until(() => done || find(root, (node) => node.textContent === 'Demo-Biometrie bestätigen'));
  if (!done) await button(root, 'Demo-Biometrie bestätigen').listeners.get('click')();
  await pending;
}

async function resign(credential, issuer, transform) {
  const { jwt } = sd.parseSdJwt(credential.sdjwt);
  const { header, payload } = sd.decodeJwt(jwt);
  const signed = await sd.signJwt(header, transform(payload), issuer.privateJwk);
  return { ...credential, sdjwt: signed + credential.sdjwt.slice(jwt.length) };
}

test('Wallet overview never starts consent; QR requests are consumed and leaving consent always restores credentials', { timeout: 5000 }, async (t) => {
  const state = await fixture(t);
  const { app, error, browserEvents, location, navigation, requests } = state;
  const presentationRequests = () => requests.filter((route) => route.startsWith('/api/requests/'));
  const requestId = crypto.randomUUID();
  const personalId = crypto.randomUUID();
  let finishResponse;
  let markResponseStarted;
  const responseStarted = new Promise((resolve) => { markResponseStarted = resolve; });
  state.handler = async (route, options) => {
    const request = {
      id: requestId, status: 'pending', vct: EMPLOYEE_VCT, verifierName: 'Empfang',
      required: ['given_name', 'family_name'], optional: [], aud: location.origin, nonce: 'challenge',
    };
    if (route === `/api/requests/${requestId}`) return Response.json({ ...request, mode: 'kiosk' });
    if (route === `/api/requests/${requestId}/sessions`) {
      assert.equal(options.method, 'POST');
      return Response.json({ ...request, id: personalId });
    }
    if (route === `/api/requests/${personalId}`) return Response.json({ ...request, id: personalId });
    if (route === `/api/requests/${personalId}/response`) {
      const { presentation } = JSON.parse(options.body);
      const verified = await sd.verifyPresentation(presentation, {
        aud: request.aud, nonce: request.nonce, isTrustedIssuer: () => true,
      });
      assert.equal(verified.ok, true, verified.error);
      return new Promise((resolve) => {
        finishResponse = () => resolve(Response.json(verified));
        markResponseStarted();
      });
    }
    throw new Error(`Unexpected request: ${route}`);
  };

  const overview = () => {
    assert.match(app.textContent, /Meine Ausweise/);
    assert.match(app.textContent, /Erika Muster/);
    assert.doesNotMatch(app.textContent, /Welche Angaben möchtest du teilen|Dein Workshop-Fortschritt/);
    assert.equal(error.hidden, true, error.textContent);
    assert.equal(app.children.some((node) => node.attributes?.['aria-label'] === 'Dein Workshop-Fortschritt'), false);
  };
  await state.start();
  await until(() => app.textContent.includes('Letzte Statusprüfung:') && !app.textContent.includes('noch nicht erfolgt'));
  assert.match(app.textContent, /Aktiv/, error.textContent);
  overview();
  assert.deepEqual(presentationRequests(), []);

  location.search = `?req=${requestId}`;
  browserEvents.get('pageshow')({ persisted: true });
  await settle();
  overview();
  assert.deepEqual(presentationRequests(), []);

  location.href = `${location.origin}/wallet.html#req=${requestId}`;
  browserEvents.get('hashchange')();
  await until(() => app.textContent.includes('Welche Angaben möchtest du teilen'));
  assert.match(app.textContent, /Empfang möchte folgende Angaben sehen/);
  assert.match(app.textContent, /Welche Angaben möchtest du teilen/);
  assert.equal(location.href, `${location.origin}/wallet.html`);
  assert.equal(navigation.href, `${location.origin}/wallet.html`);
  assert.deepEqual(presentationRequests(), [`/api/requests/${requestId}`, `/api/requests/${requestId}/sessions`]);

  location.href = navigation.href;
  browserEvents.get('pageshow')({ persisted: true });
  await settle();
  overview();
  assert.equal(presentationRequests().length, 2);

  location.hash = `#req=${requestId}`;
  browserEvents.get('hashchange')();
  await until(() => app.textContent.includes('Welche Angaben möchtest du teilen'));
  await find(app, (node) => node.textContent === 'Ablehnen').listeners.get('click')();
  await settle();
  overview();
  assert.equal(location.hash, '');

  location.hash = `#req=${personalId}`;
  browserEvents.get('hashchange')();
  await until(() => app.textContent.includes('Welche Angaben möchtest du teilen'));
  assert.equal(location.hash, '');
  assert.equal(presentationRequests().at(-1), `/api/requests/${personalId}`);
  const form = find(app, (node) => node.listeners.has('submit'));
  const submitting = form.listeners.get('submit')({ preventDefault() {} });
  await until(() => find(app, (node) => node.textContent === 'Demo-Biometrie bestätigen'));
  await button(app, 'Demo-Biometrie bestätigen').listeners.get('click')();
  await responseStarted;
  await find(app, (node) => node.textContent === 'Ablehnen').listeners.get('click')();
  await settle();
  overview();
  finishResponse();
  await submitting;
  await until(() => app.textContent.includes('Aktiv'));
  overview();
});

test('Inventory polls one public signed list per issuer, preserves raw tabs and distinguishes trust, revocation and offline status', async (t) => {
  const state = await fixture(t);
  state.wallet.credentials.push(await state.credential('second-card', 1));
  state.storage.set('wallet', JSON.stringify(state.wallet));
  await state.start();
  await until(() => badge(card(state.app, 'employee-card'))?.textContent === 'Aktiv'
    && badge(card(state.app, 'second-card'))?.textContent === 'Aktiv');
  assert.equal(state.requests.filter((route) => route === statusUri).length, 1);
  const article = card(state.app, 'employee-card');
  const rawPanel = find(article, (node) => node.attributes.id === 'raw-employee-card');
  await button(article, 'Rohdaten').listeners.get('click')();
  assert.equal(rawPanel.hidden, false);

  state.statusResponse = () => signedList(state.issuer, [0]);
  await state.poll();
  assert.equal(badge(article).textContent, 'Widerrufen');
  assert.equal(badge(card(state.app, 'second-card')).textContent, 'Aktiv');
  assert.equal(state.requests.filter((route) => route === statusUri).length, 2);
  assert.strictEqual(card(state.app, 'employee-card'), article);
  assert.equal(rawPanel.hidden, false);

  state.statusResponse = () => { throw new Error('offline'); };
  await state.poll();
  assert.equal(badge(article).textContent, 'Status nicht prüfbar');
  assert.match(article.textContent, /nicht erreichbar|Letzte Statusprüfung:/);
  assert.strictEqual(card(state.app, 'employee-card'), article);
  assert.equal(rawPanel.hidden, false);
  assert.ok(state.requests.every((route) => route === '/api/issuers' || route === statusUri));
  assert.doesNotMatch(state.app.textContent, /Welche Angaben möchtest du teilen/);

  state.browserEvents.get('pagehide')();
  assert.equal(state.timers.size, 0);
  state.statusResponse = () => signedList(state.issuer);
  state.browserEvents.get('pageshow')({ persisted: true });
  await until(() => badge(card(state.app, 'second-card'))?.textContent === 'Aktiv');
  document.hidden = true;
  state.documentEvents.get('visibilitychange')();
  assert.equal(state.timers.size, 0);
  document.hidden = false;
  state.documentEvents.get('visibilitychange')();
  await until(() => badge(card(state.app, 'second-card'))?.textContent === 'Aktiv');
});

test('Individual delete confirms browser-only scope and preserves keys and credentials added by another tab', async (t) => {
  const state = await fixture(t);
  const other = await state.credential('other-card', 1);
  state.wallet.credentials.push(other);
  state.storage.set('wallet', JSON.stringify(state.wallet));
  await state.start();
  await until(() => badge(card(state.app, 'employee-card'))?.textContent === 'Aktiv');
  const remove = button(card(state.app, 'employee-card'), 'Ausweis aus diesem Browser löschen');
  state.confirmed = false;
  await remove.listeners.get('click')();
  assert.equal(state.read().credentials.length, 2);
  const newest = await state.credential('new-from-another-tab', 2);
  state.onConfirm = () => {
    const current = state.read();
    state.storage.set('wallet', JSON.stringify({ ...current, credentials: [...current.credentials, newest] }));
  };
  state.confirmed = true;
  await remove.listeners.get('click')();
  const remaining = state.read();
  assert.equal(remaining.did, state.wallet.did);
  assert.deepEqual(remaining.privateJwk, state.wallet.privateJwk);
  assert.deepEqual(remaining.publicJwk, state.wallet.publicJwk);
  assert.deepEqual(remaining.credentials, [other, newest]);
  assert.match(state.confirmations.at(-1), /nur aus diesem Browser löschen.*kein Widerruf.*Wallet-Schlüssel und andere Ausweise bleiben erhalten/);
  assert.equal(card(state.app, 'employee-card'), null);
  assert.ok(state.requests.every((route) => route === '/api/issuers' || route === statusUri));
  await until(() => badge(card(state.app, 'other-card'))?.textContent === 'Aktiv');
});

test('Legacy, expired, malformed and tampered credentials remain visible but never become active', async (t) => {
  const state = await fixture(t);
  const legacy = await state.credential('legacy', 1, { status: undefined });
  const expired = await resign(await state.credential('expired', 2), state.issuer, (payload) => ({
    ...payload, iat: Math.floor(Date.now() / 1000) - 1000, exp: Math.floor(Date.now() / 1000) - 1,
  }));
  const original = await state.credential('tampered', 3);
  const { jwt } = sd.parseSdJwt(original.sdjwt);
  const parts = jwt.split('.');
  parts[1] = sd.jsonB64({ ...sd.decodeJwt(jwt).payload, status: { status_list: { idx: 4, uri: statusUri } } });
  const tampered = { ...original, sdjwt: parts.join('.') + original.sdjwt.slice(jwt.length) };
  state.wallet.credentials = [legacy, expired, tampered, { ...legacy, id: 'malformed', sdjwt: 'not-a-credential' }];
  state.storage.set('wallet', JSON.stringify(state.wallet));
  state.registryError = true;
  await state.start();
  await until(() => badge(card(state.app, 'expired'))?.textContent === 'Abgelaufen'
    && card(state.app, 'legacy')?.textContent.includes('neu ausstellen'));
  assert.equal(badge(card(state.app, 'legacy')).textContent, 'Status nicht prüfbar');
  assert.match(card(state.app, 'legacy').textContent, /ältere Ausweis.*keinen Widerrufsstatus.*neu ausstellen/);
  assert.equal(badge(card(state.app, 'tampered')).textContent, 'Status nicht prüfbar');
  assert.match(card(state.app, 'tampered').textContent, /Signatur ungültig/);
  assert.equal(badge(card(state.app, 'malformed')).textContent, 'Status nicht prüfbar');
  assert.doesNotMatch(state.app.textContent, /\bAktiv\b/);
  assert.equal(state.requests.filter((route) => route === statusUri).length, 0);
});

test('QR consent requires fresh status, status recovery never opens consent, and revocation before submit blocks transmission', async (t) => {
  const state = await fixture(t);
  const request = requestFixture(state);
  state.statusResponse = () => { throw new Error('offline'); };
  await state.start();
  await until(() => state.app.textContent.includes('nicht erreichbar'));
  request.open();
  assert.equal(state.location.hash, '');
  await until(() => state.app.textContent.includes('Check-In derzeit nicht möglich'));
  assert.doesNotMatch(state.app.textContent, /Welche Angaben möchtest du teilen/);
  state.statusResponse = () => signedList(state.issuer);
  await settle();
  assert.doesNotMatch(state.app.textContent, /Welche Angaben möchtest du teilen/);
  await button(state.app, 'Zur Wallet').listeners.get('click')();
  await until(() => state.app.textContent.includes('Aktiv'));
  await state.poll();
  assert.doesNotMatch(state.app.textContent, /Welche Angaben möchtest du teilen/);
  request.open();
  await until(() => state.app.textContent.includes('Welche Angaben möchtest du teilen'));

  state.statusResponse = () => signedList(state.issuer, [0]);
  await submit(state.app);
  assert.match(state.app.textContent, /Widerrufen/);
  assert.match(state.app.textContent, /Check-In nicht möglich/);
  assert.equal(request.presentations.length, 0);
  state.statusResponse = () => { throw new Error('offline'); };
  await submit(state.app);
  assert.match(state.app.textContent, /Status nicht prüfbar/);
  assert.equal(request.presentations.length, 0);
});

test('Consent chooses a suitable non-revoked credential instead of the newest revoked or incomplete card', async (t) => {
  const state = await fixture(t);
  const revoked = await state.credential('newer-revoked', 1);
  const incomplete = await state.credential('newest-incomplete', 2, { claims: { given_name: 'Erika' } });
  state.wallet.credentials.push({ ...revoked, receivedAt: Date.now() + 1 }, { ...incomplete, receivedAt: Date.now() + 2 });
  state.storage.set('wallet', JSON.stringify(state.wallet));
  state.statusResponse = () => signedList(state.issuer, [1]);
  const request = requestFixture(state);
  await state.start();
  await until(() => badge(card(state.app, 'employee-card'))?.textContent === 'Aktiv');
  request.open();
  await until(() => state.app.textContent.includes('Welche Angaben möchtest du teilen'));
  await submit(state.app);
  assert.equal(request.presentations.length, 1);
  assert.equal(sd.describeCredential(request.presentations[0]).payload.status.status_list.idx, 0);
  assert.match(state.app.textContent, /Du bist eingecheckt/);
  assert.equal(state.timers.size, 0);
});

test('Multiple valid credentials require an explicit choice and present only the selected card', async (t) => {
  const state = await fixture(t);
  state.wallet.credentials.push(await state.credential('second-card', 1, {
    claims: { given_name: 'Else', family_name: 'Beispiel', organisation: 'Demo-Issuer', role: 'Teamleitung' },
  }));
  state.storage.set('wallet', JSON.stringify(state.wallet));
  const request = requestFixture(state, { optional: ['role'] });
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  request.open();
  await until(() => state.app.textContent.includes('Mehrere Ausweise passen'));
  const radio = find(state.app, (node) => node.tagName === 'input' && node.attributes.value === 'employee-card');
  const other = find(state.app, (node) => node.tagName === 'input' && node.attributes.value === 'second-card');
  assert.ok(!radio.checked && !other.checked);
  assert.equal(button(state.app, 'Freigeben & einchecken').disabled, true);
  await submit(state.app);
  assert.equal(request.presentations.length, 0);
  assert.match(state.error.textContent, /wähle zuerst einen Ausweis/);
  radio.listeners.get('change')();
  assert.equal(radio.checked, true);
  assert.equal(other.checked, false);
  await state.poll();
  assert.equal(radio.checked, true);
  assert.match(state.app.textContent, /Beim Check-In geteilt/);
  assert.match(state.app.textContent, /Nicht als Attribut geteilt/);
  await submit(state.app);
  assert.equal(request.presentations.length, 1);
  assert.equal(sd.describeCredential(request.presentations[0]).payload.status.status_list.idx, 0);
  assert.deepEqual(sd.describeCredential(request.presentations[0]).claims, { given_name: 'Erika', family_name: 'Muster' });
});

test('Mock biometrics are explicit, cancellable and never sign or send before confirmation', async (t) => {
  const state = await fixture(t);
  const request = requestFixture(state);
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  request.open();
  await until(() => state.app.textContent.includes('Welche Angaben möchtest du teilen'));
  const form = find(state.app, (node) => node.tagName === 'form');
  const pending = form.listeners.get('submit')({ preventDefault() {} });
  await until(() => state.app.textContent.includes('Demo-Biometrie bestätigen'));
  assert.match(state.app.textContent, /keine echte Biometrie/);
  assert.match(state.app.textContent, /keine biometrischen Daten/);
  assert.equal(request.presentations.length, 0);
  await button(state.app, 'Abbrechen').listeners.get('click')();
  await pending;
  assert.equal(request.presentations.length, 0);
  assert.equal(find(state.app, (node) => node.tagName === 'dialog'), null);
  await submit(state.app);
  assert.equal(request.presentations.length, 1);
  assert.equal(state.read().did, state.wallet.did);
});

test('A selected credential becoming revoked is never silently replaced by another active credential', async (t) => {
  const state = await fixture(t);
  state.wallet.credentials.push(await state.credential('alternative', 1));
  state.storage.set('wallet', JSON.stringify(state.wallet));
  const request = requestFixture(state);
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  request.open();
  await until(() => state.app.textContent.includes('Mehrere Ausweise passen'));
  const selected = find(state.app, (node) => node.tagName === 'input' && node.attributes.value === 'employee-card');
  const alternative = find(state.app, (node) => node.tagName === 'input' && node.attributes.value === 'alternative');
  selected.listeners.get('change')();
  state.statusResponse = () => signedList(state.issuer, [0]);
  await state.poll();
  assert.equal(selected.checked, true);
  assert.equal(selected.disabled, true);
  assert.equal(alternative.checked, false);
  assert.equal(alternative.disabled, false);
  await submit(state.app);
  assert.equal(request.presentations.length, 0);
  assert.match(state.app.textContent, /Widerrufen|widerrufen/);
  alternative.listeners.get('change')();
  await submit(state.app);
  assert.equal(request.presentations.length, 1);
  assert.equal(sd.describeCredential(request.presentations[0]).payload.status.status_list.idx, 1);
});

test('Leaving during biometric confirmation cancels it and cannot send a late presentation', async (t) => {
  const state = await fixture(t);
  const request = requestFixture(state);
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  request.open();
  await until(() => state.app.textContent.includes('Welche Angaben möchtest du teilen'));
  const form = find(state.app, (node) => node.tagName === 'form');
  const pending = form.listeners.get('submit')({ preventDefault() {} });
  await until(() => find(state.app, (node) => node.tagName === 'dialog'));
  state.browserEvents.get('pagehide')();
  await pending;
  assert.equal(request.presentations.length, 0);
  assert.equal(find(state.app, (node) => node.tagName === 'dialog'), null);
  assert.equal(state.timers.size, 0);
});

test('Unsupported biometric dialog is an explicit error and never bypasses confirmation', async (t) => {
  const state = await fixture(t);
  const createElement = document.createElement;
  t.mock.method(document, 'createElement', (tag) => {
    const node = createElement(tag);
    if (tag === 'dialog') node.showModal = undefined;
    return node;
  });
  const request = requestFixture(state);
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  request.open();
  await until(() => state.app.textContent.includes('Welche Angaben möchtest du teilen'));
  await submit(state.app);
  assert.match(state.error.textContent, /Browser unterstützt die Demo-Bestätigung nicht/);
  assert.equal(request.presentations.length, 0);
  assert.equal(find(state.app, (node) => node.tagName === 'dialog'), null);
});

test('Wallet aliases redirect to the canonical origin with QR intact without creating another wallet or warning', async (t) => {
  const state = await fixture(t);
  const before = state.storage.get('wallet');
  const requestId = crypto.randomUUID();
  state.location.href = `http://localhost:3000/wallet.html#req=${requestId}`;
  let destination;
  state.location.replace = (url) => { destination = url; };
  await state.start();
  await until(() => Boolean(destination));
  assert.equal(destination, `${issuerUrl}/wallet.html#req=${requestId}`);
  assert.equal(state.storage.get('wallet'), before);
  assert.doesNotMatch(state.app.textContent, /Nicht noch einmal|zweite Wallet|Wallet.*erstellen/);
  assert.deepEqual(state.requests, []);
});

test('Consent polling preserves optional choices and open raw details through offline recovery', async (t) => {
  const state = await fixture(t);
  state.wallet.credentials = [await state.credential('employee-card', 0, {
    claims: { given_name: 'Erika', family_name: 'Muster', organisation: 'Demo-Team', role: 'Gast' },
  })];
  state.storage.set('wallet', JSON.stringify(state.wallet));
  const request = requestFixture(state, { optional: ['organisation', 'role'] });
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  request.open();
  await until(() => state.app.textContent.includes('Welche Angaben möchtest du teilen'));
  const form = find(state.app, (node) => node.tagName === 'form');
  const organisation = form.elements.namedItem('organisation');
  const role = form.elements.namedItem('role');
  const rawDetails = find(state.app, (node) => node.className === 'raw-data');
  organisation.checked = true;
  role.checked = false;
  rawDetails.open = true;
  function unchanged() {
    assert.strictEqual(find(state.app, (node) => node.tagName === 'form'), form);
    assert.strictEqual(form.elements.namedItem('organisation'), organisation);
    assert.strictEqual(form.elements.namedItem('role'), role);
    assert.equal(organisation.checked, true);
    assert.equal(role.checked, false);
    assert.equal(rawDetails.open, true);
    assert.strictEqual(find(state.app, (node) => node.className === 'raw-data'), rawDetails);
  }
  await state.poll();
  assert.equal(badge(state.app).textContent, 'Aktiv');
  unchanged();
  state.statusResponse = () => { throw new Error('offline'); };
  await state.poll();
  assert.equal(badge(state.app).textContent, 'Status nicht prüfbar');
  unchanged();
  state.statusResponse = () => signedList(state.issuer);
  await state.poll();
  assert.equal(badge(state.app).textContent, 'Aktiv');
  unchanged();
  await submit(state.app);
  assert.equal(request.presentations.length, 1);
  assert.deepEqual(sd.describeCredential(request.presentations[0]).claims, {
    given_name: 'Erika', family_name: 'Muster', organisation: 'Demo-Team',
  });
});

test('A credential deleted by another tab during the fresh submit check is never sent', async (t) => {
  const state = await fixture(t);
  const request = requestFixture(state);
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  request.open();
  await until(() => state.app.textContent.includes('Welche Angaben möchtest du teilen'));
  let release;
  state.statusResponse = () => new Promise((resolve) => { release = resolve; });
  const sending = submit(state.app);
  await until(() => Boolean(release));
  state.storage.set('wallet', JSON.stringify({ ...state.read(), credentials: [] }));
  release(await signedList(state.issuer));
  await sending;
  assert.equal(request.presentations.length, 0);
  assert.match(state.app.textContent, /inzwischen.*gelöscht/);
});

test('Late status callbacks after leaving a QR view cannot reopen consent or restart its poller', async (t) => {
  const state = await fixture(t);
  const request = requestFixture(state);
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  let release;
  state.statusResponse = () => new Promise((resolve) => { release = resolve; });
  request.open();
  await until(() => Boolean(release));
  assert.equal(state.location.hash, '');
  state.browserEvents.get('pagehide')();
  state.statusResponse = () => signedList(state.issuer);
  state.browserEvents.get('pageshow')({ persisted: true });
  await until(() => state.app.textContent.includes('Meine Ausweise') && state.app.textContent.includes('Aktiv'));
  const article = card(state.app, 'employee-card');
  release(await signedList(state.issuer));
  await until(() => [...state.timers.values()].filter((timer) => timer.ms <= 5000).length === 1);
  assert.strictEqual(card(state.app, 'employee-card'), article);
  assert.doesNotMatch(state.app.textContent, /Welche Angaben möchtest du teilen/);
  assert.equal([...state.timers.values()].filter((timer) => timer.ms <= 5000).length, 1);

  state.statusResponse = () => new Promise((resolve) => { release = resolve; });
  release = null;
  const refreshing = state.poll();
  await until(() => Boolean(release));
  state.browserEvents.get('pagehide')();
  release(await signedList(state.issuer, [0]));
  await refreshing;
  assert.equal(state.timers.size, 0);
  assert.notEqual(badge(article).textContent, 'Widerrufen');
});

test('A delayed active list cannot permit sending after a concurrent poll authenticated revocation', async (t) => {
  const state = await fixture(t);
  const request = requestFixture(state);
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  request.open();
  await until(() => state.app.textContent.includes('Welche Angaben möchtest du teilen'));
  let release;
  const oldActiveList = await signedList(state.issuer);
  state.statusResponse = () => new Promise((resolve) => { release = resolve; });
  const sending = submit(state.app);
  await until(() => Boolean(release));
  state.statusResponse = () => signedList(state.issuer, [0]);
  await state.poll();
  assert.equal(badge(state.app).textContent, 'Widerrufen');
  release(oldActiveList);
  await sending;
  assert.equal(request.presentations.length, 0);
  assert.match(state.app.textContent, /Widerrufen|widerrufen/);
});

test('Stale lists, unregistered issuers and signed off-origin references are not active', async (t) => {
  const state = await fixture(t);
  const wrongOrigin = await state.credential('wrong-origin', 1, {
    status: { status_list: { idx: 1, uri: 'https://other.example.org/api/status-list' } },
  });
  state.wallet.credentials.push(wrongOrigin);
  state.storage.set('wallet', JSON.stringify(state.wallet));
  const seconds = Math.floor(Date.now() / 1000);
  state.statusResponse = () => signedList(state.issuer, [], { iat: seconds - 31, exp: seconds - 1 });
  await state.start();
  await until(() => card(state.app, 'employee-card')?.textContent.includes('nicht mehr aktuell')
    && card(state.app, 'wrong-origin')?.textContent.includes('Statusreferenz'));
  assert.equal(badge(card(state.app, 'employee-card')).textContent, 'Status nicht prüfbar');
  assert.equal(badge(card(state.app, 'wrong-origin')).textContent, 'Status nicht prüfbar');
  assert.equal(state.requests.filter((route) => route === statusUri).length, 1);
  assert.ok(state.requests.every((route) => route === '/api/issuers' || route === statusUri));
  state.issuers = [];
  await state.poll();
  assert.match(card(state.app, 'employee-card').textContent, /nicht im aktuellen Workshop-Register registriert/);
  assert.equal(state.requests.filter((route) => route === statusUri).length, 1);
});

test('Offer code, receipt and acceptance stay functional while requiring fresh signed status before saving', async (t) => {
  const state = await fixture(t);
  const received = await state.credential('received-card', 1);
  const offerId = crypto.randomUUID();
  const offerPath = `${issuerUrl}/api/offers/${offerId}`;
  const token = sd.b64url(crypto.getRandomValues(new Uint8Array(32)));
  const offer = {
    id: offerId, issuerDid: state.issuer.did, aud: issuerUrl, nonce: crypto.randomUUID(),
    claims: { given_name: 'Erika', family_name: 'Muster' },
  };
  let claimed = false;
  let acknowledged = false;
  state.handler = async (route, options) => {
    assert.equal(options.headers['X-Offer-Token'], token);
    if (route === offerPath) return Response.json({ ...offer, status: claimed ? 'issued' : 'offered' });
    if (route === `${offerPath}/claim`) {
      const { transactionCode, proof } = JSON.parse(options.body);
      assert.equal(transactionCode, '123456');
      const { payload } = await sd.verifyJwt(proof, state.wallet.publicJwk);
      assert.equal(payload.iss, state.wallet.did);
      assert.equal(payload.aud, issuerUrl);
      claimed = true;
      return Response.json({ ok: true });
    }
    if (route === `${offerPath}/credential`) return Response.json(received);
    if (route === `${offerPath}/ack`) {
      acknowledged = true;
      return Response.json({ ok: true });
    }
    throw new Error(`Unexpected request: ${route}`);
  };
  state.location.hash = `#offer=${sd.jsonB64({ issuer: state.issuer.did, id: offerId, token })}`;
  await state.start();
  await until(() => state.app.textContent.includes('Ausgabecode prüfen & Ausweis empfangen'));
  const code = find(state.app, (node) => node.attributes.name === 'transactionCode');
  code.value = '123456';
  await submit(state.app);
  assert.match(state.app.textContent, /Dein Mitarbeiterausweis ist bereit/);
  assert.equal(claimed, true);
  assert.doesNotMatch(state.app.textContent, /jetzt signieren|auf deinem Rechner weiter/);
  assert.equal(state.requests.filter((route) => route === statusUri).length, 1);
  const accept = button(state.app, 'Ausweis in Wallet speichern');
  state.statusResponse = () => { throw new Error('offline'); };
  await accept.listeners.get('click')();
  assert.equal(state.read().credentials.length, 1);
  assert.equal(acknowledged, false);
  assert.match(state.error.textContent, /kann derzeit nicht angenommen werden/);
  state.statusResponse = () => signedList(state.issuer);
  await accept.listeners.get('click')();
  assert.equal(state.read().credentials.length, 2);
  assert.equal(state.read().credentials[1].sdjwt, received.sdjwt);
  assert.equal(acknowledged, true);
  assert.equal(state.location.hash, '');
  await until(() => state.app.textContent.includes('Aktiv'));
});

test('Hosted issuance rejects incorrect codes, signs automatically and waits only on the phone without leaking the laptop code', async (t) => {
  const state = await fixture(t);
  const offer = offerFixture(state);
  state.location.hash = offer.fragment;
  await state.start();
  await until(() => button(state.app, 'Ausgabecode prüfen & Ausweis empfangen'));
  assert.doesNotMatch(state.app.textContent, /123456|jetzt signieren/);
  const originalKeys = state.read().privateJwk;
  const input = find(state.app, (node) => node.attributes.name === 'transactionCode');
  input.value = '12';
  await submit(state.app);
  assert.match(state.app.textContent, /sechsstelligen Ausgabecode/);
  assert.equal(offer.calls.claim, 0);
  input.value = '654321';
  await submit(state.app);
  assert.match(state.app.textContent, /Ausgabecode stimmt nicht/);
  assert.equal(offer.calls.credential, 0);
  let release;
  offer.afterClaim = new Promise((resolve) => { release = resolve; });
  input.value = '123456';
  const connecting = submit(state.app);
  await until(() => state.app.textContent.includes('Dein Ausweis wird automatisch signiert'));
  assert.match(state.app.textContent, /bleibe auf dieser Seite/);
  assert.doesNotMatch(state.app.textContent, /jetzt signieren|auf deinem Rechner weiter/);
  release();
  await connecting;
  assert.equal(offer.calls.credential, 1);
  assert.match(state.app.textContent, /Dein Mitarbeiterausweis ist bereit/);
  await button(state.app, 'Ausweis in Wallet speichern').listeners.get('click')();
  assert.equal(offer.calls.ack, 1);
  assert.equal(state.read().credentials.length, 2);
  assert.deepEqual(state.read().privateJwk, originalKeys);
  const claims = sd.describeCredential(state.read().credentials[1].sdjwt).claims;
  assert.equal(claims.organisation, 'Demo-Issuer');
  assert.equal(claims.role, 'Gast');
  assert.equal(state.location.hash, '');
});

test('A direct offer scan creates the first wallet automatically and later scans reuse its keys', async (t) => {
  const state = await fixture(t);
  state.storage.delete('wallet');
  const offer = offerFixture(state);
  state.location.hash = offer.fragment;
  await state.start();
  await until(() => button(state.app, 'Ausgabecode prüfen & Ausweis empfangen'));
  const keys = state.read();
  assert.notEqual(keys.did, state.wallet.did);
  assert.equal(state.location.hash, offer.fragment);
  assert.doesNotMatch(state.app.textContent, /Wallet auf diesem Handy erstellen|Wallet schon erstellt|Wallet einmalig.*einrichten/);
  state.browserEvents.get('pageshow')({ persisted: true });
  await until(() => button(state.app, 'Ausgabecode prüfen & Ausweis empfangen'));
  assert.deepEqual(state.read(), keys);
  find(state.app, (node) => node.attributes.name === 'transactionCode').value = '123456';
  await submit(state.app);
  await button(state.app, 'Ausweis in Wallet speichern').listeners.get('click')();
  assert.equal(state.read().credentials.length, 1);
  const request = requestFixture(state);
  request.open();
  await until(() => state.app.textContent.includes('Welche Angaben möchtest du teilen'));
  assert.deepEqual(state.read().privateJwk, keys.privateJwk);
  assert.equal(state.read().did, keys.did);
  assert.doesNotMatch(state.app.textContent, /Wallet auf diesem Handy erstellen|Wallet schon erstellt/);
});

test('Concurrent navigation during first key generation creates one wallet and retains the latest offer', async (t) => {
  const state = await fixture(t);
  state.storage.delete('wallet');
  const offer = offerFixture(state);
  const generate = crypto.subtle.generateKey.bind(crypto.subtle);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  t.after(() => release());
  let generations = 0;
  let writes = 0;
  t.mock.method(crypto.subtle, 'generateKey', async (...args) => {
    generations++;
    await gate;
    return generate(...args);
  });
  t.mock.method(localStorage, 'setItem', (key, value) => { writes++; state.storage.set(key, value); });
  await state.start();
  await until(() => generations === 1);
  state.location.hash = offer.fragment;
  state.browserEvents.get('hashchange')();
  state.browserEvents.get('pageshow')({ persisted: true });
  release();
  await until(() => button(state.app, 'Ausgabecode prüfen & Ausweis empfangen'));
  assert.equal(generations, 1);
  assert.equal(writes, 1);
  assert.equal(state.location.hash, offer.fragment);
  assert.equal(offer.calls.claim, 0);
});

test('First-time creation rechecks browser storage after acquiring the cross-tab lock', async (t) => {
  const state = await fixture(t);
  state.storage.delete('wallet');
  let locks = 0;
  navigator.locks = {
    async request(name, work) {
      assert.equal(name, 'eudi-wallet-initialization');
      locks++;
      state.storage.set('wallet', JSON.stringify(state.wallet));
      return work();
    },
  };
  t.mock.method(crypto.subtle, 'generateKey', () => assert.fail('Must reuse the wallet created by another tab'));
  await state.start();
  await until(() => state.app.textContent.includes('Meine Ausweise'));
  assert.equal(locks, 1);
  assert.deepEqual(state.read(), state.wallet);
});

test('Corrupt stored wallet data is reported instead of silently replacing its keys', async (t) => {
  const state = await fixture(t);
  state.storage.set('wallet', '{broken');
  t.mock.method(crypto.subtle, 'generateKey', () => assert.fail('Must not replace unreadable wallet data'));
  await state.start();
  await until(() => state.error.textContent.includes('Browser-Daten konnten nicht gelesen werden'));
  assert.equal(state.storage.get('wallet'), '{broken');
  assert.doesNotMatch(state.app.textContent, /Wallet auf diesem Handy erstellen|Wallet schon erstellt/);
});

test('Failed automatic storage is explicit and retry saves the same generated key instead of inventing success', async (t) => {
  const state = await fixture(t);
  state.storage.delete('wallet');
  const generate = crypto.subtle.generateKey.bind(crypto.subtle);
  let generations = 0;
  let allowWrites = false;
  t.mock.method(crypto.subtle, 'generateKey', (...args) => { generations++; return generate(...args); });
  t.mock.method(localStorage, 'setItem', (key, value) => {
    if (!allowWrites) throw new DOMException('storage full', 'QuotaExceededError');
    state.storage.set(key, value);
  });
  await state.start();
  await until(() => state.error.textContent.includes('Browser konnte die Daten nicht speichern'));
  assert.equal(state.storage.has('wallet'), false);
  assert.doesNotMatch(state.app.textContent, /Meine Ausweise/);
  allowWrites = true;
  await button(state.app, 'Erneut versuchen').listeners.get('click')();
  await until(() => state.app.textContent.includes('Meine Ausweise'));
  assert.equal(generations, 1);
  assert.equal(state.read().credentials.length, 0);
});

test('A fresh wallet is prepared automatically and pasted offers never need a setup confirmation', async (t) => {
  const state = await fixture(t);
  state.storage.delete('wallet');
  const offer = offerFixture(state);
  await state.start();
  await until(() => state.app.textContent.includes('Meine Ausweise'));
  assert.ok(button(state.app, 'QR-Code scannen'));
  assert.equal(state.requests.length, 0);
  const keys = state.read();
  assert.notEqual(keys.did, state.wallet.did);
  assert.doesNotMatch(state.app.textContent, /Wallet auf diesem Handy erstellen|Wallet schon erstellt|Wallet einmalig.*einrichten/);
  const link = find(state.app, (node) => node.attributes.name === 'link');
  link.value = `${issuerUrl}/wallet.html${offer.fragment}`;
  await submit(state.app);
  await until(() => button(state.app, 'Ausgabecode prüfen & Ausweis empfangen'));
  assert.equal(state.location.hash, offer.fragment);
  assert.equal(offer.calls.claim, 0);
  assert.equal(state.read().did, keys.did);
  assert.deepEqual(state.read().privateJwk, keys.privateJwk);
  assert.equal(state.read().credentials.length, 0);
  assert.match(state.app.textContent, /Ausgabecode prüfen & Ausweis empfangen/);
  find(state.app, (node) => node.attributes.name === 'transactionCode').value = '123456';
  await submit(state.app);
  assert.match(state.app.textContent, /Dein Mitarbeiterausweis ist bereit/);
  await button(state.app, 'Ausweis in Wallet speichern').listeners.get('click')();
  assert.equal(state.read().credentials.length, 1);
  assert.equal(state.read().did, keys.did);
  assert.equal(offer.calls.ack, 1);
  assert.match(state.app.textContent, /Meine Ausweise/);
  assert.ok(button(state.app, 'QR-Code scannen'));
});

test('Inventory camera request is explicit; cancel/pagehide/hidden/navigating during permission prompt stop late streams', async (t) => {
  const state = await fixture(t);
  let resolvePermission;
  let acquisitions = 0;
  navigator.mediaDevices = {
    getUserMedia: () => { acquisitions++; return new Promise((resolve) => { resolvePermission = resolve; }); },
  };
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  assert.equal(acquisitions, 0);
  for (const exit of [
    () => button(state.app, 'Scannen abbrechen').listeners.get('click')(),
    () => state.browserEvents.get('pagehide')(),
    () => { document.hidden = true; state.documentEvents.get('visibilitychange')(); },
    () => { state.browserEvents.get('storage')({ key: 'wallet' }); },
  ]) {
    const opening = button(state.app, 'QR-Code scannen').listeners.get('click')();
    assert.match(state.app.textContent, /Kamera wird geöffnet/);
    await exit();
    const tracks = [{ stops: 0, stop() { this.stops++; } }, { stops: 0, stop() { this.stops++; } }];
    resolvePermission({ getTracks: () => tracks });
    await opening;
    assert.ok(tracks.every((track) => track.stops === 1));
    if (document.hidden) {
      document.hidden = false;
      state.documentEvents.get('visibilitychange')();
    } else state.browserEvents.get('pageshow')({ persisted: true });
    await until(() => state.app.textContent.includes('Aktiv'));
    assert.match(state.app.textContent, /Meine Ausweise/);
    assert.doesNotMatch(state.app.textContent, /Kamera wird geöffnet|Welche Angaben möchtest du teilen/);
  }
  assert.equal(acquisitions, 4);
  assert.deepEqual(state.read().privateJwk, state.wallet.privateJwk);
});

test('Fresh-wallet camera denial allows retry/cancel without rotating automatically created keys', async (t) => {
  const state = await fixture(t);
  state.storage.delete('wallet');
  const offer = offerFixture(state);
  let acquisitions = 0;
  navigator.mediaDevices = {
    getUserMedia: async () => {
      acquisitions++;
      throw Object.assign(new Error('permission denied'), { name: 'NotAllowedError' });
    },
  };
  await state.start();
  await until(() => button(state.app, 'QR-Code scannen'));
  const keys = state.read();
  assert.equal(acquisitions, 0);
  await button(state.app, 'QR-Code scannen').listeners.get('click')();
  assert.match(state.app.textContent, /Kamerazugriff nicht erlaubt/);
  const retry = button(state.app, 'Kamera erneut versuchen');
  assert.equal(retry.hidden, false);
  assert.ok(button(state.app, 'Scannen abbrechen'));
  await retry.listeners.get('click')();
  assert.equal(acquisitions, 2);
  assert.match(state.app.textContent, /Kamerazugriff nicht erlaubt/);
  await button(state.app, 'Scannen abbrechen').listeners.get('click')();
  assert.match(state.app.textContent, /Meine Ausweise/);
  assert.equal(state.read().did, keys.did);
  const link = find(state.app, (node) => node.attributes.name === 'link');
  link.value = `${issuerUrl}/wallet.html${offer.fragment}`;
  await submit(state.app);
  await until(() => button(state.app, 'Ausgabecode prüfen & Ausweis empfangen'));
  assert.equal(state.location.hash, offer.fragment);
  assert.deepEqual(state.read().privateJwk, keys.privateJwk);
  assert.equal(offer.calls.claim, 0);
});

test('Pasted external QR is rejected visibly; a valid request is explicit and restoration never reopens it', async (t) => {
  const state = await fixture(t);
  const request = requestFixture(state);
  await state.start();
  await until(() => state.app.textContent.includes('Aktiv'));
  const input = find(state.app, (node) => node.attributes.name === 'link');
  input.value = `https://external.example.org/wallet.html#req=${request.id}`;
  await submit(state.app);
  assert.match(state.app.textContent, /dieser Anwendung/);
  assert.equal(state.location.hash, '');
  assert.equal(state.requests.filter((route) => route.includes('/requests/')).length, 0);
  input.value = `${issuerUrl}/wallet.html#req=${request.id}`;
  await submit(state.app);
  assert.match(state.app.textContent, /Welche Angaben möchtest du teilen/);
  assert.equal(state.location.hash, '');
  state.browserEvents.get('pageshow')({ persisted: true });
  await until(() => state.app.textContent.includes('Meine Ausweise') && state.app.textContent.includes('Aktiv'));
  assert.doesNotMatch(state.app.textContent, /Welche Angaben möchtest du teilen/);
});

test('Two organisations on one origin use separate DID-authenticated lists, group per organisation and reject crossed list references', async (t) => {
  const state = await fixture(t);
  const id = crypto.randomUUID();
  const second = { ...await sd.generateKeyPair(), statusListUrl: `${issuerUrl}/api/status-lists/${id}` };
  const metadata = {
    id, did: second.did, name: 'Zweite Organisation', publicUrl: issuerUrl,
    statusListUrl: second.statusListUrl, state: 'approved', proofVerified: true, trusted: true,
  };
  state.issuers.push(metadata);
  for (const [credentialId, index, uri] of [
    ['second-org', 0, second.statusListUrl], ['same-org', 1, second.statusListUrl], ['crossed-list', 2, statusUri],
  ]) {
    state.wallet.credentials.push({
      id: credentialId, issuerName: metadata.name, receivedAt: Date.now(),
      sdjwt: await sd.issueSdJwt({
        issuerDid: second.did, issuerPrivateJwk: second.privateJwk, holderPublicJwk: state.wallet.publicJwk,
        vct: EMPLOYEE_VCT, claims: { given_name: 'Erika', family_name: 'Muster', organisation: metadata.name },
        status: { status_list: { idx: index, uri } },
      }),
    });
  }
  state.storage.set('wallet', JSON.stringify(state.wallet));
  state.handler = (route) => {
    assert.equal(route, second.statusListUrl);
    return signedList(second, [0]);
  };
  await state.start();
  await until(() => badge(card(state.app, 'second-org'))?.textContent === 'Widerrufen'
    && badge(card(state.app, 'same-org'))?.textContent === 'Aktiv'
    && card(state.app, 'crossed-list')?.textContent.includes('Statusreferenz'));
  assert.equal(badge(card(state.app, 'employee-card')).textContent, 'Aktiv');
  assert.equal(state.requests.filter((route) => route === statusUri).length, 1);
  assert.equal(state.requests.filter((route) => route === second.statusListUrl).length, 1);
  state.handler = () => signedList(state.issuer, [], { sub: second.statusListUrl });
  await state.poll();
  assert.equal(badge(card(state.app, 'same-org')).textContent, 'Status nicht prüfbar');
  assert.equal(badge(card(state.app, 'employee-card')).textContent, 'Aktiv');
  assert.doesNotMatch(state.app.textContent, /Welche Angaben möchtest du teilen/);
});
