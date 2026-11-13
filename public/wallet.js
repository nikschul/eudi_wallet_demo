import * as sd from './lib/sdjwt.js';
import { statusReference, loadStatusList, isRevoked } from './lib/credential-status.js';
import { EMPLOYEE_VCT, HOLDER_PROOF, decodeOffer, publicOrigin, signProof, canonicalWalletUrl } from './lib/protocol.js';
import { createCameraScanner, validateWalletQr } from './wallet-scanner.js';
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
const revokedCredentials = new Set();

function stopTimers() {
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
    el('p', {}, 'Scanne ein Angebot vom Notebook oder den QR am Empfang. Du bleibst in deiner Wallet.'),
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
        reason: revoked ? 'Die Ausweisstelle hat diesen Ausweis widerrufen. Kein Check-in möglich.'
          : 'Signatur und aktuelle signierte Statusliste geprüft: nicht widerrufen. Das Issuer-Vertrauen prüft der Empfang separat.',
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
  const reason = el('p', { class: 'muted' }, 'Eine aktuelle authentifizierte Statusprüfung steht noch aus. Kein Check-in möglich.');
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
    update({ ...current, state: 'unknown', reason: 'Die aktuelle Statusprüfung läuft. Ohne bestätigten Status ist kein Check-in möglich.' });
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

function journey(active) {
  return el('ol', { class: 'workshop-journey', 'aria-label': 'Dein Workshop-Fortschritt' },
    [active === 0 ? 'Wallet einmalig einrichten' : 'Wallet eingerichtet', 'Ausweis empfangen', 'Am Empfang einchecken'].map((title, index) => (
      el('li', { class: index === active ? 'current' : index < active ? 'complete' : '' }, `${index + 1}. ${title}`)
    )));
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
    el('p', { class: 'muted' }, 'In deiner Wallet gespeichert. Du entscheidest beim Vorzeigen, welche Angaben du teilst. Der Empfang prüft dabei den Nachweis und sein Vertrauen zum Issuer.'),
    el('p', { class: 'muted' }, `Gültig bis ${Number.isSafeInteger(payload.exp) ? new Date(payload.exp * 1000).toLocaleString('de-DE') : 'unbekannt'}`),
    status.reason, status.time,
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

function onboarding(version) {
  const fromOffer = location.hash.startsWith('#offer=');
  const create = action(el('button', { type: 'button' }, 'Wallet auf diesem Handy erstellen'), async () => {
    requireCrypto();
    if (readStored('wallet')) return render();
    const pair = await sd.generateKeyPair();
    if (version !== renderVersion) return;
    if (!readStored('wallet')) writeStored('wallet', { ...pair, credentials: [] });
    await render();
  });
  root.replaceChildren(journey(0), el('section', { class: 'card empty-state wallet-empty' },
    el('div', { class: 'wallet-outline', 'aria-hidden': 'true' }),
    el('h2', {}, 'Wallet einmalig auf diesem Handy einrichten'),
    el('p', {}, 'Verwalte deine Organisation am Notebook unter derselben Workshop-Adresse. Hier auf dem Handy verwahrst du deinen Ausweis und entscheidest später, was du teilst.'),
    el('p', {}, fromOffer ? 'Dein Ausstellungsangebot ist geöffnet. In diesem Browser wurde noch keine Wallet gefunden. Wenn dies dein erster Besuch ist, richte sie jetzt einmalig ein; dein Angebot bleibt erhalten.'
      : 'Keine Anmeldung und keine Installation: Dein Browser erzeugt einen persönlichen Schlüssel.'),
    el('div', { class: 'message warning' },
      el('strong', {}, 'Du hast schon eine Wallet eingerichtet? Nicht noch einmal anlegen.'),
      el('p', {}, 'Öffne die Wallet im selben Browser oder derselben installierten PWA wie bisher. Nutze dort „QR-Code scannen“ oder füge den QR-Link ein. Ein privates Fenster, eine andere Workshop-Adresse oder ein anderer Browser kann getrennten Speicher haben; Schlüssel werden nicht automatisch übertragen.'),
      el('p', { class: 'break-anywhere' }, `Aktuelle Wallet-Adresse: ${location.origin}/wallet.html`)),
    create, scannerButton(version), explain('keypair'),
    el('p', { class: 'muted' }, 'Bleibe im selben Browser oder derselben PWA. Eine installierte PWA kann auf iOS einen eigenen Speicher haben.')),
  pastedQr());
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
    el('p', { class: 'message notice' }, 'Deine vorhandene Wallet wird verwendet. Du musst sie nicht erneut einrichten.'),
    el('p', {}, 'Gib den sechsstelligen Ausgabecode vom Notebook ein. Nach erfolgreicher Prüfung wird der Ausweis automatisch signiert. Bleibe dazu auf diesem Handy. Dein privater Schlüssel wird nicht übertragen.'),
    action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome));
  root.replaceChildren(journey(1), panel);

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
      notify('Mitarbeiterausweis gespeichert. Du kannst jetzt am Empfang einchecken.');
    });
    panel.replaceChildren(el('span', { class: 'eyebrow' }, 'Automatisch von deiner Organisation signiert'),
      el('h2', {}, 'Dein Mitarbeiterausweis ist bereit'),
      el('p', {}, `Signatur, Bindung an deine Wallet und aktueller Widerrufsstatus wurden geprüft. Aussteller und signierte Organisation: ${issuer.name}.`),
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
      el('p', {}, 'Ausgabecode und Wallet-Schlüsselbesitz wurden geprüft. Bleibe auf diesem Handy: Die Organisation signiert automatisch, danach kannst du den Ausweis prüfen und speichern. Am Notebook ist keine weitere Aktion nötig.'),
      el('p', { class: 'muted' }, 'Dein privater Schlüssel bleibt hier auf dem Handy.'),
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
    el('p', { class: 'muted' }, 'Der Code steht nur am Notebook unter dem Angebots-QR. Er ist kein Wallet-Passwort und keine Freigabe durch den Empfang.'),
    el('button', { type: 'submit' }, 'Ausgabecode prüfen & Ausweis empfangen')),
  async (data) => connect(String(data.get('transactionCode')).trim()));
  panel.append(connectForm, explain('issuance'), raw({
    issuerDid: issuer.did, holderDid: wallet.did, expiresAt: offer.expiresAt,
  }, 'Öffentliche Verbindungsdaten anzeigen'));
}

async function consent(wallet, id, version) {
  let request = await api(`/requests/${encodeURIComponent(id)}`);
  if (version !== renderVersion) return;
  if (request.status !== 'pending') {
    throw new Error(request.status === 'expired' ? 'Dieser QR-Code ist abgelaufen. Bitte scanne den aktuellen Code am Empfang.'
      : 'Dieser Check-in-Versuch wurde schon verwendet. Bitte scanne den QR am Empfang erneut.');
  }
  if (request.mode === 'kiosk') {
    request = await api(`/requests/${encodeURIComponent(id)}/sessions`, { body: {} });
    if (version !== renderVersion) return;
    id = request.id;
  }
  const candidates = [...readWalletFor(wallet.did).credentials].reverse().sort((a, b) => b.receivedAt - a.receivedAt).filter((entry) => {
    try {
      const { payload, claims } = sd.describeCredential(entry.sdjwt);
      return payload.vct === request.vct && payload.exp * 1000 > Date.now()
        && request.required.every((field) => claims[field]);
    } catch { return false; }
  });
  if (!candidates.length) {
    root.replaceChildren(journey(1), el('section', { class: 'card' }, el('h2', {}, 'Dir fehlt noch dein Mitarbeiterausweis'),
      el('p', {}, 'Öffne deine freigegebene Organisation am Notebook unter dieser Workshop-Adresse. Erstelle dort ein Angebot und scanne dessen QR in deiner Wallet. Erst danach kommst du zum Empfang zurück.'),
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome), explain('issuance')));
    return;
  }
  const statuses = await credentialStatuses(candidates, wallet.did);
  if (version !== renderVersion) return;
  const index = statuses.findIndex((status) => status.state === 'active' && status.expiresAt > Date.now());
  if (index < 0) {
    root.replaceChildren(journey(2), el('section', { class: 'card' },
      el('h2', {}, 'Check-in derzeit nicht möglich'),
      el('p', {}, 'Kein passender Ausweis mit aktuellem, authentifiziertem und nicht widerrufenem Status verfügbar.'),
      statuses.map((status) => el('p', { class: 'message warning' }, status.reason)),
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome)));
    return;
  }
  const credential = candidates[index];
  storedCredential(wallet.did, credential);
  const { claims } = sd.describeCredential(credential.sdjwt);
  const status = statusView();
  status.update(statuses[index]);
  const choices = [...request.required, ...request.optional].map((field) => {
    const required = request.required.includes(field);
    return el('label', { class: 'disclosure-choice' },
      el('input', { type: 'checkbox', name: field, checked: required, disabled: required || !claims[field] }),
      el('span', {}, el('strong', {}, labels[field] || field), el('span', { class: 'muted' }, claims[field] || 'Nicht im Nachweis enthalten')),
      el('span', { class: 'choice-meta' }, required ? 'Pflicht' : 'Optional'));
  });
  const form = formAction(el('form', { class: 'stack' },
    el('fieldset', {}, el('legend', {}, 'Welche Angaben möchtest du teilen?'), choices),
    el('p', { class: 'privacy-note' }, 'Die freigegebenen Angaben werden mit Aussteller, Nachweistyp und Zeit am Fernseher für alle sichtbar gespeichert. Auch abgelehnte Versuche erscheinen dort mit dem angegebenen, dann noch ungeprüften Namen und Fehlergrund. Nicht ausgewählte Angaben bleiben verborgen. Verwende nur Demo-Daten.'),
    el('button', { type: 'submit' }, 'Freigeben & einchecken'),
    action(el('button', { type: 'button', class: 'secondary' }, 'Ablehnen'), goHome)), async () => {
    if (version !== renderVersion) return;
    try {
      requireCrypto();
      storedCredential(wallet.did, credential);
      const [fresh] = await credentialStatuses([credential], wallet.did);
      if (version !== renderVersion) return;
      status.update(fresh);
      if (fresh.state !== 'active') throw new Error(`Check-in nicht möglich: ${fresh.reason}`);
      const current = storedCredential(wallet.did, credential);
      const reveal = [...request.required, ...request.optional.filter((field) => form.elements.namedItem(field)?.checked)];
      const presentation = await sd.createPresentation({
        sdjwt: credential.sdjwt, reveal, holderPrivateJwk: current.privateJwk, aud: request.aud, nonce: request.nonce,
      });
      if (version !== renderVersion) return;
      storedCredential(wallet.did, credential);
      if (revokedCredentials.has(credential.sdjwt)) throw new Error('Die Ausweisstelle hat diesen Ausweis widerrufen. Kein Check-in möglich.');
      if (fresh.expiresAt <= Date.now()) throw new Error('Die Statusprüfung ist inzwischen abgelaufen. Bitte versuche es erneut.');
      const result = await api(`/requests/${encodeURIComponent(id)}/response`, { body: { presentation } });
      if (version !== renderVersion) return;
      stopTimers();
      renderVersion++;
      root.replaceChildren(journey(2), el('section', { class: `card result-card ${result.ok ? 'success' : 'failure'}` },
        el('span', { class: 'result-symbol', 'aria-hidden': 'true' }, result.ok ? '✓' : '✗'),
        el('h2', {}, result.ok ? 'Du bist eingecheckt' : 'Check-in nicht möglich'),
        el('p', { class: 'attempt-code' }, `Versuch ${id.slice(0, 8)}`),
        el('p', {}, result.ok ? 'Am Fernseher siehst du genau die von dir geteilten Angaben.' : result.error),
        result.ok ? attributes(result.claims) : el('p', {}, result.failedAt === 'Issuer-Vertrauen'
          ? 'Der Empfang akzeptiert den Issuer derzeit nicht. Bitte kläre dessen Setup mit der Moderation. Der Ausweis bleibt unverändert in deiner Wallet; er benötigt keine nachträgliche Freigabe.'
          : 'Bitte beachte den Prüfgrund unten. Deine gespeicherten Ausweise bleiben erhalten.'),
        steps(result), explain('trust'), raw(result), action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome)));
    } catch (error) {
      if (version === renderVersion) throw error;
    }
  });
  root.replaceChildren(journey(2), el('section', { class: 'card' },
    el('h2', {}, `${request.verifierName} möchte folgende Angaben sehen`),
    el('p', { class: 'muted attempt-code' }, `Versuch ${id.slice(0, 8)} · Du findest diesen Code auch am Kiosk.`),
    status.badge, status.reason, status.time, form, explain('sd'), explain('binding'), raw(request)));
  pollStatuses(wallet, [credential], [status], version, [statuses[index]]);
}

function home(wallet, version) {
  const credentials = el('section', { class: 'stack wallet-credentials', 'aria-label': 'Deine Ausweise' });
  root.replaceChildren(el('h2', {}, 'Meine Ausweise'), credentials,
    el('section', { class: 'card' }, el('h2', {}, wallet.credentials.length ? 'Ausweis am Empfang vorzeigen' : 'Einen Ausweis erhalten'),
      el('p', {}, wallet.credentials.length
        ? 'Erst wenn du den Empfangs-QR scannst oder dessen Link bewusst öffnest, fragt der Empfang nach Angaben aus deinem Ausweis. Hier siehst du nur deine gespeicherten Ausweise.'
        : 'Öffne deine freigegebene Organisation am Notebook unter dieser Workshop-Adresse. Erstelle dort ein Angebot und scanne dessen QR hier in der Wallet.'),
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
        el('p', {}, 'Deine Wallet ist eingerichtet. Scanne den Ausstellungs-QR auf deinem Notebook, um deinen Mitarbeiterausweis zu erhalten.'))]);
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
      root.replaceChildren(el('section', { class: 'card' },
        el('h2', {}, 'Wallet unter der Workshop-Adresse öffnen'),
        el('p', { class: 'message warning' }, 'Du hast die Zentrale unter einer anderen Adresse geöffnet. Richte hier keine zweite Wallet ein. Alle Smartphone-Schritte verwenden dieselbe öffentliche Workshop-Adresse.'),
        el('p', { class: 'break-anywhere' }, `Workshop-Adresse: ${url.origin}`),
        el('p', {}, 'Bereits unter einer anderen Adresse gespeicherte Schlüssel bleiben dort und werden nicht übertragen. Nutze für eine vorhandene Wallet deren bisherigen Browser und dieselbe Workshop-Adresse; bei einem Tunnelwechsel hilft dir die Moderation.'),
        el('a', { class: 'button', href: url.href }, 'Zur Wallet der Workshop-Zentrale')));
      return;
    }
    const link = decodeOffer(location.hash);
    const wallet = readStored('wallet');
    if (!wallet) return onboarding(version);
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
        : currentRequestId() ? 'Scanne den aktuellen QR am Empfang erneut, um einen neuen persönlichen Check-in-Versuch zu öffnen.'
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
