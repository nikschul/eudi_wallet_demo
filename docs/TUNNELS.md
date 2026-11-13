# Ein zentraler HTTPS-Tunnel im Terminal

[Projekt und Host-Start](../README.md#host-starten-vorgebautes-image)

**Ein Host, eine App, eine öffentliche Origin für alle Organisationen.**
Docker betreibt ausschließlich die Anwendung. cloudflared läuft separat als
nativer Vordergrundprozess im Terminal, nicht als Container, Compose-Service
oder automatisierter Launcher. Teilnehmende brauchen nur Browser, keine
eigenen Tunnel, Images, Konfigurationen oder Host-Admin-Token.

## Einmaliger Ablauf auf dem Host

Die vollständigen Startbefehle stehen nur im
[Host-Start des README](../README.md#host-starten-vorgebautes-image);
hier keinen zweiten Tunnel starten.

1. **Vorbereiten:** Docker mit aktuellem Compose, curl und
   [cloudflared nativ installieren](../README.md#cloudflared-installieren).
   Für ein vorgebautes Image muss die
   [erste GHCR-Veröffentlichung](../README.md#ghcr-erste-veröffentlichung)
   erfolgreich abgeschlossen sein. Node.js und npm auf dem Host sind unnötig.
2. **Terminal 1:** Genau einen Tunnel auf `http://localhost:3000` starten und
   offen lassen. Quick Tunnels benötigen kein Cloudflare-Konto.
3. **Konfiguration:** Die ausgegebene HTTPS-Origin als `PUBLIC_URL` in `.env`
   eintragen. Kein `APP_ROLE`, kein `WORKSHOP_URL` und keine
   organisationsspezifischen Servereinstellungen.
4. **Terminal 2:** Das vorgebaute Image ziehen, die zentrale App starten und
   lokalen sowie öffentlichen Health-Endpunkt prüfen.
5. **Verteilen:** Nur die öffentlichen Links unter derselben Origin teilen:
   `/issuer.html` für den Organisationsassistenten, `/wallet.html` für die
   Smartphone-Wallet und `/` für den Check-In. `/admin.html` und
   dessen Freischalt-Link mit dem automatisch erzeugten Token bleiben privat.

Der Tunnel kann seine Adresse bereits vergeben, bevor die App läuft.
Compose startet keinen weiteren Tunnel. Der Host-Port ist standardmäßig
**127.0.0.1:3000**, der Container-Port immer **3000**. Bei einem abweichenden
Host-Port `PORT` in `.env`, Tunnelziel und lokale Prüf-URL gemeinsam anpassen.
cloudflared muss in derselben Linux-/WSL-Umgebung laufen, in der der Docker-Port
über `localhost` erreichbar ist. Rechner und WSL-Sitzung während der Runde
nicht schlafen legen. Nur erfundene Daten verwenden.

## Bestehende Installationen und Daten

Das zentrale Mandantenmodell ersetzt die frühere Trennung in Workshop- und
Issuer-Server vollständig, **ohne Datenmigration**. Das neue Compose-Projekt
`eudi-hosted` verwendet ausschließlich das neue Volume `hosted-data`
(standardmäßig `eudi-hosted_hosted-data`). Alte Workshop-/Issuer-Volumes und
lokale Daten bleiben unangetastet und sind nicht kompatibel: nicht kopieren
oder in den neuen Container mounten. Organisationen und Ausweise neu anlegen.
Im Container setzt Compose `DATA_DIR=/app/data` für `hosted-schema.json` und
`hosted-state.json`. Alte `identity.json`, `credentials.json`, `issuers.json`
oder `attendees.json` in diesem Verzeichnis verhindern den Start ausdrücklich;
es gibt keine automatische Migration oder Löschung.

`compose.issuer.yaml` ist entfallen; vorhandene `.env.issuer` und `.env.workshop`
werden nicht mehr für das Deployment gelesen und können unverändert liegen
bleiben. Alte automatisch gespeicherte Tunneladressen werden ignoriert.
Falls eine alte Instanz den Port belegt, diese bewusst separat verwalten oder
einen anderen Host-Port wählen. Die
[gezielte Stop-Anleitung im README](../README.md#alte-app-container-gezielt-stoppen)
findet alte `eudi-workshop`-/`eudi-issuer`-App-Container über ihre Compose-Labels,
auch ohne die entfernten Compose-Dateien. Nach Prüfung nur diese Container
stoppen; ihre Volumes bleiben erhalten. Keine fremden Prozesse stoppen,
keine alten Volumes entfernen und kein `down -v` oder Volume-Prune ausführen.

## Beenden, Neustarts und neue Adressen

Den Tunnel mit **Strg+C** in seinem Terminal beenden; die zentrale App separat
mit dem Compose-Befehl aus dem README stoppen. Ein Docker-Neustart startet
keinen Tunnel. Ein noch laufender Tunnel braucht wegen eines App-Neustarts
oder Image-Updates **keinen Neustart**.

**Quick Tunnels sind temporäre Workshop-Adressen, keine stabile Produktion.**
Nach einem neuen Tunnelstart kann sich die Adresse ändern. Dann `PUBLIC_URL`
aktualisieren und die App mit dem dokumentierten Compose-Start neu erstellen.
Es ist keine zweite Issuer-Adresse zu konfigurieren.

Der Neustart erhält Organisationsschlüssel, Freigaben, Zugangszuordnungen,
Ausstellungsdaten, Historie und Widerrufe im bestehenden Volume; kein Reset
und keine Migration nötig. Angebote der alten Origin laufen ab
(`410 Gone`); neue Angebote und Ausweise verwenden die neue Adresse.

Eine neue Origin hat anderen Browser-Speicher und andere Cookies:
Wallet-Schlüssel bleiben unter der alten Adresse; Organisationszugänge im
Notebook-Browser gelten nicht automatisch unter der neuen. Verlorenen
Organisationszugang kann nur die Moderation wiederherstellen.
Ausweise mit signierter Statuslisten-URL der alten Origin neu ausstellen.
Das Datenvolume zu behalten macht URLs nicht stabil und verschiebt keine
privaten Wallet-Schlüssel. Für wiederkehrende Veranstaltungen einen stabilen
Named-Tunnel-Hostnamen oder einen Host mit fester HTTPS-Origin verwenden;
auch ein Named Tunnel bleibt ein separat verwalteter nativer Prozess.

## Fehlersuche

- **cloudflared fehlt:** Die native Installation im README durchführen; ohne
  Administratorrechte sind die offiziellen Release-Binaries eine Alternative.
- **Image nicht gefunden / Zugriff verweigert:** Erst erfolgreichen
  GHCR-Publish abwarten, `DEMO_IMAGE` und Tag prüfen. Ein privates Package
  benötigt einen berechtigten Host-Login oder explizit öffentliche Sichtbarkeit.
  Teilnehmende brauchen keine Registry-Zugangsdaten.
- **Docker nicht erreichbar:** Docker-Dienst und Benutzerrechte prüfen. Den
  Docker-Socket nicht für alle beschreibbar machen.
- **Öffentliche Adresse nicht erreichbar:** Terminal-Tunnel und Docker-App
  müssen beide laufen. Tunnelziel, lokale Erreichbarkeit, Internet, Firewall
  und Cloudflare-Erreichbarkeit prüfen.
- **Port schon belegt:** `PORT`, Tunnelziel und lokale Prüf-URL anpassen.
  Keine anderen Prozesse ungefragt beenden.
- **Alte Adresse oder falsches Image:** In der Shell exportierte `PUBLIC_URL`,
  `PORT` oder `DEMO_IMAGE` haben Vorrang vor `.env`. Alte Demo-Variablen im
  App-Terminal bewusst entfernen, Konfiguration prüfen und App neu erstellen.
  Die alte `.env.issuer` wird nicht gelesen.
- **Organisationszugang fehlt:** Dieselbe HTTPS-Origin und denselben normalen
  Notebook-Browser verwenden; Cookies nicht löschen. Bei verlorenem Zugang
  die Moderation um Wiederherstellung bitten, nicht nach einem Admin-Token fragen.
- **Host-Verwaltungslink fehlt / veraltet:** Die aktuellen App-Logs wie im
  README lesen. Jeder Serverneustart erzeugt einen neuen Host-Token; dafür
  den Tunnel nicht neu starten. Logs und privaten Link nicht öffentlich teilen.
