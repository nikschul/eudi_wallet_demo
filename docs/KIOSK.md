# Kiosk / Workshop-Zentrale

[Projekt und Installation](../README.md) · [Issuer](ISSUER.md) ·
[Hands-on](PARTICIPANTS.md)

Docker und cloudflared wie im README unter Linux/WSL einrichten.
Die Zentrale stellt Wallet-Webapp, Kiosk-Dashboard und geschützte Verwaltung bereit.
**Nur erfundene Daten verwenden. Freischalt-Link und Server-Logs geheim halten.**

## 1. Lokal starten

Die mitgelieferte `.env.workshop` verwenden: `APP_ROLE=workshop`, `PORT=3000`,
zunächst `PUBLIC_URL=http://localhost:3000`. Optional Veranstaltungstitel und
Empfangsname ändern.

```bash
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml up --build --wait
curl --fail http://localhost:3000/api/health
```

Der Container nutzt Port 3000; der Host-Port ist nur an `127.0.0.1` gebunden.
`--wait` benötigt eine aktuelle Compose-v2-Version und wartet auf den Healthcheck.

## 2. Öffentlichen Tunnel öffnen

In einem zweiten Bash-Terminal derselben Linux-/WSL-Umgebung:

```bash
export PATH="$HOME/.local/bin:$PATH"
cloudflared tunnel --url http://localhost:3000
```

Die ausgegebene HTTPS-Adresse als `PUBLIC_URL` in `.env.workshop` eintragen.
Dann im ersten Terminal:

```bash
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml up --wait app
```

**Denselben Tunnel weiterlaufen lassen.** Öffentliche Adresse im Browser prüfen;
unter `/api/config` muss `publicUrl` damit übereinstimmen. Diese Adresse an alle
Personen als `WORKSHOP_URL` verteilen. Sie bleibt die feste Smartphone-Wallet-URL
für die ganze Runde. Ein neuer Tunnel-Origin hat einen anderen Browser-Speicher.

## 3. Gemeinsam moderieren

- <http://localhost:3000/kiosk.html> auf TV/Beamer öffnen.
  Das Dashboard zeigt live registrierte Issuer, Freigaben, Check-in-Fortschritt
  und persönliche Versuche mit Fehlern und Prüfschritten.
- Den privaten lokalen Freischalt-Link aus dem **neuesten Startblock** öffnen:

  ```bash
  docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml logs --tail 20 app
  ```

  Der Link öffnet die Verwaltung automatisch. Alternativ unter
  <http://localhost:3000/admin.html> den dort ebenfalls ausgegebenen Admin-Token
  eingeben. Keine Env-Einrichtung nötig. Freischaltung bleibt beim Neuladen
  in diesem Tab erhalten; „Verwaltung sperren“ entfernt sie. Nach Serverneustart
  den neuen Link verwenden. **Nicht diesen Link an Teilnehmende verteilen**
  und die Logs nicht auf dem TV zeigen.

  Den Fingerprint einer registrierten Ausweisstelle mit dem Notebook der Person
  vergleichen, ihren Demo-Namen zuordnen und bewusst freigeben.
- Der gemeinsame Empfangs-QR kann gleichzeitig von mehreren Smartphones
  gescannt werden. Jeder Scan erzeugt eine eigene einmalige Check-in-Anfrage;
  die persönlichen Versuche blockieren sich nicht.

**Lerngeschichte:** Vor Freigabe darf der Issuer schon ausstellen, aber der
Check-in scheitert. Nach Fingerprint-Vergleich und Freigabe mit demselben Ausweis
erneut den gemeinsamen QR scannen. Der neue persönliche Versuch gelingt.
Die Replay-Demo zeigt, warum eine alte Presentation nicht erneut gültig ist.

Vor Zustimmung erklärt die Wallet die Anzeige am Kiosk. Dort erscheinen nur
die tatsächlich geteilten Angaben, Typ, Issuer, freigegebene Person und
Zeitstempel – keine versteckten Disclosures oder vollständigen JWTs.
Abgelehnte Versuche zeigen den ausdrücklich ungeprüften Namen, Versuchscode
und genauen Fehler. Die letzten 100 Versuche bleiben bis zum Serverneustart
oder Leeren der Liste sichtbar; erfolgreiche Check-in-Protokolle liegen im Volume.

## Beenden

```bash
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml down
```

Tunnel mit Strg+C beenden; Serverdaten bleiben im Volume. `down -v` würde sie
löschen. Bei einem anderen Host-Port lokale URLs und Tunnelbefehl anpassen.
Für einen zusätzlichen Issuer auf demselben Rechner dessen eigene Compose-Datei,
Env-Datei und Projektnamen verwenden, nicht beide Compose-Dateien zusammenführen.
