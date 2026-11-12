# Automatischer lokaler Start mit HTTPS

[Projekt](../README.md) · [Issuer-Setup](ISSUER.md) · [Kiosk-Setup](KIOSK.md)

Dieser Weg betreibt Zentrale und Issuer auf den jeweiligen Linux-Rechnern.
Cloudflared läuft als zusätzlicher Docker-Container. Keine lokale Installation
von Node.js, npm oder cloudflared und kein Cloudflare-Konto erforderlich.
GitHub Pages, Codespaces und ein VPS sind für diesen Weg nicht nötig.

Voraussetzungen: Bash, curl und Docker mit aktuellem Compose sowie Zugriff
auf den laufenden Docker-Daemon. Die Rechner brauchen Internet; Firewalls
können Cloudflare-Tunnel blockieren. Nur erfundene Daten verwenden.

## 1. Moderation startet die Zentrale

Im Projektordner:

```bash
bash scripts/demo.sh workshop
```

Das Skript baut das Image einschließlich Prüfungen, startet den Tunnel,
ermittelt dessen HTTPS-Adresse und startet die Zentrale mit passender
`PUBLIC_URL`. Erst nach erfolgreichem Container- und öffentlichem HTTPS-Check
erscheint **„Bereit: workshop“**.

Die Ausgabe enthält:

- die öffentliche Zentralen-Adresse für die Teilnehmenden;
- den Kiosk-Link für den großen Bildschirm;
- einen ausdrücklich **privaten Verwaltungslink** für die Moderation.

Nur die Zentralen-Adresse weitergeben, **nicht** den Verwaltungslink oder
Admin-Token. Die Wallet wird weiterhin unter dieser gemeinsamen
Zentralen-Adresse auf dem Smartphone eingerichtet.

## 2. Teilnehmende starten ihren Issuer

Jede Person startet auf ihrem eigenen Rechner:

```bash
bash scripts/demo.sh issuer --workshop-url https://ADRESSE-DER-ZENTRALE
```

Die Adresse aus Schritt 1 einsetzen, ohne einen zusätzlichen Seitenpfad.
Das Skript prüft zuerst, ob dort eine echte Workshop-Zentrale antwortet.
Die Issuer-Adresse wird anschließend automatisch ermittelt und eingesetzt.
Der eigene private Verwaltungslink erscheint in der lokalen Terminal-Ausgabe.

Danach bleiben nur die fachlichen Schritte im Browser:

1. Eigenen Namen und Issuer-Identität einrichten.
2. Issuer bei der Zentrale registrieren.
3. Die Moderation vergleicht den Fingerabdruck und setzt das Issuer-Vertrauen.
4. Ausweis vorbereiten, mit dem Handy verbinden und bewusst signieren.

Hosting automatisiert keine Vertrauensentscheidung. Jeder Issuer hat weiterhin
seinen eigenen Schlüssel und sein eigenes Datenvolume.

Die Zentralen-Adresse wird lokal gemerkt. Beim nächsten Start reicht:

```bash
bash scripts/demo.sh issuer
```

Beim ersten Start ohne gespeicherte Adresse fragt das Skript im Terminal danach.
In nicht interaktiven Aufrufen muss `--workshop-url` oder die Umgebungsvariable
`WORKSHOP_URL` gesetzt sein. Eine neue Zentralen-Adresse lässt sich mit
`--workshop-url` ausdrücklich übernehmen.

Alternativ gibt es in VS Code die Tasks **„Start workshop with HTTPS“** und
**„Start issuer with HTTPS“**.

## Status und Beenden

```bash
bash scripts/demo.sh workshop status
bash scripts/demo.sh issuer status

bash scripts/demo.sh issuer stop
bash scripts/demo.sh workshop stop
```

`status` prüft nicht nur den Container, sondern auch den öffentlichen
HTTPS-Endpunkt und die richtige Rolle. `stop` beendet ausschließlich App und
Tunnel der gewählten Rolle. Die Datenvolumes bleiben erhalten.

Das Startskript darf nach seiner Erfolgsmeldung geschlossen werden: Die
Container laufen in Docker weiter. Rechner und Docker während der Runde nicht
in den Ruhezustand versetzen. Die Quick-Tunnel-Container starten absichtlich
nicht automatisch neu; nach Rechner-/Tunnel-Neustart den Startbefehl erneut
ausführen, damit die Server-Adresse zur neu vergebenen URL passt.

## Konfiguration und Grenzen

- Die bestehenden Dateien `.env.workshop` und `.env.issuer` werden **nicht
  überschrieben**. Ihre Ports und sonstigen Einstellungen gelten weiterhin.
- Die automatisch vergebenen Adressen liegen in `.demo/workshop.env` bzw.
  `.demo/issuer.env`. Diese Dateien sind aus Git und dem Docker-Build-Kontext
  ausgeschlossen und enthalten keine Verwaltungs-Token oder privaten Schlüssel.
- Das Skript verwendet dieselben Compose-Projektnamen und Volumes wie die
  bisherigen Anleitungen: `eudi-workshop` und `eudi-issuer`. Deshalb nicht
  parallel einen zweiten manuellen Start derselben Rolle vornehmen.
- Bei einem fehlgeschlagenen Start wird ein **neu gestarteter** Tunnel wieder
  beendet. Ein bereits vorher laufender Tunnel wird nicht ungefragt gestoppt.
  Die Anwendung kann für die lokale Fehlersuche weiterhin vorhanden sein.
- Ein erneuter Start verwendet einen noch laufenden Tunnel weiter. Nach dessen
  Beenden kann Cloudflare jedoch eine andere Adresse vergeben.

**Quick Tunnels sind temporäre Workshop-Adressen, keine stabile Produktion.**
Eine neue Zentralen-Domain hat einen anderen Browser-Speicher: Bestehende
Wallet-Schlüssel bleiben unter der alten Adresse. Eine neue Issuer-Domain
erfordert erneute Registrierung und neue Ausweise mit passender signierter
Statuslisten-URL. Die Datenvolumes zu behalten macht URLs nicht stabil.
Für wiederkehrende Veranstaltungen sollten später feste Named-Tunnel-Hostnamen
oder ein VPS mit stabilen Domains verwendet werden.

Die manuelle Installation und die bisherigen Compose-Befehle bleiben als
Alternative dokumentiert. Bei automatischem Start immer dieses Skript auch
zum Wiederanlauf verwenden, statt mit den alten `PUBLIC_URL`-Werten manuell
neu zu starten.

## Fehlersuche

- **Docker nicht erreichbar:** Docker-Dienst und Benutzerrechte prüfen. Den
  Docker-Socket nicht für alle beschreibbar machen.
- **Zentrale nicht erreichbar:** Die Moderation muss zuerst Schritt 1 erfolgreich
  abschließen. Nur deren aktuelle HTTPS-Adresse verwenden.
- **Keine Tunnel-Adresse / HTTPS-Prüfung schlägt fehl:** Internet, Firewall und
  Cloudflare-Erreichbarkeit prüfen. Mit `--timeout 300` kann die Wartezeit je
  Phase erhöht werden; der Standard ist 120 Sekunden.
- **Port schon belegt:** `PORT` in der jeweiligen lokalen Env-Datei ändern und
  den Start wiederholen. Keine fremden Prozesse beenden.
- **Aktuellen Verwaltungslink erneut lesen:** Den Startbefehl wiederholen.
  Ein Serverneustart erzeugt einen neuen Token; alte Links funktionieren dann
  nicht mehr.
