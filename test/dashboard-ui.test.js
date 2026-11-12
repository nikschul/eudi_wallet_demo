import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';

const source = (file) => readFileSync(new URL(`../public/${file}`, import.meta.url), 'utf8');

class Element {
  children = [];
  listeners = new Map();
  dataset = {};
  value = '';
  hidden = false;
  disabled = false;
  open = false;
  scrollTop = 0;

  constructor(tag = 'div') { this.tag = tag; }
  get textContent() { return this.children.map((child) => typeof child === 'string' ? child : child.textContent).join(''); }
  set textContent(value) { this.replaceChildren(String(value)); }
  setAttribute(name, value) {
    if (name.startsWith('data-')) this.dataset[name.slice(5)] = value;
    else this[name] = value;
  }
  append(...children) {
    for (const child of children) {
      if (child instanceof Element) { child.remove(); child.parent = this; }
      this.children.push(child);
    }
  }
  prepend(child) { child.remove(); child.parent = this; this.children.unshift(child); }
  replaceChildren(...children) {
    for (const child of this.children) if (child instanceof Element) child.parent = null;
    this.children = [];
    this.append(...children);
  }
  remove() {
    if (!this.parent) return;
    this.parent.children.splice(this.parent.children.indexOf(this), 1);
    this.parent = null;
  }
  querySelectorAll(selector) {
    const matches = [];
    for (const child of this.children) {
      if (!(child instanceof Element)) continue;
      if (selector === child.tag || (selector === 'details[open]' && child.tag === 'details' && child.open)
        || (selector === 'button[type="submit"]' && child.tag === 'button' && child.type === 'submit')) matches.push(child);
      matches.push(...child.querySelectorAll(selector));
    }
    return matches;
  }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  addEventListener(name, handler) {
    if (!this.listeners.has(name)) this.listeners.set(name, []);
    this.listeners.get(name).push(handler);
  }
  async emit(name) {
    await Promise.all((this.listeners.get(name) || []).map((handler) => handler({ preventDefault() {} })));
  }
  focus() {}
}

function issuer(index, overrides = {}) {
  return {
    did: `did:example:issuer-${index}`, name: `Ausweisstelle ${index}`,
    employeeName: `Person ${index}`, ownerName: '', trusted: false,
    proofVerified: true, fingerprint: `KEY-${index}`, checkinCount: index % 3,
    publicUrl: `https://issuer-${index}.example.org`, ...overrides,
  };
}

function fixture(count = 180) {
  return {
    stats: { registered: count, checkins: 928 },
    issuers: Array.from({ length: count }, (_, index) => issuer(index)),
    attempts: [{
      id: 'attempt-12345678', name: 'Demo-Person', issuerName: 'Ausweisstelle 0',
      status: 'done', identityVerified: true, steps: ['Signatur geprüft'],
      time: '2026-11-12T12:00:00Z',
    }],
  };
}

function surface(page, initial = fixture()) {
  const ids = new Map([...source(`${page}.html`).matchAll(/id="([^"]+)"/g)]
    .map(([, id]) => [id, new Element()]));
  ids.get('issuer-filter')?.setAttribute('value', 'all');
  const document = { createElement: (tag) => new Element(tag), getElementById: (id) => ids.get(id), activeElement: null };
  let data = initial;
  let accessOptions;
  const mutations = [];
  const context = createContext({
    Node: Element, document, window: { addEventListener() {} },
    setTimeout() {}, clearTimeout() {}, confirm: () => true,
    FormData: class {
      constructor(form) { this.inputs = form.querySelectorAll('input'); }
      get(name) { return this.inputs.find((input) => input.name === name)?.value; }
    },
    managementAccess(options) {
      accessOptions = options;
      return {
        async request(route, options) {
          if (route === '/session') return { ok: true };
          mutations.push({ route, body: options.body });
          const entry = data.issuers.find((entry) => route.includes(encodeURIComponent(entry.did)));
          Object.assign(entry, options.body);
        },
      };
    },
    fetch: async () => ({ ok: true, json: async () => data }),
    AbortController,
  });
  const helpers = source('lib/ui.js').replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
  const script = source(`${page}.js`).replace(/^import .*;\r?$/gm, '');
  const bootstrap = page === 'admin' ? '\nrun(async () => {' : "\ndocument.getElementById('issuer-search').addEventListener";
  runInContext(`${helpers}\n${script.slice(0, script.indexOf(bootstrap))}
    globalThis.surface = { ${page === 'admin' ? 'refresh' : 'dashboard'}, filterIssuers, issuerViews };`, context);
  return {
    ids, document, ui: context.surface, mutations,
    async start() { if (page === 'admin') await accessOptions.onUnlock(); else await context.surface.dashboard(); },
    async refresh(next = data) {
      data = next;
      await context.surface[page === 'admin' ? 'refresh' : 'dashboard']();
    },
    lock: () => accessOptions.onLock(),
    setApi: (api) => { context.api = api; },
  };
}

test('Both dashboards have exactly the requested aggregate metrics and retain detailed lists', () => {
  for (const page of ['kiosk', 'admin']) {
    const html = source(`${page}.html`);
    const metrics = html.match(/<div[^>]*class="progress-stats"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/)?.[1];
    assert.ok(metrics, `${page}: metric group`);
    assert.deepEqual([...metrics.matchAll(/<strong id="([^"]+)"/g)].map((match) => match[1]),
      ['registered-count', 'checkin-count']);
    assert.doesNotMatch(html, /id="(?:attempt-count|attendee-count|trust-summary)"/);
    assert.doesNotMatch(source(`${page}.js`), /stats\.(?:trusted|checkedIn)/);
  }
  assert.match(source('kiosk.html'), /id="attempts"/);
  assert.match(source('kiosk.html'), /id="attendees"/);
});

test('Admin handles many issuers without replacing drafts, focus, open details or scroll on live changes', async () => {
  const data = fixture();
  const app = surface('admin', data);
  await app.start();
  assert.equal(app.ids.get('registered-count').textContent, '180');
  assert.equal(app.ids.get('checkin-count').textContent, '928');
  assert.equal(app.ids.get('issuers').children.length, 180);
  const view = app.ui.issuerViews.get(data.issuers[0].did);
  const input = view.assigned;
  input.value = 'Noch nicht gespeicherter Name';
  input.selectionStart = 5;
  app.document.activeElement = input;
  view.node.open = true;
  view.metadata.open = true;
  app.ids.get('issuers').scrollTop = 220;
  data.issuers[1].trusted = true;
  data.issuers[1].ownerName = 'Verifizierte Person';
  data.issuers.push(issuer(180));
  data.stats.registered = 181;
  await app.refresh();
  assert.equal(app.ui.issuerViews.get(data.issuers[0].did), view);
  assert.equal(view.assigned, input);
  assert.equal(app.document.activeElement, input);
  assert.equal(input.value, 'Noch nicht gespeicherter Name');
  assert.equal(input.selectionStart, 5);
  assert.equal(view.node.open, true);
  assert.equal(view.metadata.open, true);
  assert.equal(app.ids.get('issuers').scrollTop, 220);
  assert.equal(app.ids.get('issuers').children[0], app.ui.issuerViews.get(issuer(180).did).node);
  data.issuers[0].ownerName = 'Extern geänderter Name';
  data.issuers[0].checkinCount = 9;
  await app.refresh();
  assert.equal(input.value, 'Noch nicht gespeicherter Name');
  assert.match(view.checkins.textContent, /^9 /);
});

test('Admin search, trust filters, revocation and removals update in place without inventing credential approval', async () => {
  const data = fixture(3);
  data.issuers[0] = issuer(0, { trusted: true, ownerName: 'Geprüfter Name', checkinCount: 6 });
  data.issuers[2].proofVerified = false;
  const app = surface('admin', data);
  await app.start();
  const trusted = app.ui.issuerViews.get(data.issuers[0].did);
  assert.equal(trusted.status, 'trusted');
  assert.equal(app.ui.issuerViews.get(data.issuers[2].did).approve.disabled, true);
  app.ids.get('issuer-search').value = 'key-0';
  app.ui.filterIssuers();
  assert.equal(trusted.node.hidden, false);
  assert.equal(app.ui.issuerViews.get(data.issuers[1].did).node.hidden, true);
  app.ids.get('issuer-filter').value = 'trusted';
  await trusted.revoke.emit('click');
  assert.equal(app.mutations[0].route, `/issuers/${encodeURIComponent(data.issuers[0].did)}/trust`);
  assert.equal(app.mutations[0].body.trusted, false);
  assert.equal(trusted.status, 'untrusted');
  assert.equal(trusted.node.hidden, true);
  assert.equal(trusted.revoke.disabled, true);
  assert.match(trusted.checkins.textContent, /^6 /);
  assert.equal(app.ids.get('checkin-count').textContent, '928');
  assert.equal(app.ids.get('issuer-no-match').hidden, false);
  const removed = app.ui.issuerViews.get(data.issuers[1].did);
  data.issuers.splice(1, 1);
  data.stats.registered = 2;
  await app.refresh();
  assert.equal(removed.node.parent, null);
  assert.equal(app.ui.issuerViews.size, 2);
  app.ids.get('issuer-search').value = '';
  app.ids.get('issuer-filter').value = 'unverified';
  app.ui.filterIssuers();
  assert.equal(app.ui.issuerViews.get(data.issuers[1].did).node.hidden, false);
  assert.equal(trusted.node.hidden, true);
});

test('Admin trust submission keeps other drafts and the existing input and details', async () => {
  const data = fixture(2);
  const app = surface('admin', data);
  await app.start();
  const view = app.ui.issuerViews.get(data.issuers[0].did);
  const other = app.ui.issuerViews.get(data.issuers[1].did);
  other.assigned.value = 'Anderer Entwurf';
  view.assigned.value = '  Zugeordnete Person  ';
  view.node.open = true;
  const node = view.node;
  await view.node.querySelector('form').emit('submit');
  assert.equal(app.mutations[0].body.ownerName, 'Zugeordnete Person');
  assert.equal(app.mutations[0].body.trusted, true);
  assert.equal(view.status, 'trusted');
  assert.equal(view.node, node);
  assert.equal(view.node.open, true);
  assert.equal(other.assigned.value, 'Anderer Entwurf');
  assert.equal(view.approve.disabled, false);
  assert.equal(view.revoke.disabled, false);
});

test('Admin discards late dashboard responses after lock and clears issuer drafts', async () => {
  const app = surface('admin');
  await app.start();
  let resolve;
  app.setApi(() => new Promise((done) => { resolve = done; }));
  const pending = app.ui.refresh();
  app.lock();
  resolve(fixture());
  await pending;
  assert.equal(app.ui.issuerViews.size, 0);
  assert.equal(app.ids.get('issuers').children.length, 0);
});

test('Kiosk uses total successful check-ins, supports many searchable issuers and preserves attempt details', async () => {
  const data = fixture();
  const app = surface('kiosk', data);
  await app.start();
  assert.equal(app.ids.get('registered-count').textContent, '180');
  assert.equal(app.ids.get('checkin-count').textContent, '928');
  assert.equal(app.ids.get('progress-list').children.length, 180);
  const attempt = app.ids.get('attempts').querySelector('details');
  attempt.open = true;
  app.ids.get('progress-list').scrollTop = 160;
  const view = app.ui.issuerViews.get(data.issuers[0].did);
  app.ids.get('issuer-search').value = 'Kein Treffer für diese Suche';
  app.ui.filterIssuers();
  assert.equal(app.ids.get('issuer-no-match').hidden, false);
  assert.equal(view.node.hidden, true);
  app.ids.get('issuer-search').value = 'DID:EXAMPLE:ISSUER-0';
  app.ui.filterIssuers();
  assert.equal(view.node.hidden, false);
  data.issuers[0].trusted = true;
  data.issuers[0].ownerName = 'Geprüfte Person';
  data.issuers[0].checkinCount = 12;
  await app.refresh();
  assert.match(view.status.textContent, /vertrauenswürdig/);
  assert.match(view.checkins.textContent, /^12 /);
  assert.equal(app.ids.get('attempts').querySelector('details'), attempt);
  assert.equal(attempt.open, true);
  assert.equal(app.ids.get('progress-list').scrollTop, 160);
  data.issuers[0].trusted = false;
  await app.refresh();
  assert.match(view.status.textContent, /nicht vertraut/);
  assert.equal(app.ids.get('checkin-count').textContent, '928');
  data.issuers[0].proofVerified = false;
  await app.refresh();
  assert.match(view.status.textContent, /Schlüsselbeweis fehlt/);
  data.issuers = [];
  data.stats.registered = 0;
  data.stats.checkins = 0;
  data.attempts = [];
  await app.refresh();
  assert.equal(app.ui.issuerViews.size, 0);
  assert.equal(app.ids.get('issuer-empty').hidden, false);
  assert.equal(app.ids.get('issuer-no-match').hidden, true);
  assert.equal(app.ids.get('checkin-count').textContent, '0');
  assert.equal(app.ids.get('kiosk-result').hidden, true);
});

test('Kiosk renders all eight verifier steps without counting rejected attempts as successful check-ins', async () => {
  const data = fixture(20);
  data.stats.checkins = 12;
  data.attempts[0].steps = [
    ...Array.from({ length: 7 }, (_, index) => `Prüfschritt ${index + 1}`),
    'Signierter Credential-Status gültig',
  ];
  data.attempts.push({
    ...data.attempts[0], id: 'rejected-attempt-1234', status: 'error',
    steps: data.attempts[0].steps.slice(0, 7),
    error: 'Der Ausweis wurde widerrufen.', failedAt: 'Credential-Status',
  });
  const app = surface('kiosk', data);
  await app.start();
  assert.equal(app.ids.get('registered-count').textContent, '20');
  assert.equal(app.ids.get('checkin-count').textContent, '12');
  const attempts = app.ids.get('attempts');
  assert.equal(attempts.children.length, 2);
  const checks = attempts.children[0].querySelector('ol');
  assert.equal(checks.children.length, 8);
  assert.match(checks.children[7].textContent, /Signierter Credential-Status gültig/);
  assert.match(attempts.children[1].textContent, /widerrufen/);
  assert.match(attempts.children[1].textContent, /Abgelehnt/);
  data.attempts.unshift({
    ...data.attempts[1], id: 'another-rejected-attempt',
  });
  await app.refresh();
  assert.equal(attempts.children.length, 3);
  assert.equal(app.ids.get('checkin-count').textContent, '12');
});
