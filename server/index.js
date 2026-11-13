import { createApp } from './app.js';
import { fileURLToPath } from 'node:url';

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT muss zwischen 1 und 65535 liegen.');
const localPort = Number(process.env.HOST_PORT || port);
if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65535) throw new Error('HOST_PORT muss zwischen 1 und 65535 liegen.');
const publicUrl = process.env.PUBLIC_URL || `http://localhost:${port}`;
const role = process.env.APP_ROLE || 'workshop';
if (role !== 'workshop') throw new Error('Der separate Issuer-Modus wurde ersetzt. Bitte nur die zentral gehostete Workshop-App starten.');
if (process.env.WORKSHOP_URL) throw new Error('WORKSHOP_URL gehört zum alten Zwei-Server-Modus. Bitte nur PUBLIC_URL für die Hosted-App setzen.');
const { app, adminToken } = await createApp({
  publicUrl,
  trustMode: process.env.TRUST_MODE || 'manual',
  verifierName: process.env.VERIFIER_NAME || undefined,
  eventTitle: process.env.EVENT_TITLE || undefined,
  dataDirectory: process.env.DATA_DIR || fileURLToPath(new URL('../hosted-data/', import.meta.url)),
});
const server = app.listen(port, '0.0.0.0', () => {
  console.log(`EUDI-Demo: ${publicUrl}`);
  console.log('Rolle: Zentral gehosteter Workshop');
  console.log(`Organisation anlegen: ${publicUrl}/issuer.html`);
  console.log(`Kiosk: ${publicUrl}/kiosk.html`);
  const managementPath = '/admin.html';
  const unlockLink = (base) => {
    const url = new URL(managementPath, base);
    url.hash = `admin-token=${adminToken}`;
    return url.href;
  };
  console.log(`Verwaltung lokal (privater Freischalt-Link): ${unlockLink(`http://localhost:${localPort}`)}`);
  console.log(`Verwaltung per Tunnel (privater Freischalt-Link): ${unlockLink(publicUrl)}`);
  console.log(`Admin-Token: ${adminToken}`);
  console.log('Freischalt-Link und Token geheim halten. Bei jedem Serverstart neu; keine Env-Einrichtung nötig. Nur Demo-Daten verwenden.');
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
