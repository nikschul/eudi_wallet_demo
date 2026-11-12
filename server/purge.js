import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const directory = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../data/', import.meta.url)));
// Only known data files are removed, never an arbitrary DATA_DIR tree.
for (const name of ['issuers.json', 'attendees.json', 'issuers.json.tmp', 'attendees.json.tmp']) {
  rmSync(path.join(directory, name), { force: true });
}
console.log('Gespeicherte Issuer und Check-ins wurden gelöscht. Ein laufender Server muss davor gestoppt werden.');
