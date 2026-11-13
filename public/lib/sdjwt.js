// Shared by the browser and Node (globalThis.crypto).
const enc = new TextEncoder();
const dec = new TextDecoder();
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };
const clockTolerance = 60;

// ---------- encoding helpers ----------
export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
export const jsonB64 = (obj) => b64url(enc.encode(JSON.stringify(obj)));
export const parseB64Json = (s) => JSON.parse(dec.decode(b64urlDecode(s)));
export async function sha256b64(str) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str))));
}
const now = () => Math.floor(Date.now() / 1000);

// ---------- keys and DIDs ----------
export function publicPart({ kty, crv, x, y }) {
  return { kty, crv, x, y };
}
export async function generateKeyPair() {
  const kp = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const publicJwk = publicPart(await crypto.subtle.exportKey('jwk', kp.publicKey));
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicJwk, privateJwk, did: didFromJwk(publicJwk) };
}
export function didFromJwk(publicJwk) {
  return 'did:jwk:' + jsonB64(publicPart(publicJwk));
}
export function jwkFromDid(did) {
  if (typeof did !== 'string' || !did.startsWith('did:jwk:')) {
    throw new Error('Unbekanntes DID-Format (nur did:jwk wird unterstützt)');
  }
  return parseB64Json(did.slice('did:jwk:'.length));
}

// ---------- JWS (compact) ----------
export async function signJwt(header, payload, privateJwk) {
  const key = await crypto.subtle.importKey('jwk', privateJwk, ALG, false, ['sign']);
  const input = jsonB64(header) + '.' + jsonB64(payload);
  const sig = new Uint8Array(await crypto.subtle.sign(SIG, key, enc.encode(input)));
  return input + '.' + b64url(sig);
}
export function decodeJwt(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('Ungültiges JWT');
  return { header: parseB64Json(parts[0]), payload: parseB64Json(parts[1]) };
}
export async function verifyJwt(jwt, publicJwk) {
  const parts = String(jwt).split('.');
  const [h, p, s] = parts;
  if (parts.length !== 3 || !h || !p || !s) throw new Error('Ungültiges JWT');
  const header = parseB64Json(h);
  if (!header || header.alg !== 'ES256') throw new Error('Nicht unterstützter Signaturalgorithmus');
  const key = await crypto.subtle.importKey('jwk', publicPart(publicJwk), ALG, false, ['verify']);
  const ok = await crypto.subtle.verify(SIG, key, b64urlDecode(s), enc.encode(h + '.' + p));
  if (!ok) throw new Error('Signatur ungültig');
  return { header, payload: parseB64Json(p) };
}

// ---------- SD-JWT VC ----------
// claims: flat object, e.g. { given_name: 'Erika', family_name: 'Mustermann' }
export async function issueSdJwt({ issuerDid, issuerPrivateJwk, holderPublicJwk, vct, claims, validDays = 1, status }) {
  const disclosures = [];
  const digests = [];
  for (const [name, value] of Object.entries(claims)) {
    const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const disclosure = jsonB64([salt, name, value]);
    disclosures.push(disclosure);
    digests.push(await sha256b64(disclosure));
  }
  const payload = {
    iss: issuerDid,
    iat: now(),
    exp: now() + validDays * 86400,
    vct,
    cnf: { jwk: publicPart(holderPublicJwk) },
    _sd: digests.sort(),
    _sd_alg: 'sha-256',
    ...(status ? { status } : {}),
  };
  const jwt = await signJwt({ alg: 'ES256', typ: 'dc+sd-jwt', kid: issuerDid + '#0' }, payload, issuerPrivateJwk);
  return jwt + '~' + disclosures.join('~') + '~';
}

// Splits "jwt~d1~d2~[kb]" into its parts
export function parseSdJwt(sdjwt) {
  const parts = String(sdjwt).split('~');
  if (parts.length < 2) throw new Error('Kein SD-JWT');
  return {
    jwt: parts[0],
    disclosures: parts.slice(1, -1).map((raw) => ({ raw, value: parseB64Json(raw) })),
    kb: parts[parts.length - 1] || null,
  };
}

// Readable view of a stored credential (for the wallet UI)
export function describeCredential(sdjwt) {
  const { jwt, disclosures } = parseSdJwt(sdjwt);
  const { header, payload } = decodeJwt(jwt);
  const claims = Object.fromEntries(disclosures.map((d) => [d.value[1], d.value[2]]));
  return { header, payload, claims, disclosures };
}

// Holder: reveal only selected claims and bind to nonce + audience
export async function createPresentation({ sdjwt, reveal, holderPrivateJwk, aud, nonce }) {
  const { jwt, disclosures } = parseSdJwt(sdjwt);
  const chosen = disclosures.filter((d) => reveal.includes(d.value[1])).map((d) => d.raw + '~');
  const withoutKb = jwt + '~' + chosen.join('');
  const kb = await signJwt(
    { alg: 'ES256', typ: 'kb+jwt' },
    { iat: now(), aud, nonce, sd_hash: await sha256b64(withoutKb) },
    holderPrivateJwk,
  );
  return withoutKb + kb;
}

// Verifier: returns { ok, steps, issuer, holder, vct, claims } and never throws
export async function verifyPresentation(presentation, { aud, nonce, isTrustedIssuer, onStep }) {
  const steps = [];
  const step = (label) => {
    steps.push(label);
    onStep?.([...steps]);
  };
  try {
    const { jwt, disclosures, kb } = parseSdJwt(presentation);
    if (!kb) throw new Error('Kein Key-Binding-JWT vorhanden');
    step('Presentation zerlegt: Nachweis, ' + disclosures.length + ' Disclosure(s), Key-Binding-JWT');

    const iss = decodeJwt(jwt).payload.iss;
    if (!(await isTrustedIssuer(iss))) throw new Error('Issuer steht nicht auf der Vertrauensliste');
    step('Issuer steht auf der Vertrauensliste');

    const { header, payload } = await verifyJwt(jwt, jwkFromDid(iss));
    if (header.typ !== 'dc+sd-jwt' || payload._sd_alg !== 'sha-256'
      || !Array.isArray(payload._sd) || payload._sd.some((digest) => typeof digest !== 'string')
      || new Set(payload._sd).size !== payload._sd.length) {
      throw new Error('Ungültiges SD-JWT-Format');
    }
    step('Signatur des Issuers geprüft (öffentlicher Schlüssel aus der DID)');

    if (!Number.isSafeInteger(payload.exp) || !Number.isSafeInteger(payload.iat)) {
      throw new Error('Die Gültigkeitsdauer des Nachweises ist ungültig');
    }
    if (payload.exp <= now()) throw new Error('Nachweis ist abgelaufen');
    if (payload.iat > now() + clockTolerance || payload.exp <= payload.iat) {
      throw new Error('Die Gültigkeitsdauer des Nachweises ist ungültig');
    }
    step('Gültigkeitsdauer geprüft');

    const claims = {};
    for (const d of disclosures) {
      if (!Array.isArray(d.value) || d.value.length !== 3 || typeof d.value[0] !== 'string'
        || !d.value[0] || typeof d.value[1] !== 'string' || !d.value[1]
        || ['__proto__', 'constructor', 'prototype'].includes(d.value[1])
        || Object.hasOwn(claims, d.value[1])) {
        throw new Error('Ungültige oder doppelte Disclosure');
      }
      if (!payload._sd.includes(await sha256b64(d.raw))) throw new Error('Eine Disclosure gehört nicht zu diesem Nachweis');
      claims[d.value[1]] = d.value[2];
    }
    step('Freigegebene Attribute gegen die Hashes im Nachweis geprüft: ' + Object.keys(claims).join(', '));

    const { header: kbh, payload: kbp } = await verifyJwt(kb, payload.cnf.jwk);
    if (kbh.typ !== 'kb+jwt' || !kbp || !Number.isSafeInteger(kbp.iat) || kbp.iat > now() + clockTolerance) {
      throw new Error('Ungültiges Key-Binding-JWT');
    }
    step('Holder Binding geprüft: Wallet besitzt den passenden privaten Schlüssel');

    const withoutKb = presentation.slice(0, presentation.length - kb.length);
    if (kbp.sd_hash !== (await sha256b64(withoutKb))) throw new Error('Key-Binding passt nicht zur Presentation');
    if (kbp.nonce !== nonce || kbp.aud !== aud) throw new Error('Falsche Nonce oder falscher Empfänger (möglicher Replay-Angriff)');
    step('Nonce und Empfänger stimmen: Presentation wurde frisch für diesen Check-In erstellt');

    return { ok: true, steps, issuer: iss, holder: didFromJwk(payload.cnf.jwk), vct: payload.vct, claims };
  } catch (err) {
    return { ok: false, steps, error: err.message };
  }
}
