# EUDI Wallet Workshop

Eine deutschsprachige Lernsimulation für digitale Mitarbeiterausweise:
Am Notebook einen Ausweis vorbereiten, mit der Smartphone-Wallet verbinden,
bewusst signieren und am gemeinsamen Empfang einchecken. Der Workshop zeigt
den Unterschied zwischen **gültiger Signatur** und **Vertrauen in den Aussteller**.

## Ablauf und Architektur

- **Workshop-Zentrale:** Die Moderation betreibt Wallet-Webapp, Kiosk-Dashboard
  und geschützte Verwaltung auf ihrem Rechner (`APP_ROLE=workshop`, Host-Port 3000).
- **Persönlicher Issuer:** Jede Person betreibt ihre eigene Ausweisstelle
  auf einem Notebook (`APP_ROLE=issuer`, Host-Port 3001).
- **Smartphone:** Die Wallet bleibt unter der festen zentralen HTTPS-Adresse.
  Sie verbindet sich per Angebots-QR mit dem persönlichen Issuer. Dessen Server
  signiert erst nach Codevergleich und bewusster Bestätigung am Notebook.
- **Kiosk:** Registrierung, Freigabe und persönliche Check-in-Versuche werden
  live sichtbar. Mehrere Personen können denselben Empfangs-QR scannen:
  Jede erhält eine eigene, einmalige Anfrage.

Beide Rollen verwenden dasselbe Docker-Image, aber **unabhängige Compose-Dateien,
Projektnamen, Ports und Datenvolumes**. Sie lassen sich auch auf einem Rechner
testen; Compose-Dateien nicht zusammenführen. Private Wallet-Schlüssel bleiben
im Smartphone-Browser, Issuer-Schlüssel in dessen Server-Volume.

## Voraussetzungen und Installation

Du brauchst Internet, Docker mit Compose v2 samt `--wait` und cloudflared.
Auf dem Host sind weder Node.js noch npm nötig. Alle folgenden Shellbefehle
laufen in **Bash unter Linux oder WSL2**, im heruntergeladenen Projektordner.

Projekt herunterladen und in den Ordner wechseln:

```bash
git clone https://github.com/nikschul/eudi_wallet_demo
cd eudi_demo
```

- **Windows:** [WSL2 installieren](https://learn.microsoft.com/windows/wsl/install)
  (`wsl --install` in einer administrativen PowerShell), dann
  [Docker Desktop](https://docs.docker.com/desktop/setup/install/windows-install/)
  mit WSL-Integration für die verwendete Linux-Distribution einrichten.
- **Linux:** [Docker Engine und Compose-Plugin installieren](https://docs.docker.com/engine/install/).
  Der Docker-Daemon muss laufen und für deinen Benutzer erreichbar sein.

```bash
docker info
docker compose version
```

Bei fehlendem Socket unter WSL Docker Desktop und dessen WSL-Integration prüfen,
unter Linux Daemon und Zugriffsrechte. Den Socket nicht allgemein beschreibbar
machen. Den lokalen Docker-Kontext verwenden.

### cloudflared installieren

Nutze das [offizielle Linux-Paket-Repository](https://pkg.cloudflare.com/) oder
ein [offizielles Release](https://github.com/cloudflare/cloudflared/releases).
Ohne systemweite Installation, für amd64/arm64:

```bash
case "$(uname -m)" in
  x86_64) arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *) printf 'Bitte einen Download für deine Architektur wählen.\n' >&2; exit 1 ;;
esac
mkdir -p "$HOME/.local/bin"
curl --fail --location --show-error \
  "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}" \
  --output "$HOME/.local/bin/cloudflared" &&
  chmod +x "$HOME/.local/bin/cloudflared" &&
  "$HOME/.local/bin/cloudflared" --version
```

cloudflared läuft als Linux-Prozess in derselben Linux-/WSL-Umgebung, in der
der Docker-Host-Port über `localhost` erreichbar ist. Notebook, WSL-Sitzung
und Tunnel während der Runde nicht in den Ruhezustand versetzen oder schließen.

## Jetzt loslegen

Die mitgelieferten `.env.workshop` und `.env.issuer` enthalten nur Dummy-Werte,
keine Geheimnisse. Die jeweils eigenen Tunnel-Adressen darin ersetzen.

- **[Kiosk / Workshop-Zentrale](docs/KIOSK.md)** – Moderation startet die Zentrale.
- **[Eigener Issuer](docs/ISSUER.md)** – Ausweisstelle starten und registrieren.
- **[Hands-on für Teilnehmende](docs/PARTICIPANTS.md)** – Notebook → Handy → Kiosk.

## Grenzen und Sicherheit

**Zentrale und Issuer erzeugen bei jedem Serverstart automatisch einen eigenen
Admin-Token.** Die Server-Logs enthalten einen privaten Freischalt-Link für die
Verwaltung sowie den Token zum manuellen Eingeben. Keine Token-Konfiguration in
Env-Dateien nötig. Den Link nur auf dem eigenen Notebook öffnen, nicht verteilen
oder am Beamer zeigen; auch die Logs enthalten das Geheimnis.

Der Link transportiert den Token im URL-Fragment, das nicht an den Webserver
gesendet wird. Die UI entfernt es sofort aus der Adresszeile und merkt sich den
Token im `sessionStorage` dieses Tabs. „Verwaltung sperren“ entfernt ihn wieder.
Nach einem Neustart gilt nur der neue Token aus dem neuesten Startblock der Logs.
Verwaltungs-APIs verlangen `X-Admin-Token`; Wallet, Registrierung beim zentralen
Register und Check-in brauchen keinen Admin-Token. Die öffentlichen Kiosk-Daten
bleiben öffentlich sichtbar. Nur erfundene Daten verwenden; kein Produktionsbetrieb.

Der vertrauliche Angebotszugang im QR und der Holder-Besitznachweis bleiben
unabhängig davon Teil des Ausstellungsprotokolls.

Echte ECDSA-Signaturen, `did:jwk` und SD-JWT erklären das Prinzip. Es handelt
sich aber weder um eine offizielle EUDI Wallet noch eine EU-Vertrauensliste,
Produktions-PKI oder vollständige OpenID4VCI-/OpenID4VP-Implementierung.
Die Moderation prüft eine DID mit menschlicher Namenszuordnung, keine Domain.

Angebote gelten zehn Minuten, persönliche Check-in-Anfragen fünf Minuten.
Neustarts verwerfen offene Vorgänge; Server-Volumes erhalten Identität und
Listen. Die Wallet zeigt zuerst ihre Ausweisablage, technische DID-Details sind
nachgeordnet. Offline bleiben gespeicherte Ausweise sichtbar, ein aktueller
Vertrauensstatus oder Check-in braucht die Server.

Alle Smartphone-Schritte im selben normalen Safari-/Chrome-Browser durchführen,
keine PWA-Installation nötig. Auf iOS können installierte Web-Apps getrennten
Speicher haben. Eine neue zentrale URL bedeutet einen anderen Browser-Speicher.
Privates LAN-HTTP reicht nicht; beide öffentlichen HTTPS-Tunnel müssen vom
Smartphone erreichbar sein. Netzfilter können diese Verbindung verhindern.

Docker-/Compose-Laufzeit, Linux-/WSL-Tunnelbetrieb und echte iOS-/Android-Geräte
sind hier **nicht als geprüft zugesagt**. Lokale Browser-Tests ersetzen das nicht.
Optional für Entwicklung mit Node.js 24 LTS: `npm ci`, `npm run check`, `npm test`.
