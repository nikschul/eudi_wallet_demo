# Workshop starten

Für den bereits eingerichteten Host. Keine Installation und kein eigener
Server bei den Teilnehmenden. Docker verwendet das vorausgefüllte Image
`ghcr.io/nikschul/eudi_wallet_demo:latest`.

## 1. Terminal 1: genau einen Tunnel starten

Falls der Tunnel schon läuft, weiterverwenden und diesen Schritt überspringen.
Ansonsten:

```bash
cloudflared tunnel --url http://localhost:3000
```

Die ausgegebene HTTPS-Adresse kopieren. Dieses Terminal während des gesamten
Workshops offen lassen.

## 2. Aktuelle Adresse eintragen

Im Projektordner die vorhandene `.env` öffnen und `PUBLIC_URL` auf genau die
Adresse aus Terminal 1 setzen, ohne abschließenden Schrägstrich oder Pfad:

```dotenv
DEMO_IMAGE=ghcr.io/nikschul/eudi_wallet_demo:latest
PORT=3000
PUBLIC_URL=https://DEINE-ADRESSE.trycloudflare.com
```

Das Image ist schon vorausgefüllt. Keine Admin-Token eintragen, keine zweite
Issuer-Konfiguration anlegen. Eine bestehende `.env` nicht überschreiben.

## 3. Terminal 2: App starten

Im Projektordner:

```bash
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d --wait
curl --fail http://localhost:3000/api/health
```

Nur nach erfolgreichem Pull fortfahren. Erwartete Health-Antwort:

```json
{"ok":true,"role":"workshop"}
```

Auch die öffentliche HTTPS-Adresse mit `/api/health` im Browser prüfen.

**Nur beim Umstieg:** Falls noch der alte Container `eudi-workshop-app-1`
läuft und Port 3000 belegt, gezielt diesen stoppen und danach den Start
wiederholen:

```bash
docker stop eudi-workshop-app-1
```

Keine fremden Container stoppen. Alte Volumes bleiben erhalten; die neue App
übernimmt alte Zwei-Server-Daten nicht. Kein `down -v` und kein Volume-Prune.

## 4. Verwaltung und Beamer vorbereiten

Die Logs nur privat öffnen, nicht auf dem Beamer:

```bash
docker compose --env-file .env -f compose.yaml logs --tail=80 app
```

Den privaten Verwaltungslink aus dem neuesten Startblock öffnen. Nach einem
Serverneustart gilt der dort neu erzeugte Link beziehungsweise Admin-Token.

Unter derselben öffentlichen HTTPS-Adresse:

| Für wen? | Seite |
|---|---|
| Nur du als Host | `/admin.html`, über den privaten Verwaltungslink |
| Fernseher / Beamer und allgemeiner Einstieg | `/` (Check-In) |
| Laptops der Teilnehmenden | `/issuer.html` |
| Smartphones | `/wallet.html` |

Nur die öffentlichen Links verteilen, niemals die Logs oder den privaten
Verwaltungslink. Teilnehmende benötigen weder Docker noch eigene Tunnel,
Registry-Logins oder Admin-Token.

Die Navigation ist überall **Check-In · Aussteller · Wallet** und wechselt
im selben Tab. Nur **„Organisation anlegen“** unter dem Check-In-QR öffnet
einen neuen Tab, damit der Check-In für die Proberunde offen bleibt.
**Wallet öffnen** führt direkt zur Wallet, ohne Einrichtungsabfrage.

## 5. Vor Beginn eine Proberunde durchführen

1. Am Laptop eine Testorganisation anlegen.
2. In deiner Verwaltung Organisation prüfen und freigeben.
3. Am Laptop einen Mitarbeiterausweis mit Testnamen und Rolle anbieten.
4. Am Smartphone in der Wallet **„QR-Code scannen“** wählen und den Angebots-QR
   scannen. Die Wallet wird bei Bedarf automatisch vorbereitet, ohne
   Einrichtungsdialog oder Bestätigung einer vorhandenen Wallet.
5. Den sechsstelligen Laptop-Code eingeben und den Ausweis speichern.
6. Den großen Kiosk-QR in derselben Wallet scannen. Bei mehreren passenden
   Ausweisen einen bewusst auswählen und die Datenfreigabe prüfen.
7. **„Freigeben & einchecken“** wählen und die ausdrücklich simulierte
   **Demo-Biometrie** bestätigen. Echte Biometrie wird nicht erfasst.
8. Prüfablauf in der Wallet und erfolgreichen Check-in am Fernseher prüfen.

Nur erfundene Daten verwenden. Den Rechner wach halten, den Tunnel während
der Runde nicht neu starten und dieselbe öffentliche Adresse verwenden.
Wallet und installierte PWA können getrennte Speicher haben; ohne Anmeldung
gibt es keine Übertragung zwischen diesen Speichern. Innerhalb desselben
Browserspeichers wird die bestehende Wallet bei jedem QR wiederverwendet.

## Falls das Image `unauthorized` meldet

Bei einem privaten Package einmalig unter demselben Linux-Benutzer anmelden,
unter dem du die Compose-Befehle ausführst:

```bash
docker login ghcr.io -u nikschul
```

Am Passwort-Prompt einen berechtigten GitHub-PAT **classic** mit
`read:packages` eingeben, nicht das GitHub-Passwort. Token nicht in Befehle,
`.env`, Git oder den Chat schreiben. Danach Schritt 3 wiederholen.
Bei weiterhin fehlendem Zugriff den Image-Namen in der Actions-Zusammenfassung
und die Package-Leserechte prüfen.

## Nach dem Workshop

```bash
docker compose --env-file .env -f compose.yaml down
```

Das erhält die Daten. Anschließend den Tunnel in Terminal 1 mit **Strg+C**
beenden. Bei einem neuen Tunnelstart kann sich die Adresse ändern; dann
Schritt 2 wiederholen. Neue Adressen haben anderen Browser-Speicher, und
Ausweise mit alter Statuslisten-Adresse müssen neu ausgestellt werden.
