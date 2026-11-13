import * as sd from './sdjwt.js';

export const EMPLOYEE_VCT = 'urn:workshop:mitarbeiterausweis:1';
export const HOLDER_PROOF = 'workshop-holder-proof+jwt';
export const ROLES = Object.freeze(['Mitarbeitende', 'Teamleitung', 'Gast']);

export function publicOrigin(value, label = 'Adresse') {
  let url;
  try { url = new URL(value); } catch { throw new Error(`${label} ist keine gültige URL.`); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error(`${label} muss eine HTTPS-Adresse ohne Pfad sein (HTTP nur auf localhost).`);
  }
  return url.origin;
}

export function canonicalWalletUrl(workshopUrl, currentUrl = new URL(location.href)) {
  const url = new URL('/wallet.html', publicOrigin(workshopUrl, 'Workshop-Adresse'));
  url.search = currentUrl.search;
  url.hash = currentUrl.hash;
  return url;
}

export function offerTransactionCode(offer) {
  if (offer.status !== 'offered') return null;
  if (typeof offer.transactionCode !== 'string' || !/^\d{6}$/.test(offer.transactionCode)) {
    throw new Error('Der Issuer hat keinen gültigen Ausgabecode geliefert. Bitte aktualisiere den Issuer-Server und die Seite gemeinsam und erstelle ein neues Angebot.');
  }
  return offer.transactionCode;
}

export async function validatePublicJwk(jwk) {
  if (!jwk || Object.keys(jwk).sort().join(',') !== 'crv,kty,x,y'
    || jwk.kty !== 'EC' || jwk.crv !== 'P-256') {
    throw new Error('Ein öffentlicher P-256-Schlüssel ohne private Daten wird erwartet.');
  }
  await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  return jwk;
}

export async function signProof(type, payload, privateJwk) {
  const iat = Math.floor(Date.now() / 1000);
  return sd.signJwt({ alg: 'ES256', typ: type }, { ...payload, iat, exp: iat + 120 }, privateJwk);
}

export async function verifyProof(proof, { type, publicJwk, audience, nonce, issuer }) {
  const { header, payload } = await sd.verifyJwt(proof, await validatePublicJwk(publicJwk));
  const now = Math.floor(Date.now() / 1000);
  if (header.typ !== type || payload.iss !== issuer || payload.aud !== audience || payload.nonce !== nonce
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || payload.iat > now + 30 || payload.exp <= now || payload.exp <= payload.iat
    || payload.exp - payload.iat > 120 || payload.iat < now - 150) {
    throw new Error('Der Schlüsselbeweis ist ungültig oder abgelaufen. Bitte starte den Schritt erneut.');
  }
  return payload;
}

export function decodeOffer(fragment) {
  if (!fragment.startsWith('#offer=')) return null;
  let offer;
  try { offer = sd.parseB64Json(fragment.slice(7)); } catch {
    throw new Error('Der Ausstellungs-QR ist ungültig. Bitte scanne ihn erneut.');
  }
  if (!offer || typeof offer.issuer !== 'string' || !offer.issuer.startsWith('did:jwk:')
    || typeof offer.id !== 'string' || !/^[a-f0-9-]{36}$/.test(offer.id)
    || typeof offer.token !== 'string' || !/^[A-Za-z0-9_-]{32,100}$/.test(offer.token)) {
    throw new Error('Der Ausstellungs-QR enthält kein gültiges Angebot.');
  }
  return offer;
}
