import * as sd from './lib/sdjwt.js';
import {
  el, api, explain, raw, attributes, action, formAction, run, setupPage,
  readStored, writeStored, requireCrypto, didCard,
  readWalletFor,
} from './lib/ui.js';

const root = document.getElementById('app');
const req = new URLSearchParams(location.search).get('req');
const walletUrl = `/wallet.html${req ? `#req=${encodeURIComponent(req)}` : ''}`;

function inputField(name, label, { required = false, value = '', autocomplete = 'off' } = {}) {
  return el('label', { class: 'field' }, label,
    el('input', { name, required, value, maxlength: 120, autocomplete }));
}

async function register(issuer) {
  return api('/issuers', { body: { did: issuer.did, name: issuer.name } });
}

async function showIssuer(wallet, issuer) {
  const status = el('p', { class: 'message notice', role: 'status' }, 'Vertrauensstatus wird geladen …');
  const refresh = action(el('button', { type: 'button', class: 'secondary' }, 'Status aktualisieren'), async () => {
    const registered = await register(issuer);
    status.textContent = registered.trusted ? 'Vertrauenswürdig – bereit für den Check-in'
      : 'Wartet auf Freigabe durch den Empfang';
    status.className = `message ${registered.trusted ? 'notice' : 'warning'}`;
  });
  const role = el('label', { class: 'field' }, 'Rolle',
    el('select', { name: 'role' }, ['Gast', 'Vortragende', 'Mitarbeitende'].map((value) => el('option', { value }, value))));
  const form = formAction(el('form', { class: 'stack' },
    inputField('given_name', 'Vorname *', { required: true, autocomplete: 'given-name' }),
    inputField('family_name', 'Nachname *', { required: true, autocomplete: 'family-name' }),
    inputField('organisation', 'Organisation', { autocomplete: 'organization' }), role,
    el('p', { class: 'muted' }, '* Pflichtangaben. Der Ausweis ist einen Tag gültig.'),
    el('button', { type: 'submit' }, 'Gastausweis ausstellen')), async (data) => {
    requireCrypto();
    const claims = Object.fromEntries([...data.entries()].map(([key, value]) => [key, value.trim()]).filter(([, value]) => value));
    if (!claims.given_name || !claims.family_name) throw new Error('Bitte gib einen Vornamen und Nachnamen ein.');
    // Retry registration explicitly on issuance as well, e.g. after a server reset.
    await register(issuer);
    const currentWallet = readWalletFor(wallet.did);
    const sdjwt = await sd.issueSdJwt({
      issuerDid: issuer.did, issuerPrivateJwk: issuer.privateJwk, holderPublicJwk: currentWallet.publicJwk,
      vct: 'urn:isst:gastausweis:1', claims, validDays: 1,
    });
    const pending = { sdjwt, issuerName: issuer.name };
    const transfer = action(el('button', { type: 'button' }, 'An meine Wallet übergeben'), async () => {
      readWalletFor(wallet.did);
      writeStored('pendingOffer', pending);
      location.assign(`/wallet.html${req ? `?req=${encodeURIComponent(req)}` : ''}#offer`);
    });
    const description = sd.describeCredential(sdjwt);
    root.replaceChildren(el('section', { class: 'card success' },
      el('span', { class: 'eyebrow' }, 'Erfolgreich signiert'),
      el('h2', {}, 'Dein Gastausweis ist ausgestellt'),
      attributes(claims), transfer, explain('credential'),
      raw({ header: description.header, payload: description.payload, disclosures: description.disclosures.map((item) => item.value), sdjwt })));
  });
  root.replaceChildren(
    el('section', { class: 'card' }, el('h2', {}, issuer.name), status, refresh, explain('issuer')),
    didCard(issuer.did, 'Issuer-DID'),
    el('section', { class: 'card' }, el('h2', {}, 'Gastausweis ausstellen'),
      el('p', {}, 'Empfänger ist deine eigene Wallet.'), raw({ holderDid: wallet.did }, 'Empfänger-DID anzeigen'),
      form, explain('credential')));
  const registered = await register(issuer);
  status.textContent = registered.trusted ? 'Vertrauenswürdig – bereit für den Check-in' : 'Wartet auf Freigabe durch den Empfang';
  status.className = `message ${registered.trusted ? 'notice' : 'warning'}`;
}

async function render() {
  const wallet = readStored('wallet');
  if (!wallet) {
    root.replaceChildren(el('section', { class: 'card' }, el('h2', {}, 'Lege zuerst deine Wallet an'),
      el('p', {}, 'Dein Gastausweis wird an den Schlüssel deiner Wallet gebunden.'),
      el('a', { class: 'button', href: walletUrl }, 'Zur Wallet')));
    return;
  }
  const issuer = readStored('issuer');
  if (issuer) return showIssuer(wallet, issuer);
  const form = formAction(el('form', { class: 'stack' },
    inputField('name', 'Name deines Issuers', { required: true, value: 'Meine Ausweisstelle' }),
    el('button', { type: 'submit' }, 'Issuer anlegen')), async (data) => {
    requireCrypto();
    const name = data.get('name').trim();
    if (!name) throw new Error('Bitte gib deiner Ausweisstelle einen Namen.');
    const pair = await sd.generateKeyPair();
    const created = { ...pair, name };
    writeStored('issuer', created);
    await showIssuer(wallet, created);
  });
  root.replaceChildren(el('section', { class: 'card' },
    el('span', { class: 'step-number' }, '02'), el('h2', {}, 'Heute bist du der Aussteller'),
    el('p', {}, 'Eine eigene Ausweisstelle mit eigenem Schlüsselpaar. Danach stellst du dir deinen Gastausweis aus.'),
    form, explain('issuer')));
}

run(render);
run(setupPage);
window.addEventListener('storage', (event) => {
  if (!event.key || ['wallet', 'issuer'].includes(event.key)) run(render);
});
