import { test } from 'node:test';
import assert from 'node:assert/strict';
import { deflateSync } from 'node:zlib';
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
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
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
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (predicate()) return;
    await settle();
  }
  assert.ok(predicate(), 'Wallet did not reach the expected state');
}

const issuerUrl = 'https://issuer.example.org';
const statusUri = `${issuerUrl}/api/status-list`;
let moduleId = 0;

async function signedList(issuer, revoked = [], overrides = {}) {
  const bytes = new Uint8Array(2048);
  for (const index of revoked) bytes[index >> 3] |= 1 << (index % 8);
  const now = Math.floor(Date.now() / 1000);
  const token = await sd.signJwt({ alg: 'ES256', typ: 'statuslist+jwt' }, {
    iss: issuer.did, sub: statusUri, iat: now, exp: now + 30, ttl: 30,
    status_list: { bits: 1, lst: sd.b64url(deflateSync(bytes)) }, ...overrides,
  }, issuer.privateJwk);
  return new Response(token, { headers: { 'content-type': 'application/statuslist+jwt' } });
}

async function fixture(t) {
  const issuer = await sd.generateKeyPair();
  const wallet = { ...await sd.generateKeyPair(), credentials: [] };
  async function credential(id, index, options = {}) {
    return {
      id, issuerName: 'Demo-Issuer', receivedAt: Date.now(),
      sdjwt: await sd.issueSdJwt({
        issuerDid: issuer.did, issuerPrivateJwk: issuer.privateJwk, holderPublicJwk: wallet.publicJwk,
        vct: EMPLOYEE_VCT, claims: { given_name: 'Erika', family_name: 'Muster' },
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
    issuers: [{ did: issuer.did, publicUrl: issuerUrl, name: 'Demo-Issuer', proofVerified: true, trusted: false }],
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
    querySelector: (selector) => ({ content: selector.includes('issuer-origins') ? JSON.stringify([issuerUrl]) : location.origin }),
    querySelectorAll: (selector) => selector === 'nav a' ? [navigation] : [],
  });
  mockGlobal(t, 'localStorage', {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  });
  mockGlobal(t, 'fetch', async (route, options) => {
    if (route === '/api/config') return Response.json({ eventTitle: 'Demo' });
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
  await form.listeners.get('submit')({ preventDefault() {} });
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
  await until(() => state.app.textContent.includes('Check-in derzeit nicht möglich'));
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
  assert.match(state.app.textContent, /Check-in nicht möglich/);
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
  await until(() => state.app.textContent.includes('Ausgabecode prüfen & Wallet verbinden'));
  const code = find(state.app, (node) => node.attributes.name === 'transactionCode');
  code.value = '123456';
  await submit(state.app);
  assert.match(state.app.textContent, /Dein Mitarbeiterausweis ist bereit/);
  assert.equal(claimed, true);
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
