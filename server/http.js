import { createHash, timingSafeEqual } from 'node:crypto';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const wrap = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

export function bodyFields(body, fields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some((field) => !fields.includes(field))) {
    throw new HttpError(400, 'Die übermittelten Daten haben ein ungültiges Format.');
  }
}

export function text(value, label, max = 120) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new HttpError(400, `${label} fehlt oder ist zu lang (höchstens ${max} Zeichen).`);
  }
  return value.trim();
}

export const secretHash = (value) => createHash('sha256').update(value).digest('base64url');
export function matchesSecret(value, hash) {
  return typeof value === 'string' && typeof hash === 'string'
    && timingSafeEqual(Buffer.from(secretHash(value)), Buffer.from(hash));
}
