import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { createApp } from '../server/app.js';

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
  focus() { this.document.activeElement = this; }
  select() { this.selectionStart = 0; this.selectionEnd = this.value.length; }
}

function issuer(index, overrides = {}) {
  return {
    id: `org-${index}`, did: `did:example:issuer-${index}`, name: `Organisation ${index}`,
    state: 'pending', trusted: false,
    proofVerified: true, fingerprint: `KEY-${index}`, checkinCount: index % 3,
    publicUrl: 'https://workshop.example.org',
    statusListUrl: `https://workshop.example.org/api/organisations/org-${index}/status`,
    createdAt: '2026-11-12T10:00:00Z', approvedAt: null, ...overrides,
  };
}

function fixture(count = 180) {
  return {
    stats: { registered: count, checkins: 928 },
    issuers: Array.from({ length: count }, (_, index) => issuer(index)),
    attempts: [{
      id: 'attempt-12345678', name: 'Demo-Person', issuerName: 'Organisation 0',
      status: 'done', identityVerified: true, steps: ['Signatur geprüft'],
      time: '2026-11-12T12:00:00Z',
    }],
  };
}

function kioskFeed(data = fixture(), people = []) {
  const config = {
    publicUrl: 'https://workshop.example.org',
    issuerSetupUrl: 'https://workshop.example.org/issuer.html',
    issuerSetupQrDataUrl: 'data:image/png;base64,ORGANISATION_SETUP',
  };
  const feed = { calls: [], failures: new Map(), qrCount: 0, requestStatus: 'pending', data, people, config };
  feed.api = async (route, options) => {
    feed.calls.push({ route, options });
    if (feed.failures.has(route)) throw feed.failures.get(route);
    if (route === '/config') return config;
    if (route === '/dashboard') return feed.data;
    if (route === '/attendees') return feed.people;
    if (route === '/requests') {
      const id = `qr-${++feed.qrCount}`;
      return { id, qrDataUrl: `data:image/png;base64,${id}`, url: `${config.publicUrl}/wallet.html#req=${id}` };
    }
    if (route.startsWith('/requests/')) return { status: feed.requestStatus };
    throw new Error(`Unexpected API route: ${route}`);
  };
  return feed;
}

function surface(page, initial = fixture()) {
  const ids = new Map([...source(`${page}.html`).matchAll(/id="([^"]+)"/g)]
    .map(([, id]) => [id, new Element()]));
  ids.get('issuer-filter')?.setAttribute('value', 'all');
  const document = {
    createElement(tag) {
      const element = new Element(tag);
      element.document = document;
      return element;
    },
    getElementById: (id) => ids.get(id), querySelectorAll: () => [], activeElement: null,
  };
  for (const element of ids.values()) element.document = document;
  let data = initial;
  let accessOptions;
  const mutations = [];
  const confirmations = [];
  const clipboard = [];
  const timers = new Map();
  const pageListeners = new Map();
  let now = Date.parse('2026-11-12T12:00:00Z');
  let timerId = 0;
  let confirmed = true;
  let adminRequest = async (route, options) => {
    if (route.endsWith('/recovery')) return {
      url: 'https://workshop.example.org/issuer.html#org-access=private-recovery-token',
      expiresAt: '2026-11-12T14:00:00Z',
    };
    const entry = data.issuers.find((entry) => route.includes(encodeURIComponent(entry.did)));
    Object.assign(entry, options.body, { state: options.body.trusted ? 'approved' : 'suspended' });
  };
  const context = createContext({
    Node: Element, document,
    window: {
      addEventListener(name, handler) {
        if (!pageListeners.has(name)) pageListeners.set(name, []);
        pageListeners.get(name).push(handler);
      },
    },
    Date: class extends Date { static now() { return now; } },
    URL, navigator: { clipboard: { async writeText(text) { clipboard.push(text); } } },
    setTimeout(handler, delay = 0) {
      const id = ++timerId;
      timers.set(id, { handler, at: now + delay });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    confirm: (message) => { confirmations.push(message); return confirmed; },
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
          return adminRequest(route, options);
        },
      };
    },
    fetch: async () => ({ ok: true, json: async () => data }),
    AbortController,
  });
  const helpers = source('lib/ui.js').replace(/^import .*;\r?$/gm, '').replace(/^export /gm, '');
  const script = source(`${page}.js`).replace(/^import .*;\r?$/gm, '');
  const bootstrap = page === 'admin' ? '\nrun(async () => {' : '\npoll();';
  assert.ok(script.includes(bootstrap), `${page}: bootstrap boundary exists`);
  runInContext(`${helpers}\n${script.slice(0, script.indexOf(bootstrap))}
    globalThis.surface = { ${page === 'admin' ? 'refresh, filterIssuers, issuerViews'
    : 'dashboard, attendees, applyConfig, poll, stop, pagers'} };`, context);
  return {
    ids, document, ui: context.surface, mutations, confirmations, clipboard, timers,
    async start() { if (page === 'admin') await accessOptions.onUnlock(); else await context.surface.dashboard(); },
    async refresh(next = data) {
      data = next;
      await context.surface[page === 'admin' ? 'refresh' : 'dashboard']();
    },
    lock: () => accessOptions.onLock(),
    setApi: (api) => { context.api = api; },
    setAdmin: (handler) => { adminRequest = handler; },
    setConfirm: (value) => { confirmed = value; },
    setClipboard: (value) => { context.navigator.clipboard = value; },
    async emitPage(name, event = {}) {
      await Promise.all((pageListeners.get(name) || []).map((handler) => handler(event)));
    },
    async advance(ms) {
      const until = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, timer]) => timer.at <= until)
          .sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [id, timer] = next;
        timers.delete(id);
        now = timer.at;
        await timer.handler();
      }
      now = until;
    },
  };
}

test('Both dashboards have exactly the requested aggregate metrics and retain their lists', () => {
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

test('Admin handles 180 organisations without replacing recovery selection, focus, open details or scroll', async () => {
  const data = fixture();
  const app = surface('admin', data);
  await app.start();
  assert.equal(app.ids.get('registered-count').textContent, '180');
  assert.equal(app.ids.get('checkin-count').textContent, '928');
  assert.equal(app.ids.get('issuers').children.length, 180);
  const view = app.ui.issuerViews.get(data.issuers[0].did);
  await view.recover.emit('click');
  const input = view.recoveryLink;
  const link = input.value;
  input.selectionStart = 5;
  input.focus();
  view.node.open = true;
  view.metadata.open = true;
  view.recovery.open = true;
  app.ids.get('issuers').scrollTop = 220;
  data.issuers[1].trusted = true;
  data.issuers[1].state = 'approved';
  data.issuers.push(issuer(180));
  data.stats.registered = 181;
  await app.refresh();
  assert.equal(app.ui.issuerViews.get(data.issuers[0].did), view);
  assert.equal(view.recoveryLink, input);
  assert.equal(app.document.activeElement, input);
  assert.equal(input.value, link);
  assert.equal(input.selectionStart, 5);
  assert.equal(view.node.open, true);
  assert.equal(view.metadata.open, true);
  assert.equal(view.recovery.open, true);
  assert.equal(view.recoveryResult.hidden, false);
  assert.equal(app.ids.get('issuers').scrollTop, 220);
  assert.equal(app.ids.get('issuers').children[0], app.ui.issuerViews.get(issuer(180).did).node);
  data.issuers[0].state = 'approved';
  data.issuers[0].trusted = true;
  data.issuers[0].checkinCount = 9;
  await app.refresh();
  assert.equal(input.value, link);
  assert.match(view.checkins.textContent, /^9 /);
});

test('Admin organisation filters, suspension and removals update in place without credential approval', async () => {
  const data = fixture(3);
  data.issuers[0] = issuer(0, { state: 'approved', trusted: true, checkinCount: 6 });
  data.issuers[2].proofVerified = false;
  const app = surface('admin', data);
  await app.start();
  const trusted = app.ui.issuerViews.get(data.issuers[0].did);
  assert.equal(trusted.status, 'approved');
  assert.equal(app.ui.issuerViews.get(data.issuers[2].did).status, 'pending');
  assert.equal(app.ui.issuerViews.get(data.issuers[2].did).approve.disabled, false);
  app.ids.get('issuer-search').value = 'key-0';
  app.ui.filterIssuers();
  assert.equal(trusted.node.hidden, false);
  assert.equal(app.ui.issuerViews.get(data.issuers[1].did).node.hidden, true);
  app.ids.get('issuer-filter').value = 'approved';
  await trusted.revoke.emit('click');
  assert.equal(app.mutations[0].route, `/issuers/${encodeURIComponent(data.issuers[0].did)}/trust`);
  assert.equal(app.mutations[0].body.trusted, false);
  assert.deepEqual(Object.keys(app.mutations[0].body), ['trusted']);
  assert.equal(trusted.status, 'suspended');
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
  app.ids.get('issuer-filter').value = 'pending';
  app.ui.filterIssuers();
  assert.equal(app.ui.issuerViews.get(data.issuers[1].did).node.hidden, false);
  assert.equal(trusted.node.hidden, true);
});

test('Admin organisation approval sends trusted only and preserves other open recovery controls', async () => {
  const data = fixture(2);
  const app = surface('admin', data);
  await app.start();
  const view = app.ui.issuerViews.get(data.issuers[0].did);
  const other = app.ui.issuerViews.get(data.issuers[1].did);
  other.recovery.open = true;
  view.node.open = true;
  const node = view.node;
  await view.approve.emit('click');
  assert.deepEqual(Object.keys(app.mutations[0].body), ['trusted']);
  assert.equal(app.mutations[0].body.trusted, true);
  assert.equal(view.status, 'approved');
  assert.equal(view.node, node);
  assert.equal(view.node.open, true);
  assert.equal(other.recovery.open, true);
  assert.equal(view.approve.disabled, true);
  assert.equal(view.revoke.disabled, false);
  assert.equal(view.node.querySelector('form'), null);
  await view.approve.emit('click');
  assert.equal(app.mutations.length, 1);
  await view.revoke.emit('click');
  assert.equal(view.status, 'suspended');
  await view.approve.emit('click');
  assert.equal(view.status, 'approved');
  assert.deepEqual(app.mutations.map(({ body }) => body.trusted), [true, false, true]);
});

test('Admin discards late dashboard responses after lock and clears organisation details', async () => {
  const app = surface('admin');
  await app.start();
  const view = app.ui.issuerViews.values().next().value;
  await view.recover.emit('click');
  assert.notEqual(view.recoveryLink.value, '');
  let resolve;
  app.setApi(() => new Promise((done) => { resolve = done; }));
  const pending = app.ui.refresh();
  app.lock();
  resolve(fixture());
  await pending;
  assert.equal(app.ui.issuerViews.size, 0);
  assert.equal(app.ids.get('issuers').children.length, 0);
  assert.equal(view.recoveryLink.value, '');
  assert.equal(view.recoveryResult.hidden, true);
});

test('Kiosk is passive with no click, expansion, search or scrolling dependencies', () => {
  const html = source('kiosk.html');
  const script = source('kiosk.js');
  const css = source('kiosk.css');
  assert.doesNotMatch(html, /<(?:details|summary|button|input|select)\b|tabindex=/);
  assert.doesNotMatch(script, /addEventListener\(['"](?:click|input)|clipboard|\.open\b/);
  assert.doesNotMatch(css, /overflow(?:-[xy])?:\s*(?:auto|scroll)|@keyframes/);
  assert.match(css, /prefers-reduced-motion:\s*reduce/);
  assert.match(css, /grid-template-columns: minmax\(0, 1fr\)/);
  assert.match(html, /href="\/kiosk\.css"/);
  assert.doesNotMatch(html, /href="\/styles\.css"/);
  assert.match(html, /Mehrere Handys können gleichzeitig denselben QR scannen/);
  assert.ok(html.indexOf('id="progress-list"') < html.indexOf('id="attempts"'));
  assert.ok(html.indexOf('id="attempts"') < html.indexOf('id="attendees"'));
});

test('Kiosk uses total visits and bounds 180 organisations while trust, removals and empty states stay live', async () => {
  const data = fixture();
  const app = surface('kiosk', data);
  await app.start();
  assert.equal(app.ids.get('registered-count').textContent, '180');
  assert.equal(app.ids.get('checkin-count').textContent, '928');
  const list = app.ids.get('progress-list');
  assert.equal(list.children.length, 6);
  assert.match(list.children[0].textContent, /Organisation 179/);
  assert.match(app.ids.get('issuer-pages').textContent, /Seite 1\/30 · 1–6 von 180/);
  assert.doesNotMatch(list.textContent, /did:|KEY-|erfolgreiche Check-in/);
  const node = list.children[0];
  await app.refresh();
  assert.equal(list.children[0], node, 'Identical polls preserve the rendered page');
  data.issuers[179].trusted = true;
  data.issuers[179].state = 'approved';
  await app.refresh();
  assert.match(list.children[0].textContent, /Vertraut · freigegeben/);
  data.issuers[179].state = 'suspended';
  await app.refresh();
  assert.match(list.children[0].textContent, /Nicht vertraut · gesperrt/);
  data.issuers[179].state = 'pending';
  await app.refresh();
  assert.match(list.children[0].textContent, /Nicht vertraut · Freigabe fehlt/);
  assert.equal(app.ids.get('checkin-count').textContent, '928');
  data.issuers.pop();
  await app.refresh();
  assert.doesNotMatch(list.textContent, /Organisation 179/);
  data.issuers.push(issuer(180));
  data.stats.registered = 180;
  await app.refresh();
  assert.match(list.children[0].textContent, /Organisation 180/);
  data.issuers = [];
  data.stats.registered = 0;
  data.stats.checkins = 0;
  data.attempts = [];
  await app.refresh();
  assert.match(list.textContent, /Noch keine Organisation registriert/);
  assert.match(app.ids.get('attempts').textContent, /Noch keine Prüfungen/);
  assert.equal(app.ids.get('issuer-pages').textContent, 'Keine Einträge');
  assert.equal(app.ids.get('checkin-count').textContent, '0');
  assert.equal(app.timers.size, 0);
});

test('Kiosk shows verified, unverified, live and failed outcomes without opening details or inflating visits', async () => {
  const data = fixture(20);
  data.stats.checkins = 12;
  data.attempts[0].steps = [
    ...Array.from({ length: 7 }, (_, index) => `Prüfschritt ${index + 1}`),
    'Signierter Credential-Status gültig',
  ];
  data.attempts.push({
    ...data.attempts[0], id: 'rejected-attempt-1234', status: 'error',
    name: 'Behaupteter Name', identityVerified: false,
    steps: data.attempts[0].steps.slice(0, 7),
    error: 'Der Ausweis wurde widerrufen.', failedAt: 'Credential-Status',
  });
  const app = surface('kiosk', data);
  await app.start();
  assert.equal(app.ids.get('registered-count').textContent, '20');
  assert.equal(app.ids.get('checkin-count').textContent, '12');
  const attempts = app.ids.get('attempts');
  assert.equal(attempts.children.length, 2);
  assert.match(attempts.children[0].textContent, /Demo-Person.*Eingecheckt/);
  assert.doesNotMatch(attempts.children[0].textContent, /ungeprüft/);
  assert.match(attempts.children[1].textContent, /widerrufen/);
  assert.match(attempts.children[1].textContent, /Abgelehnt/);
  assert.match(attempts.children[1].textContent, /Behaupteter Name \(ungeprüft\)/);
  assert.match(attempts.children[1].textContent, /Credential-Status/);
  assert.match(attempts.children[1].textContent, /Am Empfang klären, danach erneut scannen/);
  assert.equal(attempts.querySelectorAll('details').length, 0);
  data.attempts.unshift({
    ...data.attempts[1], id: 'processing-attempt', status: 'processing',
    steps: ['Signierter Credential-Status gültig'], error: undefined,
  });
  await app.refresh();
  assert.equal(attempts.children.length, 3);
  assert.match(attempts.children[0].textContent, /Prüfung läuft/);
  assert.match(attempts.children[0].textContent, /Zuletzt geprüft: Signierter Credential-Status gültig/);
  assert.equal(app.ids.get('checkin-count').textContent, '12');
  data.attempts[0].status = 'done';
  await app.refresh();
  assert.match(attempts.children[0].textContent, /Behaupteter Name \(ungeprüft\)/,
    'Only identityVerified true permits a verified name, even for an inconsistent done result');
});

test('Organisation names, public keys and fixed identity replace individual operator assignment', async () => {
  for (const page of ['admin', 'kiosk']) {
    const app = surface(page, fixture(16));
    await app.start();
    if (page === 'admin') {
      const view = app.ui.issuerViews.get(issuer(0).did);
      assert.equal(view.name.textContent, 'Organisation 0');
      assert.equal(view.label.textContent, issuer(0).did);
    } else {
      assert.match(app.ids.get('progress-list').textContent, /Organisation 15/);
      assert.doesNotMatch(app.ids.get('progress-list').textContent, /did:example/);
    }
    assert.doesNotMatch(source(`${page}.js`) + source(`${page}.html`),
      /ownerName|employeeName|issuerOwner|Geprüfter Name der Person|Zuordnung bestätigen|Issuer gehört zu Mitarbeitendem/);
    assert.match(source(`${page}.html`), /Registrierte Organisationen/);
  }
  const app = surface('admin', fixture(16));
  await app.start();
  const view = app.ui.issuerViews.get(issuer(0).did);
  const metadata = JSON.parse(view.metadata.querySelector('pre').textContent);
  assert.equal(metadata.name, 'Organisation 0');
  assert.equal(metadata.did, issuer(0).did);
  assert.equal(metadata.fingerprint, 'KEY-0');
  assert.equal(metadata.publicUrl, issuer(1).publicUrl);
  assert.equal(metadata.state, 'pending');
  assert.equal(metadata.approvedAt, null);
  assert.match(view.identity.textContent, /unveränderlich/);
  assert.equal(view.node.querySelectorAll('input').length, 1, 'Only the readonly recovery link field remains');
  assert.equal(view.recoveryLink.readonly, 'true');
});

test('Host recovery is deliberate, private, expiring, copyable and independent of organisation approval', async () => {
  const app = surface('admin', fixture(14));
  await app.start();
  const view = app.ui.issuerViews.get(issuer(0).did);
  assert.equal(view.recoveryResult.hidden, true);
  app.setConfirm(false);
  await view.recover.emit('click');
  await view.approve.emit('click');
  assert.equal(app.mutations.length, 0);
  app.setConfirm(true);
  await view.recover.emit('click');
  assert.equal(app.mutations[0].route, '/organisations/org-0/recovery');
  assert.deepEqual(Object.keys(app.mutations[0].body), []);
  assert.equal(view.status, 'pending');
  assert.equal(view.recoveryResult.hidden, false);
  assert.match(view.recoveryLink.value, /\/issuer\.html#org-access=/);
  assert.match(view.recoveryExpiry.textContent, /Gültig bis.*nur einmal/);
  assert.match(view.recovery.textContent, /Erfolgreiches Einlösen widerruft den bisherigen Browserzugang/);
  assert.match(view.recoveryResult.textContent, /Nicht veröffentlichen, nicht am Kiosk zeigen/);
  assert.match(view.recoveryResult.textContent, /kein Host-Admin-Token/);
  assert.match(app.confirmations[0], /erfolgreich geöffnet und eingelöst/);
  await view.copyRecovery.emit('click');
  assert.deepEqual(app.clipboard, [view.recoveryLink.value]);
  app.setClipboard(undefined);
  await view.copyRecovery.emit('click');
  assert.match(app.ids.get('error').textContent, /manuell/);
  assert.equal(view.recoveryResult.hidden, false, 'Manual fallback remains visible');
});

test('Recovery errors are visible and a late private response cannot repopulate a locked admin page', async () => {
  const app = surface('admin', fixture(12));
  await app.start();
  const view = app.ui.issuerViews.get(issuer(0).did);
  app.setAdmin(async () => { throw new Error('Zugriff verweigert'); });
  await view.recover.emit('click');
  assert.match(app.ids.get('error').textContent, /Zugriff verweigert/);
  assert.equal(view.recoveryResult.hidden, true);
  assert.equal(view.recover.disabled, false);
  app.setAdmin(async () => ({ url: 'missing-expiry' }));
  await view.recover.emit('click');
  assert.match(app.ids.get('error').textContent, /keinen gültigen Wiederherstellungslink/);
  let resolve;
  app.setAdmin(() => new Promise((done) => { resolve = done; }));
  const pending = view.recover.emit('click');
  assert.equal(view.recover.disabled, true);
  app.lock();
  resolve({ url: 'https://workshop.example.org/issuer.html#org-access=late', expiresAt: '2026-11-12T14:00:00Z' });
  await pending;
  assert.equal(app.ui.issuerViews.size, 0);
  assert.equal(view.recoveryLink.value, '');
  assert.equal(app.ids.get('issuers').children.length, 0);
});

test('Failed approval reports its error, preserves pending state and enables an explicit retry', async () => {
  const app = surface('admin', fixture(12));
  await app.start();
  const view = app.ui.issuerViews.get(issuer(0).did);
  app.setAdmin(async () => { throw new Error('Freigabe nicht gespeichert'); });
  await view.approve.emit('click');
  assert.match(app.ids.get('error').textContent, /Freigabe nicht gespeichert/);
  assert.equal(view.status, 'pending');
  assert.equal(view.approve.disabled, false);
  assert.equal(view.revoke.disabled, true);
  assert.equal(app.ids.get('notice').textContent, '');
});

test('Kiosk secondary QR is public organisation setup with a visible laptop URL and no copy control', () => {
  const app = surface('kiosk', fixture(12));
  const config = {
    publicUrl: 'https://workshop.example.org',
    startQrDataUrl: 'data:image/png;base64,WALLET_HOME',
    issuerSetupUrl: 'https://workshop.example.org/issuer.html',
    issuerSetupQrDataUrl: 'data:image/png;base64,ORGANISATION_SETUP',
  };
  app.ui.applyConfig(config);
  assert.equal(app.ids.get('issuer-setup-qr').src, config.issuerSetupQrDataUrl);
  assert.equal(app.ids.get('issuer-setup-qr').hidden, false);
  assert.equal(app.ids.get('issuer-setup-link').href, config.issuerSetupUrl);
  assert.equal(app.ids.get('issuer-setup-link').textContent, config.issuerSetupUrl);
  assert.equal(app.ids.has('copy-issuer-setup'), false);
  const html = source('kiosk.html');
  assert.ok(html.indexOf('id="checkin-qr"') < html.indexOf('id="issuer-setup-qr"'));
  assert.match(html, /id="checkin-qr" width="640" height="640"/);
  assert.match(html, /id="issuer-setup-qr" width="112" height="112"/);
  assert.match(html, /Organisation einrichten · am Laptop/);
  assert.match(html, /Danach den Ausweisangebots-QR mit dem Handy scannen/);
  assert.doesNotMatch(source('kiosk.js'), /startQrDataUrl|managementAccess|admin-token|org-access/);
  assert.match(html, /<li>Wallet\/PWA öffnen<\/li>/);
  assert.match(html, /„QR-Code scannen“ wählen/);
  assert.doesNotMatch(html, /id="start-qr"/);
  for (const privateUrl of [
    `${config.issuerSetupUrl}#org-access=private`,
    `${config.issuerSetupUrl}#admin-token=host`,
    'https://another.example.org/issuer.html',
    `${config.publicUrl}/wallet.html`,
  ]) {
    assert.throws(() => app.ui.applyConfig({ ...config, issuerSetupUrl: privateUrl }), /ungültige Adresse/);
  }
  assert.throws(() => app.ui.applyConfig({ publicUrl: config.publicUrl }), /Organisationseinrichtung fehlt/);
});

test('Kiosk attendees stay a compact private summary, independent of current organisational trust', async () => {
  const data = fixture(12);
  const app = surface('kiosk', data);
  await app.start();
  const checkin = {
    credentialType: 'EmployeeCredential', credentialId: 'credential-1234567890',
    issuerName: 'Organisation 0', issuerDid: issuer(0).did,
    holderDid: 'did:example:holder-1',
    claims: { given_name: 'Demo', family_name: 'Gast', role: 'UNDISCLOSED_SENTINEL' },
    time: '2026-11-12T13:00:00Z', trustedAtCheckin: true,
  };
  const people = [{
    name: 'Demo Gast', issuerName: 'Organisation 0', holderDid: checkin.holderDid,
    time: checkin.time, checkins: [checkin, { ...checkin, time: '2026-11-12T13:05:00Z' }],
  }];
  app.setApi(async () => people);
  await app.ui.attendees();
  const list = app.ids.get('attendees');
  assert.match(list.textContent, /Demo Gast/);
  assert.equal(list.querySelectorAll('time').length, 1);
  assert.doesNotMatch(list.textContent, /Organisation 0|did:|credential-|UNDISCLOSED_SENTINEL|Check-in\(s\)/);
  assert.equal(list.querySelectorAll('pre').length, 0);
  assert.equal(list.querySelectorAll('details').length, 0);
  const person = list.children[0];
  await app.ui.attendees();
  assert.equal(list.children[0], person);
  data.issuers[0].state = 'suspended';
  app.setApi(async () => data);
  await app.refresh();
  assert.equal(list.children[0], person);
  app.setApi(async () => []);
  await app.ui.attendees();
  assert.match(list.textContent, /Noch niemand eingecheckt/);
});

test('Kiosk automatically surfaces all 180 organisations, 100 attempts and 90 guests with bounded DOM', async () => {
  const data = fixture();
  data.attempts = Array.from({ length: 100 }, (_, index) => ({
    ...data.attempts[0], id: `attempt-${index}`, name: `Gast ${index}`,
  }));
  const people = Array.from({ length: 90 }, (_, index) => ({
    holderDid: `did:example:guest-${index}`, name: `Person ${index}`, time: data.attempts[0].time,
  }));
  const app = surface('kiosk', data);
  app.setApi(kioskFeed(data, people).api);
  await app.start();
  await app.ui.attendees();
  const seen = { 'progress-list': new Set(), attempts: new Set(), attendees: new Set() };
  for (let page = 0; page < 34; page += 1) {
    for (const [id, limit] of [['progress-list', 6], ['attempts', 3], ['attendees', 3]]) {
      const list = app.ids.get(id);
      assert.ok(list.children.length <= limit);
      assert.equal(list.querySelectorAll('details').length, 0);
      for (const name of list.querySelectorAll('strong')) seen[id].add(name.textContent);
    }
    assert.equal(app.timers.size, 1, 'A single paging timer serves every list');
    await app.advance(12000);
  }
  assert.equal(seen['progress-list'].size, 180);
  assert.equal(seen.attempts.size, 100);
  assert.equal(seen.attendees.size, 90);
  assert.equal(app.ui.pagers.attempts.page, 0);
  await app.advance(26 * 12000);
  assert.equal(app.ui.pagers.issuers.page, 0);
  assert.match(app.ids.get('issuer-pages').textContent, /Seite 1\/30/);
});

test('Kiosk identical polls preserve page dwell and DOM; new concurrent scans immediately surface', async () => {
  const data = fixture(18);
  data.attempts = Array.from({ length: 20 }, (_, index) => ({
    ...data.attempts[0], id: `attempt-${index}`, name: `Gast ${index}`,
  }));
  const app = surface('kiosk', data);
  await app.start();
  await app.advance(12000);
  assert.equal(app.ui.pagers.issuers.page, 1);
  assert.equal(app.ui.pagers.attempts.page, 1);
  const organisation = app.ids.get('progress-list').children[0];
  const attempt = app.ids.get('attempts').children[0];
  const deadline = app.ui.pagers.attempts.nextAt;
  for (let poll = 0; poll < 7; poll += 1) {
    await app.advance(1500);
    await app.refresh(JSON.parse(JSON.stringify(data)));
    assert.equal(app.ui.pagers.attempts.page, 1);
    assert.equal(app.ui.pagers.attempts.nextAt, deadline);
    assert.equal(app.ids.get('progress-list').children[0], organisation);
    assert.equal(app.ids.get('attempts').children[0], attempt);
  }
  data.issuers[0].checkinCount = 99;
  await app.refresh(data);
  assert.equal(app.ids.get('progress-list').children[0], organisation, 'Hidden metadata does not rebuild the TV');
  await app.advance(1500);
  assert.equal(app.ui.pagers.attempts.page, 2);
  data.attempts.unshift(...Array.from({ length: 3 }, (_, index) => ({
    ...data.attempts[0], id: `concurrent-${index}`, name: `Neuer Scan ${index}`,
    status: 'processing', identityVerified: false,
  })));
  await app.refresh();
  assert.equal(app.ui.pagers.attempts.page, 0);
  for (let index = 0; index < 3; index += 1) {
    assert.match(app.ids.get('attempts').children[index].textContent, new RegExp(`Neuer Scan ${index} \\(ungeprüft\\)`));
  }
  assert.equal(app.ui.pagers.issuers.page, 2, 'Scans do not reset organisation paging');
  assert.equal(app.ids.get('checkin-count').textContent, '928');
  data.stats.checkins += 3;
  for (const attempt of data.attempts.slice(0, 3)) {
    attempt.status = 'done';
    attempt.identityVerified = true;
  }
  await app.refresh();
  assert.equal(app.ids.get('checkin-count').textContent, '931');
  assert.doesNotMatch(app.ids.get('attempts').textContent, /Neuer Scan \d \(ungeprüft\)/);
});

test('Kiosk errors preserve data, report staleness and recover automatically without blocking other sections', async () => {
  const app = surface('kiosk', fixture(18));
  const feed = kioskFeed(fixture(18), [{ name: 'Gast', time: '2026-11-12T12:00:00Z' }]);
  app.setApi(feed.api);
  await app.ui.poll();
  const organisation = app.ids.get('progress-list').children[0];
  const person = app.ids.get('attendees').children[0];
  feed.failures.set('/dashboard', new Error('Dashboard nicht erreichbar.'));
  feed.failures.set('/attendees', new Error('Gäste nicht erreichbar.'));
  await app.advance(1500);
  assert.equal(app.ids.get('progress-list').children[0], organisation);
  assert.equal(app.ids.get('attendees').children[0], person);
  assert.match(app.ids.get('dashboard-error').textContent, /Dashboard nicht erreichbar.*veraltet.*Automatischer neuer Versuch/);
  assert.match(app.ids.get('attendees-error').textContent, /Gäste nicht erreichbar.*Host informieren/);
  assert.equal(app.ids.get('checkin-qr').hidden, false, 'Dashboard failures do not remove a working QR');
  feed.failures.delete('/attendees');
  await app.advance(1500);
  assert.equal(app.ids.get('attendees-error').hidden, true);
  assert.equal(app.ids.get('dashboard-error').hidden, false, 'An unrelated successful response does not clear errors');
  feed.failures.clear();
  feed.failures.set('/requests/qr-1', new Error('QR-Verbindung unterbrochen.'));
  await app.advance(1500);
  assert.equal(app.ids.get('dashboard-error').hidden, true);
  assert.match(app.ids.get('error').textContent, /QR-Verbindung unterbrochen.*Automatischer neuer Versuch/);
  assert.equal(app.ids.get('checkin-qr').hidden, true, 'An unconfirmed stale QR is not offered for scanning');
  assert.equal(app.ids.get('qr-loading').hidden, false);
  feed.failures.clear();
  await app.advance(1500);
  assert.equal(app.ids.get('error').hidden, true);
  assert.equal(app.ids.get('checkin-qr').hidden, false);
  assert.equal(app.ids.get('attendees').children[0], person);
});

test('Kiosk initial failures are visible instead of false empty lists; configuration retries independently', async () => {
  const app = surface('kiosk');
  const feed = kioskFeed(fixture(0));
  for (const route of ['/config', '/dashboard', '/attendees']) {
    feed.failures.set(route, new Error('Verbindung fehlt.'));
  }
  app.setApi(feed.api);
  await app.ui.poll();
  for (const id of ['error', 'dashboard-error', 'attendees-error']) {
    assert.equal(app.ids.get(id).hidden, false);
    assert.match(app.ids.get(id).textContent, /Verbindung fehlt.*Automatischer neuer Versuch/);
  }
  assert.notEqual(app.ui.pagers.issuers.signature, '[]', 'Failure is not interpreted as an empty successful result');
  feed.failures.clear();
  await app.advance(1500);
  assert.equal(app.ids.get('issuer-setup-link').textContent, feed.config.issuerSetupUrl);
  assert.equal(app.ids.get('checkin-qr').hidden, false);
  assert.match(app.ids.get('progress-list').textContent, /Noch keine Organisation registriert/);
});

test('Kiosk QR renews on expiry or missing request without rotating after each successful visitor', async () => {
  const app = surface('kiosk', fixture(0));
  const feed = kioskFeed(fixture(0));
  app.setApi(feed.api);
  await app.ui.poll();
  assert.equal(feed.qrCount, 1);
  feed.requestStatus = 'done';
  await app.advance(1500);
  assert.equal(feed.qrCount, 1);
  feed.requestStatus = 'expired';
  await app.advance(1500);
  assert.equal(feed.qrCount, 2);
  assert.match(app.ids.get('checkin-link').href, /#req=qr-2$/);
  feed.requestStatus = 'pending';
  feed.failures.set('/requests/qr-2', Object.assign(new Error('Nicht gefunden'), { status: 404 }));
  await app.advance(1500);
  assert.equal(feed.qrCount, 3);
  assert.match(app.ids.get('checkin-qr').src, /qr-3$/);
  const creation = feed.calls.filter(({ route }) => route === '/requests');
  assert.ok(creation.every(({ options }) => options.body.mode === 'kiosk'));
  assert.doesNotMatch(JSON.stringify(feed.calls), /adminToken|offerToken|same-origin|org-access/);
});

test('Kiosk does not render extra claims, raw tokens, keys or proof metadata supplied by APIs', async () => {
  const data = fixture(2);
  data.issuers[1].fingerprint = 'PRIVATE_PROOF_SENTINEL';
  Object.assign(data.attempts[0], {
    identityVerified: false, name: '<img src=x onerror=alert(1)>',
    claims: { role: 'UNDISCLOSED_SENTINEL' }, jwt: 'eyJ.FULL_JWT_SENTINEL.signature',
  });
  const people = [{
    name: 'Demo Gast', time: data.attempts[0].time,
    holderDid: 'did:example:SECRET_HOLDER_SENTINEL',
    claims: { role: 'UNDISCLOSED_SENTINEL' }, checkins: [data.attempts[0]],
  }];
  const app = surface('kiosk', data);
  app.setApi(kioskFeed(data, people).api);
  await app.start();
  await app.ui.attendees();
  const text = ['progress-list', 'attempts', 'attendees'].map((id) => app.ids.get(id).textContent).join('\n');
  assert.doesNotMatch(text, /PRIVATE_PROOF_SENTINEL|UNDISCLOSED_SENTINEL|FULL_JWT_SENTINEL|SECRET_HOLDER_SENTINEL/);
  assert.match(app.ids.get('attempts').textContent, /<img src=x onerror=alert\(1\)> \(ungeprüft\)/);
  assert.equal(app.ids.get('attempts').querySelectorAll('img').length, 0, 'Untrusted names remain text, never HTML');
});

test('Kiosk pagehide disposes poll and paging timers permanently, including queued callbacks and BFCache restoration', async () => {
  const app = surface('kiosk', fixture(18));
  const feed = kioskFeed(fixture(18));
  app.setApi(feed.api);
  await app.ui.poll();
  assert.equal(app.timers.size, 2);
  const queued = [...app.timers.values()].map(({ handler }) => handler);
  const calls = feed.calls.length;
  await app.emitPage('pagehide');
  assert.equal(app.timers.size, 0);
  await app.emitPage('pageshow', { persisted: true });
  assert.match(app.ids.get('notice').textContent, /Live-Anzeige angehalten.*neu laden/);
  for (const handler of queued) await handler();
  await app.ui.poll();
  await app.advance(60000);
  assert.equal(feed.calls.length, calls);
  assert.equal(app.timers.size, 0);
  assert.equal(app.ui.pagers.issuers.page, 0);
});

test('Kiosk ignores in-flight configuration, dashboard, attendee and QR creation responses after pagehide', async () => {
  for (const delayedRoute of ['/config', '/dashboard', '/attendees', '/requests']) {
    const app = surface('kiosk', fixture(18));
    const feed = kioskFeed(fixture(18), [{ name: 'Late Guest', time: '2026-11-12T12:00:00Z' }]);
    if (delayedRoute !== '/config') app.ui.applyConfig(feed.config);
    let resolve;
    app.setApi((route, options) => route === delayedRoute
      ? new Promise((done) => { resolve = () => done(feed.api(route, options)); })
      : feed.api(route, options));
    const pending = app.ui.poll();
    assert.ok(resolve, `${delayedRoute}: request started`);
    await app.emitPage('pagehide');
    const before = [...app.ids.values()].map((node) => [node.textContent, node.src, node.href]);
    resolve();
    await pending;
    assert.deepEqual([...app.ids.values()].map((node) => [node.textContent, node.src, node.href]), before,
      `${delayedRoute}: stopped UI remains untouched`);
    assert.equal(app.timers.size, 0);
  }
});

test('Real central app feeds both dashboards and accepts the host approval and recovery controls', async () => {
  const dataDirectory = await mkdtemp(join(process.cwd(), '.dashboard-ui-'));
  let server;
  try {
    const publicUrl = 'https://workshop.example.org';
    const { app, adminToken } = await createApp({ publicUrl, dataDirectory });
    await new Promise((resolve, reject) => {
      server = app.listen(0, '127.0.0.1', resolve);
      server.once('error', reject);
    });
    const base = `http://127.0.0.1:${server.address().port}/api`;
    async function request(route, { body, cookie, host = false, status = 200 } = {}) {
      const response = await fetch(`${base}${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(host ? { 'X-Admin-Token': adminToken } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const data = await response.json();
      assert.equal(response.status, status, `${route}: ${data.error || response.status}`);
      return { data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
    }
    const config = (await request('/config')).data;
    assert.equal(config.issuerSetupUrl, `${publicUrl}/issuer.html`);
    assert.match(config.issuerSetupQrDataUrl, /^data:image\/png;base64,/);
    let first;
    for (let index = 0; index < 14; index += 1) {
      const registered = await request('/organisations', { body: { name: `Organisation ${index}` }, status: 201 });
      first ||= registered;
    }
    const initial = (await request('/dashboard')).data;
    assert.deepEqual(initial.stats, { registered: 14, checkins: 0 });
    assert.ok(initial.issuers.every((org) => org.state === 'pending' && org.publicUrl === publicUrl));
    assert.equal(new Set(initial.issuers.map((org) => org.did)).size, 14);
    assert.ok(initial.issuers.every((org) => org.statusListUrl === `${publicUrl}/api/status-lists/${org.id}`));
    await request('/admin/session', { status: 401 });
    await request('/admin/session', { host: true });
    const host = surface('admin', initial);
    host.setApi(async (route) => (await request(route)).data);
    host.setAdmin(async (route, { body }) => (await request(`/admin${route}`, { body, host: true })).data);
    await host.start();
    const kiosk = surface('kiosk', initial);
    kiosk.setApi(async (route) => (await request(route)).data);
    kiosk.ui.applyConfig(config);
    await kiosk.start();
    assert.equal(host.ids.get('issuers').children.length, 14);
    assert.equal(kiosk.ids.get('progress-list').children.length, 6);
    const organisation = first.data.organisation;
    const view = host.ui.issuerViews.get(organisation.did);
    view.node.open = true;
    await view.approve.emit('click');
    assert.equal(view.status, 'approved');
    await kiosk.refresh();
    assert.equal(kiosk.ui.pagers.issuers.items.find((item) => item.key === organisation.did).state, 'approved');
    await view.revoke.emit('click');
    assert.equal(view.status, 'suspended');
    await kiosk.refresh();
    assert.equal(kiosk.ui.pagers.issuers.items.find((item) => item.key === organisation.did).state, 'suspended');
    await view.approve.emit('click');
    await request(`/admin/organisations/${organisation.id}/recovery`, { body: {}, status: 401 });
    await view.recover.emit('click');
    assert.equal(view.recoveryResult.hidden, false);
    const recovery = new URL(view.recoveryLink.value);
    assert.equal(recovery.origin, publicUrl);
    assert.equal(recovery.pathname, '/issuer.html');
    const token = new URLSearchParams(recovery.hash.slice(1)).get('org-access');
    assert.ok(token);
    await request('/issuer/credentials', { cookie: first.cookie });
    const recovered = await request('/issuer/recover', { body: { token } });
    assert.equal(recovered.data.organisation.id, organisation.id);
    assert.equal(recovered.data.organisation.name, organisation.name);
    assert.equal(recovered.data.organisation.did, organisation.did);
    assert.equal(recovered.data.organisation.state, 'approved');
    await request('/issuer/credentials', { cookie: first.cookie, status: 401 });
    await request('/issuer/credentials', { cookie: recovered.cookie });
    await request('/issuer/recover', { body: { token }, status: 410 });
    await host.refresh();
    assert.equal(view.node.open, true);
    assert.equal(view.name.textContent, organisation.name);
    assert.equal(view.recoveryResult.hidden, false);
    assert.deepEqual((await request('/dashboard')).data.stats, { registered: 14, checkins: 0 });
  } finally {
    if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
