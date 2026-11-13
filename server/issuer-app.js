import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import QRCode from 'qrcode';
import * as sd from '../public/lib/sdjwt.js';
import { EMPLOYEE_VCT, HOLDER_PROOF, ROLES, validatePublicJwk, verifyProof } from '../public/lib/protocol.js';
import { STATUS_LIST_ENTRIES, STATUS_LIST_TTL } from '../public/lib/credential-status.js';
import { HttpError, bodyFields, text, wrap, secretHash, matchesSecret } from './http.js';

const COOKIE = 'eudi_org_access';
const ACCESS_TTL = 30 * 24 * 60 * 60 * 1000;
const RECOVERY_TTL = 10 * 60 * 1000;
const OFFER_TTL = 10 * 60 * 1000;
const secret = () => randomBytes(32).toString('base64url');

export function publicOrganisation(org, publicUrl) {
  return {
    id: org.id, name: org.name, did: org.did, publicUrl,
    statusListUrl: `${publicUrl}/api/status-lists/${org.id}`,
    state: org.state, trusted: org.state === 'approved', proofVerified: true,
    fingerprint: org.fingerprint, createdAt: org.createdAt, approvedAt: org.approvedAt,
  };
}

export async function installIssuerRoutes(app, { store, publicUrl, clock }) {
  for (const org of store.listIssuers()) {
    try {
      await validatePublicJwk(org.publicJwk);
      const probe = await sd.signJwt({ alg: 'ES256' }, { test: true }, org.privateJwk);
      await sd.verifyJwt(probe, org.publicJwk);
      if (await sd.sha256b64(org.did) !== org.fingerprint) throw new Error('Der Organisationsfingerabdruck ist beschädigt.');
      for (const record of org.credentials) {
        const key = await validatePublicJwk(sd.jwkFromDid(record.holderDid));
        if (sd.didFromJwk(key) !== record.holderDid) throw new Error('Die gespeicherte Wallet-DID ist nicht kanonisch.');
      }
      for (const offer of org.offers.filter((item) => item.sdjwt)) {
        const { jwt } = sd.parseSdJwt(offer.sdjwt);
        const { payload } = await sd.verifyJwt(jwt, org.publicJwk);
        const record = org.credentials.find((entry) => entry.id === offer.credentialId);
        if (await sd.sha256b64(jwt) !== record.id || payload.iss !== org.did
          || sd.didFromJwk(payload.cnf.jwk) !== record.holderDid
          || JSON.stringify(sd.describeCredential(offer.sdjwt).claims) !== JSON.stringify(record.claims)
          || payload.status?.status_list?.idx !== record.statusIndex
          || payload.status?.status_list?.uri !== `${offer.publicUrl}/api/status-lists/${org.id}`) {
          throw new Error('Der gespeicherte Ausstellungsbeleg passt nicht zum Credential-Protokoll.');
        }
      }
    } catch (error) {
      throw new Error('Die gespeicherten Organisationsschlüssel oder Ausstellungsbelege sind beschädigt.', { cause: error });
    }
  }
  let mutation = Promise.resolve();
  function serialize(work) {
    const result = mutation.then(work);
    mutation = result.catch(() => {});
    return result;
  }
  const metadata = (org) => publicOrganisation(org, publicUrl);
  const session = (org) => ({ organisation: org ? metadata(org) : null, roles: ROLES });
  function cookieSecret(req) {
    const values = (req.get('Cookie') || '').split(';').map((part) => part.trim())
      .filter((part) => part.startsWith(`${COOKIE}=`));
    if (!values.length) return null;
    if (values.length !== 1) throw new HttpError(401, 'Der Browser-Zugang ist ungültig. Bitte wende dich an die Moderation.');
    const value = values[0].slice(COOKIE.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(value)) throw new HttpError(401, 'Der Browser-Zugang ist ungültig. Bitte wende dich an die Moderation.');
    return value;
  }
  function owner(req, required = true) {
    const value = cookieSecret(req);
    const org = value && store.listIssuers().find((item) => matchesSecret(value, item.accessHash)
      && item.accessExpires > clock());
    if (!org && required) throw new HttpError(401, 'Der Organisationszugang fehlt oder ist abgelaufen. Nur die Moderation kann den Browser-Zugang wiederherstellen.');
    return org || null;
  }
  function setCookie(res, value) {
    res.cookie(COOKIE, value, {
      httpOnly: true, secure: publicUrl.startsWith('https:'), sameSite: 'strict', path: '/',
      maxAge: ACCESS_TTL,
    });
  }
  function approved(org) {
    if (org.state !== 'approved') throw new HttpError(409, 'Die Moderation muss diese Organisation zuerst freigeben. Eine gesperrte Organisation kann keine Ausweise ausstellen.');
  }
  function live(offer) {
    if (offer.publicUrl !== publicUrl) throw new HttpError(410, 'Die Workshop-Adresse hat sich geändert. Bitte erstelle einen neuen QR-Code und einen neuen Ausweis.');
    if (clock() >= offer.expires) throw new HttpError(410, 'Das Angebot ist abgelaufen. Bitte erstelle einen neuen QR-Code.');
    if (offer.status === 'cancelled') throw new HttpError(410, offer.cancellationReason || 'Das Angebot wurde abgebrochen.');
  }
  function findOffer(id, token, orgId) {
    const org = orgId ? store.getOrganisation(orgId) : store.listIssuers().find((item) => item.offers.some((offer) => offer.id === id));
    const offer = org?.offers.find((item) => item.id === id);
    if (!offer) throw new HttpError(404, 'Das Angebot wurde nicht gefunden. Bitte scanne einen aktuellen QR-Code.');
    if (!orgId && !matchesSecret(token, offer.tokenHash)) throw new HttpError(401, 'Der Zugangscode des Angebots fehlt oder ist ungültig.');
    return { org, offer };
  }
  function offerMetadata(org, offer, privateView = false) {
    return {
      id: offer.id, status: clock() >= offer.expires || offer.publicUrl !== publicUrl ? 'expired' : offer.status,
      issuerDid: org.did, issuerName: org.name, claims: offer.claims, nonce: offer.nonce,
      aud: offer.publicUrl, expiresAt: new Date(offer.expires).toISOString(),
      ...(privateView && offer.status === 'offered' && clock() < offer.expires && offer.publicUrl === publicUrl ? { transactionCode: offer.transactionCode } : {}),
      ...(privateView ? { holderDid: offer.holderDid || null } : {}),
      ...(offer.cancellationReason ? { cancellationReason: offer.cancellationReason } : {}),
    };
  }
  async function holderProof(offer, org, body, fields = ['proof']) {
    bodyFields(body, fields);
    try {
      if (typeof body.proof !== 'string' || body.proof.length > 10000) throw new Error();
      const { payload } = sd.decodeJwt(body.proof);
      const jwk = await validatePublicJwk(payload.jwk);
      const did = sd.didFromJwk(jwk);
      if (did === org.did) throw new Error();
      await verifyProof(body.proof, {
        type: HOLDER_PROOF, publicJwk: jwk, audience: offer.publicUrl, nonce: offer.nonce, issuer: did,
      });
      live(offer);
      return { did, jwk };
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, 'Der Wallet-Schlüsselbeweis ist ungültig oder abgelaufen. Bitte scanne den QR-Code erneut.');
    }
  }
  async function signedStatus(org) {
    const bytes = new Uint8Array(STATUS_LIST_ENTRIES / 8);
    for (const record of org.credentials) {
      if (record.revokedAt) bytes[Math.floor(record.statusIndex / 8)] |= 1 << (record.statusIndex % 8);
    }
    const iat = Math.floor(clock() / 1000);
    return sd.signJwt({ alg: 'ES256', typ: 'statuslist+jwt', kid: `${org.did}#0` }, {
      iss: org.did, sub: `${publicUrl}/api/status-lists/${org.id}`,
      iat, exp: iat + STATUS_LIST_TTL, ttl: STATUS_LIST_TTL,
      status_list: { bits: 1, lst: sd.b64url(deflateSync(bytes)) },
    }, org.privateJwk);
  }

  app.get(['/api/issuer/session', '/api/issuer/status'], (req, res) => res.json(session(owner(req, false))));
  app.post('/api/organisations', wrap(async (req, res) => {
    bodyFields(req.body, ['name']);
    const name = text(req.body.name, 'Organisationsname');
    if (cookieSecret(req)) throw new HttpError(409, 'Dieser Browser ist bereits einer Organisation zugeordnet. Bitte nutze den bestehenden Zugang oder wende dich an die Moderation.');
    const pair = await sd.generateKeyPair();
    const access = secret();
    const org = {
      id: randomUUID(), name, ...pair, state: 'pending', createdAt: new Date(clock()).toISOString(),
      approvedAt: null, fingerprint: await sd.sha256b64(pair.did),
      accessHash: secretHash(access), accessExpires: clock() + ACCESS_TTL,
      recovery: null, credentials: [], offers: [],
    };
    store.addOrganisation(org);
    setCookie(res, access);
    res.status(201).json(session(org));
  }));
  app.post('/api/admin/organisations/:id/recovery', (req, res) => {
    bodyFields(req.body, []);
    const org = store.getOrganisation(req.params.id);
    if (!org) throw new HttpError(404, 'Diese Organisation wurde nicht gefunden.');
    const token = secret();
    const expires = clock() + RECOVERY_TTL;
    store.updateOrganisation(org.id, (current) => { current.recovery = { hash: secretHash(token), expires }; });
    res.json({ url: `${publicUrl}/issuer.html#org-access=${token}`, expiresAt: new Date(expires).toISOString() });
  });
  app.post('/api/issuer/recover', (req, res) => {
    bodyFields(req.body, ['token']);
    if (typeof req.body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(req.body.token)) {
      throw new HttpError(400, 'Der Wiederherstellungslink ist ungültig.');
    }
    const org = store.listIssuers().find((item) => item.recovery && matchesSecret(req.body.token, item.recovery.hash));
    if (!org || org.recovery.expires <= clock()) throw new HttpError(410, 'Der Wiederherstellungslink ist abgelaufen oder wurde bereits verwendet. Bitte wende dich an die Moderation.');
    const existing = owner(req, false);
    if (existing && existing.id !== org.id) throw new HttpError(409, 'Dieser Browser gehört zu einer anderen Organisation. Bitte öffne den Wiederherstellungslink in einem getrennten Browserprofil.');
    const access = secret();
    const updated = store.updateOrganisation(org.id, (current) => {
      current.accessHash = secretHash(access);
      current.accessExpires = clock() + ACCESS_TTL;
      current.recovery = null;
    });
    setCookie(res, access);
    res.json(session(updated));
  });
  app.get('/api/status-lists/:id', wrap(async (req, res) => {
    const org = store.getOrganisation(req.params.id);
    if (!org) throw new HttpError(404, 'Diese Organisation wurde nicht gefunden.');
    res.type('application/statuslist+jwt').send(await signedStatus(org));
  }));

  app.use('/api/issuer', (req, res, next) => {
    req.organisationId = owner(req).id;
    next();
  });
  app.get('/api/issuer/credentials', (req, res) => res.json(owner(req).credentials));
  app.post('/api/issuer/credentials/:id/revoke', (req, res) => {
    bodyFields(req.body, []);
    const org = owner(req);
    const record = org.credentials.find((entry) => entry.id === req.params.id);
    if (!record) throw new HttpError(404, 'Dieser Ausweis wurde nicht von dieser Organisation ausgestellt.');
    const updated = store.updateOrganisation(org.id, (current) => {
      const entry = current.credentials.find((item) => item.id === record.id);
      entry.revokedAt ||= new Date(clock()).toISOString();
    });
    res.json(updated.credentials.find((entry) => entry.id === record.id));
  });
  app.post('/api/issuer/offers', wrap(async (req, res) => {
    bodyFields(req.body, ['claims']);
    bodyFields(req.body.claims, ['given_name', 'family_name', 'role']);
    const org = owner(req);
    approved(org);
    const claims = {
      given_name: text(req.body.claims.given_name, 'Vorname'),
      family_name: text(req.body.claims.family_name, 'Nachname'),
      organisation: org.name, role: req.body.claims.role,
    };
    if (!ROLES.includes(claims.role)) throw new HttpError(400, 'Bitte wähle Mitarbeitende, Teamleitung oder Gast als Rolle.');
    const token = secret();
    const transactionCode = String(randomInt(1000000)).padStart(6, '0');
    const offer = {
      id: randomUUID(), tokenHash: secretHash(token), codeHash: secretHash(transactionCode), transactionCode,
      codeAttempts: 0, nonce: secret(), expires: clock() + OFFER_TTL, status: 'offered', claims, publicUrl,
    };
    const url = `${publicUrl}/wallet.html#offer=${sd.jsonB64({ issuer: org.did, id: offer.id, token })}`;
    const qrDataUrl = await QRCode.toDataURL(url, { width: 360, margin: 4 });
    const current = owner(req);
    approved(current);
    store.updateOrganisation(current.id, (item) => {
      item.offers = item.offers.filter((entry) => entry.expires > clock());
      if (item.offers.length >= 1000) throw new HttpError(429, 'Es gibt zu viele offene Angebote. Bitte warte auf deren Ablauf.');
      item.offers.push(offer);
    });
    res.status(201).json({ ...offerMetadata(current, offer, true), url, qrDataUrl });
  }));
  app.get('/api/issuer/offers/:id', (req, res) => {
    const { org, offer } = findOffer(req.params.id, null, owner(req).id);
    res.json(offerMetadata(org, offer, true));
  });
  app.post('/api/issuer/offers/:id/cancel', (req, res) => {
    bodyFields(req.body, []);
    const { org, offer } = findOffer(req.params.id, null, owner(req).id);
    live(offer);
    if (offer.status !== 'offered') throw new HttpError(409, 'Ein bereits signiertes Angebot kann nicht abgebrochen werden. Bitte widerrufe den Ausweis.');
    store.updateOrganisation(org.id, (current) => { current.offers.find((item) => item.id === offer.id).status = 'cancelled'; });
    res.json(offerMetadata(org, { ...offer, status: 'cancelled' }, true));
  });
  app.get('/api/offers/:id', (req, res) => {
    const { org, offer } = findOffer(req.params.id, req.get('X-Offer-Token'));
    live(offer);
    res.json(offerMetadata(org, offer));
  });
  app.post('/api/offers/:id/claim', wrap(async (req, res) => {
    const result = await serialize(async () => {
      const { org, offer } = findOffer(req.params.id, req.get('X-Offer-Token'));
      live(offer);
      approved(org);
      const holder = await holderProof(offer, org, req.body, ['proof', 'transactionCode']);
      if (offer.holderDid && offer.holderDid !== holder.did) throw new HttpError(409, 'Dieses Angebot ist bereits mit einer anderen Wallet verbunden.');
      if (offer.holderDid) {
        approved(store.getOrganisation(org.id));
        const record = org.credentials.find((entry) => entry.id === offer.credentialId);
        if (!record || record.revokedAt) throw new HttpError(410, 'Dieser Ausweis wurde widerrufen oder sein Status ist nicht mehr verfügbar.');
        return offerMetadata(org, offer);
      }
      if (typeof req.body.transactionCode !== 'string' || !/^\d{6}$/.test(req.body.transactionCode)) {
        throw new HttpError(400, 'Bitte gib den sechsstelligen Ausgabecode aus dem Organisationsbrowser ein.');
      }
      if (!matchesSecret(req.body.transactionCode, offer.codeHash)) {
        const updated = store.updateOrganisation(org.id, (current) => {
          const entry = current.offers.find((item) => item.id === offer.id);
          entry.codeAttempts++;
          if (entry.codeAttempts >= 5) {
            entry.status = 'cancelled';
            entry.cancellationReason = 'Zu viele falsche Ausgabecodes. Bitte erstelle ein neues Angebot.';
          }
        }).offers.find((item) => item.id === offer.id);
        throw new HttpError(updated.status === 'cancelled' ? 429 : 400, updated.cancellationReason
          || `Der Ausgabecode ist falsch. Noch ${5 - updated.codeAttempts} Versuch(e).`);
      }
      const used = new Set(org.credentials.map((entry) => entry.statusIndex));
      if (used.size >= STATUS_LIST_ENTRIES) throw new HttpError(409, 'Die Statusliste dieser Organisation ist voll.');
      let statusIndex = randomInt(STATUS_LIST_ENTRIES);
      while (used.has(statusIndex)) statusIndex = (statusIndex + 1) % STATUS_LIST_ENTRIES;
      const sdjwt = await sd.issueSdJwt({
        issuerDid: org.did, issuerPrivateJwk: org.privateJwk, holderPublicJwk: holder.jwk,
        vct: EMPLOYEE_VCT, claims: offer.claims, validDays: 1,
        status: { status_list: { idx: statusIndex, uri: `${publicUrl}/api/status-lists/${org.id}` } },
      });
      const { payload } = sd.describeCredential(sdjwt);
      const credentialId = await sd.sha256b64(sd.parseSdJwt(sdjwt).jwt);
      const current = store.getOrganisation(org.id);
      approved(current);
      const currentOffer = current.offers.find((item) => item.id === offer.id);
      if (!currentOffer) throw new HttpError(410, 'Das Angebot ist abgelaufen.');
      live(currentOffer);
      const updated = store.updateOrganisation(org.id, (item) => {
        item.credentials.push({
          id: credentialId, issuerDid: org.did, holderDid: holder.did, claims: offer.claims, statusIndex,
          issuedAt: new Date(payload.iat * 1000).toISOString(), expiresAt: new Date(payload.exp * 1000).toISOString(),
          revokedAt: null,
        });
        Object.assign(item.offers.find((entry) => entry.id === offer.id), {
          holderDid: holder.did, credentialId, sdjwt, status: 'issued', transactionCode: null,
        });
      });
      return offerMetadata(updated, updated.offers.find((item) => item.id === offer.id));
    });
    res.json(result);
  }));
  for (const action of ['credential', 'ack']) {
    app.post(`/api/offers/:id/${action}`, wrap(async (req, res) => {
      const { org, offer } = findOffer(req.params.id, req.get('X-Offer-Token'));
      live(offer);
      const holder = await holderProof(offer, org, req.body);
      const current = findOffer(req.params.id, req.get('X-Offer-Token'));
      live(current.offer);
      approved(current.org);
      if (holder.did !== current.offer.holderDid || !['issued', 'accepted'].includes(current.offer.status)) {
        throw new HttpError(409, 'Der Ausweis kann von dieser Wallet noch nicht abgeholt werden.');
      }
      const record = current.org.credentials.find((entry) => entry.id === current.offer.credentialId);
      if (!record || record.revokedAt) throw new HttpError(410, 'Dieser Ausweis wurde widerrufen oder sein Status ist nicht mehr verfügbar.');
      if (action === 'credential') {
        return res.json({ sdjwt: current.offer.sdjwt, issuerName: current.org.name, issuerDid: current.org.did });
      }
      store.updateOrganisation(org.id, (item) => { item.offers.find((entry) => entry.id === offer.id).status = 'accepted'; });
      res.json(offerMetadata(current.org, { ...current.offer, status: 'accepted' }));
    }));
  }
  return { signedStatus };
}
