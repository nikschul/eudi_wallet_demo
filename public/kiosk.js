import { el, api, steps, labels, attributes, raw, formatTime, run, setupPage, showError, clearError } from './lib/ui.js';

let current = null;
let creating = false;
let config;
let stopped = false;
let lastAttendees;
let lastDashboard;
let lastAttempt;

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
  document.getElementById('attendee-count').textContent = people.length;
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
          el('p', {}, `Aussteller: ${checkin.issuerName}`),
          el('p', { class: 'muted' }, `Freigegebener Issuer von ${checkin.issuerOwner}`),
          attributes(checkin.claims),
          el('p', { class: 'muted' }, `Nicht geteilt: ${['organisation', 'role'].filter((field) => !Object.hasOwn(checkin.claims, field)).map((field) => labels[field]).join(', ') || 'keine optionalen Felder'}`),
          el('p', { class: 'did' }, `Credential-ID: ${checkin.credentialId.slice(0, 16)}…`),
          raw({
            credentialType: checkin.credentialType, credentialId: checkin.credentialId,
            issuerDid: checkin.issuerDid, issuerName: checkin.issuerName, issuerOwner: checkin.issuerOwner,
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
    el('p', {}, done ? `Aussteller: ${attempt.issuerName}` : attempt.error || 'Signatur, Vertrauen und Wallet-Bindung werden geprüft.'),
    el('p', { class: 'muted attempt-code' },
      `Letzter Versuch ${attempt.id.slice(0, 8)}${attempt.failedAt ? ` · ${attempt.failedAt}` : ''}${!attempt.identityVerified ? ' · Name noch ungeprüft' : ''}`),
  );
  box.hidden = false;
}

async function dashboard() {
  const data = await api('/dashboard');
  const serialized = JSON.stringify(data);
  if (serialized === lastDashboard) return;
  lastDashboard = serialized;
  document.getElementById('progress-stats').replaceChildren(
    ...[[data.stats.registered, 'registriert'], [data.stats.trusted, 'freigegeben'], [data.stats.checkedIn, 'mit Check-in']]
      .map(([count, label]) => el('div', {}, el('strong', {}, count), el('span', {}, label))),
  );
  document.getElementById('progress-list').replaceChildren(...data.issuers.length
    ? [...data.issuers].reverse().map((issuer) => el('li', {},
      el('strong', {}, issuer.ownerName || issuer.employeeName || issuer.name),
      el('span', { class: 'muted' }, issuer.name),
      el('ul', { class: 'progress-steps' },
        el('li', { class: issuer.proofVerified ? 'complete' : '' }, issuer.proofVerified ? 'Registriert' : 'Neu registrieren'),
        el('li', { class: issuer.trusted && issuer.proofVerified && issuer.ownerName ? 'complete' : '' },
          issuer.trusted && issuer.proofVerified && issuer.ownerName ? 'Freigegeben' : 'Freigabe ausstehend'),
        el('li', { class: issuer.checkinCount ? 'complete' : '' }, issuer.checkinCount ? `${issuer.checkinCount} Check-in(s)` : 'Noch kein Check-in'))))
    : [el('li', { class: 'muted' }, 'Noch kein Issuer registriert.')]);

  const list = document.getElementById('attempts');
  const opened = new Set([...list.querySelectorAll('details[open]')].map((node) => node.dataset.entry));
  document.getElementById('attempt-count').textContent = data.attempts.length;
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
  config = value;
  document.getElementById('start-qr').src = value.startQrDataUrl;
  document.getElementById('start-qr').hidden = false;
  document.getElementById('public-url').textContent = value.publicUrl;
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

window.addEventListener('pagehide', () => {
  stopped = true;
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) { stopped = false; run(poll); }
});
run(poll);
