# Annahmen und Abweichungen

## Vorrang des aktuellen Auftrags

- Die Vorlage verbietet Manifest und Service Worker. Der aktuelle Auftrag verlangt
  ausdrücklich eine PWA. Daher gibt es ein Manifest, installierbare PNG-Icons und
  eine ausschließlich statische Offline-App-Hülle. Alle anderen Stack-Vorgaben
  bleiben weitgehend erhalten; keine weiteren npm-Abhängigkeiten.
- Dockerfile und Compose wurden ergänzt. Optional übernimmt Caddy aus seinem
  offiziellen Container HTTPS. Ohne HTTPS-Profil funktioniert die App hinter
  einem vorhandenen Reverse Proxy oder Tunnel.
- Die bestehende Arbeitsmappe ist kein Git-Repository. Es werden deshalb keine
  automatischen Checkpoint-Commits erstellt und kein Repository ungefragt initialisiert.
  Die Vorlage bleibt unverändert erhalten.

## Vereinfachungen der Vorlage

- PWA und Kamera-Deep-Links teilen auf iOS nicht zuverlässig denselben Speicher.
  Deshalb wird die Browser-Nutzung empfohlen. Für eine installierte PWA existiert
  zusätzlich ein manuelles Eingabefeld für Check-in-Links derselben Domain.
  Es gibt keine Übertragung privater Schlüssel zwischen Browsern oder Apps.
- Ein zuerst gescannter Check-in-Link bleibt über Wallet-Erstellung, Issuer und
  Angebotsannahme erhalten. Die ursprüngliche Fünf-Minuten-Frist bleibt bestehen.
- Ein QR kann auch bei Ablehnung der kryptografischen Prüfung nur einmal verwendet
  werden. Der Kiosk zeigt den Fehler sechs Sekunden und erzeugt einen neuen QR.
- Ein Wechsel von `auto` zu `manual` betrifft neue Issuer, nicht bestehende
  Vertrauensentscheidungen. Der Modus wird nicht persistiert; nach Neustart gilt
  die Umgebung. Die Vertrauensentscheidungen selbst werden persistiert.
- Ein Reset der Wallet löscht Wallet und offenes Angebot, nicht den eigenen Issuer.
  Nach neuer Wallet-Erstellung kann derselbe Issuer neue Ausweise dafür ausstellen.
- Purge löscht ausschließlich die bekannten JSON-Dateien samt temporären Dateien,
  nicht rekursiv ein durch `DATA_DIR` möglicherweise falsch angegebenes Verzeichnis.
- PNG-Icons werden deterministisch mit Node-Bordmitteln im Server erzeugt.
- Für Node ist `.env` explizit mit `--env-file` zu laden (Node >= 20.6), damit
  `npm start` ohne vorhandene Konfigurationsdatei funktioniert. Dafür gibt es
  `npm run start:env` und für ein konfiguriertes Datenverzeichnis `npm run purge:env`.
- Das gemeinsame Kryptografie-Modul weicht inzwischen bewusst vom Referenzcode
  ab: JWT-Segmentzahl, Algorithmus, Typen, Digest-Liste, Disclosure-Struktur und
  Zeitangaben werden geprüft. Ablauf gilt bereits bei `exp <= now`; fehlendes
  oder ungültiges `exp` wird nicht akzeptiert. Für Ausstellungszeitpunkte gilt
  eine Toleranz von 60 Sekunden in die Zukunft für leicht abweichende Geräteuhren.
- Check-in-Anfragen bleiben auch über Navigationslinks und Kurzpfad-Redirects
  erhalten. Schreib- und Signieraktionen lesen den aktuellen Wallet-Zustand,
  damit ein anderes Browserfenster keine alten Schlüssel oder Nachweislisten
  unbemerkt wiederherstellt. API-Aufrufe brechen nach 15 Sekunden verständlich ab.
- Gespeicherte Einträge werden vor dem Aufbau der Maps geprüft. Beschädigte,
  doppelte oder ungültig datierte Datensätze stoppen den Start, ohne die
  ursprünglichen Dateien zu verändern.
- UI und API sind für Demo-Daten bestimmt. Gleiche Namen werden wie in der Vorlage
  zusammengeführt. Nur eine Server-Instanz; keine Produktionshärtung oder echte
  EUDI-Interoperabilität.

## Frühere Verifikation

Im bisherigen Projektstand mit Node 20.12.2 protokolliert:

- Alle 19 Node-Tests grün; alle JavaScript-Dateien mit `node --check` geprüft;
  keine gemeldeten Editor-Probleme.
- Kryptografie-Modul damals textgenau mit dem Referenzcode verglichen;
  die nachträglichen Validierungen sind oben dokumentiert.
- Im integrierten Chromium-Browser: Wallet erstellen und nach Reload wiederfinden,
  Issuer registrieren, Gastausweis ausstellen, Angebot annehmen, Rohdaten ansehen.
- Wallet und Issuer bei 375 CSS-Pixeln ohne horizontalen Überlauf; Texte in der
  mobilen Hauptansicht mindestens 16 px.
- Standardfreigabe enthält nur Vor-/Nachname; optionaler Check-in enthält auch
  Organisation und Rolle. Keine privaten JWK-Felder in den beobachteten API-Requests.
- Kiosk bei 1920 × 1080 ohne Seitenscrollen, QR etwa 518 px, sieben Prüfschritte,
  Begrüßung und automatischer neuer QR nach dem Sechs-Sekunden-Timer.
- Erstscan ohne Wallet behält die Anfrage durch Onboarding und Ausstellung bei.
- Manueller Issuer wird abgelehnt und nach Admin-Freigabe akzeptiert;
  Replay-Demo zeigt den Nonce-Fehler. Admin-Token bleibt im Sitzungsspeicher.
- Offline ist ein gespeicherter Nachweis lesbar. Im Service-Worker-Cache liegen
  nur die statischen Dateien, keine API-Antworten.
- Echter Serverprozess-Neustart erhält die beiden Demo-Issuer und Check-ins.

## Aktuelle Verifikation (12. November 2026)

- Node.js 24.22.3 separat im Sitzungsverzeichnis verwendet, ohne die
  Systeminstallation zu verändern.
- Alle 36 Node-Tests erfolgreich; `npm run check` prüft alle 20
  JavaScript-Dateien ohne Syntaxfehler. Keine gemeldeten Editor-Probleme.
- Tatsächlicher Prozessstart mit `.env` aus einem anderen Arbeitsordner,
  abweichender Port, Healthcheck, sauberes SIGTERM und persistente Issuer nach
  Prozessneustart sind automatisiert geprüft.
- Browserablauf bei 375 CSS-Pixeln: Check-in-QR zuerst, Wallet erstellen,
  Navigation zum Issuer mit erhaltener Anfrage, ausstellen, übergeben, annehmen
  und erfolgreich einchecken. Sieben erfolgreiche Prüfschritte, nur Vor- und
  Nachname freigegeben, kein horizontaler Überlauf in der Ergebnisansicht.
  Wegen Einschränkungen des integrierten Browsers wurden Formulare dabei
  teilweise programmatisch abgeschickt; dies ersetzt keinen Touch-Gerätetest.
- Docker CLI und Compose sind installiert. Beide Compose-Profile und die
  Port-Interpolation wurden erfolgreich mit `docker compose config` geprüft.
  Der echte Image-Build wurde versucht, scheitert aber an fehlenden
  Zugriffsrechten auf `/var/run/docker.sock`. Containerstart, Caddy und öffentliche
  TLS-Zertifikatsausstellung sind daher weiterhin **nicht verifiziert**.

Die reproduzierbaren Node-Tests stehen unter `test/`. Ein echter Gerätetest auf
iPhone und Android, ein Kamera-Scan über Mobilfunk und die Drei-Minuten-Grenze
benötigen die spätere öffentliche HTTPS-Adresse und physische Geräte. Diese
Abnahme ist durch Desktop-Browser-Tests nicht ersetzbar.
