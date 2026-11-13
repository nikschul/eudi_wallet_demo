import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

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
  replaceChildren(...children) { this.children = []; this.append(...children); }
  setAttribute(name, value) {
    this.attributes[name] = value;
    if (name === 'value') this.value = value;
  }
  removeAttribute(name) { delete this.attributes[name]; }
  addEventListener(name, handler) { this.listeners.set(name, handler); }
  querySelector(selector) {
    return find(this, (node) => selector === 'button[type="submit"]'
      ? node.tagName === 'button' && node.attributes.type === 'submit'
      : node.tagName === selector);
  }
  focus() { this.focused = true; }
  scrollIntoView() {}
  reset() {
    for (const control of findAll(this, (node) => ['input', 'select'].includes(node.tagName))) {
      control.value = control.tagName === 'select' ? control.children[0].value : control.attributes.value || '';
      control.checked = false;
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
function roleSelect(node) { return find(node, (child) => child.tagName === 'select' && child.attributes.name === 'role'); }
function currentStep(node) { return byClass(node, 'issuer-progress').children.findIndex((child) => child.attributes['aria-current'] === 'step') + 1; }
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

const roles = ['Mitarbeitende', 'Teamleitung', 'Gast'];
const claims = { given_name: 'Erika', family_name: 'Muster', organisation: 'Demo GmbH', role: 'Mitarbeitende' };
const did = 'did:example:issuer';
function organisation(state = 'pending', name = 'Demo GmbH') {
  return {
    id: 'org-id', name, did, publicUrl: 'https://workshop.example.org',
    statusListUrl: 'https://workshop.example.org/status/org-id',
    state, trusted: state === 'approved', proofVerified: true, fingerprint: 'public-fingerprint',
    createdAt: new Date().toISOString(), approvedAt: state === 'approved' ? new Date().toISOString() : null,
  };
}
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
async function fixture(t, options = {}) {
  const app = new Element('main');
  app.hidden = true;
  const error = new Element('div');
  error.hidden = true;
  const events = new Map();
  const documentEvents = new Map();
  const location = new URL(options.pageUrl || 'https://workshop.example.org/issuer.html');
  if (options.fragment) location.hash = options.fragment;
  const timers = new Map();
  let timerId = 0;
  const requests = [];
  const active = new Map();
  const maximum = new Map();
  const state = {
    organisation: organisation(), records: [], credentialsError: false,
    heldStatus: null, heldCredentials: null, heldOffer: null,
    offer: {
      id: 'offer-id', status: 'offered', transactionCode: '123456', claims,
      url: 'https://workshop.example.org/wallet.html#offer=private-offer',
      qrDataUrl: 'data:image/png;base64,abc', expiresAt: new Date(Date.now() + 600000).toISOString(),
    },
    ...options,
  };
  const session = () => ({ organisation: state.organisation, roles });
  const document = {
    visibilityState: 'visible',
    createElement: (tag) => new Element(tag),
    getElementById: (id) => ({ app, error }[id]),
    addEventListener: (name, handler) => documentEvents.set(name, handler),
  };
  mockGlobal(t, 'Node', Element);
  mockGlobal(t, 'document', document);
  mockGlobal(t, 'window', { addEventListener: (name, handler) => events.set(name, handler) });
  mockGlobal(t, 'location', location);
  mockGlobal(t, 'history', { replaceState: (data, title, route) => { location.href = new URL(route, location).href; } });
  for (const name of ['sessionStorage', 'localStorage']) {
    mockGlobal(t, name, {
      getItem() { assert.fail(`Issuer must not read ${name}`); },
      setItem() { assert.fail(`Issuer must not write ${name}`); },
      removeItem() { assert.fail(`Issuer must not use ${name}`); },
    });
  }
  mockGlobal(t, 'FormData', class {
    constructor(form) {
      this.values = findAll(form, (node) => ['input', 'select'].includes(node.tagName) && node.attributes.name)
        .map((node) => [node.attributes.name, node.value]);
    }
    get(key) { return this.values.find(([name]) => name === key)?.[1]; }
    entries() { return this.values.values(); }
  });
  mockGlobal(t, 'setTimeout', (callback, delay) => { timers.set(++timerId, { callback, delay }); return timerId; });
  mockGlobal(t, 'clearTimeout', (id) => timers.delete(id));
  mockGlobal(t, 'fetch', async (route, fetchOptions) => {
    requests.push({ route, options: fetchOptions, fragment: location.hash });
    active.set(route, (active.get(route) || 0) + 1);
    maximum.set(route, Math.max(maximum.get(route) || 0, active.get(route)));
    try {
      assert.equal(fetchOptions.cache, 'no-store');
      assert.equal(fetchOptions.headers['X-Admin-Token'], undefined);
      assert.doesNotMatch(route, /private-recovery|org-access|admin-token/);
      if (route === '/api/config') {
        assert.equal(fetchOptions.credentials, 'omit');
        const publicUrl = state.publicUrl ?? location.origin;
        return Response.json({ role: 'central', publicUrl, roles,
          issuerSetupUrl: `${publicUrl}/issuer.html` });
      }
      assert.equal(fetchOptions.credentials, 'same-origin');
      if (route === '/api/issuer/session') return state.sessionResponse || Response.json(session());
      if (route === '/api/issuer/recover') {
        assert.equal(location.hash.includes('org-access'), false);
        assert.equal(fetchOptions.method, 'POST');
        if (state.recoveryResponse) return state.recoveryResponse;
        state.organisation = state.recoveredOrganisation || organisation();
        return Response.json(session());
      }
      if (route === '/api/organisations') {
        assert.equal(fetchOptions.method, 'POST');
        if (state.createResponse) return state.createResponse;
        if (state.organisation) return Response.json({ error: 'Dieser Browser hat bereits eine Organisation.' }, { status: 409 });
        state.organisation = organisation('pending', JSON.parse(fetchOptions.body).name);
        return Response.json(session(), { status: 201 });
      }
      if (route === '/api/issuer/status') {
        if (state.heldStatus) {
          const held = state.heldStatus;
          state.heldStatus = null;
          return await held.promise;
        }
        return state.statusResponse || Response.json(session());
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
        assert.equal(fetchOptions.method, 'POST');
        assert.equal(fetchOptions.body, '{}');
        const id = route.split('/').at(-2);
        const record = state.records.find((item) => item.id === id);
        assert.ok(record);
        const updated = { ...record, revokedAt: new Date().toISOString() };
        state.records = state.records.map((item) => item.id === id ? updated : item);
        return Response.json(updated);
      }
      if (route === '/api/issuer/offers') {
        const submitted = JSON.parse(fetchOptions.body).claims;
        if (!roles.includes(submitted.role)) return Response.json({ error: 'Ungültige Rolle.' }, { status: 400 });
        return Response.json(state.offer, { status: 201 });
      }
      if (route === '/api/issuer/offers/offer-id') {
        if (state.heldOffer) {
          const held = state.heldOffer;
          state.heldOffer = null;
          return await held.promise;
        }
        return state.offerResponse || Response.json(state.offer);
      }
      throw new Error(`Unexpected request: ${route}`);
    } finally { active.set(route, active.get(route) - 1); }
  });
  await import(`../public/issuer.js?issuer-ui-test=${++fixtureId}`);
  await settle();
  assert.equal(app.hidden, false);
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
  const submit = async (form) => {
    await form.listeners.get('submit')({ preventDefault() {} });
    await settle();
  };
  const createOffer = async () => {
    input(app, 'given_name').value = claims.given_name;
    input(app, 'family_name').value = claims.family_name;
    roleSelect(app).value = claims.role;
    await submit(byClass(app, 'offer-fields').parent);
    return byClass(app, 'transfer-panel');
  };
  return { app, error, state, requests, timers, maximum, fire, click, submit, createOffer,
    events, documentEvents, document, location };
}

test('Issuer HTML is a central organisation workflow without operator or admin-token UI', async () => {
  const html = await readFile(new URL('../public/issuer.html', import.meta.url), 'utf8');
  const source = await readFile(new URL('../public/issuer.js', import.meta.url), 'utf8');
  assert.match(html, /Organisation anlegen\. Freigabe abwarten\. Ausweise ausstellen\./);
  assert.match(html, /Keine Installation oder eigener Server nötig/);
  assert.doesNotMatch(html, /Admin-Token|admin-token|Server-Logs|ausstellende Person|eigenständiger Issuer/);
  assert.doesNotMatch(source, /managementAccess|employeeName|adminToken|\/approve|\/register|\/setup|workshopUrl/);
});

test('Anonymous browser creates only an organisation name, then waits for host approval', async (t) => {
  const f = await fixture(t, { organisation: null });
  assert.equal(currentStep(f.app), 1);
  assert.equal(findAll(f.app, (node) => node.tagName === 'input').length, 1);
  assert.equal(input(f.app, 'name').attributes.maxlength, '120');
  assert.equal(input(f.app, 'employeeName'), undefined);
  assert.equal(input(f.app, 'token'), undefined);
  assert.match(f.app.textContent, /HttpOnly-Cookie|unveränderlich|nicht mehr änderbar/);
  input(f.app, 'name').value = '  Neue Organisation  ';
  await f.submit(find(f.app, (node) => node.tagName === 'form'));
  const request = f.requests.find(({ route }) => route === '/api/organisations');
  assert.deepEqual(JSON.parse(request.options.body), { name: 'Neue Organisation' });
  assert.equal(currentStep(f.app), 2);
  assert.match(f.app.textContent, /Wartet auf Freigabe/);
  assert.equal(input(f.app, 'name'), undefined);
  assert.equal(byClass(f.app, 'offer-fields').disabled, true);
  assert.match(byClass(f.app, 'fixed-organisation').textContent, /Neue Organisation/);
});

test('Organisation creation errors stay explicit and never silently overwrite an existing browser session', async (t) => {
  const f = await fixture(t, { organisation: null,
    createResponse: Response.json({ error: 'Dieser Browser hat bereits eine Organisation.' }, { status: 409 }) });
  const form = find(f.app, (node) => node.tagName === 'form');
  input(f.app, 'name').value = 'Nicht überschreiben';
  await f.submit(form);
  assert.match(byClass(form, 'form-error').textContent, /bereits eine Organisation/);
  assert.equal(input(f.app, 'name').value, 'Nicht überschreiben');
  assert.equal(currentStep(f.app), 1);
});

test('Pending, approved and suspended states update in place and preserve employee inputs and role', async (t) => {
  const f = await fixture(t);
  assert.equal(currentStep(f.app), 2);
  const fields = byClass(f.app, 'offer-fields');
  const givenName = input(f.app, 'given_name');
  const role = roleSelect(f.app);
  givenName.value = 'Nicht verlieren';
  role.value = 'Teamleitung';
  f.state.organisation = organisation('approved');
  await f.fire(5000);
  assert.match(f.app.textContent, /Freigegeben/);
  assert.equal(currentStep(f.app), 3);
  assert.equal(fields.disabled, false);
  f.state.organisation = organisation('suspended');
  await f.fire(5000);
  assert.match(f.app.textContent, /Gesperrt/);
  assert.equal(fields.disabled, true);
  f.state.statusResponse = Response.json({ error: 'Zentrale nicht erreichbar' }, { status: 503 });
  await f.fire(5000);
  assert.match(f.app.textContent, /Organisationsstatus konnte nicht geprüft werden: Zentrale/);
  assert.equal(fields.disabled, true);
  f.state.statusResponse = null;
  f.state.organisation = organisation('approved');
  await f.fire(5000);
  assert.equal(input(f.app, 'given_name'), givenName);
  assert.equal(givenName.value, 'Nicht verlieren');
  assert.equal(role.value, 'Teamleitung');
  assert.equal(fields.disabled, false);
});

test('Offer uses exactly three roles and fixed read-only organisation; forged form fields are not submitted', async (t) => {
  const f = await fixture(t, { organisation: organisation('approved') });
  assert.equal(currentStep(f.app), 3);
  const fields = byClass(f.app, 'offer-fields');
  assert.equal(input(fields, 'organisation'), undefined);
  assert.equal(input(fields, 'role'), undefined);
  assert.deepEqual(roleSelect(fields).children.map((option) => option.value), roles);
  const forged = new Element('input');
  forged.setAttribute('name', 'organisation');
  forged.value = 'Forged organisation';
  fields.append(forged);
  await f.createOffer();
  const request = f.requests.find(({ route }) => route === '/api/issuer/offers');
  assert.deepEqual(JSON.parse(request.options.body), {
    claims: { given_name: 'Erika', family_name: 'Muster', role: 'Mitarbeitende' },
  });
  assert.equal(request.options.method, 'POST');
  assert.match(byClass(f.app, 'fixed-organisation').textContent, /Demo GmbH/);
});

test('Server role validation errors are presented by the existing form error flow', async (t) => {
  const f = await fixture(t, { organisation: organisation('approved') });
  const form = byClass(f.app, 'offer-fields').parent;
  input(form, 'given_name').value = 'Erika';
  input(form, 'family_name').value = 'Muster';
  roleSelect(form).value = 'Administrator';
  await f.submit(form);
  assert.match(byClass(form, 'form-error').textContent, /Ungültige Rolle/);
  assert.equal(byClass(f.app, 'transfer-panel').hidden, true);
});

test('Offer automatically advances offered → bound → issued → accepted without a laptop sign button', async (t) => {
  const f = await fixture(t, { organisation: organisation('approved') });
  const panel = await f.createOffer();
  const qr = byClass(panel, 'offer-qr');
  const metadata = byClass(panel, 'raw-data');
  metadata.open = true;
  assert.match(panel.textContent, /Angeboten · Wartet auf Smartphone/);
  assert.equal(byClass(panel, 'pairing-code').textContent, '123456');
  assert.match(panel.textContent, /QR-Code scannen.*PWA/);
  assert.doesNotMatch(metadata.textContent, /123456|transactionCode/);
  const next = button(panel, 'Weiteren Mitarbeiterausweis vorbereiten');
  assert.equal(next.hidden, true);
  for (const status of ['bound', 'issued', 'accepted']) {
    f.state.offer = { ...f.state.offer, status, holderDid: 'did:example:phone' };
    await f.fire(1800);
    assert.equal(byClass(panel, 'pairing-code').textContent, '');
    assert.equal(byClass(panel, 'issuance-code').hidden, true);
    assert.match(panel.textContent, /Ausgabecode und Wallet-Schlüsselbeweis geprüft/);
    assert.equal(byClass(panel, 'offer-qr'), qr);
    assert.equal(byClass(panel, 'raw-data'), metadata);
    assert.equal(metadata.open, true);
    assert.equal(next.hidden, status !== 'accepted');
    assert.doesNotMatch(panel.textContent, /123456/);
  }
  assert.match(panel.textContent, /Gespeichert · Die Wallet hat den Empfang bestätigt/);
  assert.equal([...f.timers.values()].some(({ delay }) => delay === 1800), false);
  assert.equal(f.requests.some(({ route }) => route.endsWith('/approve')), false);
  assert.equal(findAll(f.app, (node) => node.tagName === 'button').some((node) => /signieren|signatur|genehmigen/i.test(node.textContent)), false);
  assert.equal(f.requests.filter(({ route, options }) => route === '/api/issuer/offers' && options.method === 'POST').length, 1);
  assert.equal(input(f.app, 'given_name').value, 'Erika');
  await f.click(panel, 'Weiteren Mitarbeiterausweis vorbereiten');
  assert.equal(panel.hidden, true);
  assert.equal(panel.children.length, 0);
  assert.equal(input(f.app, 'given_name').value, '');
  assert.equal(roleSelect(f.app).value, 'Mitarbeitende');
  assert.equal(f.requests.filter(({ route }) => route === '/api/issuer/offers').length, 1);
});

test('Active QR and details survive suspension, polling and bfcache restoration', async (t) => {
  const f = await fixture(t, { organisation: organisation('approved'), records: [credential()] });
  const panel = await f.createOffer();
  const qr = byClass(panel, 'offer-qr');
  const details = byClass(panel, 'raw-data');
  details.open = true;
  f.state.organisation = organisation('suspended');
  await f.fire(5000);
  await f.fire(1800);
  assert.equal(byClass(panel, 'offer-qr'), qr);
  assert.equal(details.open, true);
  assert.equal(panel.hidden, false);
  f.events.get('pagehide')();
  assert.equal(f.timers.size, 0);
  f.events.get('pageshow')({ persisted: true });
  await settle();
  assert.equal(byClass(panel, 'offer-qr'), qr);
  assert.equal(details.open, true);
  assert.equal(f.requests.filter(({ route }) => route === '/api/issuer/offers').length, 1);
  assert.equal([...f.timers.values()].filter(({ delay }) => delay === 5000).length, 2);
});

test('Missing six-digit code is an explicit error and polling can recover without creating another offer', async (t) => {
  const f = await fixture(t, { organisation: organisation('approved') });
  f.state.offer.transactionCode = '12345';
  const panel = await f.createOffer();
  assert.match(panel.textContent, /keinen gültigen Ausgabecode geliefert/);
  assert.equal(byClass(panel, 'issuance-code').hidden, true);
  f.state.offer.transactionCode = '654321';
  await f.fire(1800);
  assert.equal(byClass(panel, 'pairing-code').textContent, '654321');
  assert.equal(find(panel, (node) => node.attributes.role === 'alert').hidden, true);
  assert.equal(f.requests.filter(({ route }) => route === '/api/issuer/offers').length, 1);
});

test('Offer expiry clears code, explains failure and requires deliberate next-offer action', async (t) => {
  const f = await fixture(t, { organisation: organisation('approved') });
  const panel = await f.createOffer();
  f.state.offerResponse = Response.json({ error: 'Das Angebot ist abgelaufen.' }, { status: 410 });
  await f.fire(1800);
  assert.match(panel.textContent, /Angebot abgelaufen oder nicht mehr verfügbar/);
  assert.match(panel.textContent, /Das Angebot ist abgelaufen/);
  assert.equal(byClass(panel, 'pairing-code').textContent, '');
  assert.equal(button(panel, 'Weiteren Mitarbeiterausweis vorbereiten').hidden, false);
  assert.equal(f.requests.filter(({ route }) => route === '/api/issuer/offers').length, 1);
});

test('Cancelled offers and transient offer errors are explicit, not treated as successful delivery', async (t) => {
  const f = await fixture(t, { organisation: organisation('approved') });
  const panel = await f.createOffer();
  f.state.offerResponse = Response.json({ error: 'Ausgabe vorübergehend nicht erreichbar' }, { status: 503 });
  await f.fire(1800);
  assert.match(panel.textContent, /Angebotsstatus konnte nicht aktualisiert werden/);
  assert.equal(button(panel, 'Weiteren Mitarbeiterausweis vorbereiten').hidden, true);
  f.state.offerResponse = null;
  f.state.offer = { ...f.state.offer, status: 'cancelled', cancellationReason: 'Zu viele falsche Codeeingaben.' };
  await f.fire(1800);
  assert.match(panel.textContent, /Angebot abgebrochen.*Zu viele falsche Codeeingaben/);
  assert.equal(byClass(panel, 'pairing-code').textContent, '');
  assert.equal(button(panel, 'Weiteren Mitarbeiterausweis vorbereiten').hidden, false);
});

test('Refreshes never overlap, pause while hidden, and discard pre-bfcache responses', async (t) => {
  const f = await fixture(t);
  const held = deferred();
  f.state.heldStatus = held;
  const before = f.requests.filter(({ route }) => route.endsWith('/status')).length;
  await f.fire(5000, false);
  await f.click(f.app, 'Organisationsstatus aktualisieren');
  await f.fire(5000, false);
  assert.equal(f.requests.filter(({ route }) => route.endsWith('/status')).length, before + 1);
  f.events.get('pagehide')();
  f.state.organisation = organisation('approved');
  f.events.get('pageshow')({ persisted: true });
  await settle();
  held.resolve(Response.json({ organisation: organisation('suspended'), roles }));
  await settle();
  assert.match(f.app.textContent, /Freigegeben/);
  assert.doesNotMatch(f.app.textContent, /Gesperrt ·/);
  assert.equal(f.maximum.get('/api/issuer/status'), 1);
  f.document.visibilityState = 'hidden';
  f.documentEvents.get('visibilitychange')();
  assert.equal(f.timers.size, 0);
  f.document.visibilityState = 'visible';
  f.documentEvents.get('visibilitychange')();
  await settle();
  assert.equal([...f.timers.values()].filter(({ delay }) => delay === 5000).length, 2);
});

test('List failure is distinct from an empty list and does not prevent organisation status checks', async (t) => {
  const f = await fixture(t, { credentialsError: true });
  const panel = byClass(f.app, 'credentials-panel');
  assert.match(panel.textContent, /Ausweisliste konnte nicht geladen werden: Datenspeicher/);
  assert.match(panel.textContent, /Keine verlässliche Ausweisliste/);
  assert.doesNotMatch(panel.textContent, /Noch keine Ausweise ausgestellt/);
  assert.match(f.app.textContent, /Wartet auf Freigabe/);
  f.state.credentialsError = false;
  await f.click(panel, 'Ausweisliste aktualisieren');
  assert.match(panel.textContent, /Noch keine Ausweise ausgestellt/);
  assert.equal(find(panel, (node) => node.attributes.role === 'alert').hidden, true);
});

test('Suspended organisation retains searchable paginated list, open details and permanent revoke with stale-poll protection', async (t) => {
  const f = await fixture(t, { organisation: organisation('suspended'),
    records: Array.from({ length: 45 }, (_, index) => credential(index)) });
  assert.equal(byClass(f.app, 'offer-fields').disabled, true);
  const panel = byClass(f.app, 'credentials-panel');
  const list = byClass(panel, 'credential-list');
  assert.equal(list.children.length, 20);
  const entry = list.children[0];
  entry.open = true;
  await f.click(entry, 'Diesen Ausweis endgültig widerrufen');
  const confirmation = byClass(entry, 'revoke-confirmation');
  const checkbox = input(entry, 'confirmRevocation');
  checkbox.checked = true;
  await f.fire(5000);
  assert.equal(list.children[0], entry);
  assert.equal(entry.open, true);
  assert.equal(confirmation.hidden, false);
  assert.equal(checkbox.checked, true);
  await f.click(panel, 'Nächste Seite');
  assert.match(panel.textContent, /Seite 2 von 3/);
  await f.click(panel, 'Vorherige Seite');
  assert.equal(list.children[0], entry);
  const search = find(panel, (node) => node.attributes.type === 'search');
  search.value = 'Erika 44';
  search.listeners.get('input')();
  assert.equal(list.children.length, 1);
  search.value = '';
  search.listeners.get('input')();
  const snapshot = structuredClone(f.state.records);
  const held = deferred();
  f.state.heldCredentials = held;
  await f.fire(5000, false);
  const form = find(confirmation, (node) => node.tagName === 'form');
  checkbox.checked = false;
  await f.submit(form);
  assert.match(confirmation.textContent, /Bitte bestätige zuerst/);
  assert.equal(f.requests.some(({ route }) => route.endsWith('/revoke')), false);
  checkbox.checked = true;
  await f.submit(form);
  assert.equal(confirmation.hidden, true);
  assert.match(entry.textContent, /Endgültig widerrufen am/);
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
  assert.equal(byClass(f.app, 'offer-fields').disabled, true);
  assert.ok(findAll(entry, (node) => node.tagName === 'time').every((node) => !Number.isNaN(Date.parse(node.attributes.datetime))));
});

test('Lost browser session returns to onboarding and late credential polls cannot repopulate private data', async (t) => {
  const f = await fixture(t, { records: [credential()] });
  const held = deferred();
  f.state.heldCredentials = held;
  await f.fire(5000, false);
  f.state.organisation = null;
  await f.click(f.app, 'Organisationsstatus aktualisieren');
  held.resolve(Response.json([credential(99)]));
  await settle();
  assert.equal(currentStep(f.app), 1);
  assert.doesNotMatch(f.app.textContent, /Erika 0|Erika 99/);
  assert.equal(f.timers.size, 0);
});

test('Recovery consumes fragment immediately, exchanges only via POST and never uses JS storage or manual token entry', async (t) => {
  const f = await fixture(t, { organisation: null,
    fragment: '#org-access=private-recovery&keep=1', recoveredOrganisation: organisation('approved') });
  assert.equal(f.location.hash, '#keep=1');
  assert.ok(f.requests.every(({ fragment }) => !fragment.includes('org-access')));
  const request = f.requests.find(({ route }) => route === '/api/issuer/recover');
  assert.deepEqual(JSON.parse(request.options.body), { token: 'private-recovery' });
  assert.equal(request.options.method, 'POST');
  assert.equal(currentStep(f.app), 3);
  assert.equal(input(f.app, 'token'), undefined);
  assert.doesNotMatch(f.app.textContent, /private-recovery/);
  assert.equal(f.requests.some(({ route }) => route === '/api/issuer/session'), false);
});

test('Recovery failure is explicit, removes the secret and does not silently onboard another organisation', async (t) => {
  const f = await fixture(t, { fragment: '#org-access=private-recovery',
    recoveryResponse: Response.json({ error: 'Wiederherstellungslink ist ungültig.' }, { status: 403 }) });
  assert.equal(f.location.hash, '');
  assert.match(f.app.textContent, /Wiederherstellung fehlgeschlagen/);
  assert.match(f.error.textContent, /Wiederherstellungslink ist ungültig/);
  assert.equal(button(f.app, 'Organisation anlegen'), undefined);
  assert.equal(input(f.app, 'token'), undefined);
  assert.equal(f.timers.size, 0);
});

test('Recovery in an open tab stops old polling and stale responses cannot replace recovered organisation', async (t) => {
  const f = await fixture(t, { records: [credential()] });
  const held = deferred();
  f.state.heldStatus = held;
  await f.fire(5000, false);
  f.state.recoveredOrganisation = { ...organisation('approved', 'Neue Firma'), id: 'new-org' };
  f.state.records = [];
  f.location.hash = '#org-access=private-recovery';
  f.events.get('hashchange')();
  await settle();
  held.resolve(Response.json({ organisation: organisation('suspended', 'Veraltet'), roles }));
  await settle();
  assert.equal(f.location.hash, '');
  assert.equal(currentStep(f.app), 3);
  assert.match(byClass(f.app, 'fixed-organisation').textContent, /Neue Firma/);
  assert.doesNotMatch(f.app.textContent, /Veraltet|Erika 0/);
});

test('Session errors and malformed roles do not masquerade as an anonymous onboarding success', async (t) => {
  const f = await fixture(t, { sessionResponse: Response.json({ organisation: organisation(), roles: ['Admin'] }) });
  assert.match(f.error.textContent, /Organisationssitzung hat ein ungültiges Format/);
  assert.match(f.app.textContent, /Organisation konnte nicht geladen werden/);
  assert.equal(button(f.app, 'Organisation anlegen'), undefined);
});

test('Direct localhost setup link is guarded before session access or organisation creation on an HTTPS public origin', async (t) => {
  const f = await fixture(t, { organisation: null, pageUrl: 'http://localhost:3000/issuer.html?demo=1#keep=1',
    publicUrl: 'https://workshop.example.org' });
  assert.match(f.app.textContent, /Organisation unter der Workshop-Adresse öffnen/);
  assert.match(f.app.textContent, /Lege hier keine zweite Organisation an/);
  const link = find(f.app, (node) => node.tagName === 'a');
  assert.equal(link.attributes.href, 'https://workshop.example.org/issuer.html?demo=1#keep=1');
  assert.deepEqual(f.requests.map(({ route }) => route), ['/api/config']);
  assert.equal(button(f.app, 'Organisation anlegen'), undefined);
  assert.equal(find(f.app, (node) => node.tagName === 'form'), undefined);
  assert.equal(f.timers.size, 0);
});

test('Alternate HTTPS origin cannot expose an organisation session or start management polling', async (t) => {
  const f = await fixture(t, { pageUrl: 'https://alias.example.org/issuer.html',
    publicUrl: 'https://workshop.example.org', records: [credential()] });
  assert.match(f.app.textContent, /Organisations-Cookie gehört zur Workshop-Adresse/);
  assert.doesNotMatch(f.app.textContent, /Erika 0|Demo GmbH/);
  assert.deepEqual(f.requests.map(({ route }) => route), ['/api/config']);
  assert.equal(find(f.app, (node) => node.tagName === 'a').attributes.href, 'https://workshop.example.org/issuer.html');
  assert.equal(f.timers.size, 0);
});

test('Recovery on localhost strips the secret immediately and preserves it only in the canonical link fragment', async (t) => {
  const f = await fixture(t, { pageUrl: 'http://localhost:3000/issuer.html?demo=1',
    publicUrl: 'https://workshop.example.org', fragment: '#org-access=private-recovery&keep=1' });
  assert.equal(f.location.hash, '#keep=1');
  assert.ok(f.requests.every(({ fragment }) => !fragment.includes('org-access')));
  assert.deepEqual(f.requests.map(({ route }) => route), ['/api/config']);
  assert.match(f.app.textContent, /erst unter der Workshop-Adresse eingelöst/);
  assert.doesNotMatch(f.app.textContent, /private-recovery/);
  const url = new URL(find(f.app, (node) => node.tagName === 'a').attributes.href);
  assert.equal(url.origin, 'https://workshop.example.org');
  assert.equal(url.pathname, '/issuer.html');
  assert.equal(url.search, '?demo=1');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('org-access'), 'private-recovery');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('keep'), '1');
  assert.equal(url.search.includes('private-recovery'), false);
  assert.equal(input(f.app, 'token'), undefined);
  assert.equal(f.timers.size, 0);
});

test('Recovery hash changes cannot bypass a canonical-origin guard', async (t) => {
  const f = await fixture(t, { pageUrl: 'http://localhost:3000/issuer.html',
    publicUrl: 'https://workshop.example.org' });
  f.location.hash = '#org-access=private-recovery';
  f.events.get('hashchange')();
  await settle();
  assert.equal(f.location.hash, '');
  assert.deepEqual(f.requests.map(({ route }) => route), ['/api/config']);
  const url = new URL(find(f.app, (node) => node.tagName === 'a').attributes.href);
  assert.equal(url.origin, 'https://workshop.example.org');
  assert.equal(new URLSearchParams(url.hash.slice(1)).get('org-access'), 'private-recovery');
  assert.equal(f.timers.size, 0);
});

test('Matching loopback public origin remains usable for local setup and cookie-authenticated requests', async (t) => {
  const f = await fixture(t, { organisation: null, pageUrl: 'http://127.0.0.1:3000/issuer.html',
    publicUrl: 'http://127.0.0.1:3000' });
  assert.equal(currentStep(f.app), 1);
  input(f.app, 'name').value = 'Lokale Demo';
  await f.submit(find(f.app, (node) => node.tagName === 'form'));
  assert.equal(currentStep(f.app), 2);
  assert.match(byClass(f.app, 'fixed-organisation').textContent, /Lokale Demo/);
  assert.equal(f.requests.find(({ route }) => route === '/api/organisations').options.credentials, 'same-origin');
});

test('Invalid canonical public origin fails explicitly before any organisation session or recovery request', async (t) => {
  const f = await fixture(t, { pageUrl: 'http://localhost:3000/issuer.html',
    publicUrl: 'https://workshop.example.org/subpath', fragment: '#org-access=private-recovery' });
  assert.match(f.error.textContent, /Workshop-Adresse muss eine HTTPS-Adresse ohne Pfad sein/);
  assert.match(f.app.textContent, /Wiederherstellung fehlgeschlagen/);
  assert.equal(f.location.hash, '');
  assert.deepEqual(f.requests.map(({ route }) => route), ['/api/config']);
  assert.equal(button(f.app, 'Organisation anlegen'), undefined);
  assert.equal(f.timers.size, 0);
});
