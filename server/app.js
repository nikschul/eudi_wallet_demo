import express from 'express';
import QRCode from 'qrcode';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import * as sd from '../public/lib/sdjwt.js';
import { createStore } from './store.js';
import { walletIcon } from './icons.js';
import { managementAuth } from './management-auth.js';
import { EMPLOYEE_VCT, ROLES, publicOrigin } from '../public/lib/protocol.js';
import { statusReference, verifyStatusList, isRevoked } from '../public/lib/credential-status.js';
import { installIssuerRoutes, publicOrganisation } from './issuer-app.js';
import { HttpError, wrap, bodyFields as requireBody, text } from './http.js';
import { verificationChecks } from '../public/lib/verification.js';

const publicDirectory = fileURLToPath(new URL('../public/', import.meta.url));
const defaultDataDirectory = fileURLToPath(new URL('../hosted-data/', import.meta.url));
const requestLifetime = 300;
const vct = EMPLOYEE_VCT;

export async function createApp({
  publicUrl = 'http://localhost:3000',
  trustMode = 'manual',
  verifierName = 'Check-In',
  eventTitle = 'Wallet & Check-In',
  dataDirectory = defaultDataDirectory,
  clock = () => Date.now(),
} = {}) {
  if (trustMode !== 'manual') throw new Error('Im Workshop werden Issuer ausschließlich durch die Moderation freigegeben (TRUST_MODE=manual).');
  publicUrl = publicOrigin(publicUrl, 'PUBLIC_URL');
  const startQrDataUrl = await QRCode.toDataURL(`${publicUrl}/`, { width: 256, margin: 4 });
  const issuerSetupUrl = `${publicUrl}/issuer.html`;
  const issuerSetupQrDataUrl = await QRCode.toDataURL(issuerSetupUrl, { width: 256, margin: 4 });
  const store = createStore(dataDirectory);
  const requests = new Map();
  const attempts = [];
  let lastPresentation = null;
  const seconds = () => Math.floor(clock() / 1000);
  const app = express();
  const walletTemplate = readFileSync(new URL('../public/wallet.html', import.meta.url), 'utf8');
  app.disable('x-powered-by');
  app.use((req, res, next) => {
    const issuerOrigins = [publicUrl];
    res.set({
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'camera=(self)',
      'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self' blob:; manifest-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    });
    if (req.path === '/wallet.html') {
      res.set('X-Workshop-Issuer-Origins', JSON.stringify(issuerOrigins));
    }
    next();
  });
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
      if (req.get('Sec-Fetch-Site') === 'cross-site') return res.status(403).json({ error: 'Eine fremde Webseite darf diese Aktion nicht ausführen.' });
      const origin = req.get('Origin');
      const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)
        && ['localhost', '127.0.0.1', '::1'].includes(req.hostname)
        && origin === `${req.protocol}://${req.get('Host')}`;
      if (origin && origin !== publicUrl && !local) return res.status(403).json({ error: 'Der Ursprung dieser Anfrage ist nicht erlaubt.' });
      if (!req.is('application/json')) return res.status(415).json({ error: 'Diese Aktion benötigt Content-Type application/json.' });
    }
    next();
  });
  const adminToken = managementAuth(app, '/api/admin');
  app.use(express.json({ limit: '64kb', strict: true }));
  const { signedStatus } = await installIssuerRoutes(app, { store, publicUrl, clock });
  const publicIssuer = (org) => publicOrganisation(org, publicUrl);

  function newRequest(mode = 'single') {
    for (const [id, request] of requests) {
      if (seconds() - request.createdAt > 1800) requests.delete(id);
    }
    const request = {
      id: crypto.randomUUID(),
      mode,
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
    if (!request) throw new HttpError(404, 'Diese Check-In-Anfrage wurde nicht gefunden. Bitte scanne den aktuellen QR-Code.');
    if (request.status === 'pending' && seconds() - request.createdAt >= requestLifetime) {
      request.status = 'expired';
    }
    return request;
  }

  function requirePending(request) {
    if (request.status === 'expired') throw new HttpError(410, 'Der QR-Code ist abgelaufen. Bitte scanne den neuen Check-In-Code.');
    if (request.status !== 'pending') throw new HttpError(409, 'Dieser QR-Code wird bereits geprüft oder wurde schon verwendet. Bitte scanne einen neuen Code.');
  }

  function isTrustedIssuer(did) {
    const issuer = store.getIssuer(did);
    return issuer?.state === 'approved';
  }

  async function checkPresentation(request, presentation, onStep) {
    const result = await sd.verifyPresentation(presentation, {
      aud: request.aud,
      nonce: request.nonce,
      isTrustedIssuer,
      onStep,
    });
    if (!result.ok) {
      result.failedAt = ['Nachweis lesen', 'Issuer-Vertrauen', 'Issuer-Signatur', 'Gültigkeit',
        'Geteilte Angaben', 'Wallet-Bindung', 'Nonce und Empfänger'][Math.min(result.steps.length, 6)];
    }
    if (result.ok && result.vct !== request.vct) {
      result.ok = false;
      result.failedAt = 'Nachweistyp';
      result.error = 'Dieser Nachweis ist kein passender Mitarbeiterausweis. Bitte hole einen neuen Ausweis von deinem eigenen Issuer.';
    }
    if (result.ok && request.required.some((field) => typeof result.claims[field] !== 'string'
      || !result.claims[field].trim() || result.claims[field].length > 120)) {
      result.ok = false;
      result.failedAt = 'Pflichtangaben';
      result.error = 'Die erforderlichen Angaben Vorname und Nachname fehlen oder sind ungültig.';
    }
    if (result.ok && Object.entries(result.claims).some(([field, value]) => (
      ![...request.required, ...request.optional].includes(field)
      || typeof value !== 'string' || value.length > 120
    ))) {
      result.ok = false;
      result.failedAt = 'Geteilte Angaben';
      result.error = 'Der Mitarbeiterausweis enthält unerwartete oder ungültige Angaben.';
    }
    if (result.ok) {
      const issuer = store.getIssuer(result.issuer);
      try {
        const { payload } = sd.decodeJwt(sd.parseSdJwt(presentation).jwt);
        const registered = publicIssuer(issuer);
        const reference = statusReference(payload, registered);
        const list = await verifyStatusList(await signedStatus(issuer), {
          issuerDid: issuer.did, uri: registered.statusListUrl, now: clock(),
        });
        if (isRevoked(list, reference.idx)) throw new Error('Dieser Ausweis wurde vom Issuer widerrufen.');
        result.credentialId = await sd.sha256b64(sd.parseSdJwt(presentation).jwt);
        const current = store.getIssuer(result.issuer);
        const record = current?.credentials.find((entry) => entry.id === result.credentialId);
        if (!record || record.statusIndex !== reference.idx || record.holderDid !== result.holder
          || record.revokedAt) throw new Error('Der Ausweis wurde widerrufen oder sein Ausstellungsbeleg fehlt.');
        if (result.claims.organisation !== undefined && result.claims.organisation !== current.name) {
          throw new Error('Die Organisation passt nicht zum ausstellenden Schlüssel.');
        }
        if (result.claims.role !== undefined && !ROLES.includes(result.claims.role)) throw new Error('Die Rolle ist ungültig.');
        if (list.expiresAt <= clock()) throw new Error('Die Statusliste ist nicht mehr aktuell.');
        result.statusCheckedAt = new Date(clock()).toISOString();
        result.statusListExpiresAt = new Date(list.expiresAt).toISOString();
        result.steps.push('Widerrufsstatus geprüft: aktuelle signierte Statusliste, Ausweis nicht widerrufen');
        onStep?.([...result.steps]);
      } catch (error) {
        result.ok = false;
        result.failedAt = 'Widerrufsstatus';
        result.error = `Widerrufsstatus nicht akzeptiert: ${error.message}`;
      }
    }
    if (result.ok && !isTrustedIssuer(result.issuer)) {
      result.ok = false;
      result.failedAt = 'Issuer-Vertrauen';
      result.error = 'Dem Issuer wurde während der Prüfung das Vertrauen entzogen.';
    }
    if (result.ok) {
      const issuer = store.getIssuer(result.issuer);
      result.issuerName = issuer.name;
    }
    return result;
  }

  function startAttempt(request, presentation) {
    const attempt = {
      id: request.id, name: 'Unbekannte Wallet', identityVerified: false,
      issuerName: 'Unbekannter Issuer', time: new Date(clock()).toISOString(),
      status: 'processing', steps: [],
    };
    try {
      const { payload, claims } = sd.describeCredential(presentation);
      if (['given_name', 'family_name'].every((key) => typeof claims[key] === 'string'
        && claims[key].trim() && claims[key].length <= 120)) {
        attempt.name = `${claims.given_name.trim()} ${claims.family_name.trim()}`;
      }
      attempt.issuerName = store.getIssuer(payload.iss)?.name || 'Unbekannter Issuer';
    } catch {
      attempt.identityNote = 'Der Name konnte nicht aus dem Nachweis gelesen werden.';
    }
    attempts.unshift(attempt);
    attempts.splice(100);
    return attempt;
  }

  app.get('/api/health', (req, res) => res.json({ ok: true, role: 'workshop' }));
  app.get('/api/config', (req, res) => res.json({
    role: 'workshop', eventTitle, verifierName, publicUrl, trustMode, startQrDataUrl, credentialType: vct,
    roles: ROLES, issuerSetupUrl, issuerSetupQrDataUrl,
  }));
  app.get('/api/issuers', (req, res) => res.json(store.listIssuers().map(publicIssuer)));

  app.post('/api/requests', wrap(async (req, res) => {
    requireBody(req.body, ['mode']);
    if (req.body.mode !== undefined && req.body.mode !== 'kiosk') throw new HttpError(400, 'Unbekannter Check-In-Modus.');
    const request = newRequest(req.body.mode);
    const url = `${publicUrl}/wallet.html#req=${request.id}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 640, margin: 4, errorCorrectionLevel: 'M' });
    res.status(201).json({ id: request.id, url, qrDataUrl });
  }));
  app.post('/api/requests/:id/sessions', (req, res, next) => {
    try {
      requireBody(req.body, []);
      const parent = findRequest(req.params.id);
      requirePending(parent);
      if (parent.mode !== 'kiosk') throw new HttpError(400, 'Nur ein Kiosk-QR kann persönliche Check-In-Anfragen öffnen.');
      res.status(201).json(newRequest());
    } catch (error) {
      next(error);
    }
  });
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
    if (request.mode === 'kiosk') throw new HttpError(409, 'Bitte öffne zuerst eine persönliche Check-In-Anfrage über den Kiosk-QR.');
    requireBody(req.body, ['presentation']);
    const presentation = text(req.body.presentation, 'Die Presentation', 60000);
    // Reserve before the first await: two phones must not consume the same nonce.
    request.status = 'processing';
    const attempt = startAttempt(request, presentation);
    const streaming = req.get('Accept') === 'application/x-ndjson';
    const sendFrame = (frame) => {
      if (streaming && !res.destroyed && !res.writableEnded) res.write(`${JSON.stringify(frame)}\n`);
    };
    if (streaming) {
      res.status(200).set({
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store, no-transform',
        'X-Accel-Buffering': 'no',
      });
      res.flushHeaders();
      sendFrame({ type: 'progress', completed: 0, total: verificationChecks.length, steps: [] });
    }
    try {
      const result = await checkPresentation(request, presentation, (completedSteps) => {
        attempt.steps = completedSteps;
        sendFrame({ type: 'progress', completed: completedSteps.length, total: verificationChecks.length, steps: completedSteps });
      });
      if (requests.get(request.id) !== request) {
        throw new HttpError(409, 'Die Anfrage wurde durch die Moderation zurückgesetzt. Bitte scanne den neuen QR-Code.');
      }
      if (result.ok) {
        const name = `${result.claims.given_name.trim()} ${result.claims.family_name.trim()}`;
        store.recordCheckin(result.holder, {
          id: request.id, name, claims: result.claims,
          ...(result.claims.organisation ? { organisation: result.claims.organisation } : {}),
          issuerName: result.issuerName, issuerDid: result.issuer,
          holderDid: result.holder, credentialType: result.vct, credentialId: result.credentialId,
          trustedAtCheckin: true,
          statusCheckedAt: result.statusCheckedAt, statusListExpiresAt: result.statusListExpiresAt,
          time: new Date(clock()).toISOString(),
        });
        lastPresentation = presentation;
      }
      request.result = result;
      request.status = result.ok ? 'done' : 'error';
      Object.assign(attempt, {
        status: request.status, identityVerified: result.ok,
        steps: result.steps, error: result.error, failedAt: result.failedAt,
      });
      if (streaming) {
        sendFrame({ type: 'result', result });
        res.end();
      } else res.json(result);
    } catch (error) {
      request.status = 'error';
      request.result = { ok: false, steps: [], error: 'Der Check-In konnte nicht gespeichert werden. Bitte wende dich an die Moderation.' };
      Object.assign(attempt, {
        status: 'error', steps: [], error: request.result.error, failedAt: 'Check-In speichern',
      });
      if (streaming) {
        if (!(error instanceof HttpError) || error.status >= 500) console.error('Serverfehler:', error);
        const result = { ...request.result, failedAt: 'Check-In speichern',
          ...(error instanceof HttpError && error.status < 500 ? { error: error.message } : {}) };
        sendFrame({ type: 'result', result });
        res.end();
        return;
      }
      throw error;
    }
  }));
  app.get('/api/attendees', (req, res) => res.json(store.listAttendees()));

  app.get('/api/dashboard', (req, res) => {
    const checkins = store.listAttendees().flatMap((person) => person.checkins || []);
    const counts = new Map();
    for (const checkin of checkins) counts.set(checkin.issuerDid, (counts.get(checkin.issuerDid) || 0) + 1);
    const issuers = store.listIssuers().map((issuer) => ({
      ...publicIssuer(issuer), checkinCount: counts.get(issuer.did) || 0,
    }));
    res.json({
      issuers, attendees: store.listAttendees(), attempts,
      stats: {
        registered: issuers.length,
        checkins: checkins.length,
      },
    });
  });
  app.post('/api/admin/issuers/:did/trust', (req, res, next) => {
    try {
      requireBody(req.body, ['trusted']);
      if (typeof req.body.trusted !== 'boolean') throw new HttpError(400, 'Der Vertrauensstatus muss true oder false sein.');
      const issuer = store.getIssuer(req.params.did);
      if (!issuer) throw new HttpError(404, 'Dieser Issuer wurde nicht gefunden.');
      res.json(publicIssuer(store.updateOrganisation(issuer.id, (org) => {
        org.state = req.body.trusted ? 'approved' : 'suspended';
        if (req.body.trusted) org.approvedAt = new Date(clock()).toISOString();
      })));
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/admin/trust-mode', (req, res, next) => {
    try {
      requireBody(req.body, ['mode']);
      if (req.body.mode !== 'manual') throw new HttpError(400, 'Im Workshop ist nur die bewusste Freigabe durch die Moderation erlaubt.');
      res.json({ mode: trustMode });
    } catch (error) {
      next(error);
    }
  });
  app.post('/api/admin/replay', wrap(async (req, res) => {
    requireBody(req.body, []);
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
      requireBody(req.body, []);
      store.clearAttendees();
      requests.clear();
      attempts.length = 0;
      lastPresentation = null;
      res.json({ ok: true });
    } catch (error) {
      next(error);
    }
  });

  app.use('/api', (req, res, next) => next(new HttpError(404, 'Dieser API-Endpunkt wurde nicht gefunden.')));
  app.get(['/kiosk', '/kiosk.html'], (req, res) => {
    const query = req.originalUrl.indexOf('?');
    res.set('Cache-Control', 'no-cache').redirect(`/${query < 0 ? '' : req.originalUrl.slice(query)}`);
  });
  for (const page of ['wallet', 'issuer', 'admin']) {
    app.get(`/${page}`, (req, res) => {
      const query = req.originalUrl.indexOf('?');
      res.redirect(`/${page}.html${query < 0 ? '' : req.originalUrl.slice(query)}`);
    });
  }
  app.get('/wallet.html', (req, res) => {
    const origins = JSON.stringify([publicUrl])
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
    res.set('Cache-Control', 'no-cache').type('html').send(walletTemplate
      .replace('name="issuer-origins" content="[]"', `name="issuer-origins" content="${origins}"`)
      .replace('name="wallet-origin" content=""', `name="wallet-origin" content="${publicUrl}"`));
  });
  for (const [file, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    const icon = walletIcon(size);
    app.get(`/icons/${file}`, (req, res) => res.type('png').set('Cache-Control', 'public, max-age=86400').send(icon));
  }
  const require = createRequire(import.meta.url);
  const scannerDirectory = path.dirname(require.resolve('qr-scanner'));
  for (const file of ['qr-scanner.min.js', 'qr-scanner-worker.min.js']) {
    app.get(`/vendor/qr-scanner/${file}`, (req, res) => {
      res.set('Cache-Control', 'no-cache').sendFile(path.join(scannerDirectory, file));
    });
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
      ? 'Der Server konnte die Anfrage nicht verarbeiten. Bitte versuche es erneut oder wende dich an die Moderation.'
      : error.type === 'entity.parse.failed'
        ? 'Die Anfrage enthält kein gültiges JSON.'
        : error.type === 'entity.too.large'
          ? 'Die übermittelten Daten sind zu groß.'
          : error.message;
    res.status(status).json({ error: message });
  });

  return { app, adminToken };
}
