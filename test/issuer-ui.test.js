import test from 'node:test';
import assert from 'node:assert/strict';

class Element {
  children = [];
  listeners = new Map();
  attributes = {};
  dataset = {};
  value = '';
  hidden = false;
  disabled = false;
  checked = false;
  open = false;
  constructor(tagName) { this.tagName = tagName; }
  append(...children) {
    for (const child of children) {
      this.children.push(child);
      if (child instanceof Element) child.parent = this;
      if (this.tagName === 'select' && !this.value) this.value = child.value;
    }
  }
  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }
  before(node) { this.parent.children.unshift(node); node.parent = this.parent; }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'value') this.value = value;
  }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  querySelector(selector) {
    return find(this, (node) => selector === 'button[type="submit"]'
      ? node.tagName === 'button' && node.attributes.type === 'submit'
      : node.tagName === selector);
  }
  focus() { this.focused = true; }
  scrollIntoView() {}
  reset() {
    for (const input of findAll(this, (node) => node.tagName === 'input')) {
      input.value = input.attributes.value || '';
      input.checked = false;
    }
  }
  get textContent() { return this.children.map((child) => child instanceof Element ? child.textContent : child).join(''); }
  set textContent(value) { this.children = [value]; }
}

function findAll(node, predicate) {
  if (!(node instanceof Element)) return [];
  return [...(predicate(node) ? [node] : []), ...node.children.flatMap((child) => findAll(child, predicate))];
}
function find(node, predicate) { return findAll(node, predicate)[0]; }
function button(node, text) { return find(node, (child) => child.tagName === 'button' && child.textContent === text); }
function input(node, name) { return find(node, (child) => child.tagName === 'input' && child.attributes.name === name); }
function byClass(node, name) { return find(node, (child) => child.className?.split(' ').includes(name)); }
async function settle() {
  for (let count = 0; count < 4; count += 1) await new Promise((resolve) => setImmediate(resolve));
}
function deferred() {
  let resolve;
  const promise = new Promise((finish) => { resolve = finish; });
  return { promise, resolve };
}
function mockGlobal(t, name, value) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, name);
  Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  t.after(() => {
    if (previous) Object.defineProperty(globalThis, name, previous);
    else delete globalThis[name];
  });
}

const claims = { given_name: 'Erika', family_name: 'Muster', organisation: 'Demo GmbH', role: 'Mitarbeitende' };
const did = 'did:example:issuer';
function credential(index = 0) {
  return {
    id: `credential-${String(index).padStart(3, '0')}`,
    claims: { ...claims, given_name: `Erika ${index}` },
    holderDid: `did:example:holder-${index}`, issuerDid: did, statusIndex: index,
    issuedAt: new Date(Date.now() - index * 1000).toISOString(),
    expiresAt: new Date(Date.now() + 86400000).toISOString(), revokedAt: null,
  };
}

let fixtureId = 0;
async function fixture(t, { records = [], trust, credentialsError = false } = {}) {
  const app = new Element('main');
  const error = new Element('div');
  const notice = new Element('div');
  const shell = new Element('body');
  shell.append(app);
  const events = new Map();
  const documentEvents = new Map();
  const location = new URL('https://issuer.example.org/issuer.html#admin-token=secret-admin');
  const timers = new Map();
  let timerId = 0;
  const requests = [];
  const active = new Map();
  const maximum = new Map();
  const state = {
    records, credentialsError, trust: trust || { did, proofVerified: true, trusted: false, ownerName: null },
    heldTrust: null, heldCredentials: null,
    offer: {
      id: 'offer-id', status: 'offered', transactionCode: '123456', claims,
      url: 'https://workshop.example.org/wallet.html#offer=private-offer',
      qrDataUrl: 'data:image/png;base64,abc', expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
  };
  const document = {
    visibilityState: 'visible',
    createElement: (tag) => new Element(tag),
    getElementById: (id) => ({ app, error, notice }[id]),
    addEventListener: (name, handler) => documentEvents.set(name, handler),
  };
  mockGlobal(t, 'Node', Element);
  mockGlobal(t, 'document', document);
  mockGlobal(t, 'window', { addEventListener: (name, handler) => events.set(name, handler) });
  mockGlobal(t, 'location', location);
  mockGlobal(t, 'history', { replaceState: (data, title, route) => { location.href = new URL(route, location).href; } });
  const storage = new Map();
  mockGlobal(t, 'sessionStorage', {
    getItem: (key) => storage.get(key) || null,
    setItem: (key, value) => storage.set(key, value),
    removeItem: (key) => storage.delete(key),
  });
  mockGlobal(t, 'FormData', class {
    constructor(form) {
      this.values = findAll(form, (node) => node.tagName === 'input' && node.attributes.name)
        .map((node) => [node.attributes.name, node.value]);
    }
    get(key) { return this.values.find(([name]) => name === key)?.[1]; }
    entries() { return this.values.values(); }
  });
  mockGlobal(t, 'setTimeout', (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; });
  mockGlobal(t, 'clearTimeout', (id) => timers.delete(id));
  mockGlobal(t, 'fetch', async (route, options) => {
    requests.push({ route, options });
    active.set(route, (active.get(route) || 0) + 1);
    maximum.set(route, Math.max(maximum.get(route) || 0, active.get(route)));
    try {
      if (route === '/api/config') return Response.json({
        role: 'issuer', publicUrl: location.origin, workshopUrl: 'https://workshop.example.org',
      });
      assert.equal(options.headers['X-Admin-Token'], 'secret-admin');
      assert.equal(options.credentials, 'omit');
      assert.equal(options.cache, 'no-store');
      assert.doesNotMatch(route, /secret-admin/);
      if (route === '/api/issuer/session') return Response.json({ ok: true });
      if (route === '/api/issuer/status') return Response.json({ did, name: 'Demo-Issuer', employeeName: 'Anna' });
      if (route === '/api/issuer/trust') {
        if (state.heldTrust) {
          const held = state.heldTrust;
          state.heldTrust = null;
          return await held.promise;
        }
        return state.trust instanceof Response ? state.trust : Response.json(state.trust);
      }
      if (route === '/api/issuer/credentials') {
        if (state.heldCredentials) {
          const held = state.heldCredentials;
          state.heldCredentials = null;
          return await held.promise;
        }
        return state.credentialsError ? Response.json({ error: 'Datenspeicher nicht erreichbar' }, { status: 503 })
          : Response.json(state.records);
      }
      if (route.endsWith('/revoke')) {
        assert.equal(options.method, 'POST');
        assert.equal(options.body, '{}');
        const id = route.split('/').at(-2);
        const record = state.records.find((item) => item.id === id);
        assert.ok(record);
        const updated = { ...record, revokedAt: new Date().toISOString() };
        state.records = state.records.map((item) => item.id === id ? updated : item);
        return Response.json(updated);
      }
      if (route === '/api/issuer/offers' || route === '/api/issuer/offers/offer-id') return Response.json(state.offer);
      if (route === '/api/issuer/offers/offer-id/approve') {
        if (!state.trust.trusted) return Response.json({ error: 'Issuer-Vertrauen wurde entzogen.' }, { status: 403 });
        state.offer = { ...state.offer, status: 'issued' };
        state.records = [credential()];
        return Response.json(state.offer);
      }
      throw new Error(`Unexpected request: ${route}`);
    } finally { active.set(route, active.get(route) - 1); }
  });
  await import(`../public/issuer.js?issuer-ui-test=${++fixtureId}`);
  for (let attempt = 0; attempt < 1000; attempt += 1) {
    await settle();
    if (byClass(app, 'offer-fields') && !/Vertrauensstatus wird geprüft|Ausgestellte Ausweise werden geladen/.test(app.textContent)) break;
  }
  assert.ok(byClass(app, 'offer-fields'), error.textContent || 'Dashboard did not initialize');
  assert.equal(app.hidden, false);
  assert.equal(location.hash, '');
  const fire = async (delay, wait = true) => {
    const callbacks = [...timers].filter(([, timer]) => timer.delay === delay);
    const pending = callbacks.map(([id, timer]) => { timers.delete(id); return timer.callback(); });
    if (wait) await Promise.all(pending);
    await settle();
  };
  const click = async (node, label) => {
    const control = button(node, label);
    assert.ok(control, `Button missing: ${label}`);
    control.listeners.get('click')();
    await settle();
  };
  return { app, shell, error, state, requests, timers, maximum, fire, click, events, documentEvents, document };
}

test('Issuer trust polling updates all current states without replacing entered offer data', async (t) => {
  const f = await fixture(t, { trust: { status: 'unregistered', did } });
  assert.match(f.app.textContent, /Nicht registriert/);
  const fields = byClass(f.app, 'offer-fields');
  const givenName = input(f.app, 'given_name');
  givenName.value = 'Nicht verlieren';
  f.state.trust = { did, proofVerified: true, trusted: false, ownerName: null };
  await f.fire(5000);
  assert.match(f.app.textContent, /Registriert · wartet auf Vertrauen/);
  assert.equal(fields.disabled, true);
  f.state.trust = { ...f.state.trust, trusted: true, ownerName: 'Anna' };
  await f.fire(5000);
  assert.match(f.app.textContent, /Registriert und vertrauenswürdig · Anna/);
  assert.equal(fields.disabled, false);
  await f.fire(5000);
  assert.equal(input(f.app, 'given_name'), givenName);
  assert.equal(givenName.value, 'Nicht verlieren');
  f.state.trust.trusted = false;
  await f.fire(5000);
  assert.match(f.app.textContent, /Vertrauen entzogen/);
  assert.equal(fields.disabled, true);
  f.state.trust = Response.json({ error: 'Zentrale nicht erreichbar' }, { status: 503 });
  await f.fire(5000);
  assert.match(f.app.textContent, /aktuelle Registerstatus konnte nicht geprüft/);
  assert.equal(fields.disabled, true);
  f.state.trust = { did, proofVerified: true, trusted: true, ownerName: 'Anna' };
  await f.fire(5000);
  assert.equal(fields.disabled, false);
  assert.equal(givenName.value, 'Nicht verlieren');
});

test('Issuer refreshes never overlap, pause while hidden, and discard pre-bfcache responses', async (t) => {
  const f = await fixture(t);
  const held = deferred();
  f.state.heldTrust = held;
  const before = f.requests.filter(({ route }) => route.endsWith('/trust')).length;
  await f.fire(5000, false);
  await f.click(f.app, 'Verbindung & Vertrauen aktualisieren');
  await f.fire(5000, false);
  assert.equal(f.requests.filter(({ route }) => route.endsWith('/trust')).length, before + 1);
  f.events.get('pagehide')();
  assert.equal([...f.timers.values()].some(({ delay }) => delay === 5000), false);
  f.state.trust = { did, proofVerified: true, trusted: true, ownerName: 'Neue Zuordnung' };
  f.events.get('pageshow')({ persisted: true });
  await settle();
  assert.equal(f.requests.filter(({ route }) => route.endsWith('/trust')).length, before + 1);
  held.resolve(Response.json({ did, proofVerified: true, trusted: true, ownerName: 'Veraltete Zuordnung' }));
  await settle();
  assert.match(f.app.textContent, /Registriert und vertrauenswürdig · Neue Zuordnung/);
  assert.doesNotMatch(f.app.textContent, /Veraltete Zuordnung/);
  assert.equal(f.maximum.get('/api/issuer/trust'), 1);
  f.document.visibilityState = 'hidden';
  f.documentEvents.get('visibilitychange')();
  assert.equal([...f.timers.values()].some(({ delay }) => delay === 5000), false);
  f.document.visibilityState = 'visible';
  f.documentEvents.get('visibilitychange')();
  await settle();
  assert.equal([...f.timers.values()].filter(({ delay }) => delay === 5000).length, 2);
});

test('Issuer list distinguishes initial failure from an empty list and recognizes withdrawn trust after reload', async (t) => {
  const f = await fixture(t, { credentialsError: true, trust: { did, proofVerified: true, trusted: false, ownerName: 'Anna' } });
  assert.match(f.app.textContent, /Vertrauen entzogen/);
  const panel = byClass(f.app, 'credentials-panel');
  assert.match(panel.textContent, /Ausweisliste konnte nicht geladen werden: Datenspeicher/);
  assert.match(panel.textContent, /Keine verlässliche Ausweisliste/);
  assert.doesNotMatch(panel.textContent, /Noch keine Ausweise ausgestellt/);
  f.state.credentialsError = false;
  await f.click(panel, 'Ausweisliste aktualisieren');
  assert.match(panel.textContent, /Noch keine Ausweise ausgestellt/);
  assert.equal(find(panel, (node) => node.attributes.role === 'alert').hidden, true);
});

test('Issuer credential management remains usable when the hub is unreachable and trust gating is closed', async (t) => {
  const f = await fixture(t, {
    records: [credential()],
    trust: Response.json({ error: 'Zentrale ist offline' }, { status: 503 }),
  });
  assert.match(f.app.textContent, /aktuelle Registerstatus konnte nicht geprüft/);
  assert.equal(byClass(f.app, 'offer-fields').disabled, true);
  const panel = byClass(f.app, 'credentials-panel');
  const list = byClass(panel, 'credential-list');
  assert.equal(list.children.length, 1);
  assert.equal(find(panel, (node) => node.attributes.role === 'alert').hidden, true);
  const entry = list.children[0];
  await f.click(entry, 'Diesen Ausweis endgültig widerrufen');
  input(entry, 'confirmRevocation').checked = true;
  const form = find(byClass(entry, 'revoke-confirmation'), (node) => node.tagName === 'form');
  await form.listeners.get('submit')({ preventDefault() {} });
  await settle();
  assert.match(byClass(entry, 'credential-state').textContent, /Endgültig widerrufen/);
  assert.match(f.app.textContent, /aktuelle Registerstatus konnte nicht geprüft/);
  assert.equal(find(panel, (node) => node.attributes.role === 'alert').hidden, true);
  assert.equal(byClass(f.app, 'offer-fields').disabled, true);
});

test('Issuer list paginates, searches and preserves details/confirmation; revocation cannot be overwritten by a stale poll', async (t) => {
  const f = await fixture(t, { records: Array.from({ length: 45 }, (_, index) => credential(index)) });
  const panel = byClass(f.app, 'credentials-panel');
  const list = byClass(panel, 'credential-list');
  assert.equal(list.children.length, 20);
  const entry = list.children[0];
  entry.open = true;
  await f.click(entry, 'Diesen Ausweis endgültig widerrufen');
  const confirmation = byClass(entry, 'revoke-confirmation');
  const checkbox = input(entry, 'confirmRevocation');
  checkbox.checked = true;
  const givenName = input(f.app, 'given_name');
  givenName.value = 'Bleibt erhalten';
  await f.fire(5000);
  assert.equal(list.children[0], entry);
  assert.equal(entry.open, true);
  assert.equal(confirmation.hidden, false);
  assert.equal(checkbox.checked, true);
  assert.equal(givenName.value, 'Bleibt erhalten');
  await f.click(panel, 'Nächste Seite');
  assert.match(panel.textContent, /Seite 2 von 3/);
  await f.click(panel, 'Vorherige Seite');
  assert.equal(list.children[0], entry);
  assert.equal(entry.open, true);
  const search = find(panel, (node) => node.attributes.type === 'search');
  search.value = 'Erika 44';
  search.listeners.get('input')();
  assert.equal(list.children.length, 1);
  assert.match(list.textContent, /Erika 44/);
  search.value = '';
  search.listeners.get('input')();
  const snapshot = structuredClone(f.state.records);
  const held = deferred();
  f.state.heldCredentials = held;
  await f.fire(5000, false);
  const confirmForm = find(confirmation, (node) => node.tagName === 'form');
  checkbox.checked = false;
  await confirmForm.listeners.get('submit')({ preventDefault() {} });
  assert.match(confirmation.textContent, /Bitte bestätige zuerst/);
  assert.equal(f.requests.some(({ route }) => route.endsWith('/revoke')), false);
  checkbox.checked = true;
  await confirmForm.listeners.get('submit')({ preventDefault() {} });
  assert.equal(confirmation.hidden, true);
  assert.match(entry.textContent, /Endgültig widerrufen am/);
  assert.equal(button(entry, 'Diesen Ausweis endgültig widerrufen').hidden, true);
  held.resolve(Response.json(snapshot));
  await settle();
  assert.equal(list.children[0], entry);
  assert.equal(entry.open, true);
  assert.match(byClass(entry, 'credential-state').textContent, /Endgültig widerrufen/);
  assert.equal(f.maximum.get('/api/issuer/credentials'), 1);
  const filter = find(panel, (node) => node.tagName === 'select');
  filter.value = 'revoked';
  filter.listeners.get('change')();
  assert.equal(list.children.length, 1);
  assert.equal(list.children[0], entry);
  assert.ok(findAll(entry, (node) => node.tagName === 'time').every((node) => !Number.isNaN(Date.parse(node.attributes.datetime))));
});

test('Lock clears private list data and late polling cannot repopulate it; unlocking starts fresh polling', async (t) => {
  const f = await fixture(t, { records: [credential()] });
  const trust = deferred();
  const credentials = deferred();
  f.state.heldTrust = trust;
  f.state.heldCredentials = credentials;
  await f.fire(5000, false);
  await f.click(f.shell, 'Verwaltung sperren');
  assert.equal(f.app.hidden, true);
  assert.equal(f.app.children.length, 0);
  trust.resolve(Response.json({ did, proofVerified: true, trusted: true, ownerName: 'Stale Owner' }));
  credentials.resolve(Response.json([credential(99)]));
  await settle();
  assert.equal(f.app.children.length, 0);
  assert.equal([...f.timers.values()].some(({ delay }) => delay === 5000), false);
  input(f.shell, 'token').value = 'secret-admin';
  const unlockForm = find(f.shell, (node) => node.tagName === 'form');
  await unlockForm.listeners.get('submit')({ preventDefault() {} });
  assert.equal(f.app.hidden, false);
  assert.match(f.app.textContent, /Erika 0/);
  assert.doesNotMatch(f.app.textContent, /Stale Owner|Erika 99/);
  assert.equal([...f.timers.values()].filter(({ delay }) => delay === 5000).length, 2);
});

test('Active QR survives trust changes and bfcache; signing rechecks trust and terminal offers do not stop list/trust polling', async (t) => {
  const f = await fixture(t, { trust: { did, proofVerified: true, trusted: true, ownerName: 'Anna' } });
  const fields = byClass(f.app, 'offer-fields');
  const form = fields.parent;
  for (const [name, value] of Object.entries(claims)) input(form, name).value = value;
  await form.listeners.get('submit')({ preventDefault() {} });
  const transfer = byClass(f.app, 'transfer-panel');
  const qr = find(transfer, (node) => node.tagName === 'img');
  assert.match(transfer.textContent, /123456/);
  f.state.trust.trusted = false;
  await f.fire(5000);
  assert.match(f.app.textContent, /Vertrauen entzogen/);
  assert.equal(find(transfer, (node) => node.tagName === 'img'), qr);
  assert.equal(transfer.hidden, false);
  f.events.get('pagehide')();
  assert.equal([...f.timers.values()].some(({ delay }) => [1800, 5000].includes(delay)), false);
  f.events.get('pageshow')({ persisted: true });
  await settle();
  assert.equal(find(transfer, (node) => node.tagName === 'img'), qr);
  f.state.offer = { ...f.state.offer, status: 'bound', holderDid: 'did:example:holder' };
  await f.fire(1800);
  assert.match(transfer.textContent, /Ausgabecode bereits geprüft/);
  let approve = find(transfer, (node) => node.tagName === 'form');
  await approve.listeners.get('submit')({ preventDefault() {} });
  assert.match(transfer.textContent, /Issuer-Vertrauen wurde entzogen/);
  assert.equal(f.state.offer.status, 'bound');
  f.state.trust.trusted = true;
  await f.fire(5000);
  approve = find(transfer, (node) => node.tagName === 'form');
  await approve.listeners.get('submit')({ preventDefault() {} });
  await settle();
  assert.match(transfer.textContent, /Signiert/);
  assert.match(byClass(f.app, 'credentials-panel').textContent, /Erika 0/);
  f.state.offer = { ...f.state.offer, status: 'accepted' };
  await f.fire(1800);
  assert.match(transfer.textContent, /Erfolgreich übergeben/);
  assert.equal([...f.timers.values()].filter(({ delay }) => delay === 5000).length, 2);
  assert.equal([...f.timers.values()].some(({ delay }) => delay === 1800), false);
  await f.click(transfer, 'Weiteren Mitarbeiterausweis vorbereiten');
  assert.equal(transfer.hidden, true);
  assert.equal(fields.parent.hidden, false);
});
