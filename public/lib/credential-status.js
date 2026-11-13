import * as sd from './sdjwt.js';
import { publicOrigin } from './protocol.js';

export const STATUS_LIST_ENTRIES = 16384;
export const STATUS_LIST_TTL = 30;
const MAX_TOKEN_BYTES = 16384;

async function boundedBytes(stream, maximum) {
  const reader = stream.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) {
        await reader.cancel();
        throw new Error('Die Statusliste ist zu groß.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function statusListUrl(issuer) {
  if (!issuer || typeof issuer.id !== 'string'
    || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(issuer.id)) {
    throw new Error('Die registrierte Organisationskennung ist ungültig.');
  }
  const uri = `${publicOrigin(issuer.publicUrl, 'Issuer-Adresse')}/api/status-lists/${issuer.id}`;
  if (issuer.statusListUrl !== undefined && issuer.statusListUrl !== uri) {
    throw new Error('Die registrierte Statuslisten-Adresse passt nicht zur Organisation.');
  }
  return uri;
}

export function statusReference(payload, issuer) {
  const reference = payload.status?.status_list;
  if (!reference) throw new Error('Dieser ältere Ausweis hat keinen Widerrufsstatus. Bitte lasse ihn neu ausstellen.');
  const uri = statusListUrl(issuer);
  if (!Number.isSafeInteger(reference.idx) || reference.idx < 0 || reference.idx >= STATUS_LIST_ENTRIES
    || reference.uri !== uri) {
    throw new Error('Die Statusreferenz des Ausweises passt nicht zur registrierten Ausweisstelle. Bitte lasse ihn neu ausstellen.');
  }
  return reference;
}

export async function verifyStatusList(token, { issuerDid, uri, now = Date.now() }) {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_BYTES) throw new Error('Ungültige signierte Statusliste.');
  const { header, payload } = await sd.verifyJwt(token, sd.jwkFromDid(issuerDid));
  const seconds = Math.floor(now / 1000);
  if (header.typ !== 'statuslist+jwt' || payload.iss !== issuerDid || payload.sub !== uri
    || !Number.isSafeInteger(payload.iat) || !Number.isSafeInteger(payload.exp)
    || payload.iat > seconds + 5 || payload.exp <= seconds || payload.exp <= payload.iat
    || payload.exp - payload.iat > STATUS_LIST_TTL || payload.iat < seconds - STATUS_LIST_TTL
    || payload.ttl !== STATUS_LIST_TTL || payload.status_list?.bits !== 1
    || typeof payload.status_list.lst !== 'string' || !/^[A-Za-z0-9_-]+$/.test(payload.status_list.lst)) {
    throw new Error('Die signierte Statusliste ist ungültig oder nicht mehr aktuell.');
  }
  const compressed = sd.b64urlDecode(payload.status_list.lst);
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('deflate'));
  const bytes = await boundedBytes(stream, STATUS_LIST_ENTRIES / 8);
  if (bytes.length !== STATUS_LIST_ENTRIES / 8) throw new Error('Die Statusliste hat eine ungültige Länge.');
  return { bytes, issuedAt: payload.iat * 1000, expiresAt: payload.exp * 1000 };
}

export function isRevoked(list, index) {
  if (!Number.isSafeInteger(index) || index < 0 || index >= STATUS_LIST_ENTRIES) {
    throw new Error('Ungültiger Statuslisten-Index.');
  }
  return Boolean(list.bytes[Math.floor(index / 8)] & (1 << (index % 8)));
}

export async function loadStatusList(issuer, { now = () => Date.now(), timeoutMs = 5000 } = {}) {
  const uri = statusListUrl(issuer);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetch(uri, {
        headers: { Accept: 'application/statuslist+jwt' }, credentials: 'omit',
        cache: 'no-store', redirect: 'error', signal: controller.signal,
      });
    } catch (error) {
      throw new Error(controller.signal.aborted
        ? 'Der Issuer antwortet bei der Statusprüfung nicht rechtzeitig.'
        : 'Die Statusliste des Issuers ist nicht erreichbar.', { cause: error });
    }
    if (!response.ok) throw new Error(`Die Statusliste ist derzeit nicht verfügbar (HTTP ${response.status}).`);
    if (!response.headers.get('content-type')?.startsWith('application/statuslist+jwt') || !response.body) {
      throw new Error('Der Issuer hat keine signierte Statusliste geliefert.');
    }
    const bytes = await boundedBytes(response.body, MAX_TOKEN_BYTES);
    const list = await verifyStatusList(new TextDecoder().decode(bytes), { issuerDid: issuer.did, uri, now: now() });
    if (list.expiresAt <= now()) throw new Error('Die Statusliste ist nicht mehr aktuell.');
    return list;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Der Issuer antwortet bei der Statusprüfung nicht rechtzeitig.', { cause: error });
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
