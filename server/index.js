import { createApp } from './app.js';
import { createIssuerApp } from './issuer-app.js';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT muss zwischen 1 und 65535 liegen.');
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
const role = process.env.APP_ROLE || 'workshop';
if (!['workshop', 'issuer'].includes(role)) throw new Error('APP_ROLE muss workshop oder issuer sein.');
const factory = role === 'issuer' ? createIssuerApp : createApp;
const { app, adminToken } = await factory({
  publicUrl,
  workshopUrl: process.env.WORKSHOP_URL,
  trustMode: process.env.TRUST_MODE || 'manual',
  adminToken: process.env.ADMIN_TOKEN || undefined,
  verifierName: process.env.VERIFIER_NAME || undefined,
  eventTitle: process.env.EVENT_TITLE || undefined,
  dataDirectory: process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)),
});
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`EUDI-Demo: ${publicUrl}`);
  console.log(`Rolle: ${role === 'issuer' ? 'Eigene Ausweisstelle' : 'Workshop-Zentrale'}`);
  console.log(role === 'issuer' ? `Ausweisstelle: http://localhost:${port}/issuer.html` : `Kiosk: ${publicUrl}/kiosk.html`);
  if (!process.env.ADMIN_TOKEN) console.log(`Zufälliges Admin-Token: ${adminToken}`);
  else console.log('Admin-Token aus der Umgebung geladen.');
  const url = new URL(publicUrl);
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) {
    console.warn('Smartphones benötigen HTTPS für WebCrypto. Bitte PUBLIC_URL auf die öffentliche HTTPS-Adresse setzen.');
  }
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
