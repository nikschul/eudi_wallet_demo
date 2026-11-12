import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)));
// Only known data files are removed, never an arbitrary DATA_DIR tree.
const files = process.env.APP_ROLE === 'issuer' ? ['identity.json', 'credentials.json'] : ['issuers.json', 'attendees.json'];
for (const name of files.flatMap((file) => [file, `${file}.tmp`])) {
  rmSync(path.join(directory, name), { force: true });
}
console.log(process.env.APP_ROLE === 'issuer'
  ? 'Issuer-Schlüssel, Ausstellungsübersicht und Widerrufsdaten wurden gelöscht. Ein neuer Issuer benötigt eine neue Vertrauensentscheidung. Server vorher stoppen.'
  : 'Vertrauensliste und Check-ins wurden gelöscht. Server vorher stoppen.');
