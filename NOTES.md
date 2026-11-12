# Annahmen, Grenzen und Verifikation

## Getrennter Workshop

- `APP_ROLE=workshop` ist der Standard: zentrale Wallet-Webapp, Kiosk und Admin.
  `APP_ROLE=issuer` betreibt die persönliche Ausweisstelle auf einem anderen
  Rechner. Das gleiche Image wird mit zwei unabhängigen Compose-Dateien gestartet,
  nicht durch Zusammenführen der Dateien.
- Die Zentrale vertraut neuen Issuern nicht automatisch. Die Moderation bindet
  eine registrierte DID nach Fingerprint-Vergleich an eine Person (`ownerName`).
  Eine signierte Nonce beweist Schlüsselbesitz, nicht die Identität des Menschen.
  Keine automatische oder Batch-Freigabe, keine Benutzerkonten.
- Ein Mitarbeiterausweis (`urn:workshop:mitarbeiterausweis:1`) darf absichtlich
  bereits vor der Freigabe ausgestellt werden. Die Wallet warnt beim zentralen
  Vertrauensstatus; der Check-in prüft die Freigabe. Die gleiche Credential kann
  nach Freigabe mit einem neuen Check-in-QR verwendet werden.
- Private Issuer-Schlüssel liegen serverseitig in `identity.json` im
  Issuer-Volume; private Wallet-Schlüssel nur im `localStorage` des
  Smartphone-Browsers. Die jeweiligen Admin-Tokens bleiben im `sessionStorage`.
  Weder Tokens noch Schlüssel zwischen den Rollen weitergeben.
- Angebote liegen zehn Minuten im Prozessspeicher, Check-in-Anfragen fünf
  Minuten. Neustarts verwerfen diese flüchtigen Zustände, Kopplungen und Nonces.
  Workshop-Listen (`issuers.json`, `attendees.json`) und Issuer-Identität werden
  getrennt persistiert. Eine Instanz pro Volume; keine horizontale Skalierung.
- Die Wallet verbindet ihren öffentlichen Schlüssel mit Besitznachweis.
  Ein Angebot bindet genau eine Wallet; dieselbe Wallet darf den Abruf bis zum
  Ablauf wiederholen, auch nach bestätigter Annahme. Erst nach Vergleich des
  Kopplungscodes signiert die Person explizit am geschützten Issuer-Desktop.
- Issuer-APIs erlauben Cross-Origin-Zugriffe nur vom exakt konfigurierten
  Workshop-Origin. `WORKSHOP_URL` ist die zentrale öffentliche HTTPS-Adresse,
  `PUBLIC_URL` die eigene öffentliche Adresse. Lokale HTTP-Adressen dienen
  ausschließlich dem Start und der Bedienung auf dem jeweiligen Rechner.
- Der Kiosk zeigt tatsächlich freigegebene Claims, Credential-Typ, Issuer-DID
  und -Name, zugeordnete freigegebene Person und Zeitstempel. Er veröffentlicht
  weder versteckte Disclosures noch den vollständigen JWT. Die Wallet erklärt
  vor der Zustimmung, welche Informationen dort sichtbar werden.
- Nur cloudflared ist als öffentlicher Zugang dokumentiert. Internetzugang ist
  nötig; privates LAN-HTTP ist kein Smartphone-Workshop. Tunnel können durch
  Netzfilter oder Firewalls blockiert sein. Die Anleitungen verwenden Linux-
  oder WSL2-Bash mit Docker Engine beziehungsweise Docker Desktop mit
  WSL-Integration. cloudflared läuft als Linux-Prozess in derselben Umgebung,
  die den veröffentlichten Docker-Host-Port über `localhost` erreichen kann.
- Es handelt sich nicht um vollständige OpenID4VCI-/OpenID4VP-Interoperabilität,
  eine offizielle EU-Vertrauensliste, Zertifikats-PKI oder Produktionshärtung.
  Vertrauen gilt der DID und dem freigegebenen Menschen, nicht der Tunnel-Domain.

## Bewusster Bruch mit dem früheren Ablauf

Früher lagen Wallet und selbst erstellter Gastausweis-Issuer im selben
Smartphone-Browser. Das ist **nicht** der aktuelle Workshop-Ablauf. Alte
Browser-Issuer und Gastausweise sind mit der getrennten Mitarbeiterausweis-Demo
nicht kompatibel. Vor der Migration alte Server-Volumes sichern; anschließend
alte Demo-Wallet/Nachweise bewusst zurücksetzen und neu ausstellen. Kein
automatischer Purge und keine automatische Datenmigration.

Die Projekte `eudi-workshop` und `eudi-issuer` verwenden neue, getrennte Volumes.
Ein altes `demo-data`-Volume nicht ungeprüft als eines dieser Volumes einhängen.
Anleitungen für Sicherung, Wiederherstellung und bewusstes Löschen:
[Administration](docs/ADMIN.md#sichern-wiederherstellen-und-aktualisieren).
Issuer-Purge ist besonders destruktiv: Er löscht die Issuer-Identität und damit
die DID; anschließend muss die neue Identität erneut registriert und freigegeben
werden. Der Rollen-Guard darf `identity.json` nur für `APP_ROLE=issuer` löschen.

## Lokale Entwicklungsprüfungen

Auf einem Entwicklungsrechner mit Node.js 24 LTS (Minimum 20.6):

```bash
npm ci
npm run check
npm test
```

Der vorhandene Node-Test-Runner und die Syntaxprüfung bleiben maßgeblich; keine
zusätzlichen Testpakete nötig. Der Docker-Build führt diese Prüfungen ebenfalls
aus. Für einen direkten lokalen Start kann Node die jeweils explizite Datei
laden, zum Beispiel `node --env-file=.env.workshop server/index.js`.
Direkter Node-Betrieb braucht getrennte `DATA_DIR`-Verzeichnisse je Rolle.
`PORT` ist dabei der echte Server-Port, nicht nur der Docker-Host-Port.
Schlüsselbesitz, CORS und Smartphone-Verhalten sind zusätzlich im Browser zu prüfen.

## Aktuelle Verifikation: lokale Browser-Abnahme erfolgreich

Stand der gemeldeten Testergebnisse vom 12. November 2026:

### Erfolgreich geprüft

- Der Schlussdurchlauf ist abgeschlossen: `npm run check` prüfte **25 Dateien**
  erfolgreich. Unter **Node.js 20.12.2** ergab
  `node --test --test-reporter=spec --test-concurrency=8` **56/56 Tests
  erfolgreich, 0 Fehler, 4,338 Sekunden**. Die Workspace-Problems waren leer.
  Diese Ergebnisse betreffen den getrennten Workshop, nicht den früheren
  gemeinsamen Smartphone-/Issuer-Ablauf.
- Der integrierte Browserablauf wurde mit **zwei echten lokalen
  Serverprozessen auf getrennten Origins** `http://localhost:3087` und
  `http://localhost:3088` erfolgreich durchgespielt. Das waren keine zwei
  physischen Rechner und keine öffentlichen HTTPS-Tunnel.
- Die Wallet war schon vor der Issuer-Registrierung geladen und erhielt später
  den `#offer`-Link nach einem CSP-bedingten Reload. Erstmaliges Wallet-Anlegen,
  Angebots-QR, Holder-Besitznachweis und Kopplungscode funktionierten.
  Danach wurde ausdrücklich am Desktop signiert; die Wallet verifizierte
  lokal, speicherte den Ausweis und bestätigte die Annahme.
- Der Check-in des nicht freigegebenen Issuers wurde korrekt abgelehnt.
  Anschließend wurde in der Administration der Demo-Name „Erika Müller“
  mit dem Fingerprint zugeordnet und freigegeben. **Derselbe Ausweis** wurde
  mit einem neuen QR erfolgreich eingecheckt; alle sieben Prüfungen waren
  erfolgreich. Der Test-Fingerprint `fv6L8KNH_TPwIoMe` war im Issuer-Dashboard
  gut sichtbar und stimmte mit der Administration überein.
- Zwei Check-ins derselben Credential-ID blieben getrennte Kiosk-Snapshots:
  zunächst nur die Namen, danach zusätzlich die freigegebene Organisation.
  Jeder Snapshot enthielt nur die tatsächlich geteilten Angaben. Geöffnete
  Details blieben auch über Polling-Aktualisierungen hinweg geöffnet.
- Kiosk bei **1920 × 1080** ohne Überlauf, Check-in-QR etwa **518 px**.
  Wallet bei **375 px** Ansichtsbreite ohne horizontalen Überlauf.
  Alle sichtbaren Wallet-Buttons waren in dieser Ansicht **48 px** hoch.
  Das sind Desktop-Browser-Ansichten, keine Hardware-Abnahme.
- Bei einem echten **Offline-Reload mit aktivem Service Worker** blieb der
  gespeicherte Erika-Ausweis sichtbar. Der Vertrauensstatus wurde klar als
  nicht erreichbar angezeigt, nicht als offline bestätigtes Vertrauen.
- Die Replay-Oberfläche zeigte den erkannten Replay-Versuch und die falsche
  Nonce an.

### Weiterhin offene Einsatz- und Infrastrukturprüfung

- Docker CLI ist in dieser Bearbeitungsumgebung nicht verfügbar.
  `docker compose config`, Image-Build und Containerstart sind hier deshalb
  **nicht verifiziert**. Auch Sicherung, Wiederherstellung und Rollen-Purge mit
  echten Docker-Volumes sind damit nicht als abgenommen behauptet.
- Einsatz auf **zwei unabhängigen Rechnern**, Linux-/WSL-Integration,
  Socket-Zugriff und Erreichbarkeit des lokalen Docker-Host-Ports durch den
  Linux-cloudflared-Prozess sind **noch nicht abgenommen**.
- Öffentliche cloudflared-HTTPS-Tunnel, Cross-Origin-Zugriffe über diese
  Tunnel sowie Firewall-/Netzfilterverhalten sind **noch ungetestet**.
  Der erfolgreiche lokale Zwei-Origin-Test ersetzt diese Einsatzprüfung nicht.
- Echte iPhones mit Safari und Android-Geräte mit Chrome, Kamera-Links im
  selben Browser, iOS-Speicherverhalten, fremdes WLAN/Mobilfunk und ein
  physischer TV-Kiosk sind **noch nicht abgenommen**. Desktop-Tests ersetzen
  diese Prüfung nicht.

Die vollständige praktische Checkliste steht in
[ADMIN.md](docs/ADMIN.md#abnahme-vor-dem-workshop). Keine Zusage einer bereits
gemessenen Durchlaufzeit oder bestandener Hardwaretests.
