# Teilnehmende / Mitarbeitende

[Einstieg](../README.md) · [Administration / Moderation](ADMIN.md)

## Was läuft wo?

- **Moderations-Notebook:** zentrale Wallet-Webapp, Empfangs-Kiosk und Admin.
- **Dein Rechner:** deine persönliche Docker-Ausweisstelle mit eigenem Schlüssel.
- **Dein Smartphone:** deine Wallet im normalen Safari-/Chrome-Browser unter der
  **zentralen öffentlichen HTTPS-Adresse**, nicht unter deiner Issuer-Adresse.

Du brauchst Docker mit Compose v2 und `--wait`-Unterstützung, cloudflared, Internet
und die **zentrale HTTPS-Adresse der Moderation**. Auf dem Rechner ist kein
Node.js nötig. Nutze ausschließlich erfundene Demo-Mitarbeiterdaten.
Es gibt keine Benutzerkonten; dein Issuer-Token schützt deine Desktop-Aktionen.

Alle Befehle verwenden **Bash unter Linux oder WSL2** im Projektordner.
Unter Linux Docker Engine mit Compose-Plugin verwenden; unter Windows Docker
Desktop mit aktivierter **WSL-Integration für deine Linux-Distribution**.
Docker CLI und cloudflared im selben Linux-/WSL ausführen. Bei fehlendem
Docker-Socket zuerst Daemon beziehungsweise Docker Desktop und WSL-Integration
prüfen lassen, nicht den Socket allgemein beschreibbar machen.

cloudflared einmalig nach der
[Linux-/WSL-Installationsanleitung](ADMIN.md#cloudflared-installieren)
installieren: offizielles Paket-Repository oder offizielles GitHub-Release für
die mit `uname -m` geprüfte Architektur (amd64/arm64), bei Bedarf ohne `sudo`
unter `$HOME/.local/bin`. Kein Remote-Shellskript nötig.
Notebook und unter WSL auch Windows während der Runde nicht in den Ruhezustand
versetzen; WSL-Sitzung und Tunnel geöffnet lassen.

## 1. Persönlichen Issuer vorbereiten

```bash
docker info
docker compose version
cp .env.issuer.example .env.issuer
```

In `.env.issuer` **zuerst** setzen:

```dotenv
PORT=3001
PUBLIC_URL=http://localhost:3001
WORKSHOP_URL=https://DIE-ZENTRALE.trycloudflare.com
ADMIN_TOKEN=
```

`WORKSHOP_URL` ist die tatsächlich von der Moderation mitgeteilte öffentliche
HTTPS-Adresse, exakt wie im Smartphone-Browser: Schema und Host, kein Unterpfad.
**Nicht deine eigene Issuer-Adresse und nicht `localhost`.**
`PUBLIC_URL` ist dagegen deine eigene Adresse, anfangs der lokale Startwert.

Eigenes langes Zufallstoken ohne Node auf dem Host erzeugen:

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml build app
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml run --rm --no-deps app node -e "console.log(crypto.randomUUID()+crypto.randomUUID())"
```

Ausgabe als `ADMIN_TOKEN` in `.env.issuer` eintragen. **Niemals das
Workshop-Admin-Token verwenden oder dein Issuer-Token der Zentrale geben.**
Die Datei mit dem Token nicht veröffentlichen.

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml config --quiet
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml up --build --wait
curl --fail http://localhost:3001/api/health
```

Compose muss `--wait` unterstützen; andernfalls Compose aktualisieren. Die App
läuft im Container auf Port 3000, auf deinem Rechner standardmäßig nur unter
`127.0.0.1:3001`. Bei anderem Host-`PORT` lokale URLs und Tunnel entsprechend
anpassen. Für die Zentrale und den Issuer auf demselben Notebook immer die
getrennten Projekt-/Env-/Compose-Dateien verwenden, niemals zusammenführen.

## 2. Eigenen Tunnel öffnen und URL setzen

In einem **zweiten Bash-Terminal derselben Linux-/WSL-Umgebung**, in der
`curl --fail http://localhost:3001/api/health` erfolgreich war:

```bash
export PATH="$HOME/.local/bin:$PATH"
cloudflared tunnel --url http://localhost:3001
```

Deine ausgegebene Adresse, zum Beispiel
`https://mein-issuer-beispiel.trycloudflare.com`, als `PUBLIC_URL` in
`.env.issuer` eintragen. `WORKSHOP_URL` bleibt die Adresse der **Zentrale**.
Im ersten Terminal:

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml up --wait app
```

Die App wird mit der neuen Konfiguration neu erstellt. **Denselben Tunnel im
zweiten Terminal laufen lassen**, bis die Runde beendet ist. Kein
cloudflared läuft dabei als Linux-Prozess, nicht als Windows-Programm oder
Container. Deine Issuer-URL ist jetzt öffentlich im Internet
erreichbar. Sie muss auch vom Smartphone erreichbar sein; Netzfilter und
Firewalls können Cross-Site-Tunnelzugriffe verhindern.

Die Issuer-APIs erlauben Cross-Origin-Zugriffe nur vom exakt konfigurierten
Workshop-Origin. Stimmt die Adresse nicht mit dem Smartphone-Browser überein,
die Konfiguration korrigieren und die App erneut mit `up --wait app` erstellen.
Kein privates LAN-HTTP als Ersatz: Auf dem Smartphone ist das kein sicherer
WebCrypto-Kontext. `localhost` ist nur auf deinem Desktop eine lokale Ausnahme.

## 3. Ausweisstelle anlegen und zentral registrieren

Auf **deinem Rechner** <http://localhost:3001> oder
<http://localhost:3001/issuer.html> öffnen und dein **Issuer-Token** eingeben.
Das Token bleibt im `sessionStorage` des Desktop-Browser-Tabs.

1. Deiner Ausweisstelle einen Namen geben und den Demo-Mitarbeitendennamen
   (`employeeName`) eintragen.
2. Die Ausweisstelle anlegen und bei der Workshop-Zentrale registrieren.
   Eine signierte Nonce-Challenge beweist den Besitz deines Issuer-Schlüssels.
3. Der Moderation den Fingerprint aus deinem Dashboard zeigen. Sie vergleicht
   ihn und ordnet deine DID einer Person (`ownerName`) zu.

Die Moderation muss dich **manuell freigeben**. Eine Domain oder eine gültige
Signatur allein macht einen unbekannten Issuer noch nicht vertrauenswürdig.
Du darfst für die Workshop-Geschichte bereits vorher einen Ausweis ausstellen:
Die Wallet warnt, ein Check-in wird vor Freigabe abgelehnt.

## 4. Desktop und Smartphone koppeln, dann signieren

1. Am Issuer-Desktop Vor-/Nachname, Organisation und Rolle für den
   **Mitarbeiterausweis** ausfüllen
   (Credential-Typ `urn:workshop:mitarbeiterausweis:1`).
2. **„Ausstellung vorbereiten“** anklicken. Den QR auf deinem Desktop mit dem
   Smartphone scannen. Er öffnet die **zentrale Wallet**, nicht eine Wallet
   auf deinem Issuer-Rechner.
3. Auf dem Smartphone im normalen Browser die Wallet erstellen, falls noch
   keine existiert, und verbinden. Die Wallet übermittelt ihren öffentlichen
   Schlüssel samt Besitznachweis, nicht ihren privaten Schlüssel.
4. **Auf beiden Geräten den Kopplungscode vergleichen.** Bei Abweichung
   abbrechen und neu beginnen; keinen unbekannten Empfänger bestätigen.
5. Erst jetzt am token-geschützten **Desktop** ausdrücklich
   **„Mitarbeiterausweis jetzt signieren“** anklicken.
6. Auf dem Smartphone den ausgestellten Ausweis ansehen, **annehmen und
   speichern**. Er bleibt in dieser Wallet.

Ein vorbereitetes Angebot gilt zehn Minuten und bindet sich an genau eine
Wallet. Dieselbe Wallet darf den Abruf bis zum Ablauf wiederholen, auch nach
bestätigter Annahme; eine zweite Wallet kann es nicht übernehmen. Nach Ablauf
oder Issuer-Neustart ein neues Angebot vorbereiten.

Private Wallet-Schlüssel liegen nur im `localStorage` dieses
Smartphone-Browsers. Der private Issuer-Schlüssel liegt dagegen auf deinem
Rechner im Docker-Volume (`identity.json`), nicht in der Smartphone-Wallet.

## 5. Am Empfang einchecken

1. Den aktuellen Check-in-QR auf TV/Beamer scannen; er gilt fünf Minuten.
2. Im **selben Smartphone-Browser** den gespeicherten Mitarbeiterausweis
   auswählen und die freizugebenden Angaben prüfen.
3. Den Hinweis zur Veröffentlichung lesen und bewusst zustimmen.

Der Kiosk zeigt die tatsächlich freigegebenen Angaben, Credential-Typ,
Issuer-DID und -Namen, die zentral freigegebene zugeordnete Person und
Zeitstempel. Verborgene Disclosures und der vollständige JWT werden nicht
veröffentlicht. Auch deshalb nur Demo-Daten verwenden.

Noch nicht freigegeben? Das ist eine gewollte Moderationsgeschichte: Nach
Fingerprint-Vergleich und Freigabe durch die Moderation **denselben
Mitarbeiterausweis behalten**, einen **neuen** Check-in-QR scannen und erneut
zustimmen. Eine neue Ausstellung ist dafür nicht nötig. Ein wiederverwendeter
alter Nachweisversuch scheitert am Nonce-/Replay-Schutz.

## Browser, feste URLs und typische Fehler

- **Keine PWA-Installation für den Workshop empfohlen.** Alle Kamera-Links
  im selben normalen Safari-/Chrome-Browser öffnen. Auf iOS können installierte
  Web-Apps und Safari getrennte Speicher verwenden. Browserwechsel überträgt
  weder Wallet noch privaten Schlüssel.
- Die **zentrale URL muss die ganze Runde gleich bleiben**. Ein neuer
  zentraler Tunnel-Origin hat einen anderen Browser-Speicher: Dort ist deine
  alte Wallet nicht automatisch vorhanden. Mit der Moderation klären, bevor
  du einen neuen Wallet-Zustand anlegst.
- Ein Wechsel **deiner Issuer-URL** ändert mit erhaltenem Volume nicht die
  Issuer-DID. Neue URL in `PUBLIC_URL` eintragen, App neu erstellen und
  **erneut zentral registrieren**. Für offene Vorgänge neue Angebote verwenden.
- Nach einem App-Neustart sind Angebote und Kopplungen weg; nach Neustart der
  Zentrale außerdem offene Check-in-Anfragen. Neue QRs verwenden. Persistierte
  Identität und Listen bleiben erhalten.
- Bei CORS-/Verbindungsfehlern beide öffentlichen URLs im Browser prüfen.
  `WORKSHOP_URL` muss exakt zum zentralen Browser-Origin passen. Auch bei
  funktionierendem Desktop-`localhost` können Firewall oder Mobilfunk die
  öffentlichen Tunnel blockieren.
- Der frühere Ablauf „Wallet und Gastausweis-Issuer im selben Browser“ ist
  abgelöst. Alte Demo-Gastausweise sind nicht kompatibel: vor Migration
  Server-Volumes sichern, alte Wallet/Nachweise bewusst zurücksetzen und neu
  ausstellen. Kein automatischer Purge.

## Beenden, sichern und zurücksetzen

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml down
```

Deinen Tunnel mit **Strg+C** beenden. Das Volume und die Issuer-Identität
bleiben erhalten. Die Zentrale der Moderation bleibt davon unberührt.
Für einen späteren Start deine URL-Konfiguration prüfen; eine neue Tunnel-URL
erfordert erneute Registrierung.

Vor Updates bei gestoppter App die Daten sichern:

```bash
mkdir -p backups/issuer
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml stop app
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml cp app:/app/data/. ./backups/issuer/
```

Ein frisches Backup-Verzeichnis verwenden. `identity.json` enthält deinen
privaten Issuer-Schlüssel: Sicherung nicht veröffentlichen oder weitergeben.
[Wiederherstellung und Updates](ADMIN.md#sichern-wiederherstellen-und-aktualisieren).

**Nur bewusst zum endgültigen Löschen**, nach Sicherung und Stopp:

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml stop app
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml run --rm --no-deps app npm run purge
```

**Issuer-Purge löscht `identity.json`, private Schlüssel und DID.** Das ist durch
`APP_ROLE=issuer` auf die Issuer-Rolle begrenzt. Danach eine neue Identität
anlegen, registrieren und von der Moderation neu freigeben lassen; alte Ausweise
werden nicht automatisch ersetzt. Auch `down -v` löscht dein Datenvolume.
Nichts davon ist ein normaler Neustart.

Deine Smartphone-Wallet bei Bedarf separat über „Wallet zurücksetzen“ oder
Website-Daten löschen. Ein Wallet-Reset löscht nicht deine Server-Identität,
ein Issuer-Purge löscht nicht die Smartphone-Wallet.
