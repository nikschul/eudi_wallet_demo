# Kiosk / Workshop-Zentrale

[Projekt und Host-Installation](../README.md) · [Organisationseinrichtung](ISSUER.md) ·
[Hands-on](PARTICIPANTS.md) · [Tunnel im Terminal](TUNNELS.md)

Die Zentrale stellt Organisationseinrichtung, Wallet-Webapp, Kiosk-Dashboard und
geschützte Host-Verwaltung in **einer Docker-App** bereit. Dazu läuft **ein nativer
Cloudflare-Tunnel im Host-Terminal**, nicht in Docker. Teilnehmende benötigen nur
einen Laptop-Browser für ihre Organisation und ein Smartphone für ihre Wallet.
**Nur erfundene Daten verwenden. Freischalt-Link und Server-Logs geheim halten.**

Docker und cloudflared wie im [README](../README.md) unter Linux/WSL einrichten. Docker betreibt
nur die App; der Tunnel läuft separat im Terminal. Falls du vorher den
alten Zwei-Server-Aufbau verwendet hast, zuerst die
[alten App-Container gezielt stoppen](../README.md#alte-app-container-gezielt-stoppen),
ohne ihre Datenvolumes zu löschen.

## 1. Zentralen Host vorbereiten

Einmal den [Host-Start im README](../README.md#host-starten-vorgebautes-image)
durchführen. Dort stehen die einzigen Tunnel-Startbefehle und die vollständige
Checkliste bis zur Proberunde. Einen bereits laufenden Tunnel weiterverwenden.

Das Image **`ghcr.io/nikschul/eudi_wallet_demo:latest`** ist vorausgefüllt.
Verwendet werden ausschließlich `.env` und `compose.yaml`; das Compose-Projekt
heißt `eudi-hosted`. Keine `.env.workshop`, kein `APP_ROLE` und kein `--build`
für den normalen Start verwenden. In `.env` nur die aktuelle öffentliche
HTTPS-Origin als `PUBLIC_URL` eintragen und bei Bedarf Titel oder Host-Port
anpassen. Ein privates GHCR-Package benötigt einen berechtigten Docker-Login
des Hosts; Teilnehmende brauchen keinen Registry-Zugang.

Die öffentliche Adresse im Browser prüfen: `/api/health` muss dieselbe Antwort
`{"ok":true,"role":"workshop"}` wie der lokale Health-Endpunkt liefern; unter
`/api/config` muss `publicUrl` mit der Tunnel-Adresse übereinstimmen.
Die öffentliche Adresse mit `/issuer.html` an Teilnehmende zur
[Organisationseinrichtung am Laptop](ISSUER.md) verteilen. Alle Organisationen
nutzen denselben Origin, haben aber einen eigenen persistenten Signaturschlüssel
und eine eigene DID. Der bei der Registrierung gewählte Organisationsname bleibt
unveränderlich. Ein neuer Tunnel-Origin hat einen anderen Browser-Speicher.
Allgemeine Hinweise: [Tunnel im Terminal](TUNNELS.md).

Das zentrale Organisationsmodell ersetzt die frühere getrennte
Teilnehmenden-Issuer-Installation. Es gibt keine Datenmigration aus diesen alten
Installationen. Keine zusätzlichen Issuer-Container oder Teilnehmenden-Tunnel
starten; Organisationen neu auf der Zentrale registrieren.

## 2. Gemeinsam moderieren

- <http://localhost:3000/kiosk.html> auf TV/Beamer öffnen.
  Der große **Check-in-QR** bleibt der primäre QR. Darunter zeigt der Kiosk einen
  kleineren, klar beschrifteten **öffentlichen Organisations-QR** samt sichtbarer
  und kopierbarer `/issuer.html`-Adresse. Diese Adresse am Laptop öffnen; sie ist
  weder Wallet-Startseite noch privater Verwaltungs- oder Wiederherstellungslink.
  Teilnehmende registrieren ihre Organisation und warten auf deine Freigabe.
  Erst der spätere Ausweisangebots-QR öffnet die Wallet am Smartphone: einmalige
  Wallet-Einrichtung, Code eingeben, danach automatischer Ausweisempfang. Mit
  gespeichertem Ausweis wird der große Check-in-QR gescannt.

  Das Dashboard zeigt genau zwei Gesamtkennzahlen: **registrierte Organisationen**
  (einschließlich ausstehender und gesperrter Organisationen) und
  **erfolgreiche Check-ins** (alle gespeicherten erfolgreichen Vorgänge, nicht die
  Anzahl der Personen oder Organisationen mit Check-in). Wiederholte erfolgreiche
  Check-ins derselben Person zählen jeweils einzeln; abgelehnte Versuche zählen
  nicht mit. Daneben bleiben persönliche Versuche mit Fehlern und Prüfschritten
  sowie die eingecheckten Personen sichtbar.
  Pro Organisation zeigt die Liste ihren aktuellen Status **ausstehend**,
  **freigegeben** oder **gesperrt** und ihre erfolgreichen Check-ins.
  Registrierung allein ist kein Vertrauen. Der Server erzeugt den Schlüssel;
  es gibt keinen separaten manuellen Schlüsselbeweis bei der Registrierung.
- Den privaten lokalen Freischalt-Link aus dem **neuesten Startblock** öffnen:

  ```bash
  docker compose --env-file .env -f compose.yaml logs --tail=80 app
  ```

  Der Link öffnet die Verwaltung automatisch. Alternativ unter
  <http://localhost:3000/admin.html> den dort ebenfalls ausgegebenen Admin-Token
  eingeben. Keine Env-Einrichtung nötig. Freischaltung bleibt beim Neuladen
  in diesem Tab erhalten; „Verwaltung sperren“ entfernt sie. Nach Serverneustart
  den neuen Link verwenden. **Nicht diesen Link an Teilnehmende verteilen**
  und die Logs nicht auf dem TV zeigen.

  **Nur der Host benutzt diese Verwaltung und diesen Admin-Token.** Der
  Browserzugang jeder Organisation gehört dagegen zu dieser Organisation;
  Teilnehmende benötigen keinen Admin-Token.

  Eine Organisation aufklappen, ihren festen Organisationsnamen, ihre DID und
  ihren Fingerabdruck mit dem Organisationsbildschirm am Laptop vergleichen und
  **Organisation freigeben** wählen. Dabei wird nur die Organisation freigegeben,
  keine bedienende Person zugeordnet. Erst danach kann die Organisation
  Ausstellungsangebote erstellen. Ein Mitarbeiterausweis bindet Organisation
  und Wallet-Inhaber, nicht die Bedienung am Laptop.
- Viele Organisationen bleiben in beiden Ansichten in einer begrenzten, scrollbar
  bedienbaren Liste übersichtlich. Suche nach Name, DID oder Fingerabdruck;
  in der Verwaltung lässt sich zusätzlich nach Vertrauensstatus filtern.
  Neue Registrierungen stehen oben. In der Verwaltung einen Eintrag aufklappen,
  um DID, Fingerabdruck, Freigabe und Wiederherstellung zu sehen. Geöffnete Details,
  angezeigte Wiederherstellungslinks, Suche und Filter bleiben bei Live-Updates erhalten.
  Der Kiosk aktualisiert etwa alle zwei Sekunden, die Verwaltung alle fünf
  Sekunden; „Aktualisieren“ lädt die Verwaltung sofort neu. Auch das
  Sperren oder erneute Freigeben wird live angezeigt. Historische erfolgreiche Check-ins
  bleiben dabei erhalten; „Check-in-Liste leeren“ setzt deren Gesamtzahl zurück.
- Der gemeinsame Empfangs-QR kann gleichzeitig von mehreren Smartphones
  gescannt werden. Jeder Scan erzeugt eine eigene einmalige Check-in-Anfrage;
  die persönlichen Versuche blockieren sich nicht.

## 3. Organisationszugang bei Bedarf wiederherstellen

Wenn der bisherige Organisationsbrowser nicht mehr verfügbar ist, als Host zuerst
die Berechtigung außerhalb der App prüfen. In der aufgeklappten Organisation
**Organisationszugang wiederherstellen · nur Host** öffnen und die Erstellung
eines privaten Links bewusst bestätigen. Die Verwaltung zeigt den Link und seine
Ablaufzeit. **Privaten Link kopieren** verwenden oder das sichtbare Textfeld
markieren und manuell kopieren, falls die Zwischenablage nicht verfügbar ist.

Der Link führt zu `/issuer.html#org-access=…`, läuft ab und kann nur einmal
eingelöst werden. Nur der berechtigten Organisation privat mitteilen, niemals
öffentlich verteilen oder am Kiosk anzeigen. Das ist **kein Host-Admin-Token**.
Erst die erfolgreiche Einlösung widerruft den bisherigen Browserzugang dieser
Organisation. Der feste Name, der Signaturschlüssel, ausgestellte Ausweise und
der Freigabestatus bleiben erhalten; Wiederherstellung ist keine Freigabe.

**Lerngeschichte:** Zuerst wird Vertrauen zur **Organisation als Issuer**
hergestellt. Danach stellt sie selbstständig Ausweise aus; der Host gibt keine einzelnen
Credentials frei. Die Wallet entscheidet über Empfang, Speicherung und
Datenfreigabe. Der Empfang prüft beim Vorzeigen weiterhin Signatur, Gültigkeit,
Wallet-Bindung und seine aktuelle Vertrauensregel. Zusätzlich wird der signierte
Credential-Status geprüft; widerrufene Ausweise werden abgelehnt. Erfolgreiche
Check-ins zeigen im aufklappbaren Versuch alle acht Prüfschritte. Die Replay-Demo zeigt,
warum eine alte Presentation nicht erneut gültig ist.

Vor Zustimmung erklärt die Wallet die Anzeige am Kiosk. Dort erscheinen nur
die tatsächlich geteilten Angaben, Typ, ausstellende Organisation, Inhaberbindung und
Zeitstempel – keine versteckten Disclosures oder vollständigen JWTs.
Abgelehnte Versuche zeigen den ausdrücklich ungeprüften Namen, Versuchscode
und genauen Fehler. Die letzten 100 Versuche bleiben bis zum Serverneustart
oder Leeren der Liste sichtbar; erfolgreiche Check-in-Protokolle liegen im Volume.
Die Vertrauensangaben in diesen Protokollen beschreiben den historischen
Prüfzeitpunkt, nicht die aktuelle Organisationsfreigabe oder den aktuellen
Credential-Status.

**Organisation sperren** entzieht das aktuelle Host-Vertrauen zu ihrem Schlüssel.
Das ist kein Widerruf eines einzelnen Credentials; ein solcher Widerruf erfolgt
bei der Organisation. Beides kann künftige Check-ins ablehnen, verändert aber
keine historischen erfolgreichen Check-in-Protokolle.

## Beenden

```bash
docker compose --env-file .env -f compose.yaml down
```

Tunnel mit Strg+C beenden; Serverdaten bleiben im Volume. `down -v` würde sie
löschen. Bei einem anderen Host-Port lokale URLs und Tunnelbefehl anpassen.
Weitere Organisationen registrieren sich im Browser an derselben Zentrale.
Es bleiben eine Docker-App und ein nativer Terminal-Tunnel für alle.
