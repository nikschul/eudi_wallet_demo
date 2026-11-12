import * as sd from './lib/sdjwt.js';
import {
  el, api, explain, raw, attributes, steps, labels, action, formAction,
  run, setupPage, readStored, writeStored, removeStored, requireCrypto, didCard, clearError,
  currentRequestId, readWalletFor, updateRequestLinks,
} from './lib/ui.js';

const root = document.getElementById('app');
let renderVersion = 0;
const requestId = () => currentRequestId();
const issuerLink = () => `/issuer.html${requestId() ? `?req=${encodeURIComponent(requestId())}` : ''}`;

function goHome(continueRequest = false) {
  const id = continueRequest ? requestId() : null;
  history.replaceState(null, '', `/wallet.html${id ? `#req=${encodeURIComponent(id)}` : ''}`);
  return render();
}

function credentialRaw(credential) {
  const description = sd.describeCredential(credential.sdjwt);
  return el('div', {}, raw({
    header: description.header,
    payload: description.payload,
    disclosures: description.disclosures.map((disclosure) => disclosure.value),
    sdjwt: credential.sdjwt,
  }), explain('sd'));
}

function credentialCard(credential) {
  const { claims, payload } = sd.describeCredential(credential.sdjwt);
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
    el('div', { class: 'card-top' }, el('span', { class: 'eyebrow' }, 'Gastausweis'),
      el('span', { class: `badge ${expired ? 'badge-warn' : ''}` }, expired ? 'Abgelaufen' : 'Signiert')),
    el('h2', {}, `${claims.given_name || ''} ${claims.family_name || ''}`.trim()),
    el('p', { class: 'muted' }, `Ausgestellt von ${credential.issuerName}`),
    el('p', { class: 'muted' }, `Gültig bis ${new Date(payload.exp * 1000).toLocaleString('de-DE')}`),
    el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Nachweis-Details' }, viewTab, rawTab),
    view, data, explain('credential'));
}

function onboarding() {
  const create = action(el('button', { type: 'button' }, 'Wallet erstellen'), async () => {
    requireCrypto();
    const pair = await sd.generateKeyPair();
    writeStored('wallet', { ...pair, credentials: [] });
    await render();
  });
  root.replaceChildren(el('section', { class: 'card' },
    el('span', { class: 'step-number' }, '01'),
    el('h2', {}, 'Dein Schlüssel zur digitalen Identität'),
    el('p', {}, 'Erstelle eine Wallet direkt auf deinem Handy. Keine Anmeldung, keine Installation.'),
    create, explain('keypair')));
}

async function offer(wallet, version) {
  const pending = readStored('pendingOffer');
  if (!pending) {
    root.replaceChildren(el('section', { class: 'card' }, el('h2', {}, 'Kein Angebot vorhanden'),
      el('p', {}, 'Stelle dir zuerst einen Gastausweis aus.'), el('a', { class: 'button', href: issuerLink() }, 'Zum Issuer')));
    return;
  }
  const description = sd.describeCredential(pending.sdjwt);
  await sd.verifyJwt(sd.parseSdJwt(pending.sdjwt).jwt, sd.jwkFromDid(description.payload.iss));
  if (sd.didFromJwk(description.payload.cnf.jwk) !== wallet.did) {
    throw new Error('Dieser Gastausweis gehört zu einer anderen Wallet. Bitte stelle einen neuen Nachweis aus.');
  }
  if (description.payload.exp * 1000 <= Date.now()) throw new Error('Dieses Angebot ist abgelaufen. Bitte stelle einen neuen Gastausweis aus.');
  if (version !== renderVersion) return;
  const accept = action(el('button', { type: 'button' }, 'Annehmen'), async () => {
    const currentWallet = readWalletFor(wallet.did);
    if (readStored('pendingOffer')?.sdjwt !== pending.sdjwt) {
      throw new Error('Dieses Angebot wurde bereits angenommen oder ersetzt. Bitte lade die Seite neu.');
    }
    const credential = {
      id: crypto.randomUUID(), ...pending, receivedAt: Math.floor(Date.now() / 1000),
    };
    writeStored('wallet', { ...currentWallet, credentials: [...currentWallet.credentials, credential] });
    removeStored('pendingOffer');
    await goHome(true);
  });
  const decline = action(el('button', { type: 'button', class: 'secondary' }, 'Ablehnen'), async () => {
    removeStored('pendingOffer');
    await goHome();
  });
  root.replaceChildren(el('section', { class: 'card' },
    el('span', { class: 'eyebrow' }, 'Neuer Nachweis'),
    el('h2', {}, 'Dein Gastausweis ist bereit'),
    el('p', {}, `Angebot von ${pending.issuerName}`), attributes(description.claims),
    el('div', { class: 'actions' }, accept, decline), explain('credential'), credentialRaw(pending)));
}

async function consent(wallet, id, version) {
  const request = await api(`/requests/${encodeURIComponent(id)}`);
  if (version !== renderVersion) return;
  if (request.status !== 'pending') {
    throw new Error(request.status === 'expired'
      ? 'Dieser QR-Code ist abgelaufen. Bitte scanne den aktuellen Code am Empfang.'
      : 'Dieser QR-Code wird bereits geprüft oder wurde schon verwendet. Bitte scanne einen neuen Code.');
  }
  const credential = [...wallet.credentials].reverse().sort((a, b) => b.receivedAt - a.receivedAt).find((entry) => {
    const { payload } = sd.describeCredential(entry.sdjwt);
    return payload.vct === request.vct && payload.exp * 1000 > Date.now();
  });
  if (!credential) {
    root.replaceChildren(el('section', { class: 'card' }, el('h2', {}, 'Du brauchst zuerst einen Gastausweis'),
      el('p', {}, 'Lege deinen eigenen Issuer an und stelle dir einen gültigen Nachweis aus. Danach geht es hier mit dem Check-in weiter.'),
      el('a', { class: 'button', href: issuerLink() }, 'Eigenen Issuer anlegen'), explain('credential')));
    return;
  }
  const { claims } = sd.describeCredential(credential.sdjwt);
  if (request.required.some((field) => !claims[field])) throw new Error('Deinem Nachweis fehlen Pflichtangaben. Bitte stelle einen neuen Gastausweis aus.');
  const checkboxes = [...request.required, ...request.optional].map((field) => {
    const required = request.required.includes(field);
    const checkbox = el('input', {
      type: 'checkbox', name: field, checked: required, disabled: required || !claims[field],
    });
    return el('label', { class: 'disclosure-choice' }, checkbox,
      el('span', {}, el('strong', {}, labels[field] || field),
        el('span', { class: 'muted' }, claims[field] || 'Nicht im Nachweis enthalten')),
      el('span', { class: 'choice-meta' }, required ? 'Pflicht' : 'Optional'));
  });
  const submit = el('button', { type: 'submit' }, 'Freigeben & einchecken');
  const decline = action(el('button', { type: 'button', class: 'secondary' }, 'Ablehnen'), () => goHome());
  const form = formAction(el('form', { class: 'stack' },
    el('fieldset', {}, el('legend', {}, 'Diese Angaben möchtest du teilen'), checkboxes),
    el('p', { class: 'privacy-note' }, 'Nur angehakte Angaben verlassen deine Wallet. Organisation und Rolle bleiben standardmäßig privat.'),
    submit, decline), async () => {
    requireCrypto();
    const currentWallet = readWalletFor(wallet.did);
    const reveal = [...request.required, ...request.optional.filter((field) => form.elements.namedItem(field)?.checked)];
    const presentation = await sd.createPresentation({
      sdjwt: credential.sdjwt, reveal, holderPrivateJwk: currentWallet.privateJwk, aud: request.aud, nonce: request.nonce,
    });
    readWalletFor(wallet.did);
    const result = await api(`/requests/${encodeURIComponent(id)}/response`, { body: { presentation } });
    root.replaceChildren(el('section', { class: `card result-card ${result.ok ? 'success' : 'failure'}` },
      el('span', { class: 'result-symbol', 'aria-hidden': 'true' }, result.ok ? '✓' : '✗'),
      el('h2', {}, result.ok ? 'Du bist eingecheckt' : 'Check-in nicht möglich'),
      el('p', {}, result.ok ? 'Willkommen! Deine Wallet hat nur die ausgewählten Angaben geteilt.' : result.error),
      steps(result), explain('verify'), raw({ presentation, result }),
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), () => goHome())));
  });
  root.replaceChildren(el('section', { class: 'card' },
    el('span', { class: 'eyebrow' }, '03 / Check-in'),
    el('h2', {}, `${request.verifierName} möchte folgende Angaben sehen`),
    el('p', { class: 'muted' }, 'Du entscheidest, was du teilst.'), form,
    explain('sd'), explain('binding'), raw(request, 'Anfrage als Rohdaten anzeigen')));
}

function home(wallet) {
  const reset = action(el('button', { type: 'button', class: 'danger secondary' }, 'Wallet zurücksetzen'), async () => {
    if (!confirm('Wallet und Gastausweise auf diesem Gerät unwiderruflich löschen? Dein Issuer bleibt erhalten.')) return;
    removeStored('wallet', 'pendingOffer');
    await render();
  });
  const linkInput = el('input', {
    type: 'url', name: 'link', required: true, placeholder: 'https://…/wallet.html#req=…',
    autocomplete: 'off', id: 'checkin-url',
  });
  const linkForm = formAction(el('form', { class: 'stack' },
    el('label', { for: 'checkin-url' }, 'Empfangslink (für installierte PWA)'),
    linkInput, el('button', { type: 'submit', class: 'secondary' }, 'Check-in-Link öffnen')), async (data) => {
    const url = new URL(data.get('link'));
    if (url.origin !== location.origin || url.pathname !== '/wallet.html' || !/^#req=[a-f0-9-]{36}$/.test(url.hash)) {
      throw new Error('Bitte füge einen Check-in-Link dieses Empfangs ein. Du findest ihn im QR-Code am Kiosk.');
    }
    history.replaceState(null, '', url.pathname + url.hash);
    await render();
  });
  root.replaceChildren(
    didCard(wallet.did),
    el('section', { class: 'stack' }, el('h2', {}, 'Meine Nachweise'),
      wallet.credentials.length
        ? [...wallet.credentials].reverse().map(credentialCard)
        : el('div', { class: 'card empty-state' }, el('h3', {}, 'Platz für deinen ersten Gastausweis'),
          el('p', {}, 'Deine Wallet ist bereit. Jetzt wirst du selbst zum Aussteller.'))),
    el('a', { class: 'button', href: issuerLink() }, 'Eigenen Issuer anlegen'),
    explain('keypair'),
    el('details', { class: 'card' }, el('summary', {}, 'Check-in-Link öffnen'), linkForm),
    el('div', { class: 'reset-area' }, reset));
}

async function render() {
  clearError();
  updateRequestLinks();
  const version = ++renderVersion;
  root.replaceChildren(el('p', {}, 'Deine Wallet wird geladen …'));
  try {
    const wallet = readStored('wallet');
    if (!wallet) return onboarding();
    if (location.hash === '#offer') return await offer(wallet, version);
    const id = requestId();
    if (id) return await consent(wallet, id, version);
    home(wallet);
  } catch (error) {
    if (version !== renderVersion) return;
    root.replaceChildren(el('section', { class: 'card' },
      el('h2', {}, 'Gerade nicht möglich'),
      el('p', {}, 'Deine gespeicherten Nachweise bleiben erhalten. Öffne deine Wallet oder scanne den aktuellen QR-Code am Empfang.'),
      action(el('button', { type: 'button', class: 'secondary' }, 'Zur Wallet'), () => goHome())));
    throw error;
  }
}

window.addEventListener('hashchange', () => run(render));
window.addEventListener('storage', (event) => {
  if (!event.key || ['wallet', 'pendingOffer'].includes(event.key)) run(render);
});
run(render);
run(setupPage);
