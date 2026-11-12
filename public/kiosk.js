import { el, api, steps, labels, formatTime, run, setupPage, showError, clearError } from './lib/ui.js';

let current = null;
let nextAt = 0;
let creating = false;
let config;
let stopped = false;
let transitionTimer;

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
  document.getElementById('attendees').replaceChildren(
    ...people.length ? people.map((person) => el('li', {},
      el('span', { class: 'attendee-avatar', 'aria-hidden': 'true' }, person.name.slice(0, 1).toUpperCase()),
      el('div', {}, el('strong', {}, person.name), el('span', { class: 'muted' }, person.organisation || person.issuerName)),
      el('time', { datetime: person.time }, formatTime(person.time))))
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
    result.ok ? el('p', { class: 'shared-fields' }, `Geteilt: ${Object.keys(result.claims).map((field) => labels[field] || field).join(', ')}`) : null,
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
