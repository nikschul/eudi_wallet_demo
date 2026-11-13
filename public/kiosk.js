import { el, api, steps, labels, attributes, raw, formatTime, action, notify, run, setupPage, showError, clearError } from './lib/ui.js';

let current = null;
let creating = false;
let config;
let stopped = false;
let lastAttendees;
let lastAttempts;
let lastAttempt;
const issuerViews = new Map();

function filterIssuers() {
  const query = document.getElementById('issuer-search').value.trim().toLocaleLowerCase('de');
  let visible = false;
  for (const view of issuerViews.values()) {
    view.node.hidden = !view.search.includes(query);
    visible ||= !view.node.hidden;
  }
  document.getElementById('issuer-empty').hidden = issuerViews.size !== 0;
  document.getElementById('issuer-no-match').hidden = visible || issuerViews.size === 0;
}

function updateIssuers(issuers) {
  const list = document.getElementById('progress-list');
  const present = new Set(issuers.map((issuer) => issuer.did));
  for (const [did, view] of issuerViews) {
    if (!present.has(did)) {
      view.node.remove();
      issuerViews.delete(did);
    }
  }
  for (const issuer of issuers) {
    let view = issuerViews.get(issuer.did);
    if (!view) {
      const name = el('strong');
      const label = el('span', { class: 'muted' });
      const status = el('span');
      const checkins = el('span', { class: 'issuer-checkins' });
      const node = el('li', {}, name, label, el('div', { class: 'issuer-status' }, status, checkins));
      view = { node, name, label, status, checkins };
      issuerViews.set(issuer.did, view);
      list.prepend(node);
    }
    const signature = JSON.stringify(issuer);
    if (signature === view.signature) continue;
    view.signature = signature;
    view.name.textContent = issuer.name;
    view.label.textContent = issuer.did;
    view.status.className = `badge ${issuer.state === 'approved' ? '' : 'badge-warn'}`;
    view.status.textContent = { pending: 'Ausstehend · Freigabe fehlt', approved: 'Freigegeben · aktuell vertraut', suspended: 'Gesperrt · aktuell nicht vertraut' }[issuer.state];
    view.checkins.textContent = `${issuer.checkinCount} erfolgreiche Check-in(s)`;
    view.search = [issuer.name, issuer.did, issuer.fingerprint]
      .filter(Boolean).join(' ').toLocaleLowerCase('de');
  }
  filterIssuers();
}

async function newQr() {
  if (creating) return;
  creating = true;
  try {
    const request = await api('/requests', { body: { mode: 'kiosk' } });
    current = request.id;
    const image = document.getElementById('checkin-qr');
    image.src = request.qrDataUrl;
    image.hidden = false;
    document.getElementById('qr-loading').hidden = true;
    document.getElementById('checkin-link').href = request.url;
    document.getElementById('qr-stage').hidden = false;
  } finally {
    creating = false;
  }
}

async function attendees() {
  const people = await api('/attendees');
  const serialized = JSON.stringify(people);
  if (serialized === lastAttendees) return;
  const list = document.getElementById('attendees');
  const opened = new Set([...list.querySelectorAll('details[open]')].map((node) => node.dataset.entry));
  lastAttendees = serialized;
  document.getElementById('attendees').replaceChildren(
    ...people.length ? people.map((person) => {
      const entry = person.holderDid || person.name;
      const detail = el('details', { class: 'attendee-detail', 'data-entry': entry },
        el('summary', {}, el('span', { class: 'attendee-avatar', 'aria-hidden': 'true' }, person.name.slice(0, 1).toUpperCase()),
          el('span', { class: 'attendee-heading' }, el('strong', {}, person.name),
            el('span', { class: 'muted' }, `${person.checkins?.length || 0} Check-in(s) · ${person.issuerName}`)),
          el('time', { datetime: person.time }, formatTime(person.time))),
        person.checkins?.length ? [...person.checkins].reverse().map((checkin) => el('article', { class: 'checkin-record' },
          el('h3', {}, `Mitarbeiterausweis · ${formatTime(checkin.time)}`),
          el('p', {}, `Ausstellende Organisation: ${checkin.issuerName}`),
          el('p', { class: 'muted' }, 'Vertrauen zum Check-in-Zeitpunkt; heutige Organisationsfreigabe und aktueller Ausweiswiderruf sind davon unabhängig.'),
          attributes(checkin.claims),
          el('p', { class: 'muted' }, `Nicht geteilt: ${['organisation', 'role'].filter((field) => !Object.hasOwn(checkin.claims, field)).map((field) => labels[field]).join(', ') || 'keine optionalen Felder'}`),
          el('p', { class: 'did' }, `Credential-ID: ${checkin.credentialId.slice(0, 16)}…`),
          raw({
            credentialType: checkin.credentialType, credentialId: checkin.credentialId,
            issuerDid: checkin.issuerDid, issuerName: checkin.issuerName,
            holderDid: checkin.holderDid || person.holderDid,
            sharedClaims: checkin.claims, time: checkin.time, trustedAtCheckin: checkin.trustedAtCheckin,
          }, 'Prüfbare Check-in-Metadaten')))
          : el('p', { class: 'muted' }, 'Alter Eintrag ohne Disclosure-Protokoll. Für den neuen Workshop erneut einchecken.'));
      detail.open = opened.has(entry);
      return el('li', {}, detail);
    })
      : [el('li', { class: 'muted' }, 'Der erste Gast bist vielleicht du.')],
  );
}

function showAttempt(attempt) {
  const box = document.getElementById('kiosk-result');
  const done = attempt.status === 'done';
  box.className = `kiosk-result ${done ? 'success' : attempt.status === 'error' ? 'failure' : ''}`;
  box.replaceChildren(
    el('h2', {}, `${attempt.name} · ${done ? 'eingecheckt' : attempt.status === 'processing' ? 'wird geprüft' : 'nicht eingecheckt'}`),
    el('p', {}, done ? `Organisation: ${attempt.issuerName}` : attempt.error || 'Signatur, Vertrauen und Wallet-Bindung werden geprüft.'),
    el('p', { class: 'muted attempt-code' },
      `Letzter Versuch ${attempt.id.slice(0, 8)}${attempt.failedAt ? ` · ${attempt.failedAt}` : ''}${!attempt.identityVerified ? ' · Name noch ungeprüft' : ''}`),
  );
  box.hidden = false;
}

async function dashboard() {
  const data = await api('/dashboard');
  for (const [id, value] of [['registered-count', data.stats.registered], ['checkin-count', data.stats.checkins]]) {
    const node = document.getElementById(id);
    if (node.textContent !== String(value)) node.textContent = value;
  }
  updateIssuers(data.issuers);
  const serialized = JSON.stringify(data.attempts);
  if (serialized === lastAttempts) return;
  lastAttempts = serialized;

  const list = document.getElementById('attempts');
  const opened = new Set([...list.querySelectorAll('details[open]')].map((node) => node.dataset.entry));
  list.replaceChildren(...data.attempts.length ? data.attempts.map((attempt) => {
    const done = attempt.status === 'done';
    const detail = el('details', { 'data-entry': attempt.id, class: `attempt-detail ${attempt.status}` },
      el('summary', {},
        el('span', { class: 'attempt-person' }, el('strong', {}, `${attempt.name}${attempt.identityVerified ? '' : ' (ungeprüft)'}`),
          el('span', { class: 'muted attempt-code' }, `${attempt.id.slice(0, 8)} · ${formatTime(attempt.time)} · ${attempt.issuerName}`)),
        el('span', { class: `badge ${done ? '' : 'badge-warn'}` }, done ? 'Eingecheckt' : attempt.status === 'processing' ? 'Prüfung läuft' : 'Abgelehnt')),
      el('p', { class: 'muted' }, attempt.identityVerified ? 'Name und Nachweis erfolgreich geprüft.'
        : attempt.identityNote || 'Name aus dem noch nicht verifizierten Nachweis. Keine bestätigte Identität.'),
      ...(attempt.status === 'processing' ? [el('p', {}, 'Die Prüfung läuft.')] : [
        steps({ ok: done, steps: attempt.steps, error: attempt.error }),
      ]));
    detail.open = opened.has(attempt.id);
    return el('li', {}, detail,
      ...(attempt.error ? [el('p', { class: 'attempt-error' }, `${attempt.failedAt}: ${attempt.error}`)] : []));
  }) : [el('li', { class: 'muted' }, 'Noch keine Prüfungen seit Serverstart. Mehrere Handys können denselben QR scannen.')]);
  const latest = data.attempts[0];
  if (latest) {
    const signature = JSON.stringify(latest);
    if (signature !== lastAttempt) showAttempt(latest);
    lastAttempt = signature;
  } else {
    document.getElementById('kiosk-result').hidden = true;
    lastAttempt = null;
  }
}

function applyConfig(value) {
  const expected = new URL('/issuer.html', value.publicUrl).href;
  if (value.issuerSetupUrl !== expected || !value.issuerSetupQrDataUrl) {
    throw new Error('Die öffentliche Organisationseinrichtung fehlt oder hat eine ungültige Adresse. Bitte den Host informieren.');
  }
  document.getElementById('issuer-setup-qr').src = value.issuerSetupQrDataUrl;
  document.getElementById('issuer-setup-qr').hidden = false;
  document.getElementById('issuer-setup-link').href = value.issuerSetupUrl;
  document.getElementById('issuer-setup-link').textContent = value.issuerSetupUrl;
  document.getElementById('copy-issuer-setup').disabled = false;
  config = value;
}

async function poll() {
  if (stopped) return;
  try {
    if (!config) applyConfig(await setupPage());
    if (!current) await newQr();
    let request;
    try {
      request = await api(`/requests/${current}`);
    } catch (error) {
      if (error.status !== 404) throw error;
      await newQr();
    }
    if (request?.status === 'expired') await newQr();
    await dashboard();
    await attendees();
    clearError();
  } catch (error) {
    showError(error);
  } finally {
    if (!stopped) setTimeout(poll, 1500);
  }
}

document.getElementById('issuer-search').addEventListener('input', filterIssuers);
action(document.getElementById('copy-issuer-setup'), async () => {
  if (!navigator.clipboard) throw new Error('Kopieren ist hier nicht möglich. Markiere die sichtbare Organisationsadresse und kopiere sie manuell.');
  await navigator.clipboard.writeText(config.issuerSetupUrl);
  notify('Öffentliche Adresse zur Organisationseinrichtung kopiert. Am Laptop öffnen.');
});
window.addEventListener('pagehide', () => {
  stopped = true;
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) { stopped = false; run(poll); }
});
run(poll);
