# Spec: EUDI-Wallet-Simulation mit Check-in (Teil 2)

Nov 12, 2026 · @Niklas · Übergabe an Coding Agent

## Ziel und Rahmen

Gebaut wird eine Browser-Simulation des EUDI-Ablaufs: Jede Person legt auf dem eigenen Smartphone eine Wallet und einen eigenen Issuer an, stellt sich einen Gastausweis aus und checkt damit am Empfangsbildschirm ein. Das ersetzt den Check-in per Fraunhofer-PKI-Smartcard. Das echte EUDI-Reference-Wallet zeigt Teil 1 auf einem Demo-Gerät; Teil 2 ist die Simulation zum Selbermachen.

- **Kein App-Store, keine Installation:** Alles läuft als Webseite in Safari bzw. Chrome, auf iOS und Android gleich.
- **Echte Kryptographie:** Schlüsselpaare, DIDs (`did:jwk`), signierte Nachweise im SD-JWT-Format, Selective Disclosure, Key Binding mit Nonce. Nur die EU-Vertrauenskette und die Protokolle OpenID4VCI/OpenID4VP sind vereinfacht.
- **Publikum:** Nicht-Techniker klicken sich durch. Technikinteressierte können in jedem Schritt die Rohdaten aufklappen.
- **Budget:** etwa 1 Personentag für den Bau inklusive Tests, plus 1–2 h Probelauf.
- **Geräte:** eigene Smartphones der Teilnehmenden und ein Rechner mit großem Bildschirm als Empfang.

## Konzepte, die die Demo zeigt

Jedes Konzept wird an genau einer Stelle der Oberfläche sichtbar. Die Erklärtexte dazu stehen im Abschnitt „Erklärtexte für die Oberfläche“.

| Konzept | Wo sichtbar | Was technisch passiert |
| --- | --- | --- |
| Schlüsselpaar | Wallet anlegen, Issuer anlegen | ECDSA P-256 per WebCrypto im Browser; der private Schlüssel verlässt das Gerät nie |
| DID | Wallet- und Issuer-Profil | `did:jwk:` + base64url(öffentlicher JWK); ohne Register auflösbar |
| Verifiable Credential | Gastausweis in der Wallet | SD-JWT VC, vom Issuer signiert, enthält Issuer-DID und Holder-Schlüssel (`cnf`) |
| Selective Disclosure | Freigabe-Dialog beim Check-in | Nur ausgewählte Disclosures werden mitgeschickt; der Rest bleibt als Hash verborgen |
| Holder Binding | Freigabe beim Check-in | Wallet signiert Nonce und Empfänger mit ihrem privaten Schlüssel (Key-Binding-JWT) |
| Prüfung durch Verifier | Kiosk, Erklär-Panel | Signatur, Hashes, Ablaufdatum, Holder Binding, Nonce werden Schritt für Schritt geprüft |
| Vertrauensliste | Admin-Ansicht, Kiosk-Fehlermeldung | Kiosk akzeptiert nur Issuer, die auf der Liste stehen (abschaltbar) |
| Replay-Schutz | optionaler Demo-Knopf | Eine alte Presentation wird erneut gesendet und wegen falscher Nonce abgelehnt |

## Architektur und Ablauf

Ein einziger Node-Server liefert vier statische Seiten aus und stellt eine kleine API bereit. Alle Schlüssel werden im Browser erzeugt und liegen im `localStorage` des Smartphones. Der Server kennt nur öffentliche Daten: Issuer-DIDs, Check-in-Anfragen und die Check-in-Liste.

| Seite | Gerät | Rolle im EUDI-Modell |
| --- | --- | --- |
| `/wallet.html` | Smartphone | Holder (Wallet) |
| `/issuer.html` | Smartphone, gleicher Browser | Issuer (Aussteller) |
| `/kiosk.html` | Empfangsrechner | Verifier (Prüfer) |
| `/admin.html` | Laptop der Moderation | Betreiber der Vertrauensliste |

**Phase 1: Wallet anlegen**

1. Teilnehmende scannen einen QR (Folie oder Kiosk) mit der normalen Kamera-App und landen auf `/wallet.html`.
2. „Wallet erstellen“ erzeugt ein Schlüsselpaar und daraus die Holder-DID. Beides wird im `localStorage` gespeichert, die DID wird angezeigt.

**Phase 2: Issuer anlegen und Gastausweis ausstellen**

3. Über den Link „Eigenen Issuer anlegen“ geht es zu `/issuer.html`. Die Person gibt einen Issuer-Namen ein (z. B. „Niklas' Ausweisstelle“). Der Browser erzeugt ein zweites Schlüsselpaar und die Issuer-DID.
4. Der Browser registriert Issuer-DID und Namen per `POST /api/issuers` beim Server. Das entspricht dem Eintrag in eine Vertrauensliste. Je nach Modus ist der Issuer sofort vertrauenswürdig oder erst nach Freigabe durch die Admin-Ansicht.
5. Die Person füllt das Formular „Gastausweis“ aus: Vorname, Nachname, Organisation, Rolle. Die Issuer-Seite liest die Holder-DID aus dem `localStorage` (gleicher Browser), signiert den Nachweis und legt ihn als Angebot (`pendingOffer`) im `localStorage` ab.
6. Weiterleitung auf `/wallet.html#offer`. Die Wallet zeigt den Nachweis an. „Annehmen“ speichert ihn in der Wallet.

**Phase 3: Check-in am Empfang**

7. Der Kiosk legt per `POST /api/requests` eine Anfrage mit zufälliger Nonce an. Er zeigt einen QR mit der URL `{PUBLIC_URL}/wallet.html#req={id}`.
8. Die Person scannt den QR mit der Kamera-App. Die Wallet lädt die Anfrage per `GET /api/requests/{id}` und zeigt: wer fragt, welche Attribute angefragt sind, welche optional sind.
9. Die Person wählt die Attribute (Vorname und Nachname vorausgewählt, Organisation und Rolle abgewählt) und tippt „Freigeben“. Die Wallet baut die Presentation inklusive Key-Binding-JWT und sendet sie per `POST /api/requests/{id}/response`.
10. Der Server prüft die Presentation mit demselben Kryptographie-Modul und speichert Ergebnis und Prüfschritte.
11. Der Kiosk fragt alle 1,5 s `GET /api/requests/{id}` ab. Bei Erfolg zeigt er „Willkommen, …“, das Erklär-Panel mit allen Prüfschritten und danach einen neuen QR.

## Regeln und Tech-Stack für den Coding Agent

Diese Regeln sind verbindlich. Wenn etwas unklar ist, nimm die einfachste Lösung, die die Akzeptanzkriterien erfüllt, und notiere die Annahme in `NOTES.md`.

- **Laufzeit:** Node.js 20 oder neuer. Nutze `globalThis.crypto.subtle`, `atob`, `btoa`; die gibt es im Browser und in Node 20.
- **Abhängigkeiten:** nur `express` (v4) und `qrcode`. Keine weiteren npm-Pakete, keine Krypto-Bibliotheken, kein CDN.
- **Frontend:** reines HTML, CSS und JavaScript mit ES-Modulen (`<script type="module">`). Kein Framework, kein Build-Step, kein TypeScript, kein Service Worker, kein Web-App-Manifest.
- **Ein Krypto-Modul für alle:** `public/lib/sdjwt.js` wird von Wallet, Issuer und Server importiert. Der Server importiert es mit `import * as sd from '../public/lib/sdjwt.js'`. Übernimm den Referenzcode aus dem nächsten Abschnitt wörtlich.
- **Sprache:** Oberflächentexte auf Deutsch, Code und Kommentare auf Englisch.
- **Speicherung:** Browser nur im `localStorage` (Schlüssel `wallet`, `issuer`, `pendingOffer`). Server im Speicher plus JSON-Dateien in `data/`.
- **Fehler:** Jeder Fehler wird der Person als verständlicher Satz gezeigt, nie als leere Seite. Die Fehlermeldungen aus `sdjwt.js` sind bereits deutsch und werden direkt angezeigt.
- **Mobil zuerst:** Wallet und Issuer müssen auf 375 px Breite gut bedienbar sein (Schrift mindestens 16 px, Buttons mindestens 44 px hoch).
- **Nichts erfinden:** keine Funktionen außerhalb dieser Spec, keine Benutzerkonten, kein Login.

```
eudi-sim/
├── package.json            # "type": "module"; scripts: start, test, purge
├── .env.example
├── README.md
├── NOTES.md
├── server/
│   ├── index.js            # Express, statische Dateien, API
│   └── store.js            # Laden/Speichern der JSON-Dateien
├── public/
│   ├── lib/sdjwt.js        # Krypto-Modul (Referenzcode)
│   ├── lib/ui.js           # kleine Helfer: Toast, Rohdaten-Aufklapper, Fetch-Wrapper
│   ├── index.html          # Start: Links zu Wallet und Issuer
│   ├── wallet.html + wallet.js
│   ├── issuer.html + issuer.js
│   ├── kiosk.html + kiosk.js
│   ├── admin.html + admin.js
│   └── styles.css
├── test/sdjwt.test.js
└── data/                   # in .gitignore
```

| Variable | Default | Bedeutung |
| --- | --- | --- |
| `PORT` | 3000 | Port des Servers |
| `PUBLIC_URL` | `http://localhost:3000` | Öffentliche HTTPS-Adresse (Tunnel), wird in die QR-Codes geschrieben |
| `TRUST_MODE` | `auto` | `auto`: neue Issuer sind sofort vertrauenswürdig; `manual`: erst nach Freigabe in `/admin` |
| `ADMIN_TOKEN` | beim Start zufällig, in der Konsole ausgegeben | Schutz der Admin-Endpunkte |
| `VERIFIER_NAME` | `Fraunhofer ISST – Empfang` | Name, den die Wallet bei der Anfrage anzeigt |
| `EVENT_TITLE` | `EUDI Wallet Workshop` | Überschrift auf Kiosk und Startseite |

## Kryptographie-Modul mit Referenzcode

`public/lib/sdjwt.js` ist der heikelste Teil und wird deshalb vorgegeben. Übernimm den Code wörtlich und ändere ihn nur, wenn ein Test aus der Liste unten fehlschlägt. Das Format orientiert sich an SD-JWT VC (IETF) mit Key Binding, vereinfacht auf flache Claims.

```javascript
// public/lib/sdjwt.js – runs in the browser and in Node 20 (globalThis.crypto)
const enc = new TextEncoder();
const dec = new TextDecoder();
const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };

// ---------- encoding helpers ----------
export function b64url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
export function b64urlDecode(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((str.length + 3) % 4);
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}
export const jsonB64 = (obj) => b64url(enc.encode(JSON.stringify(obj)));
export const parseB64Json = (s) => JSON.parse(dec.decode(b64urlDecode(s)));
export async function sha256b64(str) {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(str))));
}
const now = () => Math.floor(Date.now() / 1000);

// ---------- keys and DIDs ----------
export function publicPart({ kty, crv, x, y }) {
  return { kty, crv, x, y };
}
export async function generateKeyPair() {
  const kp = await crypto.subtle.generateKey(ALG, true, ['sign', 'verify']);
  const publicJwk = publicPart(await crypto.subtle.exportKey('jwk', kp.publicKey));
  const privateJwk = await crypto.subtle.exportKey('jwk', kp.privateKey);
  return { publicJwk, privateJwk, did: didFromJwk(publicJwk) };
}
export function didFromJwk(publicJwk) {
  return 'did:jwk:' + jsonB64(publicPart(publicJwk));
}
export function jwkFromDid(did) {
  if (typeof did !== 'string' || !did.startsWith('did:jwk:')) {
    throw new Error('Unbekanntes DID-Format (nur did:jwk wird unterstützt)');
  }
  return parseB64Json(did.slice('did:jwk:'.length));
}

// ---------- JWS (compact) ----------
export async function signJwt(header, payload, privateJwk) {
  const key = await crypto.subtle.importKey('jwk', privateJwk, ALG, false, ['sign']);
  const input = jsonB64(header) + '.' + jsonB64(payload);
  const sig = new Uint8Array(await crypto.subtle.sign(SIG, key, enc.encode(input)));
  return input + '.' + b64url(sig);
}
export function decodeJwt(jwt) {
  const parts = String(jwt).split('.');
  if (parts.length !== 3) throw new Error('Ungültiges JWT');
  return { header: parseB64Json(parts[0]), payload: parseB64Json(parts[1]) };
}
export async function verifyJwt(jwt, publicJwk) {
  const [h, p, s] = String(jwt).split('.');
  if (!h || !p || !s) throw new Error('Ungültiges JWT');
  const key = await crypto.subtle.importKey('jwk', publicPart(publicJwk), ALG, false, ['verify']);
  const ok = await crypto.subtle.verify(SIG, key, b64urlDecode(s), enc.encode(h + '.' + p));
  if (!ok) throw new Error('Signatur ungültig');
  return { header: parseB64Json(h), payload: parseB64Json(p) };
}

// ---------- SD-JWT VC ----------
// claims: flat object, e.g. { given_name: 'Erika', family_name: 'Mustermann' }
export async function issueSdJwt({ issuerDid, issuerPrivateJwk, holderPublicJwk, vct, claims, validDays = 1 }) {
  const disclosures = [];
  const digests = [];
  for (const [name, value] of Object.entries(claims)) {
    const salt = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const disclosure = jsonB64([salt, name, value]);
    disclosures.push(disclosure);
    digests.push(await sha256b64(disclosure));
  }
  const payload = {
    iss: issuerDid,
    iat: now(),
    exp: now() + validDays * 86400,
    vct,
    cnf: { jwk: publicPart(holderPublicJwk) },
    _sd: digests.sort(),
    _sd_alg: 'sha-256',
  };
  const jwt = await signJwt({ alg: 'ES256', typ: 'dc+sd-jwt', kid: issuerDid + '#0' }, payload, issuerPrivateJwk);
  return jwt + '~' + disclosures.join('~') + '~';
}

// Splits "jwt~d1~d2~[kb]" into its parts
export function parseSdJwt(sdjwt) {
  const parts = String(sdjwt).split('~');
  if (parts.length < 2) throw new Error('Kein SD-JWT');
  return {
    jwt: parts[0],
    disclosures: parts.slice(1, -1).map((raw) => ({ raw, value: parseB64Json(raw) })),
    kb: parts[parts.length - 1] || null,
  };
}

// Readable view of a stored credential (for the wallet UI)
export function describeCredential(sdjwt) {
  const { jwt, disclosures } = parseSdJwt(sdjwt);
  const { header, payload } = decodeJwt(jwt);
  const claims = Object.fromEntries(disclosures.map((d) => [d.value[1], d.value[2]]));
  return { header, payload, claims, disclosures };
}

// Holder: reveal only selected claims and bind to nonce + audience
export async function createPresentation({ sdjwt, reveal, holderPrivateJwk, aud, nonce }) {
  const { jwt, disclosures } = parseSdJwt(sdjwt);
  const chosen = disclosures.filter((d) => reveal.includes(d.value[1])).map((d) => d.raw + '~');
  const withoutKb = jwt + '~' + chosen.join('');
  const kb = await signJwt(
    { alg: 'ES256', typ: 'kb+jwt' },
    { iat: now(), aud, nonce, sd_hash: await sha256b64(withoutKb) },
    holderPrivateJwk,
  );
  return withoutKb + kb;
}

// Verifier: returns { ok, steps, issuer, holder, vct, claims } and never throws
export async function verifyPresentation(presentation, { aud, nonce, isTrustedIssuer }) {
  const steps = [];
  const step = (label) => steps.push(label);
  try {
    const { jwt, disclosures, kb } = parseSdJwt(presentation);
    if (!kb) throw new Error('Kein Key-Binding-JWT vorhanden');
    step('Presentation zerlegt: Nachweis, ' + disclosures.length + ' Disclosure(s), Key-Binding-JWT');

    const iss = decodeJwt(jwt).payload.iss;
    if (!(await isTrustedIssuer(iss))) throw new Error('Issuer steht nicht auf der Vertrauensliste');
    step('Issuer steht auf der Vertrauensliste');

    const { payload } = await verifyJwt(jwt, jwkFromDid(iss));
    step('Signatur des Issuers geprüft (öffentlicher Schlüssel aus der DID)');

    if (payload.exp && payload.exp < now()) throw new Error('Nachweis ist abgelaufen');
    step('Gültigkeitsdauer geprüft');

    const claims = {};
    for (const d of disclosures) {
      if (!payload._sd.includes(await sha256b64(d.raw))) throw new Error('Eine Disclosure gehört nicht zu diesem Nachweis');
      claims[d.value[1]] = d.value[2];
    }
    step('Freigegebene Attribute gegen die Hashes im Nachweis geprüft: ' + Object.keys(claims).join(', '));

    const { payload: kbp } = await verifyJwt(kb, payload.cnf.jwk);
    step('Holder Binding geprüft: Wallet besitzt den passenden privaten Schlüssel');

    const withoutKb = presentation.slice(0, presentation.length - kb.length);
    if (kbp.sd_hash !== (await sha256b64(withoutKb))) throw new Error('Key-Binding passt nicht zur Presentation');
    if (kbp.nonce !== nonce || kbp.aud !== aud) throw new Error('Falsche Nonce oder falscher Empfänger (möglicher Replay-Angriff)');
    step('Nonce und Empfänger stimmen: Presentation wurde frisch für diesen Check-in erstellt');

    return { ok: true, steps, issuer: iss, holder: didFromJwk(payload.cnf.jwk), vct: payload.vct, claims };
  } catch (err) {
    return { ok: false, steps, error: err.message };
  }
}
```

Pflicht-Tests in `test/sdjwt.test.js` (mit `node --test`). Erst wenn alle grün sind, geht es an die Oberfläche.

1. **Roundtrip:** ausstellen, nur `given_name` und `family_name` freigeben, prüfen → `ok: true`, `claims` enthält genau diese zwei Felder.
2. **Umlaute:** `family_name: 'Müller'` übersteht Ausstellen und Prüfen unverändert.
3. **Manipulierte Disclosure:** eine Disclosure gegen eine selbst gebaute austauschen → `ok: false`.
4. **Falsche Nonce:** mit anderer Nonce prüfen → `ok: false`, Fehlertext enthält „Nonce“.
5. **Fremder Holder:** Key-Binding-JWT mit einem anderen privaten Schlüssel signieren → `ok: false`.
6. **Nicht vertrauenswürdiger Issuer:** `isTrustedIssuer` liefert `false` → `ok: false`.
7. **Abgelaufen:** mit `validDays: -1` ausstellen → `ok: false`.
8. **DID-Roundtrip:** `jwkFromDid(didFromJwk(jwk))` ergibt denselben öffentlichen Schlüssel.

## Server-API und Datenhaltung

Alle Endpunkte sprechen JSON. Admin-Endpunkte verlangen den Header `X-Admin-Token`. Der Server prüft Presentations mit `verifyPresentation` aus `sdjwt.js`; er erzeugt und kennt keine privaten Schlüssel.

| Methode | Pfad | Body / Antwort |
| --- | --- | --- |
| POST | `/api/issuers` | Body `{ did, name }` → `{ did, name, trusted }`. `trusted` = `true` bei `TRUST_MODE=auto`, sonst `false`. Ist die DID schon registriert: Namen aktualisieren, 200. |
| GET | `/api/issuers` | Liste `[{ did, name, trusted, createdAt }]` |
| POST | `/api/requests` | kein Body → `{ id, url, qrDataUrl }`; `url` = `{PUBLIC_URL}/wallet.html#req={id}` |
| GET | `/api/requests/:id` | `{ id, verifierName, aud, nonce, vct, required, optional, status, result }` |
| POST | `/api/requests/:id/response` | Body `{ presentation }` → Ergebnis von `verifyPresentation`. Nur einmal pro Anfrage (danach 409). |
| GET | `/api/attendees` | Liste `[{ name, organisation?, issuerName, time }]`, neueste zuerst |
| GET | `/api/config` | `{ eventTitle, publicUrl, trustMode }` für die Seiten |
| POST | `/api/admin/issuers/:did/trust` | Body `{ trusted: true \| false }` |
| POST | `/api/admin/trust-mode` | Body `{ mode: "auto" \| "manual" }` (zur Laufzeit umschaltbar) |
| POST | `/api/admin/replay` | Schickt die letzte erfolgreiche Presentation an eine neue Anfrage und gibt das (fehlgeschlagene) Prüfergebnis zurück |
| POST | `/api/admin/reset` | Leert Check-in-Liste und Anfragen; Issuer bleiben |

Eine Anfrage hat diese Felder:

```json
{
  "id": "<crypto.randomUUID()>",
  "nonce": "<b64url von 16 Zufallsbytes>",
  "aud": "isst-empfang",
  "verifierName": "<VERIFIER_NAME>",
  "vct": "urn:isst:gastausweis:1",
  "required": ["given_name", "family_name"],
  "optional": ["organisation", "role"],
  "status": "pending",
  "createdAt": 1731420000,
  "result": null
}
```

Ablauf beim Eingang einer Presentation:

1. Anfrage nicht gefunden → 404. Älter als 5 Minuten → `status: "expired"`, 410. Nicht mehr `pending` → 409.
2. `verifyPresentation(presentation, { aud: request.aud, nonce: request.nonce, isTrustedIssuer: did => issuers[did]?.trusted === true })` aufrufen.
3. Zusätzlich prüfen, dass `result.vct` gleich `request.vct` ist und alle `required`-Felder in `result.claims` stehen. Sonst `ok: false` mit verständlichem Fehler.
4. Ergebnis in `request.result` speichern, `status` auf `done` oder `error` setzen.
5. Bei Erfolg einen Eintrag in die Check-in-Liste schreiben. Schlüssel ist der kleingeschriebene Vor- plus Nachname: Gibt es ihn schon, nur die Uhrzeit aktualisieren. Die Presentation als `lastPresentation` im Speicher merken (für den Replay-Knopf).

Datenhaltung: `data/issuers.json` und `data/attendees.json`, bei jeder Änderung geschrieben, beim Start geladen. Anfragen und `lastPresentation` nur im Speicher. `npm run purge` löscht `data/`.

## Seiten: Wallet, Issuer, Kiosk, Admin

Jede Seite hat eine Hauptaktion pro Bildschirm. Unter jeder Aktion gibt es einen Aufklapper „Was passiert hier?“ (Erklärtext) und, wo es Daten gibt, „Rohdaten anzeigen“.

**Daten im `localStorage`**

```json
{
  "wallet": { "did": "did:jwk:…", "publicJwk": {}, "privateJwk": {},
              "credentials": [ { "id": "<uuid>", "sdjwt": "…", "issuerName": "…", "receivedAt": 1731420000 } ] },
  "issuer": { "did": "did:jwk:…", "name": "…", "publicJwk": {}, "privateJwk": {} },
  "pendingOffer": { "sdjwt": "…", "issuerName": "…" }
}
```

Jeder Schlüssel wird einzeln per `JSON.stringify` gespeichert.

**`/index.html` (Start)**

- Titel aus `EVENT_TITLE`, zwei große Buttons: „1. Wallet erstellen“ und „2. Eigenen Issuer anlegen“.
- Gibt es schon eine Wallet, steht unter Button 1 „Wallet öffnen“.

**`/wallet.html` (Holder)**

Die Seite reagiert auf den URL-Hash beim Laden und bei `hashchange`.

| Hash | Keine Wallet vorhanden | Wallet vorhanden |
| --- | --- | --- |
| (leer) | Onboarding: „Wallet erstellen“ → `generateKeyPair()`, speichern, DID anzeigen | Startansicht |
| `#offer` | erst Onboarding, dann weiter wie rechts | Angebot aus `pendingOffer` anzeigen: Issuer-Name, Attribute; „Annehmen“ / „Ablehnen“. Danach `pendingOffer` löschen, Hash leeren. |
| `#req=<id>` | erst Onboarding, dann Hinweis „Du brauchst zuerst einen Gastausweis“ + Link zum Issuer | Freigabe-Dialog (siehe unten) |

- **Startansicht:** Karte „Meine DID“ (gekürzt angezeigt, z. B. die ersten 24 Zeichen + „…“, Button „Kopieren“), darunter die Nachweise als Karten (Typ „Gastausweis“, Name, Issuer-Name, gültig bis). Ganz unten: „Wallet zurücksetzen“ mit Bestätigungsabfrage.
- **Nachweis-Detail:** zwei Reiter. „Ansicht“ zeigt die Attribute als Liste. „Rohdaten“ zeigt mit `describeCredential` den decodierten Header, den Payload (inklusive `_sd`-Hashes und `cnf`), jede Disclosure als `[salt, name, wert]` und den kompakten SD-JWT-String in einem umbrechenden Monospace-Feld.
- **Freigabe-Dialog:** lädt `GET /api/requests/<id>`. Zeigt „{verifierName} möchte folgende Angaben sehen“. Die `required`-Felder sind angehakt und gesperrt, die `optional`-Felder sind wählbar und abgewählt. Gewählt wird der neueste Nachweis mit passendem `vct`. „Freigeben“ ruft `createPresentation` mit `aud` und `nonce` aus der Anfrage auf und sendet per `POST /api/requests/<id>/response`. Das Ergebnis wird angezeigt: bei Erfolg „Du bist eingecheckt“ plus Prüfschritte, bei Fehler der Fehlertext. „Ablehnen“ leert den Hash, sonst passiert nichts.

**`/issuer.html` (Issuer)**

1. Ohne Wallet im `localStorage`: Hinweis „Lege zuerst deine Wallet an“ mit Link, sonst nichts.
2. Ohne Issuer: Formular „Name deines Issuers“ → `generateKeyPair()`, speichern, `POST /api/issuers`. Danach Issuer-DID und Status anzeigen („vertrauenswürdig“ oder „wartet auf Freigabe durch den Empfang“).
3. Mit Issuer: Formular „Gastausweis ausstellen“ mit Vorname\*, Nachname\*, Organisation, Rolle (Auswahl: Gast, Vortragende, Mitarbeitende). Empfänger ist fest die eigene Wallet; ihre DID wird angezeigt.
4. „Ausstellen“ ruft `issueSdJwt` mit `vct: 'urn:isst:gastausweis:1'`, `validDays: 1` und den nicht-leeren Feldern auf (`given_name`, `family_name`, `organisation`, `role`). Danach kurz den signierten Nachweis in den Rohdaten zeigen und den Button „An meine Wallet übergeben“: setzt `pendingOffer` und leitet auf `/wallet.html#offer` weiter.

**`/kiosk.html` (Verifier am Empfang, 1920×1080, kein Scrollen)**

- **Links (60 %):** Titel „Check-in mit der EUDI Wallet“, großer QR (mindestens 480 px) aus `POST /api/requests`, darunter drei kurze Schritte. In der Ecke ein kleiner QR zur Startseite mit „Noch keine Wallet?“ (aus `startQrDataUrl` von `/api/config`).
- **Rechts (40 %):** Erklär-Panel „Was der Empfang gerade geprüft hat“ mit den `steps` des letzten Check-ins, jeder Schritt mit ✓ oder ✗. Darunter die Liste „Heute eingecheckt“ mit Zähler.
- **Zustände:** `idle` (QR, Abfrage alle 1,5 s) → `success` (groß „Willkommen, {Vorname} {Nachname}“, darunter „ausgestellt von {issuerName}“ und „geteilt: {Feldliste}“, 6 s) oder `error` (Fehlertext, 6 s) → neue Anfrage, wieder `idle`. Ist die Anfrage abgelaufen, still eine neue anlegen.
- Das `/api/config` braucht dazu das Feld `startQrDataUrl` (QR auf `{PUBLIC_URL}/`).

**`/admin.html` (Moderation)**

- Token-Eingabe, gespeichert im `sessionStorage`.
- Umschalter Trust-Modus `auto` / `manual`.
- Tabelle der Issuer (Name, gekürzte DID, Schalter „vertrauenswürdig“).
- Button „Replay-Angriff vorführen“: ruft `/api/admin/replay` auf und zeigt die Prüfschritte mit dem Fehler.
- Button „Check-in-Liste leeren“ mit Bestätigung.

## Erklärtexte für die Oberfläche

Diese Texte kommen wörtlich in die Aufklapper „Was passiert hier?“. Lege sie zentral in `public/lib/texts.js` als Objekt ab, damit Niklas sie an einer Stelle anpassen kann.

| Schlüssel | Ort | Text |
| --- | --- | --- |
| `keypair` | Wallet erstellen | Dein Handy hat gerade ein Schlüsselpaar erzeugt. Der private Schlüssel bleibt in diesem Browser und verlässt ihn nie. Mit ihm beweist du später, dass ein Nachweis wirklich dir gehört. |
| `did` | Karte „Meine DID“ | Eine DID (Decentralized Identifier) ist eine Kennung, die du selbst erzeugst – ohne Anmeldung bei einer zentralen Stelle. Diese hier (did:jwk) enthält direkt deinen öffentlichen Schlüssel. Wer sie kennt, kann deine Signaturen prüfen. |
| `issuer` | Issuer anlegen | Ein Issuer stellt Nachweise aus, zum Beispiel ein Amt, eine Hochschule oder ein Arbeitgeber. Auch er hat ein Schlüsselpaar und eine DID. Damit andere seinen Nachweisen glauben, muss er auf einer Vertrauensliste stehen. In der echten EUDI-Welt pflegen das die Mitgliedstaaten. |
| `credential` | Ausstellen, Nachweis-Detail | Der Gastausweis ist ein Verifiable Credential: Der Issuer hat ihn mit seinem privaten Schlüssel signiert. Jede Veränderung würde die Signatur ungültig machen. Er ist außerdem an den Schlüssel deiner Wallet gebunden. |
| `sd` | Rohdaten, Freigabe-Dialog | Im signierten Teil stehen deine Angaben nur als Hashwerte. Die Klartexte (Disclosures) hält deine Wallet. Beim Vorzeigen gibst du nur die Disclosures heraus, die du teilen willst – der Rest bleibt verborgen. Das heißt Selective Disclosure. |
| `binding` | Freigabe-Dialog | Der Empfang schickt eine Zufallszahl (Nonce). Deine Wallet unterschreibt sie mit deinem privaten Schlüssel. So sieht der Empfang: Der Nachweis wird gerade von seinem rechtmäßigen Besitzer vorgezeigt und ist keine alte Kopie. |
| `verify` | Kiosk-Panel | Der Empfang prüft: Steht der Issuer auf der Vertrauensliste? Ist die Signatur echt? Passen die freigegebenen Angaben zu den Hashwerten? Ist der Nachweis noch gültig? Stammt er von der richtigen Wallet und wurde er frisch erzeugt? |
| `real` | Startseite, unten | Das ist eine Simulation zum Lernen. Die echte EUDI Wallet nutzt dieselben Bausteine, aber zertifizierte Apps, staatliche Vertrauenslisten und die Protokolle OpenID4VCI und OpenID4VP. |

## Betrieb: HTTPS, Tunnel, Veranstaltungstag

Die Smartphones brauchen HTTPS: WebCrypto (`crypto.subtle`) gibt es im Browser nur in sicheren Kontexten. Über `http://192.168.…` funktioniert auf den Handys nichts, nur auf `localhost`.

- **Variante 1 (Standard): Quick Tunnel.** Server lokal starten, dann `cloudflared tunnel --url http://localhost:3000`. Die ausgegebene `https://….trycloudflare.com`-Adresse als `PUBLIC_URL` setzen und den Server neu starten. Das braucht kein Konto, die Adresse wechselt aber bei jedem Start.
- **Variante 2: kleiner Server mit TLS** (z. B. ein vorhandener ISST-Server oder ein VPS mit Caddy als Reverse Proxy). Feste Adresse, unabhängig vom Laptop. Empfehlenswert, falls die Fraunhofer-IT Tunnel blockiert.
- **Gleicher Browser:** Die Kamera-App öffnet Links auf iOS in Safari, auf Android meist in Chrome. Die Wallet lebt im `localStorage` genau dieses Browsers. Teilnehmende sollen die Seite **nicht** zum Home-Bildschirm hinzufügen: Auf iOS hat eine Home-Bildschirm-App einen eigenen Speicher und fände die Wallet nicht. Die Startseite weist darauf hin.
- **Privates Surfen:** Im privaten Modus kann der Speicher beim Schließen verloren gehen. Auch dafür ein Hinweis auf der Startseite.

Das README enthält eine Checkliste für den Veranstaltungstag:

- [ ] Tunnel oder Server läuft, `PUBLIC_URL` stimmt, Startseite auf einem iPhone und einem Android-Gerät über Mobilfunk getestet.
- [ ] Kiosk im Vollbild (F11) auf dem Empfangsrechner, Admin-Ansicht auf dem Moderationslaptop.
- [ ] `TRUST_MODE` gewählt. Empfehlung: `auto` für den Ablauf, kurz `manual` für die Demo „nicht vertrauenswürdiger Issuer“.
- [ ] QR zur Startseite auf einer Folie.
- [ ] Nach der Veranstaltung `npm run purge`.

## Bauplan mit Checkpoints

Baue strikt in dieser Reihenfolge. Gehe erst weiter, wenn der Checkpoint des Schritts erfüllt ist, und committe nach jedem Schritt.

| # | Schritt | Checkpoint |
| --- | --- | --- |
| 1 | Gerüst: `package.json` mit `"type": "module"`, Express liefert `public/` aus, `/api/config` | `npm start`, `http://localhost:3000` zeigt die Startseite |
| 2 | `public/lib/sdjwt.js` aus dem Referenzcode, `test/sdjwt.test.js` mit den 8 Tests | `npm test`: alle 8 Tests grün |
| 3 | `server/store.js` und die Issuer-Endpunkte | `curl -X POST /api/issuers` legt einen Issuer an, er übersteht einen Neustart |
| 4 | `wallet.html` ohne Hash: Wallet erstellen, DID anzeigen, zurücksetzen | Im Desktop-Browser erzeugt die Seite eine DID, nach Reload ist sie noch da |
| 5 | `issuer.html` komplett und `wallet.html#offer` | Im selben Browser: Issuer anlegen, Gastausweis ausstellen, in der Wallet annehmen; Rohdaten zeigen Header, Payload und Disclosures |
| 6 | Anfrage-Endpunkte und `wallet.html#req=<id>` | Anfrage per `curl -X POST /api/requests` anlegen, `wallet.html#req=<id>` öffnen, freigeben; `GET /api/requests/<id>` zeigt `status: "done"` und alle Prüfschritte |
| 7 | `kiosk.html` | Zwei Browserfenster: Kiosk zeigt QR, URL des QR im anderen Fenster öffnen, Kiosk wechselt auf „Willkommen“ |
| 8 | `admin.html`, Trust-Modus, Replay | `manual`: Check-in schlägt mit „Vertrauensliste“ fehl, nach Freigabe klappt er; Replay zeigt den Nonce-Fehler |
| 9 | `texts.js`, Erklär-Aufklapper, `styles.css` (Akzentfarbe #179C7D) | Jede Aktion hat ihren Aufklapper; Wallet auf 375 px Breite ohne horizontales Scrollen |
| 10 | README mit Start, Tunnel, Checkliste | Ein Fremder kommt nur mit dem README zum laufenden Kiosk |
| 11 | Gerätetest über Tunnel | Akzeptanzkriterien unten auf einem echten iPhone und einem Android-Gerät |

Für lokale Tests ohne Handy reicht in Schritt 4–8 ein Desktop-Browser auf `localhost`. Zwei getrennte Personen simulierst du mit einem normalen und einem privaten Fenster.

## Akzeptanzkriterien

Fertig ist die Demo, wenn alle Punkte auf einem echten iPhone (Safari) und einem echten Android-Gerät (Chrome) über die HTTPS-Adresse erfüllt sind.

- [ ] `npm install && npm start` läuft auf einem frischen Laptop mit Node 20; `npm test` ist grün.
- [ ] Vom Scan des Start-QR bis „Willkommen“ am Kiosk dauert der ganze Ablauf für eine neue Person höchstens 3 Minuten.
- [ ] Die DID wird in der Wallet angezeigt und beginnt mit `did:jwk:`.
- [ ] In den Rohdaten des Gastausweises sind Header, Payload mit `_sd`-Hashes und `cnf` sowie die Disclosures lesbar.
- [ ] Beim Check-in sieht der Kiosk nur Vor- und Nachname, solange die optionalen Felder abgewählt bleiben. Werden sie gewählt, erscheinen sie unter „geteilt“.
- [ ] Das Kiosk-Panel zeigt alle 7 Prüfschritte mit ✓.
- [ ] Im Modus `manual` schlägt der Check-in eines neuen Issuers mit dem Hinweis auf die Vertrauensliste fehl; nach der Freigabe in `/admin` klappt er.
- [ ] „Replay-Angriff vorführen“ endet mit dem Nonce-Fehler.
- [ ] Ein QR kann nur einmal verwendet werden; der Kiosk legt danach automatisch einen neuen an.
- [ ] 10 Check-ins hintereinander ohne Neustart; dieselbe Person erscheint nur einmal in der Liste.
- [ ] Nach einem Server-Neustart sind Issuer und Check-in-Liste noch da; `npm run purge` löscht beides.
- [ ] Kein privater Schlüssel wird je an den Server geschickt (im Netzwerk-Tab der Browser-Entwicklertools prüfen).

## Out of Scope, Gesprächsstoff, offene Punkte

Nicht gebaut werden: Kompatibilität mit der echten EUDI Wallet, OpenID4VCI und OpenID4VP, Widerruf (Revocation), `did:web`, Ausstellen an fremde Wallets, Benutzerkonten und Produktionshärtung.

Diese Lücken eignen sich als Gesprächsstoff im technischen Teil:

- **Vertrauen:** Hier pflegt die Moderation die Vertrauensliste per Klick. In der EUDI-Welt sind das staatlich gepflegte Trusted Lists und Zertifikatsketten (IACA), daher läuft das Reference-Wallet nur mit registrierten Issuern.
- **Protokolle:** Unser „Angebot über `localStorage`“ und „Anfrage per QR-Link“ entsprechen grob OpenID4VCI (Credential Offer) und OpenID4VP (Authorization Request mit Nonce).
- **Schlüsselschutz:** Hier liegt der private Schlüssel im Browser-Speicher. Echte Wallets nutzen Secure Enclave bzw. Hardware-Keystore und eine Wallet-Attestierung.
- **Widerruf:** Ein verlorener Ausweis bleibt hier bis zum Ablauf gültig. Echte Systeme nutzen Status-Listen.
- **DID-Methoden:** `did:jwk` ist selbstbeschreibend. `did:web` verknüpft eine DID mit einer Domain und wäre für Organisationen wie Fraunhofer naheliegend.

Offene Punkte für Niklas:

- HTTPS-Variante festlegen: Quick Tunnel testen, ob er aus dem Fraunhofer-Netz funktioniert; sonst einen Server mit TLS organisieren.
- Ankündigungstext anpassen, falls noch möglich: „Wallet-Simulation im Browser“ statt „EUDI Wallet installieren“.
- Probelauf mit 2–3 Kolleg\*innen auf eigenen Geräten, mindestens ein iPhone dabei.

## Quellen

- [SD-JWT VC (IETF Draft)](https://datatracker.ietf.org/doc/draft-ietf-oauth-sd-jwt-vc/)
- [Selective Disclosure for JWTs (IETF)](https://datatracker.ietf.org/doc/draft-ietf-oauth-selective-disclosure-jwt/)
- [did:jwk Method Specification](https://github.com/quartzjer/did-jwk/blob/main/spec.md)
- [MDN: SubtleCrypto (nur in sicheren Kontexten)](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto)
- [Cloudflare Quick Tunnels](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/)
