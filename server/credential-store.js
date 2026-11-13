import { STATUS_LIST_ENTRIES } from '../public/lib/credential-status.js';
import { ROLES } from '../public/lib/protocol.js';

export function validateCredentialRecords(entries, issuerDid, organisation) {
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
      || Object.values(entry.claims).some((value) => typeof value !== 'string' || !value.trim() || value.length > 120)
      || !ROLES.includes(entry.claims.role)
      || (organisation !== undefined && entry.claims.organisation !== organisation)) {
      throw new Error('Ein gespeicherter Credential-Eintrag ist beschädigt.');
    }
    ids.add(entry.id);
    indices.add(entry.statusIndex);
  }
}
