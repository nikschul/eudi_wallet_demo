import express from 'express';
import QRCode from 'qrcode';
import { createHash, randomBytes, randomInt, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as sd from '../public/lib/sdjwt.js';
import { managementAuth } from './management-auth.js';
import {
  EMPLOYEE_VCT, REGISTRATION_PROOF, HOLDER_PROOF, publicOrigin, validatePublicJwk, signProof, verifyProof,
} from '../public/lib/protocol.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const lifetime = 10 * 60 * 1000;
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function bodyFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((field) => !fields.includes(field))) {
    throw new HttpError(400, 'Die übermittelten Daten haben ein ungültiges Format.');
  }
}

function text(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 120) {
    throw new HttpError(400, `${label} fehlt oder ist zu lang (höchstens 120 Zeichen).`);
  }
  return value.trim();
}

function matchesSecret(value, expected) {
  const digest = (input) => createHash('sha256').update(input).digest();
  return typeof value === 'string' && timingSafeEqual(digest(value), digest(expected));
}

function registryMetadata(record) {
  const result = {};
  for (const key of ['did', 'name', 'employeeName', 'publicUrl', 'trusted', 'ownerName',
    'fingerprint', 'createdAt', 'updatedAt', 'registeredAt']) {
    if (['string', 'boolean'].includes(typeof record[key]) || record[key] === null) result[key] = record[key];
  }
  return result;
}

export async function createIssuerApp({
  publicUrl,
  workshopUrl,
  dataDirectory,
  clock = () => Date.now(),
} = {}) {
  publicUrl = publicOrigin(publicUrl, 'Issuer-Adresse');
  workshopUrl = publicOrigin(workshopUrl, 'Workshop-Adresse');
  if (publicUrl === workshopUrl) throw new Error('Issuer und Workshop brauchen getrennte Adressen.');
  if (typeof dataDirectory !== 'string' || !dataDirectory) throw new Error('Das Issuer-Datenverzeichnis fehlt.');
  await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
  const identityFile = path.join(dataDirectory, 'identity.json');
  let identity = null;
  try {
    identity = JSON.parse(await readFile(identityFile, 'utf8'));
    await validatePublicJwk(identity.publicJwk);
    if (sd.didFromJwk(identity.publicJwk) !== identity.did
      || identity.privateJwk?.d === undefined
      || JSON.stringify(sd.publicPart(identity.privateJwk)) !== JSON.stringify(sd.publicPart(identity.publicJwk))) {
      throw new Error('Ungültige Issuer-Schlüssel.');
    }
    text(identity.name, 'Name der Ausweisstelle');
    text(identity.employeeName, 'Name der ausstellenden Person');
    const probe = await sd.signJwt({ alg: 'ES256' }, { test: true }, identity.privateJwk);
    await sd.verifyJwt(probe, identity.publicJwk);
    await chmod(identityFile, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Die gespeicherte Issuer-Identität konnte nicht sicher geladen werden.', { cause: error });
  }

  async function saveIdentity(next) {
    const temporary = path.join(dataDirectory, `.identity-${randomUUID()}.json`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await chmod(temporary, 0o600);
      await rename(temporary, identityFile);
      identity = next;
    } finally {
      if (handle) await handle.close();
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  let mutation = Promise.resolve();
  function serialize(work) {
    const result = mutation.then(work);
    mutation = result.catch(() => {});
    return result;
  }

  async function workshop(route, body) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(`${workshopUrl}/api${route}`, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { Accept: 'application/json', ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: 'error',
        signal: controller.signal,
      });
      const result = await response.json();
      if (!response.ok) {
        throw new HttpError(502, `Die Workshop-Zentrale hat die Anfrage abgelehnt: ${
          typeof result?.error === 'string' ? result.error.slice(0, 300) : 'Bitte erneut versuchen.'}`);
      }
      return result;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(502, controller.signal.aborted
        ? 'Die Workshop-Zentrale antwortet nicht rechtzeitig (10 Sekunden).'
        : 'Die Workshop-Zentrale ist nicht erreichbar oder hat keine gültige Antwort gesendet.');
    } finally {
      clearTimeout(timeout);
    }
  }

  function requireIdentity() {
    if (!identity) throw new HttpError(409, 'Bitte lege zuerst die Identität deiner Ausweisstelle an.');
    return identity;
  }

  function currentRecord(record, issuer = identity) {
    return issuer && record && record.did === issuer.did && record.publicUrl === publicUrl
      && record.name === issuer.name && record.employeeName === issuer.employeeName;
  }

  async function lookupRegistration(issuer) {
    const records = await workshop('/issuers');
    if (!Array.isArray(records)) throw new HttpError(502, 'Die Workshop-Zentrale hat keine gültige Vertrauensliste gesendet.');
    const record = records.find((item) => currentRecord(item, issuer));
    return record ? registryMetadata(record) : null;
  }

  const offers = new Map();
  const expired = new Map();
  function cleanOffers() {
    for (const [id, offer] of offers) {
      if (clock() >= offer.expires) {
        expired.set(id, offer.token);
        offers.delete(id);
      }
    }
    while (expired.size > 1000) expired.delete(expired.keys().next().value);
  }

  function live(offer) {
    if (clock() >= offer.expires) throw new HttpError(410, 'Das Angebot ist abgelaufen. Bitte erstelle einen neuen QR-Code.');
    if (offer.status === 'cancelled') throw new HttpError(410, 'Das Angebot wurde abgebrochen.');
  }

  function findOffer(id, token, admin = false) {
    cleanOffers();
    const offer = offers.get(id);
    const expected = offer?.token || expired.get(id);
    if (!expected) throw new HttpError(404, 'Das Angebot wurde nicht gefunden. Bitte scanne einen aktuellen QR-Code.');
    if (!admin && !matchesSecret(token, expected)) throw new HttpError(401, 'Der Zugangscode des Angebots fehlt oder ist ungültig.');
    if (!offer) throw new HttpError(410, 'Das Angebot ist abgelaufen. Bitte erstelle einen neuen QR-Code.');
    if (!admin) live(offer);
    return offer;
  }

  function offerMetadata(offer, admin = false) {
    return {
      id: offer.id, status: offer.status, issuerDid: offer.issuerDid, issuerName: offer.issuerName,
      employeeName: offer.employeeName, claims: offer.claims, nonce: offer.nonce,
      aud: publicUrl, expiresAt: new Date(offer.expires).toISOString(),
      ...(offer.pairingCode ? { pairingCode: offer.pairingCode } : {}),
      ...(admin ? { holderDid: offer.holderDid || null } : {}),
    };
  }

  async function holderProof(offer, body) {
    bodyFields(body, ['proof']);
    try {
      if (typeof body.proof !== 'string' || body.proof.length > 10000) throw new Error();
      const { payload } = sd.decodeJwt(body.proof);
      const jwk = await validatePublicJwk(payload.jwk);
      const did = sd.didFromJwk(jwk);
      if (did === offer.issuerDid) throw new Error();
      await verifyProof(body.proof, {
        type: HOLDER_PROOF, publicJwk: jwk, audience: publicUrl, nonce: offer.nonce, issuer: did,
      });
      live(offer);
      return { did, jwk };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'Der Wallet-Schlüsselbeweis ist ungültig oder abgelaufen. Bitte scanne den QR-Code erneut.');
    }
  }

  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use('/api/offers', (req, res, next) => {
    res.vary('Origin');
    if (req.get('Origin') === workshopUrl) {
      res.set({
        'Access-Control-Allow-Origin': workshopUrl,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Offer-Token',
      });
    }
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });
  app.use(express.json({ limit: '32kb', strict: true }));
  app.get('/api/health', (req, res) => res.json({ ok: true, role: 'issuer' }));
  app.get('/api/config', (req, res) => res.json({
    role: 'issuer', publicUrl, workshopUrl, eventTitle: 'Meine Ausweisstelle',
  }));
  const status = () => ({
    ...(identity ? { did: identity.did, name: identity.name, employeeName: identity.employeeName,
      ...(identity.registration ? { registration: registryMetadata(identity.registration) } : {}) } : {}),
    publicUrl, workshopUrl,
  });
  const adminToken = managementAuth(app, '/api/issuer');
  app.get('/api/issuer/status', (req, res) => res.json(status()));
  app.post('/api/issuer/setup', wrap(async (req, res) => {
    bodyFields(req.body, ['name', 'employeeName']);
    const name = text(req.body.name, 'Name der Ausweisstelle');
    const employeeName = text(req.body.employeeName, 'Name der ausstellenden Person');
    await serialize(async () => {
      const pair = identity || await sd.generateKeyPair();
      const unchanged = identity?.name === name && identity?.employeeName === employeeName;
      await saveIdentity({
        did: pair.did, publicJwk: pair.publicJwk, privateJwk: pair.privateJwk, name, employeeName,
        ...(unchanged && identity.registration ? { registration: identity.registration } : {}),
      });
    });
    res.json(status());
  }));
  app.post('/api/issuer/register', wrap(async (req, res) => {
    bodyFields(req.body, []);
    const registration = await serialize(async () => {
      const issuer = requireIdentity();
      const challenge = await workshop('/issuers/challenge', {});
      if (typeof challenge?.id !== 'string' || !challenge.id || typeof challenge.nonce !== 'string'
        || !challenge.nonce || challenge.aud !== workshopUrl
        || !Number.isFinite(Date.parse(challenge.expiresAt)) || Date.parse(challenge.expiresAt) <= clock()) {
        throw new HttpError(502, 'Die Registrierungs-Challenge der Workshop-Zentrale ist ungültig oder abgelaufen.');
      }
      const proof = await signProof(REGISTRATION_PROOF, {
        iss: issuer.did, aud: workshopUrl, nonce: challenge.nonce,
        name: issuer.name, employeeName: issuer.employeeName, publicUrl,
      }, issuer.privateJwk);
      const record = await workshop('/issuers', { challengeId: challenge.id, proof });
      if (!currentRecord(record, issuer) || typeof record.trusted !== 'boolean') {
        throw new HttpError(502, 'Die Workshop-Zentrale hat eine unpassende Registrierung zurückgegeben.');
      }
      const safe = registryMetadata(record);
      await saveIdentity({ ...issuer, registration: safe });
      return safe;
    });
    res.json(registration);
  }));
  app.get('/api/issuer/trust', wrap(async (req, res) => {
    const issuer = identity;
    const registration = await lookupRegistration(issuer);
    res.json(registration || { status: 'unregistered', ...(issuer ? { did: issuer.did } : {}), publicUrl });
  }));
  app.post('/api/issuer/offers', wrap(async (req, res) => {
    bodyFields(req.body, ['claims']);
    bodyFields(req.body.claims, ['given_name', 'family_name', 'organisation', 'role']);
    const claims = {
      given_name: text(req.body.claims.given_name, 'Vorname'),
      family_name: text(req.body.claims.family_name, 'Nachname'),
      organisation: text(req.body.claims.organisation, 'Organisation'),
      role: req.body.claims.role === undefined ? 'Mitarbeitende' : text(req.body.claims.role, 'Rolle'),
    };
    const issuer = requireIdentity();
    if (!await lookupRegistration(issuer) || issuer !== identity) {
      throw new HttpError(409, 'Bitte registriere die aktuellen Angaben deiner Ausweisstelle zuerst bei der Workshop-Zentrale.');
    }
    cleanOffers();
    if (offers.size >= 1000) throw new HttpError(429, 'Es gibt zu viele offene Angebote. Bitte warte auf deren Ablauf.');
    const offer = {
      id: randomUUID(), token: randomBytes(32).toString('base64url'),
      nonce: randomBytes(32).toString('base64url'), expires: clock() + lifetime, status: 'offered',
      issuerDid: issuer.did, issuerName: issuer.name, employeeName: issuer.employeeName, claims,
    };
    const url = `${workshopUrl}/wallet.html#offer=${sd.jsonB64({ issuer: issuer.did, id: offer.id, token: offer.token })}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 360, margin: 4 });
    offers.set(offer.id, offer);
    res.status(201).json({ ...offerMetadata(offer, true), url, qrDataUrl });
  }));
  app.get('/api/issuer/offers/:id', wrap(async (req, res) => {
    res.json(offerMetadata(findOffer(req.params.id, null, true), true));
  }));
  app.post('/api/issuer/offers/:id/approve', wrap(async (req, res) => {
    bodyFields(req.body, ['pairingCode']);
    const offer = findOffer(req.params.id, null, true);
    live(offer);
    if (offer.status !== 'bound' || offer.signing || !offer.holderJwk) {
      throw new HttpError(409, 'Nur ein verbundenes, noch nicht signiertes Wallet-Angebot kann freigegeben werden.');
    }
    if (!matchesSecret(req.body.pairingCode, offer.pairingCode)) {
      throw new HttpError(400, 'Der Vergleichscode stimmt nicht überein. Vergleiche ihn mit der Wallet.');
    }
    offer.signing = true;
    try {
      const sdjwt = await sd.issueSdJwt({
        issuerDid: offer.issuerDid, issuerPrivateJwk: requireIdentity().privateJwk,
        holderPublicJwk: offer.holderJwk, vct: EMPLOYEE_VCT, claims: offer.claims, validDays: 1,
      });
      live(offer);
      offer.sdjwt = sdjwt;
      offer.status = 'issued';
      res.json(offerMetadata(offer, true));
    } finally {
      offer.signing = false;
    }
  }));
  app.post('/api/issuer/offers/:id/cancel', wrap(async (req, res) => {
    bodyFields(req.body, []);
    const offer = findOffer(req.params.id, null, true);
    live(offer);
    if (!['offered', 'bound'].includes(offer.status) || offer.signing) {
      throw new HttpError(409, 'Ein bereits signiertes Angebot kann nicht abgebrochen werden.');
    }
    offer.status = 'cancelled';
    res.json(offerMetadata(offer, true));
  }));
  app.get('/api/offers/:id', wrap(async (req, res) => {
    res.json(offerMetadata(findOffer(req.params.id, req.get('X-Offer-Token'))));
  }));
  app.post('/api/offers/:id/claim', wrap(async (req, res) => {
    const offer = findOffer(req.params.id, req.get('X-Offer-Token'));
    const holder = await holderProof(offer, req.body);
    if (offer.holderDid && offer.holderDid !== holder.did) {
      throw new HttpError(409, 'Dieses Angebot ist bereits mit einer anderen Wallet verbunden.');
    }
    if (!offer.holderDid) {
      offer.holderDid = holder.did;
      offer.holderJwk = holder.jwk;
      offer.pairingCode = String(randomInt(1000000)).padStart(6, '0');
      offer.status = 'bound';
    }
    res.json(offerMetadata(offer));
  }));
  app.post('/api/offers/:id/credential', wrap(async (req, res) => {
    const offer = findOffer(req.params.id, req.get('X-Offer-Token'));
    const holder = await holderProof(offer, req.body);
    if (holder.did !== offer.holderDid || !['issued', 'accepted'].includes(offer.status)) {
      throw new HttpError(409, 'Der Ausweis ist für diese Wallet noch nicht zur Abholung freigegeben.');
    }
    res.json({ sdjwt: offer.sdjwt, issuerName: offer.issuerName, issuerDid: offer.issuerDid });
  }));
  app.post('/api/offers/:id/ack', wrap(async (req, res) => {
    const offer = findOffer(req.params.id, req.get('X-Offer-Token'));
    const holder = await holderProof(offer, req.body);
    if (holder.did !== offer.holderDid || !['issued', 'accepted'].includes(offer.status)) {
      throw new HttpError(409, 'Dieser Ausweis kann von dieser Wallet noch nicht bestätigt werden.');
    }
    offer.status = 'accepted';
    res.json(offerMetadata(offer));
  }));

  app.get(['/', '/issuer.html'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.sendFile(path.join(publicDirectory, 'issuer.html'));
  });
  for (const file of ['issuer.js', 'issuer.css', 'styles.css', 'lib/ui.js', 'lib/management.js', 'lib/texts.js',
    'lib/sdjwt.js', 'lib/protocol.js']) {
    app.get(`/${file}`, (req, res) => res.sendFile(path.join(publicDirectory, ...file.split('/'))));
  }
  app.use((req, res) => res.status(404).json({ error: 'Diese Seite oder API gibt es auf der Ausweisstelle nicht.' }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const code = error instanceof HttpError ? error.status : error.type === 'entity.too.large' ? 413
      : error instanceof SyntaxError && 'body' in error ? 400 : 500;
    res.status(code).json({ error: code === 500
      ? 'Die Ausweisstelle konnte die Anfrage nicht verarbeiten. Bitte versuche es erneut.'
      : code === 413 ? 'Die Anfrage ist zu groß.'
        : code === 400 && !(error instanceof HttpError) ? 'Die Anfrage enthält kein gültiges JSON.' : error.message });
  });
  return { app, adminToken };
}
