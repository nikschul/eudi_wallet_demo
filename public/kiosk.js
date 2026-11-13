import { el, api, formatTime } from './lib/ui.js';

const PAGE_MS = 12000;
const POLL_MS = 1500;
let current;
let config;
let stopped = false;
let pollTimer;
let pageTimer;

function message(id, text = '') {
  const box = document.getElementById(id);
  box.textContent = text;
  box.hidden = !text;
}

function pager(listId, indicatorId, size, renderItem, empty) {
  return {
    items: [], page: 0, nextAt: 0, signature: null, rendered: null,
    set(items) {
      const signature = JSON.stringify(items);
      if (signature === this.signature) return;
      const previous = new Set(this.items.map((item) => item.key));
      const fresh = items.some((item) => !previous.has(item.key))
        || items[0]?.key !== this.items[0]?.key;
      this.items = items;
      this.signature = signature;
      if (fresh) {
        this.page = 0;
        this.nextAt = Date.now() + PAGE_MS;
      }
      this.page = Math.min(this.page, Math.max(0, Math.ceil(items.length / size) - 1));
      this.render();
      schedulePages();
    },
    render() {
      const start = this.page * size;
      const visible = this.items.slice(start, start + size);
      const signature = JSON.stringify([this.page, visible, this.items.length]);
      if (signature === this.rendered) return;
      this.rendered = signature;
      document.getElementById(listId).replaceChildren(...visible.length
        ? visible.map(renderItem) : [el('li', { class: 'empty muted' }, empty)]);
      document.getElementById(indicatorId).textContent = this.items.length
        ? `Seite ${this.page + 1}/${Math.ceil(this.items.length / size)} · ${start + 1}–${start + visible.length} von ${this.items.length}${this.items.length > size ? ' · Wechsel alle 12 s' : ''}`
        : 'Keine Einträge';
    },
    advance(now) {
      if (this.items.length <= size || now < this.nextAt) return;
      this.page = (this.page + 1) % Math.ceil(this.items.length / size);
      this.nextAt = now + PAGE_MS;
      this.render();
    },
    get paged() { return this.items.length > size; },
  };
}

function issuerRow(issuer) {
  const state = {
    approved: ['trusted', 'Vertraut · freigegeben'],
    pending: ['pending', 'Nicht vertraut · Freigabe fehlt'],
    suspended: ['suspended', 'Nicht vertraut · gesperrt'],
  }[issuer.state] || ['pending', 'Vertrauen unbekannt · Host fragen'];
  return el('li', { class: `issuer-row ${state[0]}` },
    el('strong', {}, issuer.name), el('span', { class: 'issuer-state' }, state[1]));
}

function attemptRow(attempt) {
  const done = attempt.status === 'done';
  const processing = attempt.status === 'processing';
  const state = done ? 'Eingecheckt' : processing ? 'Prüfung läuft' : 'Abgelehnt';
  const detail = processing
    ? (attempt.step ? `Zuletzt geprüft: ${attempt.step} · Prüfung läuft weiter.` : 'Signatur, Vertrauen und Wallet-Bindung werden geprüft.')
    : done ? 'Nachweis akzeptiert · erfolgreicher Besuch gespeichert.'
      : `${attempt.failedAt ? `${attempt.failedAt}: ` : ''}${attempt.error || 'Prüfung fehlgeschlagen.'} Beim Check-In klären, danach erneut scannen.`;
  return el('li', { class: `attempt-row ${attempt.status}` },
    el('div', { class: 'attempt-heading' },
      el('strong', {}, `${attempt.name}${attempt.identityVerified === true ? '' : ' (ungeprüft)'}`),
      el('span', { class: 'badge' }, state)),
    el('p', { class: 'attempt-meta muted' }, `${attempt.identityVerified === true ? '' : 'Name ungeprüft · '}${formatTime(attempt.time)} · ${attempt.issuerName} · ${attempt.key.slice(0, 8)}`),
    el('p', { class: 'attempt-outcome' }, detail));
}

const pagers = {
  issuers: pager('progress-list', 'issuer-pages', 6, issuerRow, 'Noch keine Organisation registriert.'),
  attempts: pager('attempts', 'attempt-pages', 3, attemptRow, 'Noch keine Prüfungen seit Serverstart. Jetzt den Check-In-QR scannen.'),
  attendees: pager('attendees', 'attendee-pages', 3, (person) =>
    el('li', {}, el('strong', {}, person.name), el('time', { datetime: person.time }, formatTime(person.time))),
  'Noch niemand eingecheckt.'),
};

function schedulePages() {
  clearTimeout(pageTimer);
  if (stopped) return;
  const active = Object.values(pagers).filter((page) => page.paged);
  if (!active.length) return;
  pageTimer = setTimeout(() => {
    if (stopped) return;
    for (const page of active) page.advance(Date.now());
    schedulePages();
  }, Math.max(0, Math.min(...active.map((page) => page.nextAt)) - Date.now()));
}

async function newQr() {
  const request = await api('/requests', { body: { mode: 'kiosk' } });
  if (stopped) return;
  current = request.id;
  const image = document.getElementById('checkin-qr');
  image.src = request.qrDataUrl;
  document.getElementById('checkin-link').href = request.url;
}

function applyConfig(value) {
  if (stopped) return;
  const expected = new URL('/issuer.html', value.publicUrl).href;
  if (value.issuerSetupUrl !== expected || !value.issuerSetupQrDataUrl) {
    throw new Error('Die öffentliche Organisationseinrichtung fehlt oder hat eine ungültige Adresse. Bitte den Host informieren.');
  }
  document.getElementById('issuer-setup-qr').src = value.issuerSetupQrDataUrl;
  document.getElementById('issuer-setup-qr').hidden = false;
  document.getElementById('issuer-setup-link').href = value.issuerSetupUrl;
  document.getElementById('issuer-setup-link').textContent = 'Organisation anlegen ↗';
  document.getElementById('wallet-start').href = new URL('/wallet.html', value.publicUrl).href;
  config = value;
}

async function refreshQr() {
  if (!config) {
    const value = await api('/config');
    if (stopped) return;
    applyConfig(value);
    for (const title of document.querySelectorAll('[data-event-title]')) title.textContent = value.eventTitle;
  }
  if (stopped) return;
  if (!current) await newQr();
  if (stopped) return;
  try {
    const request = await api(`/requests/${current}`);
    if (stopped) return;
    if (request.status === 'expired') await newQr();
  } catch (error) {
    if (stopped) return;
    if (error.status !== 404) throw error;
    await newQr();
  }
  if (stopped) return;
  document.getElementById('checkin-qr').hidden = false;
  document.getElementById('checkin-link').hidden = false;
  document.getElementById('qr-loading').hidden = true;
}

async function dashboard() {
  const data = await api('/dashboard');
  if (stopped) return;
  for (const [id, value] of [['registered-count', data.stats.registered], ['checkin-count', data.stats.checkins]]) {
    const node = document.getElementById(id);
    if (node.textContent !== String(value)) node.textContent = value;
  }
  pagers.issuers.set([...data.issuers].reverse().map((issuer) => ({
    key: issuer.did, name: issuer.name, state: issuer.state,
  })));
  pagers.attempts.set(data.attempts.map((attempt) => ({
    key: attempt.id, name: attempt.name, identityVerified: attempt.identityVerified,
    status: attempt.status, issuerName: attempt.issuerName, time: attempt.time,
    step: attempt.steps?.at(-1), error: attempt.error, failedAt: attempt.failedAt,
  })));
}

async function attendees() {
  const people = await api('/attendees');
  if (stopped) return;
  pagers.attendees.set(people.map((person) => ({
    key: person.holderDid || person.name, name: person.name, time: person.time,
  })));
}

async function refreshSection(work, errorId) {
  try {
    await work();
    if (!stopped) message(errorId);
  } catch (error) {
    if (stopped) return;
    message(errorId, `${error.message || 'Daten konnten nicht geladen werden.'} Anzeige möglicherweise veraltet. Automatischer neuer Versuch; bei anhaltenden Fehlern den Host informieren.`);
    if (errorId === 'error') {
      document.getElementById('checkin-qr').hidden = true;
      document.getElementById('checkin-link').hidden = true;
      const loading = document.getElementById('qr-loading');
      loading.textContent = 'Check-In-QR nicht verfügbar · Wiederverbindung läuft …';
      loading.hidden = false;
    }
  }
}

async function poll() {
  if (stopped) return;
  await Promise.all([
    refreshSection(refreshQr, 'error'),
    refreshSection(dashboard, 'dashboard-error'),
    refreshSection(attendees, 'attendees-error'),
  ]);
  if (!stopped) pollTimer = setTimeout(poll, POLL_MS);
}

function stop() {
  stopped = true;
  clearTimeout(pollTimer);
  clearTimeout(pageTimer);
}

window.addEventListener('pagehide', stop);
window.addEventListener('pageshow', (event) => {
  if (event.persisted && stopped) message('notice', 'Live-Anzeige angehalten. Host: diese Seite neu laden.');
});
if ('serviceWorker' in navigator && globalThis.isSecureContext) {
  navigator.serviceWorker.register('/sw.js').catch(() => {
    if (!stopped) message('notice', 'Offline-Modus nicht verfügbar. Die Live-Anzeige benötigt eine Verbindung. Bei anhaltenden Fehlern den Host informieren.');
  });
}
poll();
