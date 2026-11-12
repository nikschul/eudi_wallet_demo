# Administration / Moderation

[Einstieg](../README.md) · [Anleitung für Teilnehmende](PARTICIPANTS.md)

## Rollen und Voraussetzungen

Die **Workshop-Zentrale auf dem Notebook der Moderation** stellt die
Wallet-Webapp, den TV-/Empfangs-Kiosk und die Administration bereit. Jede Person
startet dagegen eine **eigene Docker-Ausweisstelle auf ihrem eigenen Rechner**.
Das Smartphone öffnet ausschließlich die feste zentrale Wallet-URL und erreicht
von dort die öffentliche Issuer-API für die Ausstellung.

Alle Anleitungen verwenden **Bash unter Linux oder WSL2** im Projektordner.
Benötigt werden Compose v2 mit `--wait`-Unterstützung, Internet und cloudflared
auf jedem beteiligten Rechner. Falls `--wait` unbekannt ist, Compose
aktualisieren. Auf dem Host ist kein Node.js nötig.

### Docker unter Linux oder WSL

- **Linux:** Docker Engine mit laufendem Daemon und Compose-Plugin verwenden.
- **Windows mit WSL2:** Docker Desktop starten und die **WSL-Integration für
  genau die verwendete Linux-Distribution** aktivieren. Docker-Befehle und
  cloudflared anschließend in dieser WSL-Bash ausführen, nicht zwischen
  Windows-PowerShell und verschiedenen Distributionen wechseln.

```bash
docker info
docker compose version
```

Bei fehlendem Docker-Socket unter WSL zuerst den laufenden Docker Desktop und
dessen WSL-Integration prüfen. Unter Linux Daemon und Socket-Zugriffsrechte vom
Host-Administrator prüfen lassen; den Socket nicht allgemein beschreibbar
machen. Den lokalen Docker-Kontext verwenden: Bei einem entfernten Daemon
liegen veröffentlichte Ports nicht automatisch auf dem eigenen `localhost`.

### cloudflared installieren

Die offiziellen Linux-Installationen stehen in den
[Cloudflare-Downloads](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/downloads/):
entweder das [offizielle Paket-Repository](https://pkg.cloudflare.com/) für die
Distribution nutzen oder das passende Binary aus den
[offiziellen GitHub-Releases](https://github.com/cloudflare/cloudflared/releases)
laden. Ohne systemweite Installation geht es in das eigene lokale
Binärverzeichnis; zuerst die **Linux-/WSL-Architektur** prüfen:

```bash
uname -m
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) printf 'Nicht unterstützte Architektur; passenden offiziellen Download wählen.\n' >&2; exit 1 ;;
esac
mkdir -p "$HOME/.local/bin"
curl --fail --location --show-error \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}" \
  --output "$HOME/.local/bin/cloudflared" &&
  chmod +x "$HOME/.local/bin/cloudflared" &&
  "$HOME/.local/bin/cloudflared" --version
```

Nur nach erfolgreichem Download und Versionsaufruf fortfahren. Es wird kein
heruntergeladenes Shellskript mit `sudo` ausgeführt. Die Tunnelbefehle unten
ergänzen `PATH` im jeweiligen Terminal; keine Shell-Profiländerung ist nötig.
cloudflared muss als **Linux-Prozess in derselben Linux-/WSL-Umgebung** laufen,
in der der per Docker veröffentlichte Host-Port über `localhost` erreichbar
ist. Vor dem Tunnelstart muss der jeweilige lokale `curl`-Healthcheck dort
funktionieren.

Notebook wach halten und Ruhezustand während der gesamten Runde vermeiden;
unter WSL auch Windows und die WSL-Sitzung laufen lassen.
Die Tunnel machen die App **öffentlich im Internet erreichbar**. Nur erfundene
Demo-Namen und keine echten Mitarbeiterdaten verwenden.

## Zentrale starten

### 1. Konfiguration und eigenes Token

```bash
cp .env.example .env.workshop
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml build app
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml run --rm --no-deps app node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
```

Den ausgegebenen Wert als `ADMIN_TOKEN` in `.env.workshop` eintragen. Das Token
ist nur für die Moderation; **niemals in einer Issuer-Konfiguration verwenden**
oder an Teilnehmende weitergeben. Die lokale Datei nicht veröffentlichen.
Anfangs bleibt `PUBLIC_URL=http://localhost:3000`. Optional `VERIFIER_NAME` und
`EVENT_TITLE` setzen.

```bash
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml config --quiet
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml up --build --wait
curl --fail http://localhost:3000/api/health
```

`--wait` wartet auf den Dockerfile-Healthcheck und startet im Hintergrund.
Der Server hört im Container immer auf Port 3000; `PORT` in der Env-Datei
bestimmt nur den Host-Port. Die Bindung ist absichtlich ausschließlich
`127.0.0.1`. Bei geändertem Host-Port auch die lokalen URLs und den Tunnelbefehl
anpassen. Ein `localhost`-Aufruf auf dem Notebook ersetzt keinen Smartphone-Test.

### 2. Öffentlichen Tunnel offen halten

In einem **zweiten Bash-Terminal derselben Linux-/WSL-Umgebung**:

```bash
export PATH="$HOME/.local/bin:$PATH"
cloudflared tunnel --url http://localhost:3000
```

Die ausgegebene HTTPS-Adresse, zum Beispiel
`https://workshop-beispiel.trycloudflare.com`, in `.env.workshop` als `PUBLIC_URL`
eintragen. Die Beispiele sind Platzhalter; ausschließlich die eigene tatsächlich
ausgegebene Adresse verwenden, ohne Unterpfad. Danach im ersten Terminal:

```bash
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml up --wait app
```

Compose erstellt die App mit der neuen Umgebung neu. **Denselben Tunnel dabei
weiterlaufen lassen.** Kein cloudflared-Container oder weiterer HTTPS-Dienst
ist nötig. Die öffentliche Adresse anschließend im Browser und mit
`curl --fail https://DEINE-ZENTRALE.trycloudflare.com/api/health` prüfen.
Unter `/api/config` muss `publicUrl` genau diese öffentliche Adresse enthalten.

Diese zentrale HTTPS-Adresse als `WORKSHOP_URL` an alle Personen verteilen und
für die gesamte Veranstaltung stabil halten. Sie ist zugleich der feste
Smartphone-Wallet-Origin. Ein neuer Tunnel bekommt normalerweise eine andere
Adresse: Anderer Origin bedeutet anderen Browser-Speicher, keine automatische
Übernahme der Wallet. Alle Issuer müssten außerdem ihre `WORKSHOP_URL` anpassen.

### 3. Bedienoberflächen

- <http://localhost:3000/admin.html>: Admin-Token der **Zentrale** eingeben.
  Es bleibt im `sessionStorage` dieses Browser-Tabs, nicht in der Wallet.
- <http://localhost:3000/kiosk.html>: auf dem TV/Beamer öffnen, möglichst
  1920 × 1080 im Vollbild. Die QR-Codes müssen die öffentliche zentrale URL nutzen.
- Smartphone: zentrale öffentliche HTTPS-Adresse, nicht `localhost` und
  nicht die Adresse eines persönlichen Issuers.

## Registrierung und manuelle Vertrauensentscheidung

Neue Issuer sind standardmäßig **nicht freigegeben**. Es gibt keine automatische
oder Batch-Freigabe.

1. Jede Person legt im eigenen Issuer-Dashboard eine Ausweisstelle mit Namen
   und ihrem Demo-Mitarbeitendennamen (`employeeName`) an und registriert sie
   bei der Zentrale.
2. Der Issuer beweist den Besitz seines Schlüssels durch eine signierte
   Nonce-Challenge. Das ist **kein Nachweis der menschlichen Identität**.
3. Die Person zeigt ihren Fingerprint im Dashboard. Persönlich mit dem Eintrag
   in der Workshop-Administration vergleichen.
4. Die Moderation ordnet den Issuer mit `ownerName` der überprüften Person zu
   und gibt ihn bewusst frei. Freigegeben wird die registrierte **DID plus
   menschliche Zuordnung**, nicht die Tunnel-Domain.

Die persönliche Issuer-URL kann sich ändern, ohne die DID zu ändern, solange das
Issuer-Volume erhalten bleibt. Nach URL-Wechsel muss die Person die neue URL in
`PUBLIC_URL` setzen, die App neu erstellen und den Issuer erneut registrieren.
Fingerprint und Zuordnung dabei erneut kontrollieren. Die Wallet muss die neue
Issuer-URL erreichen können.

### Moderationsgeschichte: Signatur ist nicht gleich Vertrauen

1. Einen neuen Issuer zunächst ausstehend lassen. Die Person darf trotzdem den
   Mitarbeiterausweis ausstellen: Das ist absichtlich Teil der Geschichte.
2. Im Smartphone wird der zentrale Vertrauensstatus als Warnung sichtbar.
   Ein Check-in mit dem nicht freigegebenen Issuer scheitert.
3. Fingerprint vergleichen und die Person in der Zentrale freigeben.
4. **Denselben bereits ausgestellten Mitarbeiterausweis** behalten, einen
   **neuen Check-in-QR** scannen und erneut zustimmen: jetzt erfolgreich.
5. In der Administration die Replay-Demo ausführen: Eine alte Presentation
   scheitert an der neuen Nonce.

Die Wallet erklärt vor der Zustimmung die Veröffentlichung. Der Kiosk zeigt
für jeden Check-in die tatsächlich freigegebenen Claims, den Credential-Typ,
Issuer-DID und -Namen, die freigegebene zugeordnete Person sowie Zeitstempel.
Versteckte Disclosures und vollständige JWTs gehören nicht auf den TV.
Auch die Check-in-Anzeige ist deshalb ausschließlich für Demo-Daten gedacht.

## Zwei Instanzen auf demselben Notebook

Zur Vorbereitung ist das möglich; die Abnahme soll trotzdem zwei unabhängige
Rechner umfassen. Die Dateien sind **zwei eigenständige Compose-Projekte**:

| Rolle | Env-Datei | Compose-Datei | Projekt | Host-Port | Volume im Projekt |
| --- | --- | --- | --- | --- | --- |
| Zentrale | `.env.workshop` | `compose.yaml` | `eudi-workshop` | 3000 | `workshop-data` |
| Eigener Issuer | `.env.issuer` | `compose.issuer.yaml` | `eudi-issuer` | 3001 | `issuer-data` |

Immer `-p`, `--env-file` und genau eine `-f`-Datei angeben. **Nicht** beide
Compose-Dateien mit mehreren `-f` zusammenführen. Beide bauen dasselbe Image
`eudi-wallet-demo:local`; Ports, Umgebungen und projektbezogene Volumes bleiben
getrennt. Für jede Instanz läuft ein eigener cloudflared-Prozess.
Die beiden Admin-Tokens müssen unterschiedlich sein.

## Sichern, wiederherstellen und aktualisieren

Vor Update oder Migration beide Instanzen gezielt stoppen. Sicherungen in neue
Verzeichnisse legen, nicht versehentlich ältere Sicherungen überschreiben:

```bash
mkdir -p backups/workshop
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml stop app
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml cp app:/app/data/. ./backups/workshop/
```

Der Workshop persistiert `issuers.json` und `attendees.json`. Eine Datei kann vor
der ersten Änderung noch fehlen. Für den Issuer separat:

```bash
mkdir -p backups/issuer
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml stop app
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml cp app:/app/data/. ./backups/issuer/
```

**`identity.json` enthält private Issuer-Schlüssel**. Sicherungen zugriffsgeschützt
aufbewahren, nicht veröffentlichen und nicht an andere Teilnehmende verteilen.
Env-Dateien mit Tokens ebenfalls separat schützen. Smartphone-Schlüssel sind
in keinem Server-Backup enthalten.

Zur Wiederherstellung zunächst stoppen; auf einem neuen Host zuerst mit dem
gleichen Projekt-/Env-/Datei-Präfix `create app` ausführen. Nur vorhandene,
vertrauenswürdige und zur Rolle passende Dateien kopieren. Beispiel Workshop:

```bash
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml cp ./backups/workshop/issuers.json app:/app/data/issuers.json
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml cp ./backups/workshop/attendees.json app:/app/data/attendees.json
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml run --rm --no-deps --user root --cap-add CHOWN app chown node:node /app/data/issuers.json /app/data/attendees.json
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml up --wait app
```

Bei fehlender Datei deren Kopierbefehl und deren Pfad bei `chown` weglassen.
Für die Issuer-Identität analog, bei gestopptem Issuer:

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml cp ./backups/issuer/identity.json app:/app/data/identity.json
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml run --rm --no-deps --user root --cap-add CHOWN app chown node:node /app/data/identity.json
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml up --wait app
```

Nur für die Wiederherstellung wird der Hilfsprozess als root mit der einzelnen
Capability `CHOWN` zum Setzen des Dateieigentümers genutzt; die App selbst läuft
als `node` ohne zusätzliche Capabilities. Nie zwei laufende
Instanzen mit derselben Identität oder demselben Datenvolume betreiben.

Nach einem Update der Projektdateien mit dem jeweiligen vollständigen Präfix
`up --build --wait` ausführen. Neubau und Container-Neustart erhalten das Volume.
Bei einem fehlgeschlagenen Build lässt sich der bisherige Container mit
`start app` wieder starten. Rollback: passende vorherige Projektversion und
kompatible Sicherung wiederherstellen, dann erneut bauen.

Angebote (zehn Minuten), Kopplungszustände, Check-in-Anfragen (fünf Minuten) und
Nonces liegen nur im Prozessspeicher. Nach Neustart neue Angebots-/Check-in-QRs
erzeugen; persistente Listen und Issuer-Identität bleiben erhalten.

## Beenden und bewusst löschen

Normales Beenden erhält Daten:

```bash
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml down
```

Den zugehörigen Tunnel mit **Strg+C** beenden. Issuer separat mit seinem Präfix
und seinem Tunnel stoppen. `down -v` ist **kein** Update-/Normal-Stopp-Befehl:
Es löscht die jeweiligen Volumes.

Nur wenn Daten wirklich gelöscht werden sollen, vorher sichern und Server
stoppen. **Nicht automatisch bei Start, Update oder Migration ausführen.**

```bash
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml stop app
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml run --rm --no-deps app npm run purge
```

Workshop-Purge entfernt gezielt die Listen und ihre temporären JSON-Dateien;
das Volume bleibt bestehen. Für die eigene Ausweisstelle:

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml stop app
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml run --rm --no-deps app npm run purge
```

**Destruktiv: Issuer-Purge löscht auch `identity.json`, also private Schlüssel
und Issuer-DID.** Der Rollen-Guard erlaubt dies nur mit `APP_ROLE=issuer`.
Danach ist eine neu angelegte Identität neu zu registrieren und erneut von der
Moderation freizugeben; alte Credentials werden dadurch nicht neu signiert.
Keine Wiederverwendung des Workshop-Tokens. Ein Issuer-Reset ist kein Wallet-Reset.

Bei direktem Node-Betrieb den Server erst stoppen und gezielt die richtige
Rollen-/Datenkonfiguration laden:
`node --env-file=.env.workshop server/purge.js` beziehungsweise
`APP_ROLE=issuer node --env-file=.env.issuer server/purge.js` (Bash).
Für jede Rolle einen eigenen `DATA_DIR` konfigurieren; bei Workshop explizit
`APP_ROLE=workshop` setzen, falls die Shell einen anderen Rollenwert enthält.
Browser-Wallets löschen die Personen bewusst über „Wallet zurücksetzen“ oder
die Website-Daten ihres Smartphone-Browsers.

## Abnahme vor dem Workshop

Noch offene Prüfungen, **keine Behauptung bereits bestandener Gerätetests**:

- [ ] Zentrale auf Moderationsrechner und Issuer auf einem zweiten unabhängigen
  Rechner; eigene Projekte, Volumes und unterschiedliche Tokens nachweisen.
  Linux-/WSL-Bash, Docker-Socket-Zugriff und cloudflared in derselben Umgebung
  prüfen; den lokalen Host-Port dort mit `curl` erreichen.
- [ ] Beide öffentlichen HTTPS-Adressen erreichbar, `PUBLIC_URL` jeweils korrekt;
  Issuer-`WORKSHOP_URL` exakt der zentrale Browser-Origin. Keine Smartphone-Links
  mit `localhost` oder privater HTTP-LAN-Adresse.
- [ ] Desktop lokal und über Tunnel prüfen: WebCrypto/Schlüsselbesitz, signierte
  Registrierung, Wallet-Public-Key-Proof und exakter CORS-Origin; keine privaten
  Wallet-Schlüssel in Requests.
- [ ] Auf echtem iPhone mit Safari und Android mit Chrome jeweils denselben
  normalen Browser für alle Kamera-Links nutzen; keine PWA-Installation empfehlen.
  iOS-Speicher und Reload prüfen.
- [ ] Kopplungscodes auf beiden Geräten vergleichen, erst danach explizit am
  geschützten Desktop signieren; Annahme, Speicherung und neuer Check-in.
- [ ] Vor Freigabe ablehnen, nach Fingerprint-/Personenfreigabe denselben
  Mitarbeiterausweis mit neuem QR akzeptieren; Replay-Demo ablehnen.
- [ ] Wallet erklärt TV-Veröffentlichung vor Zustimmung. Kiosk zeigt nur die
  tatsächlichen Disclosures, Typ, Issuer, freigegebene Person und Zeitstempel,
  keine verborgenen Angaben oder vollständigen JWTs.
- [ ] Angebotsablauf nach zehn Minuten, Check-in-Ablauf nach fünf Minuten und
  Neustartverlust offener Vorgänge prüfen; Listen und Issuer-DID bleiben erhalten.
- [ ] Tunnel während der gesamten Runde laufen lassen; fremdes WLAN/Mobilfunk
  und Cross-Site-Zugriffe prüfen. Firewall-/Netzfilter können Tunnel blockieren.
- [ ] Sicherung/Wiederherstellung und absichtlichen Rollen-Purge nur mit
  entbehrlichen Demo-Daten erproben; vor Migration alte Volumes sichern.

Fehlerdiagnose mit dem jeweiligen vollständigen Compose-Präfix und `logs app`
oder `ps`. Bei CORS-Fehlern tatsächlichen Smartphone-Origin und `WORKSHOP_URL`
vergleichen, nicht Wildcard-CORS einschalten. Ein öffentlicher Tunnel ersetzt
keine Produktionsauthentifizierung. Diese Demo prüft vereinfachtes Vertrauen in
eine DID und Person, keine offizielle EU-Vertrauensliste oder PKI.
