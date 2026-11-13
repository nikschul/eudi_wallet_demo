# Wallet & Check-In

Eine deutschsprachige Lernsimulation für digitale Mitarbeiterausweise:
Am Notebook einen Ausweis vorbereiten, mit der Smartphone-Wallet verbinden
und beim gemeinsamen Check-In vorzeigen. Die Anwendung zeigt
den Unterschied zwischen **gültiger Signatur** und **Vertrauen in den Aussteller**.
Zusätzlich wird der **Widerrufsstatus des einzelnen Ausweises** geprüft.

**Host ist schon eingerichtet?** Die kurze
[Schritt-für-Schritt-Startanleitung](docs/WORKSHOP_START.md) enthält nur den
Workshop-Start mit dem vorgebauten Image, ohne Installationsanleitung.

## Ablauf und Architektur

- **Ein zentraler Host:** Die Moderation betreibt genau eine App mit einer
  öffentlichen HTTPS-Origin für alle Organisationen, Wallets und den Empfang.
- **Organisationen als Mandanten:** Jede Organisation hat eine isolierte
  Identität, eigene serverseitige Schlüssel und eigene Ausweise innerhalb
  derselben App. Die Moderation gibt die Organisation frei.
- **Teilnehmende brauchen nur Browser:** Am Notebook den Organisationsassistenten
  unter `/issuer.html` öffnen; die Smartphone-Wallet liegt unter `/wallet.html`.
  Keine eigenen Images, Konfigurationen, Tunnel oder Admin-Token verteilen.
- **Ausstellung:** Angebots-QR scannen und den nur am Notebook angezeigten
  sechsstelligen Code in der Wallet eingeben. Bei korrektem Code und
  Wallet-Besitznachweis signiert der Server automatisch; kein manueller
  Signaturknopf am Notebook.
- **Kiosk:** Organisationsregistrierung, Vertrauen und persönliche Check-in-Versuche werden
  live sichtbar. Mehrere Personen können denselben Empfangs-QR scannen:
  Jede erhält eine eigene, einmalige Anfrage.

Private Wallet-Schlüssel bleiben im Smartphone-Browser. Organisationsschlüssel
bleiben ausschließlich im zentralen Server-Volume. Der Organisationszugang
bleibt als Cookie im Notebook-Browser erhalten. Bei Verlust kann **nur die
Moderation** den Zugang wiederherstellen.

Ausweise sind fest an die ausstellende Organisation gebunden und enthalten
keinen Namen der bedienenden Person. Die Rollen heißen **Mitarbeitende**,
**Teamleitung** und **Gast**.

| Zugang unter derselben öffentlichen Origin | Zweck |
|---|---|
| `/issuer.html` | Öffentlicher Organisationsassistent; eigener Mandantenzugang per Cookie |
| `/wallet.html` | Smartphone-Wallet |
| `/` | Check-In: Startseite, QR-Code und Live-Dashboard |
| `/admin.html` | Private Verwaltung der Moderation; Admin-Token erforderlich |

Alle Seiten verwenden dieselbe Navigation: **Check-In**, **Aussteller** und
**Wallet**. Blau kennzeichnet den Check-In, Gelb die Aussteller-Seite und Grün
die Wallet. Der Aussteller-Link auf der Startseite öffnet einen neuen Tab,
damit der Check-In geöffnet bleibt. Alte Links auf `/kiosk.html` führen zur
Startseite weiter.

**Wallet öffnen** führt ohne Einrichtungsdialog zur Ausweisablage. Vorhandene
Wallet-Schlüssel werden weiterverwendet; nur wenn keine Wallet gespeichert ist,
wird automatisch eine angelegt. Der Aussteller-Assistent zeigt nacheinander
Organisationsname, Freigabestatus, Ausweisformular und QR-Übergabe. Die
Ausweisverwaltung bleibt als eigener aufklappbarer Bereich erreichbar.

## Voraussetzungen und Installation

Nur der **Host** braucht Internet, curl, Docker mit Compose v2 samt `--wait` und
eine lokale cloudflared-Installation. **Docker betreibt nur die App.
Genau ein Tunnel läuft separat als nativer Vordergrundprozess im Terminal.**
Auf dem Host sind weder Node.js noch npm nötig. Alle folgenden Shellbefehle
laufen unter **Linux oder WSL2**. Das App-Image benötigt kein Bash.

Nach der [ersten Image-Veröffentlichung](#ghcr-erste-veröffentlichung) braucht
der Host nur die Compose-Datei und die Konfigurationsvorlage, nicht den
Quellcode oder einen npm-Build:

```bash
mkdir -p eudi-hosted
cd eudi-hosted
curl -fLO https://raw.githubusercontent.com/nikschul/eudi_wallet_demo/main/compose.yaml
curl -fLO https://raw.githubusercontent.com/nikschul/eudi_wallet_demo/main/.env.example
test -e .env || cp .env.example .env
```

Eine vorhandene `.env` nicht überschreiben, sondern bewusst prüfen.
Bei einem Fork die Download-URLs und `DEMO_IMAGE` an das tatsächliche Repository
anpassen. Teilnehmende laden keine dieser Dateien herunter.

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

cloudflared nur auf dem zentralen Host installieren. Es ist nicht im
Docker-Image enthalten; Teilnehmende brauchen es nicht.

**Arch Linux:** Das Paket liegt im offiziellen Extra-Repository; kein AUR
und kein manueller Binary-Download nötig:

```bash
sudo pacman -Syu cloudflared
cloudflared --version
```

Bei Arch-Derivaten vorher prüfen, ob deren aktivierte Repositories das Paket
ebenfalls anbieten. Keine einzelnen Pakete mit `pacman -Sy` partiell aktualisieren.

**Debian / Ubuntu und darauf basierende Distributionen:** Einmalig das
[offizielle Cloudflare-APT-Repository](https://pkg.cloudflare.com/) hinzufügen.
Danach übernimmt APT auch die Updates; Architektur und Installationspfad müssen
nicht manuell gewählt werden.

```bash
set -o pipefail
sudo apt-get update
sudo apt-get install ca-certificates curl
sudo install -d -m 0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg |
  sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
printf '%s\n' 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' |
  sudo tee /etc/apt/sources.list.d/cloudflared.list >/dev/null
sudo apt-get update
sudo apt-get install cloudflared
cloudflared --version
```

Ist dieses Repository schon eingerichtet, reicht `sudo apt-get install cloudflared`.
Für einen Rechner ohne Administratorrechte bleiben die
[offiziellen Releases](https://github.com/cloudflare/cloudflared/releases) eine
Alternative; sie sind nicht mehr der Standardweg dieser Anleitung.

cloudflared läuft als Linux-Prozess in derselben Linux-/WSL-Umgebung, in der
der Docker-Host-Port über `localhost` erreichbar ist. Notebook, WSL-Sitzung
und Tunnel während der Runde nicht in den Ruhezustand versetzen oder schließen.

## Host starten: vorgebautes Image

**Voreingestellt ist `ghcr.io/nikschul/eudi_wallet_demo:latest`** – sowohl in
`compose.yaml` als auch in `.env.example`. Keine Image-ID oder Commit-SHA
heraussuchen; eine bestehende `.env` sollte denselben `DEMO_IMAGE`-Wert enthalten.
Ein erfolgreicher `main`-Lauf der [GHCR-Pipeline](#ghcr-erste-veröffentlichung)
veröffentlicht dieses Tag, startet aber noch keine App auf deinem Rechner.
Bei `unauthorized` oder `denied` das Package bewusst öffentlich lesbar machen
oder den Host wie dort beschrieben bei GHCR anmelden. Ist noch kein Image
veröffentlicht, bleibt der [lokale Quellcode-Build](#optional-lokaler-quellcode-build).

Bei einer früheren Zwei-Server-Installation zuerst die
[alten App-Container gezielt stoppen](#alte-app-container-gezielt-stoppen),
damit insbesondere Host-Port 3000 frei ist. Dabei bleiben deren Volumes erhalten.

### 1. Terminal 1: genau einen nativen Tunnel starten

```bash
cloudflared tunnel --url http://localhost:3000
```

Dieses Terminal offen lassen. cloudflared kann bereits eine
`https://….trycloudflare.com`-Adresse ausgeben, bevor die App läuft. Der Tunnel
wird weder von Compose noch von einem Skript oder CI gestartet.

### 2. Terminal 2: Host konfigurieren und App starten

In `.env` die ausgegebene **HTTPS-Origin ohne Pfad** als `PUBLIC_URL` eintragen.
Die Vorlage verwendet nur für eine lokale Vorschau `http://localhost:3000`;
damit funktioniert die Smartphone-Runde noch nicht.
Eine bereits eingetragene Tunneladresse nur behalten, wenn genau dieser Tunnel
noch läuft. `DEMO_IMAGE` ist vorausgefüllt und muss für den normalen Start
nicht geändert werden.

- `DEMO_IMAGE=ghcr.io/nikschul/eudi_wallet_demo:latest` ist der Standard.
  Für reproduzierbare Runden ein veröffentlichtes Versions-Tag, `sha-<vollständige
  Commit-SHA>` oder `ghcr.io/nikschul/eudi_wallet_demo@sha256:<Digest>` verwenden.
- `PORT=3000` ist ausschließlich der Host-Port, gebunden an **127.0.0.1**.
  Im Container bleibt der Port **3000**. Bei einem anderen Host-Port auch das
  Ziel des einen Terminal-Tunnels anpassen.
- Optional `VERIFIER_NAME` und `EVENT_TITLE` setzen. Keine Admin-Token,
  Organisationsschlüssel, `APP_ROLE` oder `WORKSHOP_URL` konfigurieren.

Dann im Verzeichnis der Compose-Datei:

```bash
docker compose --env-file .env -f compose.yaml config --quiet
docker compose --env-file .env -f compose.yaml pull
docker compose --env-file .env -f compose.yaml up -d --wait
curl --fail --silent --show-error http://localhost:3000/api/health
docker compose --env-file .env -f compose.yaml logs --tail=80 app
```

Der Health-Endpunkt antwortet mit `{"ok":true,"role":"workshop"}`; die historische
Rollenbezeichnung bedeutet **keinen zweiten Server**. Ein Host-Admin-Token wird
automatisch erzeugt und mit privaten Freischalt-Links protokolliert.
Nur die Moderation öffnet damit `/admin.html`. Logs und Links nicht teilen.
Die öffentliche HTTPS-Adresse ebenfalls mit `/api/health` prüfen, danach nur
die normalen Browser-Links für Organisation, Wallet und Kiosk verteilen.

Die Standard-Compose-Datei enthält **keinen Build** und keinen Tunnel-Service.
Sie zieht das Image aus GHCR. Der Container läuft als `node`, mit
schreibgeschütztem Root-Dateisystem, beschreibbarem Datenvolume und `/tmp`.

### 3. Workshop im Browser vorbereiten

1. **Nur für dich:** Den privaten Verwaltungslink aus den aktuellen App-Logs
   in einem nicht projizierten Browserfenster öffnen. Dieser Link schaltet
   `/admin.html` frei; weder Link noch Token an Teilnehmende geben.
2. **Am Beamer:** Die öffentliche Workshop-Adresse `/` öffnen.
   Der große QR dient dem Check-in, der kleinere der Organisationseinrichtung.
3. **Für die Laptops:** Dieselbe öffentliche Adresse mit `/issuer.html`
   verteilen. Jede Gruppe legt ihre Organisation selbst im eigenen Browser an.
4. **Für die Smartphones:** Dieselbe Adresse mit `/wallet.html` öffnen.
   Die Kamera startet über **„QR-Code scannen“** in der Wallet/PWA. Die Wallet
   wird beim Öffnen automatisch vorbereitet; es gibt keinen Einrichtungsdialog.

### 4. Vor Beginn eine vollständige Proberunde durchführen

Eine Testorganisation am Laptop anlegen, in deiner Host-Verwaltung prüfen und
freigeben. Danach einen Mitarbeiterausweis mit Testnamen und Rolle anbieten.
Auf dem Smartphone den Angebots-QR in der Wallet scannen, den nur am Laptop
angezeigten Code eingeben und den Ausweis speichern. Anschließend den großen
Kiosk-QR in derselben Wallet scannen und die Angaben bewusst teilen.
Der Kiosk muss einen erfolgreichen Check-in zeigen. Erst danach die Runde
für die Teilnehmenden öffnen; der [detaillierte Ablauf](#ein-eindeutiger-ablauf)
und die [Moderationsanleitung](docs/KIOSK.md) beschreiben die einzelnen Anzeigen.

Während des Workshops den Rechner wach halten, beide Dienste laufen lassen
und die öffentliche Adresse nicht wechseln. Teilnehmende benötigen weder
Docker noch eigene Tunnel, Registry-Logins oder Admin-Token.

### Betrieb, Updates und Daten

Für Updates `DEMO_IMAGE` bei Bedarf ändern und dieselben `pull`-/`up`-Befehle
ausführen; den bestehenden Terminal-Tunnel dafür **nicht neu starten**.
Bei einem App-Neustart den neuen Admin-Token aus den Logs verwenden.

```bash
docker compose --env-file .env -f compose.yaml down
```

Das stoppt nur die zentrale App und erhält das Volume. Den Tunnel separat
mit **Strg+C** in Terminal 1 beenden. **Kein `down -v` und kein Volume-Prune**
für diesen Ablauf.

Das neue Projekt heißt `eudi-hosted`; seine neue Volume-Ressource heißt
`hosted-data` (standardmäßig Docker-Volume `eudi-hosted_hosted-data`).
Sie enthält alle Organisationsidentitäten, Schlüssel und dauerhaften Listen.
Compose setzt `DATA_DIR=/app/data`; dort liegen die versionierten Dateien
`hosted-schema.json` und `hosted-state.json`. Bei einem nativen Entwicklungsstart
ohne `DATA_DIR` verwendet der Server stattdessen den lokalen Ordner `hosted-data/`,
der aus Git und dem Docker-Build-Kontext ausgeschlossen ist.
Zur Sicherung die App bewusst stoppen und das **gesamte neue Volume** geschützt
sichern; Schlüssel und zugehörige Ausstellungs-/Widerrufsdaten gehören zusammen.
Wallet-Schlüssel und Ausweise im Browser sind davon nicht erfasst.

**Keine Migration der alten Zwei-Server-Daten:** Alte Workshop-/Issuer-Volumes
und lokale Daten sind mit dem zentralen Mandantenmodell nicht kompatibel.
Nicht in das neue Volume kopieren oder daran mounten. Diese Einrichtung
liest, löscht und verändert sie nicht; Organisationen und Ausweise neu anlegen.
Liegen alte `identity.json`, `credentials.json`, `issuers.json` oder
`attendees.json` im konfigurierten Datenverzeichnis, verweigert der Server
den Start ausdrücklich; er migriert oder entfernt diese Dateien nicht.
Alte Server bei Bedarf bewusst separat stoppen, falls sie den Host-Port belegen.
`compose.issuer.yaml` ist entfallen. Vorhandene `.env.issuer` und `.env.workshop`
werden von den obigen Befehlen **nicht eingelesen** und müssen nicht gelöscht
oder verändert werden. Alte automatisch gespeicherte Tunneladressen werden
ebenfalls nicht verwendet.

### Alte App-Container gezielt stoppen

Nur beim Umstieg: Vor dem ersten Start von `eudi-hosted` die eigenen alten
App-Container anzeigen. Die Compose-Labels funktionieren auch nach Entfernung
der alten Compose-Dateien und benötigen keine alte Env-Datei:

```bash
docker ps --filter label=com.docker.compose.project=eudi-workshop --filter label=com.docker.compose.service=app --format 'table {{.ID}}\t{{.Names}}\t{{.Ports}}'
docker ps --filter label=com.docker.compose.project=eudi-issuer --filter label=com.docker.compose.service=app --format 'table {{.ID}}\t{{.Names}}\t{{.Ports}}'
```

IDs, Namen und Ports prüfen. **Nur eigene alte App-Container** auswählen.
Im folgenden Befehl `CONTAINER_ID` durch genau eine zuvor geprüfte ID ersetzen
und den Befehl bei Bedarf für die andere alte App wiederholen:

```bash
docker stop CONTAINER_ID
```

Bei leeren Listen nichts stoppen. Bei bewusst abweichenden alten Projektnamen
den jeweiligen Projektfilter entsprechend anpassen; keine pauschalen
Stop-Befehle für alle Container verwenden. `docker stop` erhält Container
und Datenvolumes. Es ist kein `down`, `rm`, `-v` oder Prune nötig; alte
Volumes und `.env.issuer` nicht löschen oder ändern. Erst danach die neue
zentrale App starten. Den neuen Terminal-Tunnel dafür nicht erneut starten.

Details zu URL-Wechseln und Problemen: [Tunnel im Terminal](docs/TUNNELS.md).

## Optional: lokaler Quellcode-Build

Nur für Entwicklung oder vor der ersten GHCR-Veröffentlichung; nicht pro
teilnehmender Person. Git und eine lokale Docker-Buildx-/BuildKit-Installation
sind nötig, aber weiterhin kein Node.js/npm auf dem Host.

```bash
git clone https://github.com/nikschul/eudi_wallet_demo.git
cd eudi_wallet_demo
test -e .env || cp .env.example .env
```

`PUBLIC_URL` wie oben konfigurieren. Den bereits laufenden nativen Tunnel
weiterverwenden, nicht zusätzlich starten. Der explizite Override ersetzt
GHCR-Pulls durch einen lokalen Build:

```bash
docker compose --env-file .env -f compose.yaml -f compose.local.yaml up -d --build --wait
```

Das lokale Image heißt `eudi-wallet-demo:local`. Der Build verwendet Node.js 24,
installiert die Lockfile-Abhängigkeiten und führt im Dockerfile-Stage `verified`
**`npm run check` und `npm test`** aus, bevor das Runtime-Image erstellt wird.
Das Node-24-Runtime-Image enthält kein Bash und benötigt kein Docker-Tunnel-Image.
Auch für Logs oder `down` beide Compose-Dateien angeben. Der Override verwendet
dasselbe neue `hosted-data`-Volume; lokale und vorgebaute Variante nicht als
zwei konkurrierende Instanzen betreiben.

## GHCR: erste Veröffentlichung

Der Workflow [Container images](.github/workflows/images.yaml) baut
**linux/amd64 und linux/arm64**. Beide Architekturen müssen zuerst im
Dockerfile-Stage `verified` die bestehenden Checks und Tests bestehen.
Erst danach wird das Runtime-Image veröffentlicht.

| Ereignis | Ergebnis |
|---|---|
| Push nach `main` | Publiziert `main`, `latest` und `sha-<vollständige Commit-SHA>` |
| Push eines `v*`-Tags oder veröffentlichtes GitHub-Release | Publiziert das Tag, bei Semver auch z. B. `1.2.3`, sowie das SHA-Tag |
| `workflow_dispatch` / „Run workflow“ | Manuell bauen und veröffentlichen; auf `main` auch `main` und `latest` |
| Pull Request nach `main` | Nur `verified` bauen/testen, kein Login und kein Push |

`latest` folgt ausschließlich `main`, nicht automatisch einem Release.
Ein manueller Lauf auf einem anderen Branch erzeugt dessen Branch- und SHA-Tag.
Tag-Push und Release können zwei Läufe für denselben Stand auslösen.
Der Image-Name wird dynamisch aus **`github.repository` in Kleinschreibung**
gebildet; der kanonische GitHub-Repositoryname ist
**`nikschul/eudi_wallet_demo`**, das Image damit
**`ghcr.io/nikschul/eudi_wallet_demo`**. Ein alter lokaler Git-Remote-Name kann
nach einer Umbenennung weiterleiten; maßgeblich ist der kanonische
Repositoryname in GitHub Actions, nicht der alte Name in der Remote-URL.
Bei Forks `DEMO_IMAGE` entsprechend ändern.
Tags sind veränderbar; für einen unveränderlichen Stand den Digest aus der
Workflow-Zusammenfassung verwenden.

1. Nach Freigabe die fertigen Änderungen committen und nach GitHub pushen.
   **Diese Anleitung und lokale Änderungen allein erzeugen kein Remote-Image.**
2. Unter [Actions → Container images](https://github.com/nikschul/eudi_wallet_demo/actions/workflows/images.yaml)
   den erfolgreichen `main`-Lauf abwarten
   oder nach Aufnahme des Workflows auf dem Standardbranch „Run workflow“
   wählen. Fehlgeschlagene Checks verhindern die Veröffentlichung.
3. Unter den Repository-/Kontoeinstellungen GitHub Actions und GHCR-Publishing
   zulassen. Der Publish-Job nutzt das eingebaute **`GITHUB_TOKEN`** mit
   `packages: write`; **keine neuen GHCR-Secrets** anlegen. Nur dieser Job hat
   Schreibrechte. PR-Code läuft ohne Paket-Schreibrechte und ohne Registry-Login;
   es gibt keinen `pull_request_target`-Workflow.
4. Nach dem ersten erfolgreichen Publish die Package-Einstellungen prüfen:
   Neue GHCR-Packages können zunächst **privat** sein, auch bei öffentlichem
   Quellcode. Für anonymes `docker compose pull` das Image ausdrücklich
   öffentlich freigeben. Falls das Package bereits existiert, dem Repository
   unter „Manage Actions access“ die nötigen Schreibrechte geben.
5. Bei absichtlich privatem Package meldet sich **nur der Host** mit
   `docker login ghcr.io -u <GitHub-Benutzername>` an und gibt einen berechtigten
   PAT (classic) mit `read:packages` am Passwort-Prompt ein; gegebenenfalls
   Organisations-SSO autorisieren. Token nicht in Befehle, Git oder `.env`
   schreiben; Docker-Zugangsdaten geschützt speichern. Teilnehmende brauchen
   keinen GHCR-Zugang.
6. Anschließend den [Pull-/Startablauf](#host-starten-vorgebautes-image) verwenden.

Die Pipeline veröffentlicht Images, **sie deployt nicht auf den Host** und
startet keinen Tunnel. Der Host zieht Updates bewusst selbst. GitHub Pages
kann die APIs und Schlüsselhaltung nicht betreiben; ein Actions-Runner ist
ebenfalls kein dauerhafter App-Host.

## Grenzen und Sicherheit

**Nur der zentrale Host erzeugt bei jedem Serverstart einen Admin-Token.**
Die Server-Logs enthalten private Freischalt-Links für die Verwaltung sowie
den Token zum manuellen Eingeben. Keine Token-Konfiguration in Env-Dateien
nötig. Nur die Moderation darf ihn verwenden; nicht verteilen oder am Beamer
zeigen. Auch die Logs enthalten das Geheimnis.

Der Link transportiert den Token im URL-Fragment, das nicht an den Webserver
gesendet wird. Die UI entfernt es sofort aus der Adresszeile und merkt sich den
Token im `sessionStorage` dieses Tabs. „Verwaltung sperren“ entfernt ihn wieder.
Nach einem Neustart gilt nur der neue Token aus dem neuesten Startblock der Logs.
Host-Verwaltungs-APIs verlangen `X-Admin-Token`; Organisationsassistent,
Wallet und Check-in brauchen keinen Host-Admin-Token. Mandantenaktionen
benötigen den eigenen Organisationszugang. Die öffentlichen Kiosk-Daten
bleiben öffentlich sichtbar. Nur erfundene Daten verwenden; kein Produktionsbetrieb.

Der vertrauliche Angebotszugang im QR, der separate Ausgabecode und der Holder-Besitznachweis bleiben
unabhängig davon Teil des Ausstellungsprotokolls.

Echte ECDSA-Signaturen, `did:jwk` und SD-JWT erklären das Prinzip. Es handelt
sich aber weder um eine offizielle EUDI Wallet noch eine EU-Vertrauensliste,
Produktions-PKI oder vollständige OpenID4VCI-/OpenID4VP-Implementierung.
Die Moderation prüft eine DID mit menschlicher Namenszuordnung, keine Domain.

Angebote gelten zehn Minuten, persönliche Check-in-Anfragen fünf Minuten.
Ein Neustart mit neuer `PUBLIC_URL` erhält Organisationsschlüssel, Freigaben,
Zugangszuordnungen, Ausstellungsdaten, Historie und Widerrufe im zentralen
Volume. Angebote der alten Origin laufen ab; neue Angebote verwenden die neue
Adresse. Kein Volume-Reset nötig. Bereits ausgestellte Ausweise mit alter
Statuslisten-URL müssen neu ausgestellt werden. Die Wallet zeigt zuerst ihre
Ausweisablage, technische DID-Details sind
nachgeordnet. Offline bleiben gespeicherte Ausweise sichtbar; Ausstellung und
Check-in brauchen den zentralen Server. Organisationsvertrauen wird im Setup verwaltet, nicht
als ausstehende Freigabe auf dem gespeicherten Credential angezeigt.

Alle Smartphone-Schritte im selben normalen Safari-/Chrome-Browser durchführen,
keine PWA-Installation nötig. Auf iOS können installierte Web-Apps getrennten
Speicher haben. Eine neue zentrale URL bedeutet einen anderen Browser-Speicher.
Privates LAN-HTTP reicht nicht; die eine öffentliche HTTPS-Origin muss vom
Smartphone erreichbar sein. Netzfilter können diese Verbindung verhindern.

Docker-/Compose-Laufzeit, Linux-/WSL-Tunnelbetrieb und echte iOS-/Android-Geräte
sind hier **nicht als geprüft zugesagt**. Lokale Browser-Tests ersetzen das nicht.
Optional für Entwicklung mit Node.js 24 LTS: `npm ci`, `npm run check`, `npm test`.

## Ein eindeutiger Ablauf

1. **Organisationsassistent:** Am Notebook `/issuer.html` unter der gemeinsamen
   Adresse öffnen und die Organisation anlegen. Die Moderation prüft
   Fingerabdruck und Zuordnung und gibt die Organisation frei.
   Erst danach sind Angebote möglich. Dies ist eine bewusste Vereinfachung
   unseres Workshops, keine universelle Voraussetzung für jede SSI-Ausstellung.
2. **Wallet öffnen:** Auf dem Smartphone unter der festen Workshop-Adresse,
   vorab oder direkt über den Angebots-QR. Der Schlüssel wird bei Bedarf
   automatisch angelegt, ohne Einrichtungsdialog. Weitere Scans verwenden
   dieselbe Wallet und denselben Schlüssel innerhalb desselben Browserspeichers.
   Unter einem abweichenden Host wird keine zweite Wallet angelegt; die Seite
   leitet mit dem geöffneten QR zur konfigurierten Workshop-Adresse weiter.
3. **Ausweis erhalten:** Angebots-QR scannen, den nur am Notebook angezeigten
   sechsstelligen Ausgabecode in der Wallet eingeben. Falsche Eingaben werden
   direkt am Formular angezeigt; fünf Fehlversuche beenden das Angebot.
   Der Code steht nicht im QR oder in der öffentlichen Angebotsantwort.
   Nach erfolgreicher Bindung kann dieselbe Wallet ohne erneute Codeeingabe
   fortsetzen, auch nach Neuladen.
4. **Automatisch ausstellen:** Nach korrektem Code und Wallet-Besitznachweis
   signiert der Server mit dem Schlüssel dieser Organisation. Keine zusätzliche
   Signaturbestätigung am Notebook. Die Wallet prüft und speichert den Ausweis.
   Der Empfang erteilt **keine Credential-Freigabe**.
5. **Vorzeigen:** Empfangs-QR scannen und Angaben bewusst teilen. Der Verifier
   prüft Signatur, Gültigkeit, Bindung, sein aktuelles Issuer-Vertrauen und
   eine aktuelle signierte Widerrufsstatusliste.

Bei mehreren passenden Ausweisen entscheidet die Wallet-Nutzerin oder der
Wallet-Nutzer ausdrücklich, welcher Ausweis vorgezeigt wird. Vor der Signatur
zeigt die Demo eine abbrechbare **Demo-Biometrie**: keine echte Geräteabfrage,
keine biometrischen Daten und kein zusätzlicher technischer Schutz. Erst nach
der Bestätigung werden die gewählten Disclosures signiert und übertragen.
Die Wallet zeigt die tatsächlichen acht Prüfungen des Empfangs als Live-Fortschritt,
nicht als zeitgesteuerte Erfolgssimulation. Namen bleiben für die
Anwesenheitskontrolle erforderlich; die Rolle bleibt freiwillig.

Die drei Dashboard-Zustände lauten entsprechend **„Issuer registriert“**,
**„Issuer vertrauenswürdig“** und **„Eingecheckt“**. Die beiden aggregierten
Metriken zählen ausschließlich **registrierte Issuer** und **erfolgreiche
Check-ins**. Wiederholte erfolgreiche Check-ins derselben Person zählen einzeln;
abgelehnte Versuche zählen nicht. Einzelne Issuer und Prüfversuche bleiben
darunter nachvollziehbar.

Wenn erneut eine Wallet-Einrichtung erscheint, zuerst Browser und Origin prüfen:
`localhost`, Tunnel-Domain, Kamera-In-App-Browser, Privatmodus und installierte
PWA können getrennte Speicher haben. Die App überträgt keine privaten Schlüssel
zwischen ihnen. Ein neuer Tunnel-Origin kann keine alte Wallet wiederfinden.

## Credentials verwalten und widerrufen

Der eigene Organisationsbereich führt eine dauerhafte Liste aller
ausgestellten Ausweise. Sie enthält Demo-Attribute, die gebundene öffentliche
Wallet-DID, Ausstellungs-/Ablaufzeit und Widerrufszeit, aber keine privaten
Wallet-Schlüssel. Personen mit Organisationszugang können einen eigenen Ausweis nach Bestätigung
**unwiderruflich widerrufen**. Das funktioniert auch nach Ablauf des Angebots
und nach einem Neustart. Ein Widerruf ändert oder löscht keine früheren
erfolgreichen Check-in-Protokolle.

Die Wallet kann jeden Ausweis **nur lokal löschen**. Das löscht weder ihren
Schlüssel noch andere Ausweise, widerruft den Ausweis nicht beim Issuer und
löscht keine historischen Check-ins. Ohne aktuelle Verbindung bleiben die
Ausweise lesbar; ihr aktueller Widerrufsstatus ist dann nicht prüfbar.
Issuer-Vertrauen und Credential-Widerruf sind getrennt: Vertrauen zu entziehen
verändert nicht die signierten Credentials, verhindert aber deren Annahme
durch den Empfang.

### Statuslisten nach dem EUDI-Prinzip

Neue Ausweise enthalten eine signierte `status.status_list`-Referenz mit
Listen-URL und zufällig vergebenem Index. Jede Organisation veröffentlicht
unter ihrer mandantengebundenen Listen-URL eine ES256-signierte, komprimierte Bitliste als
`application/statuslist+jwt`. Sie enthält **keine Namen, Credential-IDs oder
Wallet-DIDs**. Wallet und Verifier laden die gemeinsame Liste, niemals einen
personenbezogenen Status-Endpunkt. Ein Abruf verrät daher nicht, welcher
konkrete Ausweis gerade verwendet wird. Die Wallet aktualisiert die Anzeige
etwa alle fünf Sekunden, ohne eine Präsentationsanfrage auszulösen.

Die Demo akzeptiert Statuslisten höchstens 30 Sekunden lang und lädt vor
jedem Check-in eine neue Liste. Signatur, Issuer, Listen-URL, Index,
Gültigkeitszeit und Listenformat müssen passen. **Widerrufen, nicht erreichbar,
veraltet oder nicht prüfbar bedeutet keinen Check-in**; es gibt keinen stillen
„aktiv“-Fallback. Ein zusätzlicher Prüfschritt macht das Ergebnis sichtbar.
Das ist eine konservative **Verifier-Richtlinie unseres Workshops**, keine
universelle EUDI-Pflicht zur ständigen Erreichbarkeit: Das ARF erlaubt unter
anderem gültige zwischengespeicherte Listen und überlässt die Annahme bei
fehlendem Status einer anwendungsbezogenen Risikoentscheidung.

Diese bewusst kleine Umsetzung orientiert sich am Token-Status-List-Modell
für SD-JWTs, ist aber keine vollständige interoperable oder zertifizierte
EUDI-Implementierung. Eine Liste bietet 16.384 Plätze pro Issuer; belegte
Indizes werden auch nach Ablauf eines Ausweises nicht erneut vergeben.

### Adressen und bestehende Ausweise

Updates und Sicherungen betreffen nur noch die zentrale App und ihr neues
Volume; siehe [Betrieb, Updates und Daten](#betrieb-updates-und-daten).
Organisationsidentitäten, Schlüssel und Widerrufsdaten nicht voneinander trennen.
Alte Ausweise aus dem Zwei-Server-Modell werden nicht übernommen.
Auch die zentrale öffentliche Adresse muss für signierte Listen-URLs stabil
bleiben; bei einer neuen Domain Ausweise neu ausstellen und Browserzugänge
mit der Moderation klären.

Quelle: [EUDI ARF, Abschnitt 6.6.3.7 – Revocation checking](https://eudi.dev/latest/main/06-trust-model/#6637-relying-party-verifies-that-the-pid-or-attestation-is-not-revoked).

## Einordnung: echter EUDI-Ablauf

**Ein Angebots-QR ist noch kein Ausweis.** Bei OpenID4VCI verweist das
Credential Offer auf den Issuer und angebotene Nachweistypen. Die Wallet
authentifiziert beziehungsweise autorisiert den Ausstellungsabruf und weist
bei schlüsselgebundenen Credentials den passenden Schlüsselbesitz nach. Erst
die Issuer-Antwort enthält das signierte Credential.

OpenID4VCI kennt unterschiedliche Abläufe. Beim **Pre-Authorized Code Flow**
kann der Issuer zusätzlich einen **`tx_code`** vereinbaren, den die Person
in der Wallet eingibt. Dieser Code darf nicht bereits im Angebots-QR stehen.
Beim **Authorization Code Flow** wird stattdessen typischerweise die
Authentifizierung und Zustimmung beim Issuer eingebunden. Zwei unterschiedliche,
beidseits anzuzeigende Zahlen sind keine allgemeine EUDI-Vorgabe. Bei einem
reinen Vergleichscode müssten die Anzeigen gerade gleich sein.

Unser Ausgabecode bildet nur das Prinzip des optionalen `tx_code` nach:
eigene Claim-API statt OAuth-Token-Endpoint, automatische Signatur nach
korrektem Code und Wallet-Besitznachweis,
keine vollständige OpenID4VCI-Implementierung. Das Anzeigen von QR und Code
am selben Notebook ist ein Workshop-UX-Mittel, kein unabhängiger zweiter
Faktor und keine echte Identitätsprüfung. Nur den Code dieses Issuers eingeben,
keine Passwörter oder SMS-Codes anderer Dienste.

**Registrierung, Zertifizierung und Vertrauen sind zu unterscheiden:**

- **Wallet:** Die Wallet-Lösung unterliegt EUDI-Konformitäts- und
  Zertifizierungsanforderungen; der Wallet-Anbieter wird entsprechend dem
  vorgesehenen Verfahren bekannt gemacht.
- **Issuer:** PID- und Attributanbieter registrieren sich im EUDI-Ökosystem
  bei einem Registrar und verwenden Zugangs- und Registrierungszertifikate.
  Für qualifizierte Attributnachweise gelten zusätzliche Anforderungen an
  qualifizierte Vertrauensdienste und deren Beaufsichtigung. Nicht qualifizierte
  Nachweise können andere Vertrauensmodelle verwenden. Registrierung allein
  bestätigt weder die Richtigkeit jedes Attributs noch eine fachliche
  Berechtigung, beliebige Nachweistypen auszustellen.
- **Verifier / Relying Party:** Registriert sich ebenfalls und weist sich
  gegenüber der Wallet aus. Registrierung umfasst unter anderem die
  vorgesehenen Anwendungsfälle und angeforderten Daten. Das ist nicht
  gleichbedeutend mit derselben umfassenden Zertifizierung wie bei einer
  Wallet-Lösung oder einem qualifizierten Vertrauensdienst.
- **Beim Vorzeigen:** Die Wallet informiert über den anfragenden Verifier,
  die Person stimmt der Datenweitergabe zu, und der Verifier prüft Herkunft,
  Gültigkeit beziehungsweise Status, Bindung und sein Vertrauensmodell.
  Keine Moderation muss jedes gespeicherte Credential nachträglich genehmigen.
  Vertrauen kann über Zertifikatsketten, Vertrauensanker und Register entstehen;
  ein persönlicher bilateraler Freigabeschritt ist keine allgemeine Vorgabe.

Unser Fingerprint-Vergleich samt Issuer-Vertrauensliste ersetzt diese
Infrastruktur nur für die Demo. Insbesondere besitzt unser Kiosk noch kein
echtes EUDI-Relying-Party-Zertifikat.

Quellen:
[EUDI ARF, Kapitel 6 – Trust model](https://eudi.dev/latest/main/06-trust-model/),
[EUDI ARF, Kapitel 7 – Wallet certification](https://eudi.dev/latest/main/07-wallet-solution-certification-and-risk-management/),
[OpenID4VCI 1.0](https://openid.net/specs/openid-4-verifiable-credential-issuance-1_0.html),
[Verordnung (EU) 2024/1183](https://eur-lex.europa.eu/eli/reg/2024/1183/oj/eng).
