import { randomBytes, timingSafeEqual } from 'node:crypto';

export function managementAuth(app, prefix) {
  const token = randomBytes(32).toString('base64url');
  const expected = Buffer.from(token);
  app.use(prefix, (req, res, next) => {
    const supplied = Buffer.from(req.get('X-Admin-Token') || '');
    if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
      return res.status(401).json({
        error: 'Verwaltung gesperrt. Bitte den aktuellen Freischalt-Link aus den Server-Logs öffnen oder den Admin-Token eingeben. Nach einem Serverneustart gilt ein neuer Token.',
      });
    }
    next();
  });
  app.get(`${prefix}/session`, (req, res) => res.json({ ok: true }));
  return token;
}
