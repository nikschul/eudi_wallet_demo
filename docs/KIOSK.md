# Kiosk / Workshop-Zentrale

[Projekt und Installation](../README.md) · [Issuer](ISSUER.md) ·
[Hands-on](PARTICIPANTS.md) · [Automatischer Start und Tunnel](TUNNELS.md)

Die Zentrale stellt Wallet-Webapp, Kiosk-Dashboard und geschützte Verwaltung bereit.
**Nur erfundene Daten verwenden. Freischalt-Link und Server-Logs geheim halten.**

Für den automatischen lokalen Start (Variante C) siehe
[Automatischer Start und Tunnel](TUNNELS.md): `bash scripts/demo.sh workshop`.
Die folgenden Schritte bleiben als manuelle Alternative erhalten; dafür Docker
und cloudflared wie im README unter Linux/WSL einrichten.

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
  Das Dashboard zeigt genau zwei Gesamtkennzahlen: **registrierte Issuer** und
  **erfolgreiche Check-ins** (alle gespeicherten erfolgreichen Vorgänge, nicht die
  Anzahl der Personen oder Issuer mit Check-in). Wiederholte erfolgreiche
  Check-ins derselben Person zählen jeweils einzeln; abgelehnte Versuche zählen
  nicht mit. Daneben bleiben persönliche Versuche mit Fehlern und Prüfschritten
  sowie die eingecheckten Personen sichtbar.
  Pro Issuer zeigt die Liste seinen aktuellen Vertrauensstatus und seine
  erfolgreichen Check-ins. Registrierung allein ist kein Vertrauen; ein fehlender
  Schlüsselbeweis wird gesondert angezeigt.
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
  vergleichen, ihren Demo-Namen zuordnen und **den Issuer im Setup als
  vertrauenswürdig kennzeichnen**. Erst danach wird am Issuer die Erstellung
  von Ausstellungsangeboten möglich.
- Viele Issuer bleiben in beiden Ansichten in einer begrenzten, scrollbar
  bedienbaren Liste übersichtlich. Suche nach Name, DID oder Fingerabdruck;
  in der Verwaltung lässt sich zusätzlich nach Vertrauensstatus filtern.
  Neue Registrierungen stehen oben. In der Verwaltung einen Eintrag aufklappen,
  um Fingerabdruck, Zuordnung und Vertrauensaktionen zu sehen. Geöffnete Details,
  ungespeicherte Eingaben, Suche und Filter bleiben bei Live-Updates erhalten.
  Der Kiosk aktualisiert etwa alle zwei Sekunden, die Verwaltung alle fünf
  Sekunden; „Aktualisieren“ lädt die Verwaltung sofort neu. Auch ein
  Vertrauensentzug wird live angezeigt. Historische erfolgreiche Check-ins
  bleiben dabei erhalten; „Check-in-Liste leeren“ setzt deren Gesamtzahl zurück.
- Der gemeinsame Empfangs-QR kann gleichzeitig von mehreren Smartphones
  gescannt werden. Jeder Scan erzeugt eine eigene einmalige Check-in-Anfrage;
  die persönlichen Versuche blockieren sich nicht.

**Lerngeschichte:** Zuerst wird Vertrauen zum **Issuer** hergestellt. Danach
stellt er selbstständig Ausweise aus; die Moderation gibt keine einzelnen
Credentials frei. Die Wallet entscheidet über Empfang, Speicherung und
Datenfreigabe. Der Empfang prüft beim Vorzeigen weiterhin Signatur, Gültigkeit,
Wallet-Bindung und seine aktuelle Vertrauensregel. Zusätzlich wird der signierte
Credential-Status geprüft; widerrufene Ausweise werden abgelehnt. Erfolgreiche
Check-ins zeigen im aufklappbaren Versuch alle acht Prüfschritte. Die Replay-Demo zeigt,
warum eine alte Presentation nicht erneut gültig ist.

Vor Zustimmung erklärt die Wallet die Anzeige am Kiosk. Dort erscheinen nur
die tatsächlich geteilten Angaben, Typ, Issuer, zugeordnete ausstellende Person und
Zeitstempel – keine versteckten Disclosures oder vollständigen JWTs.
Abgelehnte Versuche zeigen den ausdrücklich ungeprüften Namen, Versuchscode
und genauen Fehler. Die letzten 100 Versuche bleiben bis zum Serverneustart
oder Leeren der Liste sichtbar; erfolgreiche Check-in-Protokolle liegen im Volume.
Die Vertrauensangaben in diesen Protokollen beschreiben den historischen
Prüfzeitpunkt, nicht das aktuelle Issuer-Vertrauen oder den aktuellen
Credential-Status.

## Beenden

```bash
docker compose -p eudi-workshop --env-file .env.workshop -f compose.yaml down
```

Tunnel mit Strg+C beenden; Serverdaten bleiben im Volume. `down -v` würde sie
löschen. Bei einem anderen Host-Port lokale URLs und Tunnelbefehl anpassen.
Für einen zusätzlichen Issuer auf demselben Rechner dessen eigene Compose-Datei,
Env-Datei und Projektnamen verwenden, nicht beide Compose-Dateien zusammenführen.
