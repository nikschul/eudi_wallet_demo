import * as sd from './lib/sdjwt.js';
import { EMPLOYEE_VCT, HOLDER_PROOF, decodeOffer, publicOrigin, signProof } from './lib/protocol.js';
import {
  el, api, explain, raw, attributes, steps, labels, action, formAction,
  run, setupPage, readStored, writeStored, removeStored, requireCrypto, didCard, clearError,
  currentRequestId, readWalletFor,
} from './lib/ui.js';

const root = document.getElementById('app');
let renderVersion = 0;
let offerTimer;
function ensureIssuerConnection(baseUrl) {
  const origins = JSON.parse(document.querySelector('meta[name="issuer-origins"]').content);
  if (!origins.includes(baseUrl)) {
    // Reload when a new issuer was registered after this document's CSP was set.
    location.reload();
    return false;
  }
  return true;
}

function goHome() {
  history.replaceState(null, '', '/wallet.html');
  return render();
}

function journey(active) {
  return el('ol', { class: 'workshop-journey', 'aria-label': 'Dein Workshop-Fortschritt' },
    ['Wallet einrichten', 'Ausweis empfangen', 'Am Empfang einchecken'].map((title, index) => (
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

function credentialCard(credential, issuers) {
  const { claims, payload } = sd.describeCredential(credential.sdjwt);
  const issuer = issuers?.find((entry) => entry.did === payload.iss);
  const trusted = issuer?.trusted && issuer.proofVerified && issuer.ownerName;
  const view = el('div', { role: 'tabpanel', id: `view-${credential.id}` }, attributes(claims));
  const data = el('div', { role: 'tabpanel', id: `raw-${credential.id}`, hidden: true }, credentialRaw(credential));
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
  const expired = payload.exp * 1000 <= Date.now();
  return el('article', { class: 'card credential' },
    el('div', { class: 'card-top' }, el('span', { class: 'eyebrow' }, payload.vct === EMPLOYEE_VCT ? 'Mitarbeiterausweis' : 'Alter Nachweis – nicht für diesen Workshop'),
      el('span', { class: `badge ${expired ? 'badge-warn' : ''}` }, expired ? 'Abgelaufen' : 'Signiert')),
    el('h2', {}, `${claims.given_name || ''} ${claims.family_name || ''}`.trim()),
    el('p', { class: 'muted' }, `Ausgestellt von ${credential.issuerName}`),
    el('p', { class: `message ${trusted ? 'notice' : 'warning'}` },
      issuers === null ? 'Vertrauensstatus gerade nicht erreichbar. Die gespeicherte Signatur bleibt prüfbar.'
        : trusted ? `Vom Empfang freigegeben: Issuer von ${issuer.ownerName}.`
          : 'Noch nicht vom Empfang freigegeben. Eine gültige Signatur allein reicht für den Check-in nicht.'),
    el('p', { class: 'muted' }, `Gültig bis ${new Date(payload.exp * 1000).toLocaleString('de-DE')}`),
    el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Nachweis-Details' }, viewTab, rawTab),
    view, data, explain('credential'));
}

function onboarding() {
  const fromOffer = location.hash.startsWith('#offer=');
  const create = action(el('button', { type: 'button' }, 'Wallet auf diesem Handy erstellen'), async () => {
    requireCrypto();
    const pair = await sd.generateKeyPair();
    writeStored('wallet', { ...pair, credentials: [] });
    await render();
  });
  root.replaceChildren(journey(0), el('section', { class: 'card' },
    el('span', { class: 'step-number' }, '01'),
    el('h2', {}, 'Dein Handy wird zu deiner Wallet'),
    el('p', {}, 'Die Ausweisstelle läuft auf deinem Rechner. Hier auf dem Handy verwahrst du deinen Ausweis und entscheidest später, was du teilst.'),
    el('p', {}, fromOffer ? 'Dein Ausstellungsangebot wartet bereits. Richte zuerst deine Wallet ein; danach geht es automatisch weiter.'
      : 'Keine Anmeldung und keine Installation: Dein Browser erzeugt einen persönlichen Schlüssel.'),
    create, explain('keypair'),
    el('p', { class: 'muted' }, 'Bleibe im selben normalen Browser. Eine installierte PWA kann auf iOS einen eigenen Speicher haben.')));
}

async function holderProof(wallet, offer) {
  const current = readWalletFor(wallet.did);
  return signProof(HOLDER_PROOF, {
    iss: current.did, aud: offer.aud, nonce: offer.nonce, jwk: current.publicJwk,
  }, current.privateJwk);
}

async function issuance(wallet, link, version) {
  const issuers = await api('/issuers');
  const issuer = issuers.find((entry) => entry.did === link.issuer && entry.proofVerified);
  if (!issuer) throw new Error('Diese Ausweisstelle ist noch nicht beim Workshop registriert. Melde sie zuerst auf deinem Rechner an und scanne den QR erneut.');
  const baseUrl = publicOrigin(issuer.publicUrl, 'Issuer-Adresse');
  if (!ensureIssuerConnection(baseUrl)) return;
  const remote = (suffix = '', body) => api(`/offers/${encodeURIComponent(link.id)}${suffix}`, {
    baseUrl, offerToken: link.token, ...(body === undefined ? {} : { body }),
  });
  const offer = await remote();
  if (version !== renderVersion) return;
  if (offer.issuerDid !== issuer.did || offer.aud !== baseUrl) throw new Error('Das Angebot passt nicht zur registrierten Ausweisstelle.');
  const trustNotice = el('p', { class: `message ${issuer.trusted ? 'notice' : 'warning'}` },
    issuer.trusted ? `Der Empfang vertraut diesem Issuer von ${issuer.ownerName}.`
      : 'Dieser Issuer wartet auf die Freigabe durch die Moderation. Du kannst den Ausweis schon erhalten, aber noch nicht am Empfang verwenden.');
  const panel = el('section', { class: 'card' },
    el('span', { class: 'eyebrow' }, 'Angebot deiner Ausweisstelle'),
    el('h2', {}, issuer.name), trustNotice, attributes(offer.claims),
    el('p', {}, 'Der Ausweis wird erst nach deiner Verbindung auf dem Rechner signiert. Es wird nur dein öffentlicher Schlüssel übertragen.'));
  root.replaceChildren(journey(1), panel);

  async function displayIssued(state) {
    const received = await remote('/credential', { proof: await holderProof(wallet, offer) });
    const description = sd.describeCredential(received.sdjwt);
    if (description.payload.vct !== EMPLOYEE_VCT || description.payload.iss !== issuer.did
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
    if (version !== renderVersion) return;
    const accept = action(el('button', { type: 'button' }, 'Ausweis in Wallet speichern'), async () => {
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
      history.replaceState(null, '', '/wallet.html');
      renderVersion++;
      root.replaceChildren(journey(2), el('section', { class: 'card success result-card' },
        el('span', { class: 'result-symbol', 'aria-hidden': 'true' }, '✓'),
        el('h2', {}, 'Dein Mitarbeiterausweis ist in der Wallet'),
        el('p', {}, 'Nimm dein Handy zum Fernseher und scanne dort den großen Check-in-QR. Dein Issuer wird dafür nicht mehr benötigt.'),
        action(el('button', { type: 'button' }, 'Meine Wallet öffnen'), goHome)));
    });
    panel.replaceChildren(el('span', { class: 'eyebrow' }, 'Auf deinem Rechner signiert'),
      el('h2', {}, 'Dein Mitarbeiterausweis ist bereit'),
      el('p', {}, `Signatur und Bindung an deine Wallet wurden geprüft. Aussteller: ${issuer.name}.`),
      trustNotice, attributes(description.claims), accept, explain('credential'),
      credentialRaw(received));
  }

  async function waitForIssue() {
    try {
      const state = await remote();
      if (version !== renderVersion) return;
      if (['issued', 'accepted'].includes(state.status)) return await displayIssued(state);
      const message = panel.querySelector('[data-pairing]');
      if (message) message.textContent = `Vergleichscode: ${state.pairingCode || offer.pairingCode || '…'}`;
      offerTimer = setTimeout(waitForIssue, 1500);
    } catch (error) {
      if (version !== renderVersion) return;
      const retry = action(el('button', { type: 'button', class: 'secondary' }, 'Verbindung erneut prüfen'), () => render());
      panel.append(el('div', { class: 'message error', role: 'alert' }, error.message), retry);
    }
  }

  async function connect() {
    requireCrypto();
    const bound = await remote('/claim', { proof: await holderProof(wallet, offer) });
    if (version !== renderVersion) return;
    panel.replaceChildren(el('span', { class: 'eyebrow' }, 'Wallet verbunden'),
      el('h2', {}, 'Jetzt geht es auf deinem Rechner weiter'),
      el('p', {}, 'Vergleiche den Code auf beiden Geräten. Klicke dann in deiner Ausweisstelle auf „Mitarbeiterausweis jetzt signieren“.'),
      el('p', { class: 'pairing-code', 'data-pairing': true }, `Vergleichscode: ${bound.pairingCode || offer.pairingCode || '…'}`),
      el('p', { class: 'muted' }, 'Dein privater Schlüssel bleibt hier auf dem Handy.'),
      explain('binding'));
    await waitForIssue();
  }
  const connectButton = action(el('button', { type: 'button' }, 'Wallet mit Ausweisstelle verbinden'), connect);
  panel.append(connectButton, explain('issuance'), raw({
    issuerDid: issuer.did, holderDid: wallet.did, expiresAt: offer.expiresAt,
  }, 'Öffentliche Verbindungsdaten anzeigen'));
}

async function consent(wallet, id, version) {
  const request = await api(`/requests/${encodeURIComponent(id)}`);
  if (version !== renderVersion) return;
  if (request.status !== 'pending') {
    throw new Error(request.status === 'expired' ? 'Dieser QR-Code ist abgelaufen. Bitte scanne den aktuellen Code am Empfang.'
      : 'Dieser QR-Code wurde schon verwendet. Bitte scanne einen neuen Code.');
  }
  const credential = [...wallet.credentials].reverse().sort((a, b) => b.receivedAt - a.receivedAt).find((entry) => {
    const { payload } = sd.describeCredential(entry.sdjwt);
    return payload.vct === request.vct && payload.exp * 1000 > Date.now();
  });
  if (!credential) {
    root.replaceChildren(journey(1), el('section', { class: 'card' }, el('h2', {}, 'Dir fehlt noch dein Mitarbeiterausweis'),
      el('p', {}, 'Öffne deine eigene Ausweisstelle auf dem Rechner. Bereite dort die Ausstellung vor und scanne deren QR mit diesem Handy. Erst danach kommst du zum Empfang zurück.'),
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome), explain('issuance')));
    return;
  }
  const { claims } = sd.describeCredential(credential.sdjwt);
  if (request.required.some((field) => !claims[field])) throw new Error('Deinem Nachweis fehlen Pflichtangaben. Bitte stelle einen neuen Mitarbeiterausweis aus.');
  const choices = [...request.required, ...request.optional].map((field) => {
    const required = request.required.includes(field);
    return el('label', { class: 'disclosure-choice' },
      el('input', { type: 'checkbox', name: field, checked: required, disabled: required || !claims[field] }),
      el('span', {}, el('strong', {}, labels[field] || field), el('span', { class: 'muted' }, claims[field] || 'Nicht im Nachweis enthalten')),
      el('span', { class: 'choice-meta' }, required ? 'Pflicht' : 'Optional'));
  });
  const form = formAction(el('form', { class: 'stack' },
    el('fieldset', {}, el('legend', {}, 'Welche Angaben möchtest du teilen?'), choices),
    el('p', { class: 'privacy-note' }, 'Die freigegebenen Angaben werden mit Aussteller, Nachweistyp und Zeit am Fernseher für alle sichtbar gespeichert. Nicht ausgewählte Angaben bleiben verborgen. Verwende nur Demo-Daten.'),
    el('button', { type: 'submit' }, 'Freigeben & einchecken'),
    action(el('button', { type: 'button', class: 'secondary' }, 'Ablehnen'), goHome)), async () => {
    requireCrypto();
    const current = readWalletFor(wallet.did);
    const reveal = [...request.required, ...request.optional.filter((field) => form.elements.namedItem(field)?.checked)];
    const presentation = await sd.createPresentation({
      sdjwt: credential.sdjwt, reveal, holderPrivateJwk: current.privateJwk, aud: request.aud, nonce: request.nonce,
    });
    readWalletFor(wallet.did);
    const result = await api(`/requests/${encodeURIComponent(id)}/response`, { body: { presentation } });
    root.replaceChildren(journey(2), el('section', { class: `card result-card ${result.ok ? 'success' : 'failure'}` },
      el('span', { class: 'result-symbol', 'aria-hidden': 'true' }, result.ok ? '✓' : '✗'),
      el('h2', {}, result.ok ? 'Du bist eingecheckt' : 'Check-in nicht möglich'),
      el('p', {}, result.ok ? 'Am Fernseher siehst du genau die von dir geteilten Angaben.' : result.error),
      result.ok ? attributes(result.claims) : el('p', {}, 'Wenn die Vertrauensfreigabe fehlt: Bitte die Moderation um Freigabe deines Issuers. Danach denselben Ausweis mit einem neuen Check-in-QR verwenden.'),
      steps(result), explain('trust'), raw(result), action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome)));
  });
  root.replaceChildren(journey(2), el('section', { class: 'card' }, el('span', { class: 'eyebrow' }, 'Vorzeigen statt neu ausstellen'),
    el('h2', {}, `${request.verifierName} möchte folgende Angaben sehen`), form, explain('sd'), explain('binding'), raw(request)));
}

async function home(wallet, version) {
  const credentials = el('section', { class: 'stack' }, el('h2', {}, 'Meine Nachweise'));
  const linkInput = el('input', { type: 'url', name: 'link', required: true, id: 'checkin-url', placeholder: 'https://…/wallet.html#…', autocomplete: 'off' });
  const linkForm = formAction(el('form', { class: 'stack' },
    el('label', { for: 'checkin-url' }, 'QR-Link einfügen (zum Beispiel in der installierten PWA)'), linkInput,
    el('button', { type: 'submit', class: 'secondary' }, 'QR-Link öffnen')), async (data) => {
    const url = new URL(data.get('link'));
    if (url.origin !== location.origin || url.pathname !== '/wallet.html'
      || (!/^#req=[a-f0-9-]{36}$/.test(url.hash) && !decodeOffer(url.hash))) {
      throw new Error('Bitte verwende einen Wallet-QR-Link dieser Workshop-Zentrale.');
    }
    history.replaceState(null, '', url.pathname + url.hash);
    await render();
  });
  root.replaceChildren(journey(wallet.credentials.length ? 2 : 1), didCard(wallet.did), credentials,
    el('section', { class: 'card' }, el('h2', {}, wallet.credentials.length ? 'Nächster Schritt: Empfang' : 'Nächster Schritt: eigener Issuer'),
      el('p', {}, wallet.credentials.length
        ? 'Scanne mit der Kamera den großen QR am Fernseher. Dort zeigst du deinen vorhandenen Ausweis vor.'
        : 'Hoste deine Ausweisstelle auf deinem Rechner. Erstelle dort ein Angebot und scanne dessen QR mit diesem Handy. Deine Wallet bleibt hier.'),
      explain('issuance')),
    action(el('button', { type: 'button', class: 'secondary' }, 'Vertrauensstatus aktualisieren'), render),
    el('details', { class: 'card' }, el('summary', {}, 'QR-Link öffnen'), linkForm),
    action(el('button', { type: 'button', class: 'secondary danger' }, 'Wallet zurücksetzen'), async () => {
      if (!confirm('Wallet-Schlüssel und Ausweise auf diesem Handy unwiderruflich löschen? Die Ausweisstelle auf deinem Rechner bleibt erhalten.')) return;
      removeStored('wallet', 'pendingOffer');
      await render();
    }));
  const show = (issuers) => credentials.replaceChildren(el('h2', {}, 'Meine Nachweise'),
    ...wallet.credentials.length ? [...wallet.credentials].reverse().map((entry) => credentialCard(entry, issuers))
      : [el('p', { class: 'muted' }, 'Noch kein Ausweis vorhanden. Deine Wallet ist bereit für das Angebot vom Rechner.')]);
  show(null);
  try {
    const issuers = await api('/issuers');
    if (version === renderVersion) show(issuers);
  } catch (error) {
    if (version === renderVersion) throw error;
  }
}

async function render() {
  clearError();
  clearTimeout(offerTimer);
  const version = ++renderVersion;
  root.replaceChildren(el('p', {}, 'Deine Wallet wird geladen …'));
  try {
    const wallet = readStored('wallet');
    if (!wallet) return onboarding();
    const link = decodeOffer(location.hash);
    if (link) return await issuance(wallet, link, version);
    const id = currentRequestId();
    if (id) return await consent(wallet, id, version);
    await home(wallet, version);
  } catch (error) {
    if (version !== renderVersion) return;
    if (!root.querySelector('.card')) root.replaceChildren(el('section', { class: 'card' },
      el('h2', {}, 'Gerade nicht möglich'),
      el('p', {}, 'Prüfe, ob dein Issuer und sein Tunnel laufen. Bei einer neuen Tunnel-Adresse: Issuer neu anmelden und den QR erneut scannen.'),
      action(el('button', { type: 'button', class: 'secondary' }, 'Erneut versuchen'), render),
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), goHome)));
    throw error;
  }
}

window.addEventListener('hashchange', () => run(render));
window.addEventListener('storage', (event) => {
  if (!event.key || event.key === 'wallet') run(render);
});
window.addEventListener('pagehide', () => { clearTimeout(offerTimer); renderVersion++; });
window.addEventListener('pageshow', (event) => { if (event.persisted) run(render); });
run(render);
run(setupPage);
