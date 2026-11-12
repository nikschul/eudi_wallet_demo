# EUDI Wallet Demo

Eine deutschsprachige, mobiloptimierte EUDI-Lernsimulation: Jede Person erstellt
auf dem Smartphone eine Wallet und einen Issuer, stellt sich einen signierten
Gastausweis aus und checkt per QR-Code am Empfang ein.

**Keine echte EUDI Wallet und kein Produktions-Identitätssystem.** Echte
ECDSA-P-256-Signaturen, `did:jwk`, SD-JWT Selective Disclosure und Holder Binding;
vereinfachte Vertrauensliste und Protokolle. Nur Demo-Daten verwenden.

## Schnellstart mit Node

Empfohlen: **Node.js 24 LTS** mit npm. Mindestversion: Node.js **20.6**;
für neue Deployments eine noch unterstützte LTS-Version verwenden. Wer nur
Docker Compose verwendet, braucht auf dem Host weder Node.js noch npm.

```sh
npm ci
npm run check
npm test
npm start
```

Dann <http://localhost:3000> öffnen. Ohne Konfiguration wird ein zufälliges
Admin-Token in der Konsole ausgegeben. Ein Build-Schritt entfällt.

| Seite | Aufgabe |
| --- | --- |
| `/` | Einstieg, Hinweise zur PWA und zum Browser-Speicher |
| `/wallet.html` | Wallet, Nachweise, Rohdaten und Freigabe |
| `/issuer.html` | Eigene Ausweisstelle und Gastausweis |
| `/kiosk.html` | Empfangsbildschirm mit großem Check-in-QR und kleinem Start-QR |
| `/admin.html` | Vertrauensliste, Replay-Demo und Check-in-Liste zurücksetzen |

Die Kurzpfade `/wallet`, `/issuer`, `/kiosk`, `/admin` leiten entsprechend weiter.

### Konfiguration

```sh
cp .env.example .env
# .env anpassen, danach:
npm run start:env
```

`npm start` liest Umgebungsvariablen des Prozesses, aber nicht automatisch `.env`.
`npm run start:env` lädt `.env` ausdrücklich und meldet eine fehlende Datei als Fehler.
Unter PowerShell statt `cp` bei Bedarf `Copy-Item .env.example .env` verwenden.
Docker Compose liest `.env` automatisch. Die Datei enthält gegebenenfalls das
Admin-Token und darf nicht veröffentlicht werden.

| Variable | Standard | Bedeutung |
| --- | --- | --- |
| `PORT` | `3000` | Lokal: Server-Port; Compose: lokaler Host-Port, Container bleibt auf 3000 |
| `PUBLIC_URL` | `http://localhost:<PORT>` | Öffentliche Basis-Adresse **ohne Unterpfad**; für Smartphones HTTPS. Ein expliziter Wert in `.env` muss zum gewählten Port passen |
| `TRUST_MODE` | `auto` | Neue Issuer sofort akzeptieren oder mit `manual` erst freigeben |
| `ADMIN_TOKEN` | zufällig je Start | Admin-API; für Deployment festes, langes Zufallstoken aus druckbaren ASCII-Zeichen ohne Leerzeichen setzen |
| `VERIFIER_NAME` | `Fraunhofer ISST – Empfang` | Angezeigter Empfänger |
| `EVENT_TITLE` | `EUDI Wallet Workshop` | Titel auf Startseite und Kiosk |
| `DOMAIN` | – | Nur Caddy: öffentliche Domain ohne Schema oder Pfad |
| `DATA_DIR` | `data` im Projekt | Optional für Node-Betrieb; Compose nutzt fest `/app/data` |

Änderungen an der Umgebung erfordern einen Neustart. Ein über Admin geänderter
Vertrauensmodus gilt bis zum Neustart; bereits freigegebene Issuer bleiben freigegeben.

## Docker-Deployment

Voraussetzungen: Docker Engine/Desktop mit Compose v2 oder neuer, laufender
Daemon und Zugriffsrechte auf diesen Daemon. Zuerst prüfen:

```sh
docker info
docker compose version
```

Bei `permission denied` am Docker-Socket muss der Host-Administrator den
Docker-Zugriff einrichten oder eine Rootless-Docker-Installation bereitstellen.
Den Socket nicht allgemein beschreibbar machen. Mitgliedschaft in der
Docker-Gruppe gewährt praktisch Root-Rechte.

### Lokal oder hinter vorhandenem Reverse Proxy

```sh
cp .env.example .env
# PUBLIC_URL und optional ADMIN_TOKEN in .env setzen.
docker compose config --quiet
docker compose up -d --build --wait
docker compose logs app
curl --fail http://localhost:3000/api/health
```

App: <http://localhost:3000>, Kiosk: <http://localhost:3000/kiosk.html>.
Der Container läuft ohne Root-Rechte, mit Healthcheck und schreibgeschütztem
Root-Dateisystem. Der Docker-Build führt Syntaxprüfung und Tests aus.
`--wait` wartet auf den App-Healthcheck. Bei einem anderen `PORT` die lokale
Prüf-URL und den expliziten `PUBLIC_URL` aus der Beispieldatei anpassen.

Der App-Port ist absichtlich nur auf `127.0.0.1` gebunden. Ein vorhandener
HTTPS-Reverse-Proxy auf demselben Host kann an `http://127.0.0.1:3000`
weiterleiten. Ein Proxy in einem anderen Container muss dasselbe Docker-Netz
nutzen und `app:3000` erreichen. `PUBLIC_URL` muss die externe HTTPS-Adresse sein.

### Öffentlicher Server mit automatischem HTTPS

1. Domain per DNS (A, gegebenenfalls AAAA) auf den Server richten.
2. Eingehende Ports **80/tcp und 443/tcp** freigeben; optional 443/udp für HTTP/3.
3. In `.env` beispielsweise setzen:

```dotenv
DOMAIN=wallet.example.org
PUBLIC_URL=https://wallet.example.org
TRUST_MODE=auto
ADMIN_TOKEN=<eigenes-langes-zufaelliges-token>
```

Token bei Bedarf erzeugen:

```sh
node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
```

Ohne lokales Node.js geht dies nach dem Image-Build auch mit
`docker compose run --rm --no-deps app node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"`.
Den ausgegebenen Wert nur in der lokalen `.env` hinterlegen, nie im Quellcode.

4. Starten:

```sh
docker compose --profile https config --quiet
docker compose --profile https up -d --build --wait
docker compose --profile https ps
docker compose logs caddy app
curl --fail https://wallet.example.org/api/health
```

Caddy kümmert sich um Zertifikate und HTTPS-Weiterleitung. Der Server muss für
die Zertifikatsausstellung aus dem Internet erreichbar sein. Anschließend
`https://wallet.example.org/kiosk.html` auf dem Empfangsbildschirm öffnen.
Die öffentliche Health-Prüfung muss `{"ok":true}` zurückgeben. Außerdem unter
`https://wallet.example.org/api/config` prüfen, dass `publicUrl` exakt die
öffentliche HTTPS-Adresse ist. `--wait` ersetzt diese TLS- und DNS-Prüfung nicht.
`DOMAIN` und `PUBLIC_URL` müssen denselben Hostnamen verwenden.

### Aktualisieren, Sichern und Wiederherstellen

Vor einem Update die JSON-Dateien sichern. Die folgenden Befehle gelten für
den App-Dienst mit oder ohne HTTPS-Profil:

```sh
docker compose stop app
mkdir -p backups
docker compose cp app:/app/data/. ./backups/
docker compose --profile https up -d --build --wait
```

Die Sicherung enthält Demo-Namen und die Vertrauensliste: nicht veröffentlichen
und nach der Veranstaltung gezielt löschen. Durch das Stoppen entsteht ein
konsistenter Stand. Bei einem fehlgeschlagenen Build kann der bisherige
Container mit `docker compose start app` wieder gestartet werden.

Zur Wiederherstellung den App-Dienst stoppen, die beiden gesicherten Dateien in
das Volume kopieren und die Eigentümerschaft für den nicht privilegierten
Container-Benutzer setzen:

```sh
docker compose stop app
docker compose cp ./backups/issuers.json app:/app/data/issuers.json
docker compose cp ./backups/attendees.json app:/app/data/attendees.json
docker compose run --rm --no-deps --user root app chown node:node /app/data/issuers.json /app/data/attendees.json
docker compose start app
```

Nur Dateien wiederherstellen, die tatsächlich in der Sicherung vorhanden sind.
Eine Datei existiert erst nach der ersten Änderung ihrer Liste. Beschädigte
oder doppelte Einträge werden beim Start mit einer Fehlermeldung abgelehnt,
nicht stillschweigend ersetzt. Sicherungen stammen aus vertrauenswürdiger Quelle.
Für den allerersten Start eines neuen Hosts zuerst mit `docker compose create app`
einen Container samt Volume anlegen, dann die Wiederherstellung durchführen.
Die Browser-Schlüssel gehören nicht zum Server-Backup.

Für einen Rollback die vorherige Projektversion wiederherstellen und erneut
mit `--build --wait` starten; ein Neubau allein löscht das Datenvolume nicht.
Keine zweite App-Instanz gegen dasselbe Volume starten. `docker compose down -v`
würde auch die Daten- und Zertifikatsvolumes löschen und ist kein Update-Befehl.

### Alternativ: temporärer HTTPS-Tunnel

Nach lokalem Node- oder Docker-Start:

```sh
cloudflared tunnel --url http://localhost:3000
```

Die ausgegebene `https://….trycloudflare.com`-Adresse als `PUBLIC_URL` setzen,
danach Node neu starten bzw. `docker compose up -d app` ausführen.
Die Tunnel-Adresse ändert sich normalerweise nach einem Tunnel-Neustart.
Eine andere Adresse ist ein anderer Browser-Speicher: Wallets müssen dort neu
angelegt werden. Eine feste Domain ist für Veranstaltungen zuverlässiger.

**Wichtig:** `http://192.168.…` ist auf Smartphones kein sicherer Kontext.
WebCrypto und PWA-Service-Worker benötigen HTTPS; nur `localhost` ist eine lokale
Ausnahme. Im Kiosk ist immer die öffentliche Adresse in den QR-Codes enthalten.

### Daten, Neustart und Löschen

`data/issuers.json` und `data/attendees.json` werden atomar gespeichert.
Docker verwendet dafür das benannte Volume `demo-data`. Ein Container-Neustart
oder Neubau erhält diese Daten. Offene Anfragen, Nonces und die letzte Presentation
leben nur im Speicher; nach Neustart zeigt der Kiosk automatisch einen neuen QR.

Nach der Veranstaltung, Server vorher stoppen:

```sh
# Node:
# Laufenden Server mit Strg+C stoppen.
npm run purge
# Falls DATA_DIR in .env steht, stattdessen:
npm run purge:env

# Docker, einschließlich eines eventuell aktiven Caddy:
docker compose --profile https down
docker compose run --rm --no-deps app npm run purge
```

Der Purge löscht gezielt beide Datendateien und eventuelle temporäre Versionen.
Das Datenverzeichnis/Volume bleibt bestehen. Zertifikate werden nicht gelöscht.
Für die nächste Runde wieder `docker compose --profile https up -d` ausführen.
Browser-Schlüssel löscht jede Person über „Wallet zurücksetzen“; der lokale
Issuer bleibt dabei bestehen. Zum vollständigen Löschen auch die Website-Daten
im Browser entfernen.

## Ablauf auf dem Smartphone (etwa drei Minuten)

1. Kleinen Start-QR vom Kiosk scannen, „Wallet erstellen“ antippen.
2. „Eigenen Issuer anlegen“, einen Namen vergeben und Issuer anlegen.
3. Gastausweis ausfüllen, ausstellen, an die Wallet übergeben, annehmen.
4. Großen Check-in-QR scannen. Vor-/Nachname sind erforderlich; Organisation
   und Rolle sind zunächst abgewählt.
5. „Freigeben & einchecken“: Wallet und Kiosk zeigen das Ergebnis. Der Kiosk
   zeigt sieben Prüfschritte, begrüßt sechs Sekunden lang und erstellt einen neuen QR.

Wer zuerst den Check-in-QR scannt, wird durch Wallet und Ausstellung geführt;
die Anfrage wird auch über die Wallet-/Issuer-Navigation und Kurzpfade mitgenommen.
Nach fünf Minuten muss ein
neuer QR gescannt werden. Jeder QR ist auch nach einem fehlgeschlagenen Versuch
verbraucht. Alle Personen scannen nacheinander den jeweils aktuellen QR.

### PWA und iPhone-Besonderheit

Die App hat Manifest, lokale Icons und einen Service Worker. Auf Android kann
sie über den Browser bzw. den angebotenen Installationsbutton installiert werden;
auf iOS über **Teilen → Zum Home-Bildschirm**.

**Für den Workshop ist keine Installation nötig.** Kamera-Links im selben
Browser öffnen. Auf iOS können installierte Web-Apps einen eigenen Speicher
haben; Kamera-Links öffnen oft Safari statt der installierten PWA. Ein
Browserwechsel oder die Installation überträgt Wallet-Schlüssel nicht.

Für eine bereits installierte PWA kann der aktuelle QR-Link über
**„Check-in-Link öffnen“** in der Wallet eingefügt werden. Es werden nur Links
derselben Domain akzeptiert. Alternativ den gesamten Ablauf im normalen
Safari-/Chrome-Browser durchführen (empfohlen).

Offline werden ausschließlich die statischen App-Dateien bereitgestellt.
Bereits gespeicherte Nachweise sind lesbar; Ausstellung, Vertrauensfreigabe und
Check-in brauchen den Server. **Keine API-Antworten, Tokens oder persönlichen
Daten liegen im Service-Worker-Cache.** Private Schlüssel sind nur im
`localStorage` dieses Browsers gespeichert und werden nie an die API gesendet.

## Moderation

`/admin.html` öffnen und das Admin-Token eingeben; es bleibt im `sessionStorage`.
Für den normalen Ablauf `auto` nutzen. Für eine Vertrauenslisten-Demo:

1. Auf `manual` umstellen und einen **neuen** Issuer anlegen.
2. Check-in versuchen: „Issuer steht nicht auf der Vertrauensliste“.
3. Issuer in der Admin-Tabelle freigeben.
4. Neuen Check-in-QR scannen: jetzt erfolgreich.
5. „Replay-Angriff vorführen“: die alte Presentation scheitert an der neuen Nonce.

Die Checkbox einer bestehenden Ausweisstelle ändert deren Freigabe unmittelbar.
„Check-in-Liste leeren“ verwirft auch laufende Anfragen, nicht die Issuer.
Personen werden anhand des normalisierten Vor- und Nachnamens dedupliziert;
bei erneutem Check-in wird nur die Uhrzeit aktualisiert. Namensgleiche Personen
werden in dieser vereinfachten Demo zusammengeführt.

## Tests und Aufbau

```sh
npm run check
npm test
```

Node-eigener Test-Runner, keine zusätzlichen Testpakete. Tests prüfen die acht
Kryptografie-Fälle sowie API, Persistenz, zehn Check-ins, optionale Angaben,
manuelle Freigabe, Replay, konkurrierende Antworten, Ablauf und Fehlerfälle.
Zusätzliche Regressionstests decken ungültige JWT-Formate und Zeitangaben,
doppelte Disclosures und Datensätze, Navigation, Browser-Timeouts und
veraltete Wallet-Zustände ab. Ein echter Kindprozess prüft `.env`, einen
abweichenden Port, einen anderen Arbeitsordner, sauberes Beenden und Neustart.

- `public/lib/sdjwt.js`: gemeinsames Kryptografie-Modul für Browser und Server,
  mit zusätzlichen Format- und Gültigkeitsprüfungen gegenüber der Vorlage.
- `public/lib/texts.js`: zentrale Erklärtexte.
- `server/app.js`: Express-API, QR-Codes und statische Dateien.
- `server/store.js`: JSON-Persistenz.
- `public/sw.js`: ausschließlich statische Offline-App-Hülle.
- `scripts/check.js`: plattformunabhängige Syntaxprüfung aller JavaScript-Dateien.
- [NOTES.md](./NOTES.md): Annahmen, Abweichungen und Verifikationsgrenzen.

Nur `express` v4 und `qrcode` sind direkte npm-Abhängigkeiten; keine
CDNs, Frameworks, Krypto-Bibliotheken oder Frontend-Build-Schritte.

## Checkliste für den Veranstaltungstag

- [ ] Feste HTTPS-Adresse/Tunnel erreichbar; `PUBLIC_URL` stimmt.
- [ ] Auf echtem iPhone (Safari) und Android (Chrome) über Mobilfunk getestet.
- [ ] Von Start-QR bis „Willkommen“ mit einer neuen Person höchstens drei Minuten.
- [ ] Kiosk bei 1920 × 1080 im Vollbild (F11), Moderation separat geöffnet.
- [ ] `TRUST_MODE=auto` für den Ablauf; `manual` und Replay einmal geprobt.
- [ ] Start-QR auf einer Folie; normale Kamera-App und derselbe Browser erklärt.
- [ ] Umlaute, optionale Angaben und sieben Prüfschritte kontrolliert.
- [ ] Zehn Check-ins hintereinander; dieselbe Person nur einmal in der Liste.
- [ ] Neustart getestet; Issuer und Check-in-Liste bleiben erhalten.
- [ ] Im Netzwerk-Tab kontrolliert: kein privater Schlüssel geht an die API.
- [ ] Nach der Veranstaltung Server stoppen, Purge durchführen, Browser-Daten löschen.

## Grenzen

Die Demo nutzt keine echten OpenID4VCI-/OpenID4VP-Protokolle, staatlichen
Vertrauensketten, Hardware-Keystores oder Widerrufslisten. Admin-Token ist kein
Benutzerkonto. Die öffentlichen Demo-Endpunkte und Check-in-Namen sind für ein
betreutes Workshop-Umfeld gedacht, nicht für ungeschützten Produktionsbetrieb.
Nur **eine App-Instanz** betreiben: Anfragen und Replay-Status sind absichtlich
im Prozessspeicher, JSON-Dateien ersetzen keine Mehrbenutzer-Datenbank.
