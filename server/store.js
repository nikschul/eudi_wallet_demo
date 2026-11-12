import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';
import { publicOrigin } from '../public/lib/protocol.js';

function validateCheckin(entry) {
  const strings = ['id', 'name', 'issuerName', 'issuerDid', 'issuerOwner', 'holderDid', 'credentialType', 'credentialId', 'time'];
  if (!entry || strings.some((key) => typeof entry[key] !== 'string' || !entry[key])
    || !Number.isFinite(Date.parse(entry.time)) || entry.trustedAtCheckin !== true
    || !entry.claims || typeof entry.claims !== 'object' || Array.isArray(entry.claims)
    || Object.entries(entry.claims).some(([key, value]) => !['given_name', 'family_name', 'organisation', 'role'].includes(key)
      || typeof value !== 'string' || value.length > 120)
    || !entry.claims.given_name?.trim() || !entry.claims.family_name?.trim()) {
    throw new Error('Ein gespeichertes Check-in-Protokoll ist beschädigt.');
  }
}

export function createStore(directory) {
  mkdirSync(directory, { recursive: true });

  function load(name) {
    try {
      const entries = JSON.parse(readFileSync(path.join(directory, `${name}.json`), 'utf8'));
      if (!Array.isArray(entries)) throw new Error('Eine Liste wurde erwartet.');
      const key = name === 'issuers' ? 'did' : 'key';
      for (const entry of entries) {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)
          || typeof entry[key] !== 'string' || !entry[key]
          || typeof entry.name !== 'string'
          || (name === 'issuers' ? typeof entry.trusted !== 'boolean'
            : typeof entry.time !== 'string' || !Number.isFinite(Date.parse(entry.time)))) {
          throw new Error('Ein gespeicherter Eintrag ist beschädigt.');
        }
        if (name === 'issuers' && entry.proofVerified) {
          if (publicOrigin(entry.publicUrl) !== entry.publicUrl || typeof entry.employeeName !== 'string'
            || typeof entry.fingerprint !== 'string' || (entry.trusted && !entry.ownerName)) {
            throw new Error('Die gespeicherte Issuer-Zuordnung ist beschädigt.');
          }
        }
        if (name === 'attendees' && entry.checkins !== undefined) {
          if (!Array.isArray(entry.checkins)) throw new Error('Die Check-in-Historie ist keine Liste.');
          for (const checkin of entry.checkins) validateCheckin(checkin);
        }
      }
      if (new Set(entries.map((entry) => entry[key])).size !== entries.length) {
        throw new Error('Doppelte Einträge wurden gefunden.');
      }
      return entries;
    } catch (error) {
      if (error.code === 'ENOENT') return [];
      throw new Error(`Die Datei ${name}.json konnte nicht geladen werden: ${error.message}`, { cause: error });
    }
  }

  function save(name, entries) {
    const target = path.join(directory, `${name}.json`);
    const temporary = `${target}.tmp`;
    writeFileSync(temporary, JSON.stringify(entries, null, 2), { mode: 0o600 });
    renameSync(temporary, target);
  }

  let issuers = new Map(load('issuers').map((entry) => [entry.did, entry]));
  let attendees = new Map(load('attendees').map((entry) => [entry.key, entry]));
  return {
    getIssuer: (did) => issuers.get(did),
    listIssuers: () => [...issuers.values()],
    putIssuer(issuer) {
      const next = new Map(issuers).set(issuer.did, issuer);
      save('issuers', [...next.values()]);
      issuers = next;
      return issuer;
    },
    listAttendees: () => [...attendees.values()]
      .sort((a, b) => b.time.localeCompare(a.time))
      .map(({ key, ...attendee }) => attendee),
    putAttendee(key, attendee) {
      const previous = attendees.get(key);
      const next = new Map(attendees).set(key, previous
        ? { ...previous, time: attendee.time }
        : { key, ...attendee });
      save('attendees', [...next.values()]);
      attendees = next;
    },
    recordCheckin(key, checkin) {
      validateCheckin(checkin);
      const previous = attendees.get(key);
      const entry = {
        ...checkin,
        checkins: [...(previous?.checkins || []), checkin],
        key,
      };
      const next = new Map(attendees).set(key, entry);
      save('attendees', [...next.values()]);
      attendees = next;
    },
    clearAttendees() {
      save('attendees', []);
      attendees = new Map();
    },
  };
}
