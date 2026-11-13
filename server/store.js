import {
  mkdirSync, readFileSync, renameSync, existsSync, chmodSync, openSync, writeFileSync,
  fsyncSync, closeSync, unlinkSync,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import * as sd from '../public/lib/sdjwt.js';
import { ROLES, publicOrigin } from '../public/lib/protocol.js';
import { validateCredentialRecords } from './credential-store.js';

export const HOSTED_SCHEMA = 'eudi-hosted-organisations-v1';
export const LEGACY_FILES = ['identity.json', 'credentials.json', 'issuers.json', 'attendees.json'];
const hash = (value) => typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);
const uuid = (value) => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value);
const date = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const name = (value) => typeof value === 'string' && Boolean(value.trim()) && value.length <= 120;
const clone = (value) => structuredClone(value);

export function validateCheckin(entry) {
  const strings = ['id', 'name', 'issuerName', 'issuerDid', 'holderDid', 'credentialType', 'credentialId', 'time'];
  if (!entry || strings.some((key) => typeof entry[key] !== 'string' || !entry[key])
    || ['issuerOwner', 'employeeName', 'ownerName'].some((key) => Object.hasOwn(entry, key))
    || !date(entry.time) || entry.trustedAtCheckin !== true
    || !entry.claims || typeof entry.claims !== 'object' || Array.isArray(entry.claims)
    || Object.entries(entry.claims).some(([key, value]) => !['given_name', 'family_name', 'organisation', 'role'].includes(key)
      || typeof value !== 'string' || value.length > 120)
    || !entry.claims.given_name?.trim() || !entry.claims.family_name?.trim()
    || (entry.claims.role !== undefined && !ROLES.includes(entry.claims.role))) {
    throw new Error('Ein gespeichertes Check-in-Protokoll ist beschädigt.');
  }
}

function validate(state) {
  if (!state || state.schema !== HOSTED_SCHEMA || !Array.isArray(state.organisations)
    || !Array.isArray(state.attendees)) throw new Error('Das Hosted-Speicherformat ist beschädigt.');
  const ids = new Set();
  const dids = new Set();
  const offers = new Set();
  for (const org of state.organisations) {
    if (!org || !uuid(org.id) || ids.has(org.id) || dids.has(org.did) || !name(org.name)
      || ['employeeName', 'ownerName', 'issuerOwner'].some((key) => Object.hasOwn(org, key))
      || !['pending', 'approved', 'suspended'].includes(org.state)
      || !date(org.createdAt) || (org.approvedAt !== null && !date(org.approvedAt))
      || (org.state === 'approved' && !date(org.approvedAt))
      || !hash(org.accessHash) || !Number.isSafeInteger(org.accessExpires)
      || !org.publicJwk || !org.privateJwk?.d || sd.didFromJwk(org.publicJwk) !== org.did
      || JSON.stringify(sd.publicPart(org.privateJwk)) !== JSON.stringify(sd.publicPart(org.publicJwk))
      || !hash(org.fingerprint) || !Array.isArray(org.offers)
      || (org.recovery !== null && (!org.recovery || !hash(org.recovery.hash) || !Number.isSafeInteger(org.recovery.expires)))) {
      throw new Error('Eine gespeicherte Organisationsidentität ist beschädigt.');
    }
    validateCredentialRecords(org.credentials, org.did, org.name);
    for (const offer of org.offers) {
      if (!offer || !uuid(offer.id) || offers.has(offer.id) || !hash(offer.tokenHash)
        || !hash(offer.codeHash) || typeof offer.nonce !== 'string' || !Number.isSafeInteger(offer.expires)
        || publicOrigin(offer.publicUrl) !== offer.publicUrl
        || !['offered', 'issued', 'accepted', 'cancelled'].includes(offer.status)
        || !Number.isInteger(offer.codeAttempts) || offer.codeAttempts < 0 || offer.codeAttempts > 5
        || !offer.claims || Object.keys(offer.claims).sort().join(',') !== 'family_name,given_name,organisation,role'
        || !name(offer.claims.given_name) || !name(offer.claims.family_name)
        || offer.claims.organisation !== org.name || !ROLES.includes(offer.claims.role)
        || (offer.status === 'offered' && !/^\d{6}$/.test(offer.transactionCode))
        || (['issued', 'accepted'].includes(offer.status) && (
          typeof offer.sdjwt !== 'string' || !org.credentials.some((entry) => entry.id === offer.credentialId
            && entry.holderDid === offer.holderDid)) )) {
        throw new Error('Ein gespeichertes Ausstellungsangebot ist beschädigt.');
      }
      offers.add(offer.id);
    }
    ids.add(org.id);
    dids.add(org.did);
  }
  const holders = new Set();
  for (const attendee of state.attendees) {
    if (!attendee || typeof attendee.key !== 'string' || holders.has(attendee.key)
      || !Array.isArray(attendee.checkins) || !attendee.checkins.length) {
      throw new Error('Eine gespeicherte Check-in-Historie ist beschädigt.');
    }
    validateCheckin(attendee);
    for (const checkin of attendee.checkins) validateCheckin(checkin);
    holders.add(attendee.key);
  }
}

export function createStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (LEGACY_FILES.some((file) => existsSync(path.join(directory, file)))) {
    throw new Error('Alte Zwei-Server-Daten gefunden. Bitte ein neues leeres Hosted-Datenverzeichnis verwenden; eine Migration ist nicht vorgesehen.');
  }
  const marker = path.join(directory, 'hosted-schema.json');
  const target = path.join(directory, 'hosted-state.json');
  const initialized = existsSync(marker);
  let state;
  if (initialized) {
    try {
      if (JSON.parse(readFileSync(marker, 'utf8')).schema !== HOSTED_SCHEMA) throw new Error('Unbekannte Speicherversion.');
      state = JSON.parse(readFileSync(target, 'utf8'));
      validate(state);
      chmodSync(marker, 0o600);
      chmodSync(target, 0o600);
    } catch (error) {
      throw new Error('Die Hosted-Daten konnten nicht sicher geladen werden. Fehlende oder beschädigte Daten dürfen nicht zurückgesetzt werden.', { cause: error });
    }
  } else {
    if (existsSync(target)) throw new Error('Der Hosted-Speichermarker fehlt. Die Daten dürfen nicht zurückgesetzt werden.');
    writeFileSync(marker, JSON.stringify({ schema: HOSTED_SCHEMA }), { flag: 'wx', mode: 0o600 });
    state = { schema: HOSTED_SCHEMA, organisations: [], attendees: [] };
  }
  function save(next) {
    validate(next);
    const temporary = path.join(directory, `.hosted-state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = openSync(temporary, 'wx', 0o600);
      writeFileSync(handle, JSON.stringify(next, null, 2));
      fsyncSync(handle);
      closeSync(handle);
      handle = undefined;
      renameSync(temporary, target);
      state = next;
      const directoryHandle = openSync(directory, 'r');
      try { fsyncSync(directoryHandle); } finally { closeSync(directoryHandle); }
    } finally {
      if (handle !== undefined) closeSync(handle);
      if (existsSync(temporary)) unlinkSync(temporary);
    }
  }
  if (!initialized) save(state);
  return {
    getOrganisation: (id) => clone(state.organisations.find((org) => org.id === id) || null),
    getIssuer: (did) => clone(state.organisations.find((org) => org.did === did) || null),
    listIssuers: () => clone(state.organisations),
    addOrganisation(org) {
      const next = clone(state);
      next.organisations.push(clone(org));
      save(next);
    },
    updateOrganisation(id, update) {
      const next = clone(state);
      const org = next.organisations.find((item) => item.id === id);
      if (!org) throw new Error('Die Organisation wurde nicht gefunden.');
      const immutable = JSON.stringify([org.id, org.name, org.did, org.publicJwk, org.privateJwk, org.fingerprint, org.createdAt]);
      const previousCredentials = clone(org.credentials);
      update(org);
      if (JSON.stringify([org.id, org.name, org.did, org.publicJwk, org.privateJwk, org.fingerprint, org.createdAt]) !== immutable) {
        throw new Error('Die Organisationsbindung darf nicht geändert werden.');
      }
      for (const previous of previousCredentials) {
        const record = org.credentials.find((entry) => entry.id === previous.id);
        const { revokedAt, ...fixed } = previous;
        const { revokedAt: nextRevokedAt, ...nextFixed } = record || {};
        if (JSON.stringify(fixed) !== JSON.stringify(nextFixed)
          || (revokedAt !== null && nextRevokedAt !== revokedAt)) {
          throw new Error('Ausstellungsbelege dürfen nicht geändert oder gelöscht und Widerrufe nicht zurückgenommen werden.');
        }
      }
      save(next);
      return clone(org);
    },
    listAttendees: () => clone(state.attendees).sort((a, b) => b.time.localeCompare(a.time))
      .map(({ key, ...attendee }) => attendee),
    recordCheckin(key, checkin) {
      validateCheckin(checkin);
      const next = clone(state);
      const previous = next.attendees.find((entry) => entry.key === key);
      next.attendees = next.attendees.filter((entry) => entry.key !== key);
      next.attendees.push({ ...clone(checkin), key, checkins: [...(previous?.checkins || []), clone(checkin)] });
      save(next);
    },
    clearAttendees() {
      save({ ...state, attendees: [] });
    },
  };
}
