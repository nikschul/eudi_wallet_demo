# Hands-on für Teilnehmende

[Projekt](../README.md) · [Issuer einrichten](ISSUER.md) · [Kiosk einrichten](KIOSK.md)

Vorbereitung: Die Moderation startet die Zentrale, du startest und registrierst
deinen eigenen Issuer nach der verlinkten Anleitung. Nur erfundene Daten verwenden.
Die Issuer-Verwaltung auf deinem Notebook über den privaten Freischalt-Link aus
den Server-Logs öffnen. Er wird beim Start automatisch erzeugt und bleibt geheim.
Auf dem Smartphone ist **kein Admin-Token** nötig; dort nur die Angebots- und
Kiosk-QR-Codes scannen, niemals den Verwaltungslink.

## Notebook → Handy → Signieren → Kiosk

1. **Notebook:** Im Issuer-Dashboard Vor-/Nachname, Organisation und Rolle
   ausfüllen. **„QR-Angebot erstellen – noch nicht signieren“** anklicken.
2. **Handy:** Angebots-QR scannen. Er öffnet die Wallet unter der festen
   **zentralen HTTPS-Adresse**, nicht unter deiner Issuer-Adresse.
   Falls nötig die Wallet anlegen; zunächst ist die Ausweisablage leer.
   Mit dem Angebot verbinden und den Besitz des Wallet-Schlüssels nachweisen.
3. **Beide Geräte:** Den angezeigten Kopplungscode vergleichen. Bei Abweichung
   abbrechen. Den Code vom Smartphone am Notebook zur Bestätigung eingeben.
4. **Notebook:** Angaben prüfen und ausdrücklich
   **„Mitarbeiterausweis jetzt signieren“** anklicken. Scannen allein signiert
   noch nichts.
5. **Handy:** Ausweis prüfen, annehmen und speichern. Er erscheint in der
   Ausweisablage; technische DID-Details sind nicht der erste Einstieg.
6. **Kiosk:** Gemeinsamen Empfangs-QR scannen. Auch bei gleichzeitigen Scans
   erhält jede Person ihre eigene einmalige Anfrage. Freizugebende Angaben
   und Hinweis zur Kiosk-Anzeige lesen, dann bewusst zustimmen.

Das Dashboard zeigt den persönlichen Versuch samt Prüfschritten oder Fehler.
Der Versuchscode steht auch auf dem Handy. Bei abgelehnten Versuchen wird der
angegebene Name ausdrücklich als ungeprüft markiert. Nicht freigegebene Angaben
bleiben verborgen. Vor der zentralen
Issuer-Freigabe scheitert der Check-in absichtlich: Fingerprint und Demo-Namen
von der Moderation vergleichen und freigeben lassen, dann **denselben Ausweis**
behalten und den Empfangs-QR für einen neuen Versuch erneut scannen.

Alle Handy-Schritte im selben normalen Safari-/Chrome-Browser durchführen,
keine PWA-Installation nötig. Private Wallet-Schlüssel bleiben in diesem Browser.
Angebots-QR und -Link nicht weitergeben: Sie enthalten den vertraulichen
Angebotszugang. Das Angebot gilt zehn Minuten und bindet nur eine Wallet;
deren Abruf kann bis zum Ablauf wiederholt werden. Persönliche
Check-in-Anfragen gelten fünf Minuten. Nach Server-Neustart offene Vorgänge
neu beginnen; Details zu URLs und Verbindung stehen im [Issuer-Setup](ISSUER.md).
