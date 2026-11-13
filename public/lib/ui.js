import { texts } from './texts.js';
import { readVerificationStream } from './verification.js';

export const labels = {
  given_name: 'Vorname', family_name: 'Nachname', organisation: 'Organisation', role: 'Rolle',
};

export function el(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [name, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') node.className = value;
    else if (['checked', 'disabled', 'hidden', 'required'].includes(name)) node[name] = Boolean(value);
    else node.setAttribute(name, String(value));
  }
  for (const child of children.flat(Infinity)) {
    if (child !== null && child !== undefined) node.append(child instanceof Node ? child : String(child));
  }
  return node;
}

export function explain(key) {
  return el('details', { class: 'explanation' },
    el('summary', {}, 'Was passiert hier?'), el('p', {}, texts[key]));
}

export function raw(data, title = 'Rohdaten anzeigen') {
  return el('details', { class: 'raw-data' }, el('summary', {}, title),
    el('pre', {}, typeof data === 'string' ? data : JSON.stringify(data, null, 2)));
}

export function attributes(claims) {
  return el('dl', { class: 'attributes' }, Object.entries(claims).map(([name, value]) => [
    el('dt', {}, labels[name] || name), el('dd', {}, value),
  ]));
}

export function steps(result) {
  return el('ol', { class: 'checks' },
    (result.steps || []).map((label) => el('li', { class: 'check-pass' },
      el('span', { 'aria-label': 'Erfolgreich' }, '✓'), el('span', {}, label))),
    result.ok ? null : el('li', { class: 'check-fail' },
      el('span', { 'aria-label': 'Fehlgeschlagen' }, '✗'), el('span', {}, result.error)));
}

export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

export async function api(route, {
  body, offerToken, adminToken, baseUrl = '', timeoutMs = 15000, credentials = 'omit', onProgress,
} = {}) {
  if (!['omit', 'same-origin'].includes(credentials)) {
    throw new TypeError('Ungültiger Cookie-Modus: Erlaubt sind omit oder same-origin.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const timeoutMessage = onProgress
    ? 'Die Live-Prüfung antwortet nicht rechtzeitig. Das Ergebnis kann bereits gespeichert sein. Prüfe den Versuch am Kiosk, bevor du den QR erneut scannst.'
    : 'Der Server antwortet nicht rechtzeitig. Bitte versuche es erneut.';
  try {
    let response;
    try {
      response = await fetch(`${baseUrl}/api${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Accept: onProgress ? 'application/x-ndjson' : 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(offerToken ? { 'X-Offer-Token': offerToken } : {}),
          ...(adminToken ? { 'X-Admin-Token': adminToken } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        cache: 'no-store',
        credentials,
        signal: controller.signal,
      });
    } catch (error) {
      throw new Error(controller.signal.aborted
        ? timeoutMessage
        : 'Der Server ist nicht erreichbar. Prüfe deine Internetverbindung und versuche es erneut.', { cause: error });
    }
    let data;
    try {
      data = onProgress && response.ok && response.headers.get('content-type')?.includes('application/x-ndjson')
        ? await readVerificationStream(response, onProgress)
        : await response.json();
    } catch (error) {
      throw new Error(controller.signal.aborted
        ? timeoutMessage
        : onProgress ? `Die Live-Prüfung wurde unterbrochen: ${error.message}`
          : 'Der Server hat keine lesbare Antwort geschickt. Bitte versuche es erneut.', { cause: error });
    }
    if (!response.ok) throw new ApiError(data?.error || 'Die Anfrage ist fehlgeschlagen.', response.status);
    return data;
  } finally {
    clearTimeout(timeout);
  }
}

export function showError(error) {
  const box = document.getElementById('error');
  box.textContent = error.message || 'Etwas ist schiefgegangen. Bitte lade die Seite neu.';
  box.hidden = false;
}

export function clearError() {
  const box = document.getElementById('error');
  box.hidden = true;
  box.textContent = '';
}

let noticeTimer;

export function notify(message) {
  const box = document.getElementById('notice');
  box.textContent = message;
  box.hidden = false;
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { box.hidden = true; }, 6000);
}

export async function run(work) {
  try {
    return await work();
  } catch (error) {
    showError(error);
  }
}

export function action(button, work) {
  button.addEventListener('click', () => run(async () => {
    clearError();
    button.disabled = true;
    try { await work(); } finally { button.disabled = false; }
  }));
  return button;
}

export function formAction(form, work) {
  const errorBox = el('p', { class: 'message error form-error', role: 'alert', hidden: true, tabindex: '-1' });
  form.append(errorBox);
  form.addEventListener('invalid', (event) => {
    errorBox.textContent = event.target.dataset?.validationMessage || event.target.validationMessage || 'Bitte prüfe deine Eingabe.';
    errorBox.hidden = false;
  }, true);
  form.addEventListener('input', () => { errorBox.hidden = true; });
  form.addEventListener('submit', (event) => {
    event.preventDefault();
    return run(async () => {
      clearError();
      errorBox.hidden = true;
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      try {
        await work(new FormData(form));
      } catch (error) {
        errorBox.textContent = error.message || 'Die Aktion ist fehlgeschlagen. Bitte versuche es erneut.';
        errorBox.hidden = false;
        errorBox.focus();
        throw error;
      } finally {
        button.disabled = false;
      }
    });
  });
  return form;
}

export function readStored(key) {
  try {
    const value = localStorage.getItem(key);
    if (!value) return null;
    const data = JSON.parse(value);
    const valid = data && typeof data === 'object'
      && (key === 'pendingOffer'
        ? typeof data.sdjwt === 'string' && typeof data.issuerName === 'string'
        : typeof data.did === 'string' && data.publicJwk && data.privateJwk
          && (key !== 'wallet' || Array.isArray(data.credentials)));
    if (!valid) throw new Error('Ungültiges Datenformat');
    return data;
  } catch (error) {
    throw new Error('Deine Browser-Daten konnten nicht gelesen werden. Nutze denselben Browser ohne privaten Modus und lösche beschädigte Website-Daten bei Bedarf in den Browser-Einstellungen.', { cause: error });
  }
}

export function writeStored(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    throw new Error('Dein Browser konnte die Daten nicht speichern. Erlaube Website-Speicher und nutze keinen privaten Modus.', { cause: error });
  }
}

export function removeStored(...keys) {
  try {
    for (const key of keys) localStorage.removeItem(key);
  } catch (error) {
    throw new Error('Die Browser-Daten konnten nicht gelöscht werden. Prüfe die Speicher-Einstellungen deines Browsers.', { cause: error });
  }
}

export function readWalletFor(did) {
  const wallet = readStored('wallet');
  if (!wallet || wallet.did !== did) {
    throw new Error('Deine Wallet wurde in einem anderen Fenster geändert oder zurückgesetzt. Bitte lade die Seite neu.');
  }
  return wallet;
}

export function currentRequestId(url = new URL(location.href)) {
  return url.hash.startsWith('#req=') ? url.hash.slice(5) : null;
}

export function resetWalletNavigation() {
  for (const link of document.querySelectorAll('nav a')) {
    if (link.pathname !== '/wallet.html') continue;
    const url = new URL(link.href);
    url.search = '';
    url.hash = '';
    link.href = url.href;
  }
}

export function requireCrypto() {
  if (!globalThis.isSecureContext || !globalThis.crypto?.subtle) {
    throw new Error('Deine Wallet braucht eine sichere HTTPS-Adresse. Eine lokale IP-Adresse mit http:// funktioniert auf Smartphones nicht. Bitte wende dich an den Empfang.');
  }
}

export const shortDid = (did) => `${did.slice(0, 24)}…`;
export const formatTime = (date) => new Date(date).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

export function didCard(did, title = 'Meine DID') {
  const copy = action(el('button', { type: 'button', class: 'secondary' }, 'Kopieren'), async () => {
    if (!navigator.clipboard) throw new Error('Kopieren ist hier nicht möglich. Öffne die Rohdaten und kopiere die DID dort.');
    await navigator.clipboard.writeText(did);
    notify('DID kopiert.');
  });
  return el('section', { class: 'card' }, el('span', { class: 'eyebrow' }, 'Dein öffentlicher Schlüssel'),
    el('h2', {}, title), el('p', { class: 'did' }, shortDid(did)), copy, explain('did'), raw({ did }));
}

let pageSetup = false;

export async function setupPage() {
  if (!pageSetup) {
    pageSetup = true;
    setupBrowserFeatures();
  }
  resetWalletNavigation();
  const config = await api('/config');
  for (const title of document.querySelectorAll('[data-event-title]')) title.textContent = config.eventTitle;
  return config;
}

function setupBrowserFeatures() {
  for (const node of document.querySelectorAll('[data-explain]')) node.replaceWith(explain(node.dataset.explain));
  window.addEventListener('offline', () => showError(new Error('Du bist offline. Bereits gespeicherte Nachweise sind lesbar; für Ausstellung und Check-in brauchst du eine Verbindung.')));
  window.addEventListener('online', () => { clearError(); notify('Du bist wieder online. Bitte wiederhole die letzte Aktion.'); });
  const install = document.getElementById('install');
  if (install) {
    let prompt;
    window.addEventListener('beforeinstallprompt', (event) => {
      event.preventDefault();
      prompt = event;
      install.hidden = false;
    });
    action(install, async () => {
      if (!prompt) return;
      await prompt.prompt();
      await prompt.userChoice;
      install.hidden = true;
      prompt = null;
    });
  }
  if ('serviceWorker' in navigator && globalThis.isSecureContext) {
    navigator.serviceWorker.register('/sw.js').catch(() => {
      showError(new Error('Der Offline-Modus konnte nicht aktiviert werden. Die Demo bleibt online nutzbar; lade die Seite für einen erneuten Versuch neu.'));
    });
  }
}
