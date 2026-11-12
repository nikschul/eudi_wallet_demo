import express from 'express';
import QRCode from 'qrcode';
import { timingSafeEqual } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as sd from '../public/lib/sdjwt.js';
import { createStore } from './store.js';
import { walletIcon } from './icons.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const defaultDataDirectory = fileURLToPath(new URL('../data/', import.meta.url));
const requestLifetime = 300;
const vct = 'urn:isst:gastausweis:1';
const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireBody(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((key) => !fields.includes(key))) {
    throw new HttpError(400, 'Die übermittelten Daten haben ein ungültiges Format.');
  }
}

function text(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(400, `${label} fehlt oder ist zu lang (höchstens ${max} Zeichen).`);
  }
  return value.trim();
}

export async function createApp({
  publicUrl = 'http://localhost:3000',
  trustMode = 'auto',
  adminToken = sd.b64url(crypto.getRandomValues(new Uint8Array(32))),
  verifierName = 'Fraunhofer ISST – Empfang',
  eventTitle = 'EUDI Wallet Workshop',
  dataDirectory = defaultDataDirectory,
  clock = () => Date.now(),
} = {}) {
  if (!['auto', 'manual'].includes(trustMode)) throw new Error('TRUST_MODE muss auto oder manual sein.');
  if (typeof adminToken !== 'string' || !adminToken.trim() || adminToken !== adminToken.trim()
    || /[^\x21-\x7e]/.test(adminToken)) {
    throw new Error('ADMIN_TOKEN muss aus druckbaren ASCII-Zeichen ohne Leerzeichen bestehen.');
  }
  const parsedUrl = new URL(publicUrl);
  if (!['http:', 'https:'].includes(parsedUrl.protocol) || parsedUrl.username || parsedUrl.password
    || parsedUrl.pathname !== '/' || parsedUrl.search || parsedUrl.hash) {
    throw new Error('PUBLIC_URL muss eine HTTP(S)-Adresse ohne Pfad, Zugangsdaten, Query oder Hash sein.');
  }
  publicUrl = parsedUrl.origin;
  const startQrDataUrl = await QRCode.toDataURL(`${publicUrl}/`, { width: 256, margin: 4 });
  const store = createStore(dataDirectory);
  const requests = new Map();
  let lastPresentation = null;
  const seconds = () => Math.floor(clock() / 1000);
  const app = express();
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  app.use(express.json({ limit: '64kb', strict: true }));

  function newRequest() {
    for (const [id, request] of requests) {
      if (seconds() - request.createdAt > 1800) requests.delete(id);
    }
    const request = {
      id: crypto.randomUUID(),
      nonce: sd.b64url(crypto.getRandomValues(new Uint8Array(16))),
      aud: 'isst-empfang',
      verifierName,
      vct,
      required: ['given_name', 'family_name'],
      optional: ['organisation', 'role'],
      status: 'pending',
      createdAt: seconds(),
      result: null,
    };
    requests.set(request.id, request);
    return request;
  }

  function findRequest(id) {
    const request = requests.get(id);
    if (!request) throw new HttpError(404, 'Diese Check-in-Anfrage wurde nicht gefunden. Bitte scanne den aktuellen QR-Code.');
    if (request.status === 'pending' && seconds() - request.createdAt >= requestLifetime) {
      request.status = 'expired';
    }
    return request;
  }

  function requirePending(request) {
    if (request.status === 'expired') throw new HttpError(410, 'Der QR-Code ist abgelaufen. Bitte scanne den neuen Code am Empfang.');
    if (request.status !== 'pending') throw new HttpError(409, 'Dieser QR-Code wird bereits geprüft oder wurde schon verwendet. Bitte scanne einen neuen Code.');
  }

  async function checkPresentation(request, presentation) {
    const result = await sd.verifyPresentation(presentation, {
      aud: request.aud,
      nonce: request.nonce,
      isTrustedIssuer: (did) => store.getIssuer(did)?.trusted === true,
    });
    if (result.ok && result.vct !== request.vct) {
      result.ok = false;
      result.error = 'Dieser Nachweis ist kein passender Gastausweis.';
    }
    if (result.ok && request.required.some((field) => typeof result.claims[field] !== 'string'
      || !result.claims[field].trim() || result.claims[field].length > 120)) {
      result.ok = false;
      result.error = 'Die erforderlichen Angaben Vorname und Nachname fehlen oder sind ungültig.';
    }
    if (result.ok && Object.entries(result.claims).some(([field, value]) => (
      ![...request.required, ...request.optional].includes(field)
      || typeof value !== 'string' || value.length > 120
    ))) {
      result.ok = false;
      result.error = 'Der Gastausweis enthält unerwartete oder ungültige Angaben.';
    }
    if (result.ok) result.issuerName = store.getIssuer(result.issuer).name;
    return result;
  }

  app.get('/api/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({
    eventTitle, publicUrl, trustMode, startQrDataUrl,
  }));
  app.get('/api/issuers', (req, res) => res.json(store.listIssuers()));
  app.post('/api/issuers', wrap(async (req, res) => {
    requireBody(req.body, ['did', 'name']);
    const did = text(req.body.did, 'Die Issuer-DID', 1024);
    const name = text(req.body.name, 'Der Issuer-Name');
    try {
      const key = sd.jwkFromDid(did);
      if (Object.keys(key).sort().join(',') !== 'crv,kty,x,y' || key.kty !== 'EC' || key.crv !== 'P-256'
        || sd.didFromJwk(key) !== did) throw new Error('Ein öffentlicher P-256-Schlüssel wurde erwartet.');
      await crypto.subtle.importKey('jwk', key, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch {
      throw new HttpError(400, 'Die Issuer-DID muss einen gültigen öffentlichen P-256-Schlüssel enthalten.');
    }
    const existing = store.getIssuer(did);
    const issuer = store.putIssuer({
      did, name, trusted: existing ? existing.trusted : trustMode === 'auto',
      createdAt: existing?.createdAt ?? seconds(),
    });
    res.status(existing ? 200 : 201).json(issuer);
  }));

  app.post('/api/requests', wrap(async (req, res) => {
    const request = newRequest();
    const url = `${publicUrl}/wallet.html#req=${request.id}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 640, margin: 4, errorCorrectionLevel: 'M' });
    res.status(201).json({ id: request.id, url, qrDataUrl });
  }));
  app.get('/api/requests/:id', (req, res, next) => {
    try {
      res.json(findRequest(req.params.id));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/requests/:id/response', wrap(async (req, res) => {
    const request = findRequest(req.params.id);
    requirePending(request);
    requireBody(req.body, ['presentation']);
    const presentation = text(req.body.presentation, 'Die Presentation', 60000);
    // Reserve before the first await: two phones must not consume the same nonce.
    request.status = 'processing';
    try {
      const result = await checkPresentation(request, presentation);
      if (requests.get(request.id) !== request) {
        throw new HttpError(409, 'Die Anfrage wurde durch die Moderation zurückgesetzt. Bitte scanne den neuen QR-Code.');
      }
      if (result.ok) {
        const name = `${result.claims.given_name.trim()} ${result.claims.family_name.trim()}`;
        store.putAttendee(name.toLocaleLowerCase('de-DE'), {
          name,
          ...(result.claims.organisation ? { organisation: result.claims.organisation } : {}),
          issuerName: result.issuerName,
          time: new Date(clock()).toISOString(),
        });
        lastPresentation = presentation;
      }
      request.result = result;
      request.status = result.ok ? 'done' : 'error';
      res.json(result);
    } catch (error) {
      request.status = 'error';
      request.result = { ok: false, steps: [], error: 'Der Check-in konnte nicht gespeichert werden. Bitte wende dich an den Empfang.' };
      throw error;
    }
  }));
  app.get('/api/attendees', (req, res) => res.json(store.listAttendees()));

  app.use('/api/admin', (req, res, next) => {
    const provided = Buffer.from(req.get('X-Admin-Token') || '');
    const expected = Buffer.from(adminToken);
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return next(new HttpError(401, 'Das Admin-Token fehlt oder ist ungültig.'));
    }
    next();
  });
  app.post('/api/admin/issuers/:did/trust', (req, res, next) => {
    try {
      requireBody(req.body, ['trusted']);
      if (typeof req.body.trusted !== 'boolean') throw new HttpError(400, 'Der Vertrauensstatus muss true oder false sein.');
      const issuer = store.getIssuer(req.params.did);
      if (!issuer) throw new HttpError(404, 'Dieser Issuer wurde nicht gefunden.');
      res.json(store.putIssuer({ ...issuer, trusted: req.body.trusted }));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/admin/trust-mode', (req, res, next) => {
    try {
      requireBody(req.body, ['mode']);
      if (!['auto', 'manual'].includes(req.body.mode)) throw new HttpError(400, 'Bitte wähle auto oder manual als Vertrauensmodus.');
      trustMode = req.body.mode;
      res.json({ mode: trustMode });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/admin/replay', wrap(async (req, res) => {
    if (!lastPresentation) throw new HttpError(409, 'Für die Replay-Demo muss zuerst eine Person erfolgreich einchecken.');
    const request = newRequest();
    request.status = 'processing';
    const result = await checkPresentation(request, lastPresentation);
    request.result = result;
    request.status = result.ok ? 'done' : 'error';
    res.json(result);
  }));
  app.post('/api/admin/reset', (req, res, next) => {
    try {
      store.clearAttendees();
      requests.clear();
      lastPresentation = null;
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Dieser API-Endpunkt wurde nicht gefunden.')));
  for (const page of ['wallet', 'issuer', 'kiosk', 'admin']) {
    app.get(`/${page}`, (req, res) => {
      const query = req.originalUrl.indexOf('?');
      res.redirect(`/${page}.html${query < 0 ? '' : req.originalUrl.slice(query)}`);
    });
  }
  for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const icon = walletIcon(size);
    app.get(`/icons/${file}`, (req, res) => res.type('png').set('Cache-Control', 'public, max-age=86400').send(icon));
  }
  app.use(express.static(publicDirectory, {
    setHeaders(res) { res.set('Cache-Control', 'no-cache'); },
  }));
  app.use((req, res) => res.status(404).type('text').send('Diese Seite gibt es nicht. Bitte öffne die Startseite unter /.'));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    const status = error.status || 500;
    if (status >= 500) console.error('Serverfehler:', error);
    const message = status >= 500
      ? 'Der Server konnte die Anfrage nicht verarbeiten. Bitte versuche es erneut oder wende dich an den Empfang.'
      : error.type === 'entity.parse.failed'
        ? 'Die Anfrage enthält kein gültiges JSON.'
        : error.type === 'entity.too.large'
          ? 'Die übermittelten Daten sind zu groß.'
          : error.message;
    res.status(status).json({ error: message });
  });

  return { app, adminToken };
}
