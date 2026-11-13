import { existsSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { HOSTED_SCHEMA, LEGACY_FILES } from './store.js';

const directory = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../hosted-data/', import.meta.url)));
if (process.env.APP_ROLE && process.env.APP_ROLE !== 'workshop') throw new Error('Der alte Issuer-Modus wird nicht mehr unterstützt. Alte Daten werden nicht gelöscht.');
if (LEGACY_FILES.some((file) => existsSync(path.join(directory, file)))) {
  throw new Error('Alte Zwei-Server-Daten gefunden. Diese werden nicht gelöscht. Bitte ein neues Hosted-Datenverzeichnis verwenden.');
}
const marker = path.join(directory, 'hosted-schema.json');
const state = path.join(directory, 'hosted-state.json');
if (existsSync(marker)) {
  if (JSON.parse(readFileSync(marker, 'utf8')).schema !== HOSTED_SCHEMA) throw new Error('Unbekannte Speicherversion; es wird nichts gelöscht.');
  rmSync(state, { force: true });
  rmSync(marker);
} else if (existsSync(state)) {
  throw new Error('Der Hosted-Speichermarker fehlt; es wird nichts gelöscht.');
}
console.log('Hosted-Organisationsschlüssel, Browser-Zugänge, Ausstellungsbelege und Check-ins wurden gelöscht. Server vorher stoppen. Alte Daten und andere Dateien bleiben unverändert.');
