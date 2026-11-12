import { el, api, steps, labels, attributes, raw, formatTime, run, setupPage, showError, clearError } from './lib/ui.js';

let current = null;
let nextAt = 0;
let creating = false;
let config;
let stopped = false;
let transitionTimer;
let lastAttendees;

async function newQr() {
  if (creating) return;
  creating = true;
  try {
    const request = await api('/requests', { body: {} });
    current = request.id;
    nextAt = 0;
    clearTimeout(transitionTimer);
    const image = document.getElementById('checkin-qr');
    image.src = request.qrDataUrl;
    image.hidden = false;
    document.getElementById('qr-loading').hidden = true;
    document.getElementById('checkin-link').href = request.url;
    document.getElementById('qr-stage').hidden = false;
    document.getElementById('kiosk-result').hidden = true;
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

function showResult(result) {
  nextAt = Date.now() + 6000;
  clearTimeout(transitionTimer);
  transitionTimer = setTimeout(() => {
    if (!stopped) run(newQr);
  }, 6000);
  document.getElementById('qr-stage').hidden = true;
  const box = document.getElementById('kiosk-result');
  box.className = `kiosk-result ${result.ok ? 'success' : 'failure'}`;
  box.replaceChildren(
    el('span', { class: 'result-symbol', 'aria-hidden': 'true' }, result.ok ? '✓' : '✗'),
    el('h2', {}, result.ok ? `Willkommen, ${result.claims.given_name} ${result.claims.family_name}` : 'Check-in nicht möglich'),
    el('p', {}, result.ok ? `Ausgestellt von ${result.issuerName}` : result.error),
    ...(result.ok ? [
      el('p', { class: 'muted' }, `Vertrauensliste: Issuer von ${result.issuerOwner}`),
      el('p', { class: 'shared-fields' }, `Geteilt: ${Object.keys(result.claims).map((field) => labels[field] || field).join(', ')}`),
    ] : []),
    el('p', { class: 'muted' }, 'Der nächste QR-Code erscheint gleich automatisch.'),
  );
  box.hidden = false;
  document.getElementById('verification').replaceChildren(steps(result));
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
    if (!current || (nextAt && Date.now() >= nextAt)) await newQr();
    if (!nextAt) {
      let request;
      try {
        request = await api(`/requests/${current}`);
      } catch (error) {
        if (error.status !== 404) throw error;
        await newQr();
      }
      if (request?.status === 'expired') await newQr();
      else if (request && ['done', 'error'].includes(request.status)) showResult(request.result);
    }
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
  clearTimeout(transitionTimer);
});
window.addEventListener('pageshow', (event) => {
  if (event.persisted) { stopped = false; run(poll); }
});
run(poll);
