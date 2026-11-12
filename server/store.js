import { mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import path from 'node:path';

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
    clearAttendees() {
      save('attendees', []);
      attendees = new Map();
    },
  };
}
