import * as sd from './lib/sdjwt.js';
import { statusReference, loadStatusList, isRevoked } from './lib/credential-status.js';
import { EMPLOYEE_VCT, HOLDER_PROOF, decodeOffer, publicOrigin, signProof, canonicalWalletUrl } from './lib/protocol.js';
import { createCameraScanner, validateWalletQr } from './wallet-scanner.js';
import { verificationChecks } from './lib/verification.js';
import {
  el, api, explain, raw, attributes, steps, labels, action, formAction,
  run, setupPage, readStored, writeStored, removeStored, requireCrypto, didCard, clearError,
  currentRequestId, readWalletFor, notify,
} from './lib/ui.js';

const root = document.getElementById('app');
let renderVersion = 0;
let offerTimer;
let statusTimer;
let camera;
let cancelBiometrics;
let walletInitialization;
const revokedCredentials = new Set();

function stopTimers() {
  cancelBiometrics?.();
  clearTimeout(offerTimer);
  clearTimeout(statusTimer);
}

function stopCamera() {
  camera?.stop();
  camera = null;
}

function openQr(url) {
  history.replaceState(null, '', url.pathname + url.hash);
  return render();
}

function scannerButton(version) {
  return action(el('button', { type: 'button' }, 'QR-Code scannen'), () => openScanner(version));
}

async function openScanner(version) {
  if (version !== renderVersion) return;
  stopTimers();
  stopCamera();
  const scannerVersion = ++renderVersion;
  const video = el('video', { playsinline: true, muted: true, 'aria-label': 'Kameravorschau für QR-Codes' });
  const heading = el('h2', { tabindex: '-1' }, 'QR-Code scannen');
  const status = el('p', { class: 'scanner-status', role: 'status', 'aria-live': 'polite' });
  const retry = action(el('button', { type: 'button', class: 'secondary', hidden: true }, 'Kamera erneut versuchen'),
    () => camera?.start());
  root.replaceChildren(el('section', { class: 'card wallet-scanner', 'aria-label': 'QR-Code scannen' },
    heading,
    el('p', {}, 'Scanne den Ausstellungs-QR vom Laptop oder den Check-In-QR.'),
    video, status,
    el('div', { class: 'scanner-actions' }, retry,
      action(el('button', { type: 'button', class: 'secondary' }, 'Scannen abbrechen'), render))));
  camera = createCameraScanner({
    video, origin: document.querySelector('meta[name="wallet-origin"]').content,
    onState(state, message) {
      if (scannerVersion !== renderVersion) return;
      status.textContent = message;
      status.className = `scanner-status${state === 'error' ? ' message error' : ''}`;
      status.setAttribute('role', state === 'error' ? 'alert' : 'status');
      status.setAttribute('aria-live', state === 'error' ? 'assertive' : 'polite');
      retry.hidden = state !== 'error';
    },
    onDecode: (url) => {
      if (scannerVersion !== renderVersion) return;
      return run(() => openQr(url));
    },
  });
  heading.focus();
  await camera.start();
}

function pastedQr() {
  const input = el('input', { type: 'url', name: 'link', required: true, id: 'checkin-url', placeholder: 'https://…/wallet.html#…', autocomplete: 'off' });
  const form = formAction(el('form', { class: 'stack' },
    el('label', { for: 'checkin-url' }, 'QR-Link einfügen (zum Beispiel ohne Kamerazugriff)'), input,
    el('button', { type: 'submit', class: 'secondary' }, 'QR-Link öffnen')), async (data) => {
    const url = validateWalletQr(data.get('link'), document.querySelector('meta[name="wallet-origin"]').content);
    await openQr(url);
  });
  return el('details', { class: 'card' }, el('summary', {}, 'QR-Link öffnen'), form);
}

function storedCredential(walletDid, credential) {
  const current = readWalletFor(walletDid);
  if (!current.credentials.some((entry) => entry.id === credential.id && entry.sdjwt === credential.sdjwt)) {
    throw new Error('Dieser Ausweis wurde inzwischen aus deiner Wallet gelöscht. Bitte öffne die Ausweisablage erneut.');
  }
  return current;
}

async function credentialStatuses(credentials, walletDid, registeredIssuers) {
  const registry = registeredIssuers ? Promise.resolve(registeredIssuers) : api('/issuers', { timeoutMs: 5000 }).catch((error) => ({ error }));
  const lists = new Map();
  const statuses = await Promise.all(credentials.map(async (credential) => {
    try {
      const { jwt } = sd.parseSdJwt(credential.sdjwt);
      const claimedIssuer = sd.decodeJwt(jwt).payload.iss;
      const { header, payload } = await sd.verifyJwt(jwt, sd.jwkFromDid(claimedIssuer));
      if (payload.iss !== claimedIssuer || header.typ !== 'dc+sd-jwt' || payload._sd_alg !== 'sha-256'
        || !Array.isArray(payload._sd) || payload._sd.some((digest) => typeof digest !== 'string')
        || new Set(payload._sd).size !== payload._sd.length
        || !Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)
        || payload.exp <= payload.iat || payload.iat * 1000 > Date.now() + 60000
        || sd.didFromJwk(payload.cnf?.jwk || {}) !== walletDid) {
        throw new Error('Signatur, Gültigkeit oder Wallet-Bindung des Ausweises ist ungültig.');
      }
      if (payload.exp * 1000 <= Date.now()) {
        return { state: 'expired', reason: 'Die Gültigkeitsdauer dieses Ausweises ist abgelaufen.', checkedAt: Date.now() };
      }
      // Older credentials must never acquire a status from an unsigned local ID.
      if (!payload.status?.status_list) {
        throw new Error('Dieser ältere Ausweis hat keinen Widerrufsstatus. Bitte lasse ihn neu ausstellen.');
      }
      const issuers = await registry;
      if (issuers.error) throw issuers.error;
      const issuer = issuers.find((entry) => entry.did === payload.iss && entry.proofVerified);
      if (!issuer) throw new Error('Die Ausweisstelle ist nicht im aktuellen Workshop-Register registriert.');
      const reference = statusReference(payload, issuer);
      if (!lists.has(issuer.did)) lists.set(issuer.did, loadStatusList(issuer));
      const list = await lists.get(issuer.did);
      if (list.expiresAt <= Date.now()) throw new Error('Die Statusliste ist nicht mehr aktuell.');
      // A delayed older list must not undo an already authenticated revocation.
      if (isRevoked(list, reference.idx)) revokedCredentials.add(credential.sdjwt);
      const revoked = revokedCredentials.has(credential.sdjwt);
      return {
        state: revoked ? 'revoked' : 'active',
        reason: revoked ? 'Die Ausweisstelle hat diesen Ausweis widerrufen. Kein Check-In möglich.'
          : 'Signatur und Widerrufsstatus sind aktuell geprüft. Beim Check-In wird zusätzlich das Vertrauen zum Aussteller geprüft.',
        checkedAt: Date.now(), expiresAt: Math.min(list.expiresAt, payload.exp * 1000),
        credentialExpiresAt: payload.exp * 1000,
      };
    } catch (error) {
      return { state: 'unknown', reason: error.message, checkedAt: Date.now() };
    }
  }));
  return statuses.map((status) => {
    const expired = status.credentialExpiresAt <= Date.now();
    if (!expired && (status.state !== 'active' || status.expiresAt > Date.now())) return status;
    return {
      ...status, state: expired ? 'expired' : 'unknown',
      reason: expired ? 'Die Gültigkeitsdauer dieses Ausweises ist abgelaufen.' : 'Die Statusliste ist nicht mehr aktuell.',
    };
  });
}

function statusView() {
  const badge = el('span', { class: 'badge badge-warn' }, 'Status nicht prüfbar');
  const reason = el('p', { class: 'muted' }, 'Eine aktuelle authentifizierte Statusprüfung steht noch aus. Kein Check-In möglich.');
  const time = el('p', { class: 'muted' }, 'Letzte Statusprüfung: noch nicht erfolgt.');
  let current;
  function update(status) {
    current = status;
    badge.textContent = { active: 'Aktiv', expired: 'Abgelaufen', revoked: 'Widerrufen', unknown: 'Status nicht prüfbar' }[status.state];
    badge.className = `badge${status.state === 'active' ? '' : ' badge-warn'}`;
    reason.textContent = status.reason;
    time.textContent = `Letzte Statusprüfung: ${new Date(status.checkedAt).toLocaleString('de-DE')}`;
  }
  function pending() {
    if (current?.state !== 'active') return;
    update({ ...current, state: 'unknown', reason: 'Die aktuelle Statusprüfung läuft. Ohne bestätigten Status ist kein Check-In möglich.' });
  }
  return { badge, reason, time, update, pending };
}

function pollStatuses(wallet, credentials, views, version, initialStatuses) {
  function schedule(statuses) {
    const remaining = statuses.filter((status) => status.state === 'active').map((status) => Math.max(1, status.expiresAt - Date.now()));
    statusTimer = setTimeout(refresh, Math.min(5000, ...remaining));
  }
  async function refresh() {
    if (version !== renderVersion || document.hidden) return;
    views.forEach((view) => view.pending());
    const statuses = await credentialStatuses(credentials, wallet.did);
    if (version !== renderVersion || document.hidden) return;
    statuses.forEach((status, index) => views[index].update(status));
    schedule(statuses);
  }
  if (initialStatuses) schedule(initialStatuses);
  else run(refresh);
}

function goHome() {
  history.replaceState(null, '', '/wallet.html');
  return render();
}

function credentialRaw(credential) {
  const description = sd.describeCredential(credential.sdjwt);
  return el('div', {}, raw({
    header: description.header, payload: description.payload,
    disclosures: description.disclosures.map((disclosure) => disclosure.value), sdjwt: credential.sdjwt,
  }), explain('sd'));
}

function credentialCard(credential, wallet, status, version) {
  let description;
  try { description = sd.describeCredential(credential.sdjwt); } catch {
    description = { claims: {}, payload: {} };
  }
  const { claims, payload } = description;
  const view = el('div', { role: 'tabpanel', id: `view-${credential.id}` }, attributes(claims));
  const data = el('div', { role: 'tabpanel', id: `raw-${credential.id}`, hidden: true },
    description.header ? credentialRaw(credential) : raw(credential.sdjwt));
  const viewTab = el('button', { type: 'button', role: 'tab', 'aria-selected': 'true', 'aria-controls': view.id }, 'Ansicht');
  const rawTab = el('button', { type: 'button', role: 'tab', 'aria-selected': 'false', 'aria-controls': data.id }, 'Rohdaten');
  function select(showRaw) {
    view.hidden = showRaw;
    data.hidden = !showRaw;
    viewTab.setAttribute('aria-selected', String(!showRaw));
    rawTab.setAttribute('aria-selected', String(showRaw));
  }
  viewTab.addEventListener('click', () => select(false));
  rawTab.addEventListener('click', () => select(true));
  return el('article', { class: 'card credential' },
    el('div', { class: 'card-top' }, el('span', { class: 'eyebrow' }, payload.vct === EMPLOYEE_VCT ? 'Mitarbeiterausweis' : 'Alter Nachweis – nicht für diesen Workshop'),
      status.badge),
    el('h2', {}, `${claims.given_name || ''} ${claims.family_name || ''}`.trim() || 'Gespeicherter Ausweis'),
    el('p', { class: 'muted' }, `Ausgestellt von ${credential.issuerName}`),
    el('p', { class: 'muted' }, `Gültig bis ${Number.isSafeInteger(payload.exp) ? new Date(payload.exp * 1000).toLocaleString('de-DE') : 'unbekannt'}`),
    el('details', {}, el('summary', {}, 'Statusprüfung'), status.reason, status.time),
    el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Nachweis-Details' }, viewTab, rawTab),
    view, data, explain('credential'),
    action(el('button', { type: 'button', class: 'secondary danger' }, 'Ausweis aus diesem Browser löschen'), async () => {
      if (version !== renderVersion) return;
      if (!confirm('Diesen Ausweis nur aus diesem Browser löschen? Das ist kein Widerruf durch die Ausweisstelle. Wallet-Schlüssel und andere Ausweise bleiben erhalten.')) return;
      const current = readWalletFor(wallet.did);
      writeStored('wallet', {
        ...current, credentials: current.credentials.filter((entry) => entry.id !== credential.id || entry.sdjwt !== credential.sdjwt),
      });
      await render();
      notify('Ausweis nur aus diesem Browser gelöscht. Kein Widerruf bei der Ausweisstelle.');
    }));
}

async function ensureWallet(version) {
  async function initialize() {
    let wallet = readStored('wallet');
    if (wallet) {
      walletInitialization = undefined;
      return wallet;
    }
    requireCrypto();
    walletInitialization ??= sd.generateKeyPair();
    let pair;
    try { pair = await walletInitialization; } catch (error) {
      walletInitialization = undefined;
      throw error;
    }
    if (version !== renderVersion) return null;
    wallet = readStored('wallet');
    if (!wallet) {
      wallet = { ...pair, credentials: [] };
      writeStored('wallet', wallet);
    }
    walletInitialization = undefined;
    return wallet;
  }
  return typeof navigator.locks?.request === 'function'
    ? navigator.locks.request('eudi-wallet-initialization', initialize)
    : initialize();
}

async function holderProof(wallet, offer) {
  const current = readWalletFor(wallet.did);
  return signProof(HOLDER_PROOF, {
    iss: current.did, aud: offer.aud, nonce: offer.nonce, jwk: current.publicJwk,
  }, current.privateJwk);
}

async function issuance(wallet, link, version) {
  const issuers = await api('/issuers');
  if (version !== renderVersion) return;
  const issuer = issuers.find((entry) => entry.did === link.issuer && entry.proofVerified);
  if (!issuer) throw new Error('Diese Organisation ist noch nicht im Workshop registriert. Prüfe ihre Einrichtung am Notebook und scanne den QR erneut.');
  const baseUrl = publicOrigin(issuer.publicUrl, 'Workshop-Adresse');
  if (baseUrl !== location.origin) throw new Error('Diese Organisation gehört nicht zu dieser Workshop-Zentrale.');
  if (issuer.state !== 'approved') throw new Error('Diese Organisation ist noch nicht freigegeben oder wurde gesperrt. Bitte wende dich an die Moderation.');
  const remote = (suffix = '', body) => api(`/offers/${encodeURIComponent(link.id)}${suffix}`, {
    baseUrl, offerToken: link.token, ...(body === undefined ? {} : { body }),
  });
  const offer = await remote();
  if (version !== renderVersion) return;
  if (offer.issuerDid !== issuer.did || offer.aud !== baseUrl) throw new Error('Das Angebot passt nicht zur registrierten Ausweisstelle.');
  const panel = el('section', { class: 'card' },
    el('span', { class: 'eyebrow' }, 'Angebot deiner Ausweisstelle'),
    el('h2', {}, issuer.name), attributes(offer.claims),
    el('p', {}, 'Gib den sechsstelligen Code ein, der am Laptop unter dem QR-Code steht.'),
    action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome));
  root.replaceChildren(panel);

  async function displayIssued() {
    const received = await remote('/credential', { proof: await holderProof(wallet, offer) });
    const description = sd.describeCredential(received.sdjwt);
    if (description.payload.vct !== EMPLOYEE_VCT || description.payload.iss !== issuer.did
      || description.claims.organisation !== issuer.name
      || sd.didFromJwk(description.payload.cnf.jwk) !== wallet.did) {
      throw new Error('Der empfangene Nachweis passt nicht zu deiner Wallet oder diesem Aussteller.');
    }
    const presentation = await sd.createPresentation({
      sdjwt: received.sdjwt, reveal: Object.keys(description.claims), holderPrivateJwk: readWalletFor(wallet.did).privateJwk,
      aud: location.origin, nonce: offer.nonce,
    });
    const verified = await sd.verifyPresentation(presentation, {
      aud: location.origin, nonce: offer.nonce, isTrustedIssuer: (did) => did === issuer.did,
    });
    if (!verified.ok) throw new Error(`Dein Ausweis konnte nicht geprüft werden: ${verified.error}`);
    const [status] = await credentialStatuses([received], wallet.did, [issuer]);
    if (version !== renderVersion) return;
    if (status.state !== 'active') throw new Error(`Dein Ausweis kann derzeit nicht angenommen werden: ${status.reason}`);
    const accept = action(el('button', { type: 'button' }, 'Ausweis in Wallet speichern'), async () => {
      if (version !== renderVersion) return;
      const [fresh] = await credentialStatuses([received], wallet.did, [issuer]);
      if (version !== renderVersion) return;
      if (fresh.state !== 'active') throw new Error(`Dein Ausweis kann derzeit nicht angenommen werden: ${fresh.reason}`);
      const current = readWalletFor(wallet.did);
      if (!current.credentials.some((entry) => entry.sdjwt === received.sdjwt)) {
        writeStored('wallet', {
          ...current, credentials: [...current.credentials, {
            id: crypto.randomUUID(), sdjwt: received.sdjwt, issuerName: issuer.name,
            receivedAt: Math.floor(Date.now() / 1000),
          }],
        });
      }
      // Saving locally happens first; failed acknowledgements can be retried safely.
      await remote('/ack', { proof: await holderProof(wallet, offer) });
      if (version !== renderVersion) return;
      history.replaceState(null, '', '/wallet.html');
      await render();
      notify('Mitarbeiterausweis gespeichert. Du kannst jetzt einchecken.');
    });
    panel.replaceChildren(el('span', { class: 'eyebrow' }, 'Automatisch von deiner Organisation signiert'),
      el('h2', {}, 'Dein Mitarbeiterausweis ist bereit'),
      el('p', {}, 'Der Ausweis wurde geprüft. Speichere ihn, um damit einzuchecken.'),
      attributes(description.claims), accept,
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome), explain('credential'),
      credentialRaw(received));
  }

  async function waitForIssue() {
    try {
      const state = await remote();
      if (version !== renderVersion) return;
      if (['issued', 'accepted'].includes(state.status)) return await displayIssued();
      offerTimer = setTimeout(waitForIssue, 1500);
    } catch (error) {
      if (version !== renderVersion) return;
      const retry = action(el('button', { type: 'button', class: 'secondary' }, 'Verbindung erneut prüfen'), () => render());
      panel.append(el('div', { class: 'message error', role: 'alert' }, error.message), retry);
    }
  }

  async function connect(transactionCode) {
    requireCrypto();
    if (transactionCode !== undefined && !/^\d{6}$/.test(transactionCode)) {
      throw new Error('Bitte gib den sechsstelligen Ausgabecode vom Notebook ein.');
    }
    await remote('/claim', {
      proof: await holderProof(wallet, offer),
      ...(transactionCode === undefined ? {} : { transactionCode }),
    });
    if (version !== renderVersion) return;
    panel.replaceChildren(el('span', { class: 'eyebrow' }, 'Wallet verbunden'),
      el('h2', {}, 'Dein Ausweis wird automatisch signiert'),
      el('p', {}, 'Code bestätigt. Dein Ausweis wird vorbereitet; bleibe auf dieser Seite.'),
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome), explain('binding'));
    await waitForIssue();
  }
  if (['bound', 'issued', 'accepted'].includes(offer.status)) return connect();
  const connectForm = formAction(el('form', { class: 'stack' },
    el('label', { class: 'field' }, 'Ausgabecode vom Notebook',
      el('input', {
        name: 'transactionCode', type: 'text', required: true, minlength: 6, maxlength: 6,
        pattern: '[0-9]{6}', inputmode: 'numeric', autocomplete: 'off',
        title: 'Bitte gib die sechs Ziffern ein, die nur beim Angebot auf dem Notebook angezeigt werden.',
        'data-validation-message': 'Bitte gib den sechsstelligen Ausgabecode vom Notebook ein.',
      })),
    el('button', { type: 'submit' }, 'Ausgabecode prüfen & Ausweis empfangen')),
  async (data) => connect(String(data.get('transactionCode')).trim()));
  panel.append(connectForm, explain('issuance'), raw({
    issuerDid: issuer.did, holderDid: wallet.did, expiresAt: offer.expiresAt,
  }, 'Öffentliche Verbindungsdaten anzeigen'));
}

function verificationProgress(title, checks) {
  const bar = el('progress', { max: checks.length, value: 0, 'aria-label': title });
  const status = el('p', { role: 'status', 'aria-live': 'polite' });
  const rows = checks.map((label) => el('li', {}, label));
  const node = el('section', { class: 'card verification-progress', tabindex: '-1' }, el('h2', {}, title),
    bar, status, el('ol', { class: 'verification-stages' }, rows));
  function update(completed, details = []) {
    bar.setAttribute('value', completed);
    status.textContent = `${completed} von ${checks.length} Prüfungen abgeschlossen${completed < checks.length ? ` · ${checks[completed]}` : ''}`;
    rows.forEach((row, index) => {
      row.className = index < completed ? 'stage-complete' : index === completed ? 'stage-current' : 'stage-pending';
      row.textContent = `${index < completed ? '✓' : index === completed ? '…' : '–'} ${details[index] || checks[index]}`;
    });
  }
  update(0);
  function fail(message) {
    status.textContent = message;
    status.setAttribute('role', 'alert');
    rows.forEach((row) => {
      if (row.className === 'stage-current') row.className = 'stage-failed';
    });
  }
  return { node, update, fail };
}

function demoBiometrics(credential, reveal, version) {
  return new Promise((resolve) => {
    const dialog = el('dialog', { class: 'biometric-dialog', 'aria-labelledby': 'biometric-title' },
      el('span', { class: 'eyebrow' }, 'Simulation · keine echte Biometrie'),
      el('div', { class: 'biometric-symbol', 'aria-hidden': 'true' }, '◎'),
      el('h2', { id: 'biometric-title' }, 'Datenfreigabe bestätigen'),
      el('p', {}, `Du verwendest den Ausweis von ${credential.issuerName}.`),
      el('p', {}, `Freigabe: ${reveal.map((field) => labels[field] || field).join(', ')}.`),
      el('p', { class: 'muted' }, 'Eine echte Wallet kann hier Fingerabdruck, Gesichtserkennung oder eine PIN verlangen. Diese Demo simuliert nur die Bestätigung. Sie erfasst keine biometrischen Daten und bietet keinen echten Geräteschutz.'));
    if (typeof dialog.showModal !== 'function' || typeof dialog.close !== 'function') {
      throw new Error('Dieser Browser unterstützt die Demo-Bestätigung nicht. Bitte verwende einen aktuellen Safari- oder Chrome-Browser.');
    }
    let finished = false;
    function finish(accepted) {
      if (finished) return;
      finished = true;
      cancelBiometrics = undefined;
      dialog.close();
      dialog.remove();
      resolve(accepted && version === renderVersion);
    }
    const confirmButton = el('button', { type: 'button' }, 'Demo-Biometrie bestätigen');
    confirmButton.addEventListener('click', () => finish(true));
    const cancelButton = el('button', { type: 'button', class: 'secondary' }, 'Abbrechen');
    cancelButton.addEventListener('click', () => finish(false));
    dialog.append(el('div', { class: 'biometric-actions' }, confirmButton, cancelButton));
    dialog.addEventListener('cancel', (event) => { event.preventDefault(); finish(false); });
    dialog.addEventListener('close', () => finish(false));
    root.append(dialog);
    cancelBiometrics = () => finish(false);
    dialog.showModal();
    confirmButton.focus();
  });
}

async function consent(wallet, id, version) {
  const preparing = verificationProgress('Check-In-Anfrage vorbereiten', [
    'Check-In-Anfrage prüfen', 'Passende Mitarbeiterausweise ermitteln', 'Signaturen und aktuellen Widerrufsstatus prüfen',
  ]);
  root.replaceChildren(preparing.node);
  preparing.node.focus();
  preparing.node.scrollIntoView?.({ block: 'start' });
  async function prepare(work) {
    try { return await work(); } catch (error) {
      if (version === renderVersion) preparing.fail(error.message);
      throw error;
    }
  }
  let request = await prepare(() => api(`/requests/${encodeURIComponent(id)}`));
  if (version !== renderVersion) return;
  if (request.status !== 'pending') {
    const message = request.status === 'expired' ? 'Dieser QR-Code ist abgelaufen. Bitte scanne den aktuellen Check-In-Code.'
      : 'Dieser Check-In-Versuch wurde schon verwendet. Bitte scanne den Check-In-QR erneut.';
    preparing.fail(message);
    throw new Error(message);
  }
  if (request.mode === 'kiosk') {
    request = await prepare(() => api(`/requests/${encodeURIComponent(id)}/sessions`, { body: {} }));
    if (version !== renderVersion) return;
    id = request.id;
  }
  preparing.update(1);
  const candidates = [...readWalletFor(wallet.did).credentials].reverse().sort((a, b) => b.receivedAt - a.receivedAt).filter((entry) => {
    try {
      const { payload, claims } = sd.describeCredential(entry.sdjwt);
      return payload.vct === request.vct && payload.exp * 1000 > Date.now()
        && request.required.every((field) => claims[field]);
    } catch { return false; }
  });
  if (!candidates.length) {
    root.replaceChildren(el('section', { class: 'card' }, el('h2', {}, 'Dir fehlt noch dein Mitarbeiterausweis'),
      el('p', {}, 'Lass dir am Laptop einen Ausweis ausstellen und scanne dessen QR-Code in deiner Wallet. Danach kannst du einchecken.'),
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome), explain('issuance')));
    return;
  }
  preparing.update(2);
  const statuses = await credentialStatuses(candidates, wallet.did);
  if (version !== renderVersion) return;
  preparing.update(3);
  const eligible = statuses.flatMap((status, index) => status.state === 'active' && status.expiresAt > Date.now() ? [index] : []);
  if (!eligible.length) {
    root.replaceChildren(el('section', { class: 'card' },
      el('h2', {}, 'Check-In derzeit nicht möglich'),
      el('p', {}, 'Kein passender Ausweis mit aktuellem, authentifiziertem und nicht widerrufenem Status verfügbar.'),
      statuses.map((status) => el('p', { class: 'message warning' }, status.reason)),
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome)));
    return;
  }
  const status = statusView();
  let selectedIndex;
  let busy = false;
  const inputByField = new Map();
  const preview = el('div', { class: 'disclosure-preview', 'aria-live': 'polite' });
  const fields = el('fieldset', {}, el('legend', {}, 'Welche Angaben möchtest du teilen?'));
  const consentDetails = el('div', { class: 'stack', hidden: true }, status.badge, status.reason, status.time, fields,
    el('p', { class: 'muted' }, 'Dein Name ist für die Anwesenheitsliste erforderlich, weitere Angaben sind freiwillig. Der Aussteller bleibt über seine Signatur erkennbar.'),
    preview);
  const submitButton = el('button', { type: 'submit', disabled: true }, 'Freigeben & einchecken');
  const selection = el('fieldset', { class: 'credential-picker' }, el('legend', {}, 'Welchen Ausweis möchtest du verwenden?'));
  const optionViews = candidates.map((credential, index) => {
    const { claims, payload } = sd.describeCredential(credential.sdjwt);
    const badge = el('span');
    const radio = el('input', { type: 'radio', name: 'credential', value: credential.id, required: true,
      'aria-label': `${credential.issuerName} · ${claims.given_name} ${claims.family_name} · ${claims.role || 'Mitarbeiterausweis'}` });
    const option = el('label', { class: 'credential-option' }, radio,
      el('span', {}, el('strong', {}, credential.issuerName),
        el('span', {}, `${claims.given_name} ${claims.family_name} · ${claims.role || 'Mitarbeiterausweis'}`),
        el('small', {}, `Gültig bis ${new Date(payload.exp * 1000).toLocaleString('de-DE')}`), badge));
    selection.append(option);
    radio.addEventListener('change', () => {
      if (!busy && !radio.disabled) select(index);
    });
    return {
      pending() {
        radio.disabled = true;
        if (selectedIndex === index) {
          status.pending();
          submitButton.disabled = true;
        }
      },
      update(next) {
        statuses[index] = next;
        radio.disabled = next.state !== 'active' || next.expiresAt <= Date.now();
        badge.textContent = { active: 'Aktiv', revoked: 'Widerrufen', expired: 'Abgelaufen', unknown: 'Status nicht prüfbar' }[next.state];
        if (selectedIndex === index) {
          status.update(next);
          submitButton.disabled = radio.disabled || busy;
        }
      },
      radio,
    };
  });
  function updatePreview() {
    if (selectedIndex === undefined) return;
    const { claims } = sd.describeCredential(candidates[selectedIndex].sdjwt);
    const shared = Object.entries(claims).filter(([field]) => request.required.includes(field) || inputByField.get(field)?.checked);
    const privateClaims = Object.entries(claims).filter(([field]) => !shared.some(([key]) => key === field));
    preview.replaceChildren(
      el('section', {}, el('h3', {}, 'Beim Check-In geteilt'), attributes(Object.fromEntries(shared))),
      el('section', {}, el('h3', {}, 'Nicht als Attribut geteilt'),
        privateClaims.length ? attributes(Object.fromEntries(privateClaims)) : el('p', {}, 'Keine weiteren Angaben im Ausweis.')));
  }
  function select(index) {
    const credential = candidates[index];
    storedCredential(wallet.did, credential);
    selectedIndex = index;
    const { claims } = sd.describeCredential(credential.sdjwt);
    optionViews.forEach((view, position) => { view.radio.checked = position === index; });
    fields.replaceChildren(el('legend', {}, 'Welche Angaben möchtest du teilen?'));
    inputByField.clear();
    for (const field of [...request.required, ...request.optional]) {
      const required = request.required.includes(field);
      const input = el('input', { type: 'checkbox', name: field, checked: required, disabled: required || !claims[field] });
      input.addEventListener('change', updatePreview);
      inputByField.set(field, input);
      fields.append(el('label', { class: 'disclosure-choice' }, input,
        el('span', {}, el('strong', {}, labels[field] || field), el('span', { class: 'muted' }, claims[field] || 'Nicht im Nachweis enthalten')),
        el('span', { class: 'choice-meta' }, required ? 'Für Anwesenheit nötig' : 'Freiwillig')));
    }
    status.update(statuses[index]);
    submitButton.disabled = statuses[index].state !== 'active';
    consentDetails.hidden = false;
    updatePreview();
  }
  const progress = verificationProgress('Dein Ausweis wird geprüft', verificationChecks);
  progress.node.hidden = true;
  const form = formAction(el('form', { class: 'stack' },
    selection, consentDetails,
    el('p', { class: 'privacy-note' }, 'Geteilte Angaben erscheinen öffentlich in der Check-In-Anzeige. Fehlgeschlagene Versuche zeigen den ungeprüften Namen und Fehlergrund. Nur erfundene Daten verwenden.'),
    submitButton,
    action(el('button', { type: 'button', class: 'secondary' }, 'Ablehnen'), goHome)), async () => {
    if (version !== renderVersion) return;
    try {
      if (selectedIndex === undefined) throw new Error('Bitte wähle zuerst einen Ausweis für diesen Check-In aus.');
      requireCrypto();
      const credential = candidates[selectedIndex];
      const reveal = [...request.required, ...request.optional.filter((field) => inputByField.get(field)?.checked)];
      if (!await demoBiometrics(credential, reveal, version)) return;
      if (version !== renderVersion) return;
      busy = true;
      selection.disabled = true;
      fields.disabled = true;
      storedCredential(wallet.did, credential);
      const [fresh] = await credentialStatuses([credential], wallet.did);
      if (version !== renderVersion) return;
      status.update(fresh);
      if (fresh.state !== 'active') throw new Error(`Check-In nicht möglich: ${fresh.reason}`);
      const current = storedCredential(wallet.did, credential);
      const presentation = await sd.createPresentation({
        sdjwt: credential.sdjwt, reveal, holderPrivateJwk: current.privateJwk, aud: request.aud, nonce: request.nonce,
      });
      if (version !== renderVersion) return;
      storedCredential(wallet.did, credential);
      if (revokedCredentials.has(credential.sdjwt)) throw new Error('Die Ausweisstelle hat diesen Ausweis widerrufen. Kein Check-In möglich.');
      if (fresh.expiresAt <= Date.now()) throw new Error('Die Statusprüfung ist inzwischen abgelaufen. Bitte versuche es erneut.');
      progress.node.hidden = false;
      progress.node.setAttribute('tabindex', '-1');
      progress.node.focus();
      progress.node.scrollIntoView?.({ block: 'start' });
      progress.update(0);
      const result = await api(`/requests/${encodeURIComponent(id)}/response`, {
        body: { presentation },
        onProgress: ({ completed, steps: completedSteps }) => {
          if (version === renderVersion) progress.update(completed, completedSteps);
        },
      });
      if (version !== renderVersion) return;
      stopTimers();
      renderVersion++;
      const resultHeading = el('h2', { tabindex: '-1' }, result.ok ? 'Du bist eingecheckt' : 'Check-In nicht möglich');
      root.replaceChildren(el('section', { class: `card result-card ${result.ok ? 'success' : 'failure'}` },
        el('span', { class: 'result-symbol', 'aria-hidden': 'true' }, result.ok ? '✓' : '✗'),
        resultHeading,
        el('p', { class: 'attempt-code' }, `Versuch ${id.slice(0, 8)}`),
        el('p', {}, result.ok ? 'Am Fernseher siehst du genau die von dir geteilten Angaben.' : result.error),
        result.ok ? attributes(result.claims) : el('p', {}, result.failedAt === 'Issuer-Vertrauen'
          ? 'Diesem Aussteller wird beim Check-In derzeit nicht vertraut. Bitte wende dich an die Moderation. Dein Ausweis bleibt in der Wallet erhalten.'
          : 'Bitte beachte den Prüfgrund unten. Deine gespeicherten Ausweise bleiben erhalten.'),
        steps(result), explain('trust'), raw(result), action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome)));
      resultHeading.focus();
      resultHeading.scrollIntoView?.({ block: 'start' });
    } catch (error) {
      if (version === renderVersion) {
        progress.fail(error.message);
        throw error;
      }
    } finally {
      busy = false;
      selection.disabled = false;
      fields.disabled = false;
    }
  });
  optionViews.forEach((view, index) => view.update(statuses[index]));
  if (eligible.length === 1) select(eligible[0]);
  root.replaceChildren(el('section', { class: 'card' },
    el('h2', {}, `${request.verifierName} möchte folgende Angaben sehen`),
    el('p', { class: 'muted attempt-code' }, `Versuch ${id.slice(0, 8)} · Du findest diesen Code auch am Kiosk.`),
    el('p', {}, eligible.length > 1 ? 'Mehrere Ausweise passen. Du entscheidest, welche Organisation du bei diesem Check-In vorzeigst.'
      : 'Dieser Ausweis passt zur Anwesenheitskontrolle. Prüfe die Angaben vor der Freigabe.'),
    form, progress.node, explain('sd'), explain('binding'), raw(request)));
  pollStatuses(wallet, candidates, optionViews, version, statuses);
}

function home(wallet, version) {
  const credentials = el('section', { class: 'stack wallet-credentials', 'aria-label': 'Deine Ausweise' });
  root.replaceChildren(el('h2', {}, 'Meine Ausweise'), credentials,
    el('section', { class: 'card' }, el('h2', {}, wallet.credentials.length ? 'Ausweis vorzeigen oder empfangen' : 'Einen Ausweis erhalten'),
      el('p', {}, wallet.credentials.length
        ? 'Scanne einen Check-In-QR oder den QR-Code für einen neuen Ausweis.'
        : 'Scanne den Ausstellungs-QR auf dem Laptop. Den Code erhältst du dort ebenfalls.'),
      scannerButton(version), explain('issuance')),
    pastedQr(),
    el('details', { class: 'card wallet-settings' }, el('summary', {}, 'Wallet-Details'),
      didCard(wallet.did),
      action(el('button', { type: 'button', class: 'secondary danger' }, 'Wallet zurücksetzen'), async () => {
      if (!confirm('Wallet-Schlüssel und Ausweise auf diesem Handy unwiderruflich löschen? Deine Organisation in der Workshop-Zentrale bleibt erhalten.')) return;
      removeStored('wallet', 'pendingOffer');
      await render();
    })));
  const entries = [...wallet.credentials].reverse();
  const views = entries.map(() => statusView());
  credentials.replaceChildren(
    ...entries.length ? entries.map((credential, index) => credentialCard(credential, wallet, views[index], version))
      : [el('section', { class: 'card empty-state wallet-empty' },
        el('div', { class: 'wallet-outline', 'aria-hidden': 'true' }),
        el('h2', {}, 'Noch keine Ausweise'),
        el('p', {}, 'Hier findest du deine gespeicherten Mitarbeiterausweise.'))]);
  if (entries.length) pollStatuses(wallet, entries, views, version);
}

async function render() {
  stopCamera();
  clearError();
  stopTimers();
  const version = ++renderVersion;
  root.replaceChildren(el('p', {}, 'Deine Wallet wird geladen …'));
  try {
    const url = canonicalWalletUrl(document.querySelector('meta[name="wallet-origin"]').content);
    if (url.origin !== location.origin) {
      location.replace(url.href);
      return;
    }
    const link = decodeOffer(location.hash);
    const wallet = readStored('wallet') || await ensureWallet(version);
    if (version !== renderVersion || !wallet) return;
    walletInitialization = undefined;
    if (link) return await issuance(wallet, link, version);
    const id = currentRequestId();
    if (id) {
      history.replaceState(null, '', '/wallet.html');
      return await consent(wallet, id, version);
    }
    home(wallet, version);
  } catch (error) {
    if (version !== renderVersion) return;
    if (!root.querySelector('.card')) root.replaceChildren(el('section', { class: 'card' },
      el('h2', {}, 'Gerade nicht möglich'),
      el('p', {}, location.hash.startsWith('#offer=')
        ? 'Prüfe deine Verbindung zur Workshop-Zentrale und die Freigabe deiner Organisation. Scanne bei einem abgelaufenen Angebot einen neuen QR vom Notebook.'
        : currentRequestId() ? 'Scanne den aktuellen Check-In-QR erneut, um einen neuen Versuch zu öffnen.'
          : 'Prüfe deine Verbindung zur Workshop-Zentrale. Gespeicherte Ausweise bleiben in diesem Browser erhalten.'),
      action(el('button', { type: 'button', class: 'secondary' }, 'Erneut versuchen'), render),
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome)));
    throw error;
  }
}

window.addEventListener('hashchange', () => run(render));
window.addEventListener('storage', (event) => {
  if (!event.key || event.key === 'wallet') run(render);
});
window.addEventListener('pagehide', () => { stopCamera(); stopTimers(); renderVersion++; });
window.addEventListener('pageshow', (event) => { if (event.persisted) run(render); });
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    stopCamera();
    stopTimers();
    renderVersion++;
  } else run(render);
});
run(render);
run(setupPage);
