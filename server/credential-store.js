import { chmod, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomInt, randomUUID } from 'node:crypto';
import { STATUS_LIST_ENTRIES } from '../public/lib/credential-status.js';

function validate(entries, issuerDid) {
  if (!Array.isArray(entries)) throw new Error('Eine Credential-Liste wurde erwartet.');
  const ids = new Set();
  const indices = new Set();
  for (const entry of entries) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'claims,expiresAt,holderDid,id,issuedAt,issuerDid,revokedAt,statusIndex'
      || typeof entry.id !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(entry.id) || ids.has(entry.id)
      || !Number.isSafeInteger(entry.statusIndex) || entry.statusIndex < 0
      || entry.statusIndex >= STATUS_LIST_ENTRIES || indices.has(entry.statusIndex)
      || typeof entry.issuerDid !== 'string' || !entry.issuerDid.startsWith('did:jwk:') || entry.issuerDid !== issuerDid
      || typeof entry.holderDid !== 'string' || !entry.holderDid.startsWith('did:jwk:')
      || typeof entry.issuedAt !== 'string' || typeof entry.expiresAt !== 'string'
      || !Number.isFinite(Date.parse(entry.issuedAt)) || !Number.isFinite(Date.parse(entry.expiresAt))
      || Date.parse(entry.expiresAt) <= Date.parse(entry.issuedAt)
      || (entry.revokedAt !== null && (typeof entry.revokedAt !== 'string' || !Number.isFinite(Date.parse(entry.revokedAt))))
      || !entry.claims || typeof entry.claims !== 'object' || Array.isArray(entry.claims)
      || Object.keys(entry.claims).sort().join(',') !== 'family_name,given_name,organisation,role'
      || Object.values(entry.claims).some((value) => typeof value !== 'string' || !value.trim() || value.length > 120)) {
      throw new Error('Ein gespeicherter Credential-Eintrag ist beschädigt.');
    }
    ids.add(entry.id);
    indices.add(entry.statusIndex);
  }
}

export async function createCredentialStore(directory, issuerDid, { required = false } = {}) {
  const file = path.join(directory, 'credentials.json');
  let records = [];
  let missing = false;
  try {
    records = JSON.parse(await readFile(file, 'utf8'));
    validate(records, issuerDid);
    await chmod(file, 0o600);
  } catch (error) {
    if (error.code !== 'ENOENT' || required) throw new Error('Die gespeicherten Credentials konnten nicht sicher geladen werden.', { cause: error });
    missing = true;
  }
  async function save(next) {
    validate(next, issuerDid || next[0]?.issuerDid);
    const temporary = path.join(directory, `.credentials-${randomUUID()}.json`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(next, null, 2), 'utf8');
      await handle.sync();
      await handle.close();
      handle = null;
      await rename(temporary, file);
      records = next;
      issuerDid ||= next[0]?.issuerDid;
    } finally {
      if (handle) await handle.close();
      await unlink(temporary).catch((error) => { if (error.code !== 'ENOENT') throw error; });
    }
  }
  if (missing) await save([]);
  return {
    list: () => records.map((entry) => ({ ...entry, claims: { ...entry.claims } })),
    get: (id) => {
      const entry = records.find((item) => item.id === id);
      return entry ? { ...entry, claims: { ...entry.claims } } : null;
    },
    allocateIndex() {
      const used = new Set(records.map((entry) => entry.statusIndex));
      if (used.size >= STATUS_LIST_ENTRIES) throw new Error('Die Statusliste ist voll. Es können keine weiteren Ausweise ausgestellt werden.');
      const start = randomInt(STATUS_LIST_ENTRIES);
      for (let offset = 0; offset < STATUS_LIST_ENTRIES; offset++) {
        const index = (start + offset) % STATUS_LIST_ENTRIES;
        if (!used.has(index)) return index;
      }
      throw new Error('Es konnte kein freier Statuslisten-Index vergeben werden.');
    },
    async add(entry) { await save([...records, entry]); },
    async revoke(id, time) {
      const entry = records.find((item) => item.id === id);
      if (!entry) return null;
      if (!entry.revokedAt) await save(records.map((item) => item.id === id ? { ...item, revokedAt: time } : item));
      return { ...records.find((item) => item.id === id), claims: { ...entry.claims } };
    },
    statusBytes() {
      const bytes = new Uint8Array(STATUS_LIST_ENTRIES / 8);
      for (const entry of records) {
        if (entry.revokedAt) bytes[Math.floor(entry.statusIndex / 8)] |= 1 << (entry.statusIndex % 8);
      }
      return bytes;
    },
  };
}
