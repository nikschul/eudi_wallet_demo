# EUDI Wallet Workshop

Eine deutschsprachige Lernsimulation für digitale Mitarbeiterausweise:
Am Notebook einen Ausweis vorbereiten, mit der Smartphone-Wallet verbinden,
bewusst signieren und am gemeinsamen Empfang einchecken. Der Workshop zeigt
den Unterschied zwischen **gültiger Signatur** und **Vertrauen in den Aussteller**.
Zusätzlich wird der **Widerrufsstatus des einzelnen Ausweises** geprüft.

## Ablauf und Architektur

- **Workshop-Zentrale:** Die Moderation betreibt Wallet-Webapp, Kiosk-Dashboard
  und geschützte Verwaltung auf ihrem Rechner (`APP_ROLE=workshop`, Host-Port 3000).
- **Persönlicher Issuer:** Jede Person betreibt ihre eigene Ausweisstelle
  auf einem Notebook (`APP_ROLE=issuer`, Host-Port 3001).
- **Smartphone:** Die Wallet bleibt unter der festen zentralen HTTPS-Adresse.
  Sie verbindet sich per Angebots-QR mit dem persönlichen Issuer. Dessen Server
  signiert erst nach Eingabe des Ausgabecodes in der Wallet und bewusster
  Bestätigung am Notebook.
- **Kiosk:** Issuer-Registrierung, Issuer-Vertrauen und persönliche Check-in-Versuche werden
  live sichtbar. Mehrere Personen können denselben Empfangs-QR scannen:
  Jede erhält eine eigene, einmalige Anfrage.

Beide Rollen verwenden dasselbe Docker-Image, aber **unabhängige Compose-Dateien,
Projektnamen, Ports und Datenvolumes**. Sie lassen sich auch auf einem Rechner
testen; Compose-Dateien nicht zusammenführen. Private Wallet-Schlüssel bleiben
im Smartphone-Browser, Issuer-Schlüssel in dessen Server-Volume.

## Voraussetzungen und Installation

Du brauchst Internet, Bash, curl und Docker mit Compose v2 samt `--wait`.
Beim [automatischen Start](docs/TUNNELS.md) läuft cloudflared im Container;
die lokale Installation unten ist nur für den manuellen Alternativweg nötig.
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

Dieser Abschnitt ist optional, wenn du den [automatischen Docker-Start](docs/TUNNELS.md)
verwendest.

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

## Jetzt loslegen

**Einfachster lokaler Weg – inklusive automatischem HTTPS-Tunnel:**

```bash
# Zuerst auf dem Rechner der Moderation:
bash scripts/demo.sh workshop

# Dann je Teilnehmer-Rechner, mit der ausgegebenen Zentralen-Adresse:
bash scripts/demo.sh issuer --workshop-url https://ADRESSE-DER-ZENTRALE
```

Keine Tunnel-URLs von Hand in Env-Dateien kopieren. Details zu Status,
Beenden und temporären Adressen: [Automatischer Start](docs/TUNNELS.md).

Für den manuellen Alternativweg:
Die mitgelieferten `.env.workshop` und `.env.issuer` enthalten nur Dummy-Werte,
keine Geheimnisse. Die jeweils eigenen Tunnel-Adressen darin ersetzen.

- **[Kiosk / Workshop-Zentrale](docs/KIOSK.md)** – Moderation startet die Zentrale.
- **[Eigener Issuer](docs/ISSUER.md)** – Ausweisstelle starten und registrieren.
- **[Hands-on für Teilnehmende](docs/PARTICIPANTS.md)** – Notebook → Handy → Kiosk.

## Hosting und Automatisierung: Konzept

**Variante C, der lokale Compose-Tunnel-Start, ist umgesetzt:** siehe
[Automatischer Start](docs/TUNNELS.md). Die übrigen Varianten bleiben eine
Zielarchitektur; Deployment-Workflows oder Codespaces-Konfigurationen sind
noch nicht enthalten.

**GitHub Actions deployt, GitHub Pages hostet nur statische Dateien.** Pages
kann weder die Express-APIs noch Issuer-Schlüssel, Ausstellungsdaten und
Widerrufsdienste betreiben. Ein Actions-Runner ist ebenfalls kein dauerhafter
App-Host: GitHub-gehostete Jobs enden spätestens nach sechs Stunden und bieten
keinen verlässlichen dauerhaften App-Speicher oder öffentlichen Server-Endpunkt.
Self-hosted Runner würden wiederum einen eigenen Server voraussetzen.

| Variante | Laufzeit | Aufwand für Teilnehmende | Einordnung |
|---|---|---|---|
| Zentrale und getrennte Issuer auf einem Workshop-VPS | Eigene Container, Schlüssel und Volumes je Issuer; Reverse Proxy mit HTTPS | Browser öffnen | Am zuverlässigsten; selbständige Issuer-Identitäten, aber kein Hosting auf dem eigenen Notebook |
| Zentrale auf VPS, persönlicher Issuer in GitHub Codespaces | Eigener Workspace mit öffentlich freigegebenem App-Port | Codespace starten, Issuer einrichten | Nahe am persönlichen Hosting, ohne lokale Docker-/Tunnelinstallation |
| Zentrale und Issuer lokal mit Tunnel-Sidecar | Rechner betreiben App und cloudflared gemeinsam in Compose | Startskript ausführen | Umgesetzt; Docker-Tunnel, URL-Übernahme und Erreichbarkeitsprüfung sind automatisiert |
| Nur Kiosk-Oberfläche auf GitHub Pages | Statisches Frontend, Workshop-API weiterhin auf VPS | Browser öffnen | Machbar, ersetzt aber keinen Backend-Host und bringt zusätzliche CORS-/URL-Konfiguration mit |

Für den **Pages-Kiosk** müssten API-Adresse und Asset-Basispfad konfigurierbar
werden. Aktuell verwenden die Seiten Root-Pfade und Same-Origin-API-Aufrufe.
Projekt-Pages liegen dagegen üblicherweise unter `/<repository>/`.
Die Workshop-API müsste genau den Kiosk-Origin per CORS erlauben, inklusive
der Erstellung von Check-in-Anfragen; Wallet-QRs müssten weiterhin auf die
feste Wallet-Adresse der Zentrale zeigen. Keine Admin-Token, Schlüssel oder
Personendaten dürfen in Pages-Builds eingebettet werden.

**Codespaces** bietet pro Person einen isolierten Workspace und eine
öffentliche Port-URL mit HTTPS am GitHub-Proxy. Der App-Port muss öffentlich
sein, damit Smartphone und Zentrale ohne GitHub-Anmeldung zugreifen können;
Organisationsrichtlinien können das verbieten. Workspace-Speicher bleibt bei
einem Stop erhalten, aber nicht nach dem Löschen des Codespaces. Idle-Stop,
Kontingente und Kosten müssen für die Workshop-Dauer berücksichtigt werden.
Die feste Codespace-URL ist als `PUBLIC_URL` zu verwenden; ein neu angelegter
Codespace mit neuer URL benötigt neue Registrierung und neue Ausweise.
Das ersetzt cloudflared durch GitHubs Port-Proxy, nicht durch GitHub Pages.

**Pipelines können den Vorbereitungsteil vereinfachen:** Tests ausführen,
ein versioniertes Image in GHCR veröffentlichen und die Zentrale auf dem VPS
aktualisieren. Ein separates Startskript oder ein Compose-Tunnel-Sidecar kann
dann auf dem Notebook den Tunnel starten, die URL prüfen, die lokale
Konfiguration setzen und den Issuer starten. Ein CI-Job allein erreicht
aber nicht das private Notebook und hält es nicht für die Person online.
Quick-Tunnel-URLs wechseln; für wiederholbare Workshops sind stabile,
vorab zugewiesene Named-Tunnel-Hostnamen oder Codespaces/VPS-Adressen besser.
Globale Cloudflare-Zugangsdaten gehören nicht auf Teilnehmer-Notebooks.

Empfohlene Reihenfolge: **versioniertes Image und zentrale VPS-Bereitstellung**,
danach **Codespaces als installationsarmen Teilnehmerweg**; optional ein
lokales Compose-Tunnel-Profil für den Lernpfad „selbst hosten“.
Einen separaten Pages-Kiosk würde ich erst ergänzen, wenn die Trennung
von Frontend und Backend selbst ein Ziel ist. Registrierung und menschliche
Vertrauensentscheidung bleiben unabhängig vom automatisierten Hosting.

Quellen:
[GitHub Pages](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages),
[Actions-Limits](https://docs.github.com/en/actions/reference/limits),
[Codespaces-Portfreigaben](https://docs.github.com/en/codespaces/developing-in-a-codespace/forwarding-ports-in-your-codespace).

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

Der vertrauliche Angebotszugang im QR, der separate Ausgabecode und der Holder-Besitznachweis bleiben
unabhängig davon Teil des Ausstellungsprotokolls.

Echte ECDSA-Signaturen, `did:jwk` und SD-JWT erklären das Prinzip. Es handelt
sich aber weder um eine offizielle EUDI Wallet noch eine EU-Vertrauensliste,
Produktions-PKI oder vollständige OpenID4VCI-/OpenID4VP-Implementierung.
Die Moderation prüft eine DID mit menschlicher Namenszuordnung, keine Domain.

Angebote gelten zehn Minuten, persönliche Check-in-Anfragen fünf Minuten.
Neustarts verwerfen offene Vorgänge; Server-Volumes erhalten Identität und
Listen. Die Wallet zeigt zuerst ihre Ausweisablage, technische DID-Details sind
nachgeordnet. Offline bleiben gespeicherte Ausweise sichtbar; Ausstellung und
Check-in brauchen die Server. Issuer-Vertrauen wird im Setup verwaltet, nicht
als ausstehende Freigabe auf dem gespeicherten Credential angezeigt.

Alle Smartphone-Schritte im selben normalen Safari-/Chrome-Browser durchführen,
keine PWA-Installation nötig. Auf iOS können installierte Web-Apps getrennten
Speicher haben. Eine neue zentrale URL bedeutet einen anderen Browser-Speicher.
Privates LAN-HTTP reicht nicht; beide öffentlichen HTTPS-Tunnel müssen vom
Smartphone erreichbar sein. Netzfilter können diese Verbindung verhindern.

Docker-/Compose-Laufzeit, Linux-/WSL-Tunnelbetrieb und echte iOS-/Android-Geräte
sind hier **nicht als geprüft zugesagt**. Lokale Browser-Tests ersetzen das nicht.
Optional für Entwicklung mit Node.js 24 LTS: `npm ci`, `npm run check`, `npm test`.

## Ein eindeutiger Ablauf

1. **Issuer-Setup:** Eigene Ausweisstelle registrieren. Die Moderation prüft
   Fingerabdruck und Zuordnung und kennzeichnet den Issuer als vertrauenswürdig.
   Erst danach sind Angebote möglich. Dies ist eine bewusste Vereinfachung
   unseres Workshops, keine universelle Voraussetzung für jede SSI-Ausstellung.
2. **Wallet einmalig einrichten:** Auf dem Smartphone unter der festen
   Workshop-Adresse, vorab oder beim ersten Angebots-QR. Weitere Scans verwenden
   dieselbe Wallet und denselben Schlüssel. Unter einem abweichenden Host wird
   keine zweite Wallet angelegt; die UI verweist auf die konfigurierte Adresse.
3. **Ausweis erhalten:** Angebots-QR scannen, den nur am Notebook angezeigten
   sechsstelligen Ausgabecode in der Wallet eingeben. Falsche Eingaben werden
   direkt am Formular angezeigt; fünf Fehlversuche beenden das Angebot.
   Der Code steht nicht im QR oder in der öffentlichen Angebotsantwort.
   Nach erfolgreicher Bindung kann dieselbe Wallet ohne erneute Codeeingabe
   fortsetzen, auch nach Neuladen.
4. **Bewusst ausstellen:** Am Notebook Angaben prüfen und signieren. Die Wallet
   prüft die Signatur und speichert den Ausweis auf Wunsch. Der Empfang erteilt
   **keine Credential-Freigabe**.
5. **Vorzeigen:** Empfangs-QR scannen und Angaben bewusst teilen. Der Verifier
   prüft Signatur, Gültigkeit, Bindung, sein aktuelles Issuer-Vertrauen und
   eine aktuelle signierte Widerrufsstatusliste.

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

Die Issuer-Verwaltung führt eine dauerhafte Liste aller **ab dieser Version**
ausgestellten Ausweise. Sie enthält Demo-Attribute, die gebundene öffentliche
Wallet-DID, Ausstellungs-/Ablaufzeit und Widerrufszeit, aber keine privaten
Wallet-Schlüssel. Die ausstellende Person kann einen Ausweis nach Bestätigung
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
Listen-URL und zufällig vergebenem Index. Der Issuer veröffentlicht unter
`/api/status-list` eine ES256-signierte, komprimierte Bitliste als
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

### Aktualisierung und Sicherung

Beide Rollen mit `up -d --build` aktualisieren und die Seiten neu laden.
Volumes und Wallet-Speicher **nicht löschen**. Beim Issuer gehören
`identity.json` **und** `credentials.json` gemeinsam in die Sicherung.
Die neue Liste wird beim erstmaligen Upgrade angelegt; spätere beschädigte
oder fehlende Widerrufsdaten verhindern den Issuer-Start, statt alle Ausweise
versehentlich wieder als aktiv zu veröffentlichen.
Ein absichtlicher Issuer-Purge entfernt Identität und Credential-Liste
gemeinsam und erzeugt beim nächsten Einrichten eine neue DID. Nur bei
gestopptem Server und nach bewusster Sicherung verwenden.

**Alte Ausweise müssen neu ausgestellt werden:** Einer bestehenden Signatur
kann nachträglich keine Statusreferenz hinzugefügt werden. Alte Credentials
bleiben in der Wallet sichtbar, gelten für diesen Check-in aber als nicht
prüfbar. Die bisherige Version hat keine dauerhafte Ausstellungsübersicht
geführt; diese alte Historie lässt sich nicht zuverlässig rekonstruieren.
Auch die Issuer-Adresse muss für die signierte Listen-URL stabil bleiben;
bei einer neuen Domain die Ausweise neu ausstellen.

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
eigene `/claim`-API statt OAuth-Token-Endpoint, bewusste Signatur am Notebook,
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
