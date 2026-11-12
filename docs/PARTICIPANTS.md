# Hands-on für Teilnehmende

[Projekt](../README.md) · [Issuer einrichten](ISSUER.md) · [Kiosk einrichten](KIOSK.md)

Vorbereitung: Die Moderation startet die Zentrale. Du startest und registrierst
deinen eigenen Issuer; die Moderation kennzeichnet ihn nach Fingerprint-Vergleich
als vertrauenswürdig. **Dieses Setup ist vor der ersten Ausstellung abgeschlossen.**
Nur erfundene Daten verwenden.
Die Issuer-Verwaltung auf deinem Notebook über den privaten Freischalt-Link aus
den Server-Logs öffnen. Er wird beim Start automatisch erzeugt und bleibt geheim.
Auf dem Smartphone ist **kein Admin-Token** nötig; dort nur die Angebots- und
Kiosk-QR-Codes scannen, niemals den Verwaltungslink.

## Wallet einmalig einrichten

Die Wallet gehört zum Smartphone-Browser unter der festen öffentlichen
**Workshop-Adresse**, nicht zum Issuer und nicht zum Notebook. Du kannst sie
vorab unter dieser Adresse einrichten oder beim ersten Angebots-QR. Beide
Einstiege führen zur selben Wallet. Jeder weitere Angebots- oder Empfangs-QR
verwendet deren vorhandenen Schlüssel; eine erneute Einrichtung ist nicht nötig.

Falls trotzdem eine Einrichtung erscheint: **Nicht sofort eine neue Wallet
anlegen.** Den Link im selben normalen Browser öffnen, keinen Kamera-In-App-
Browser, privaten Modus oder getrennte installierte PWA verwenden. Die Adresse
mit der bisherigen Workshop-Adresse vergleichen. `localhost`, eine IP und eine
andere Tunnel-Domain sind getrennte Speicher. Die UI zeigt die aktuelle Adresse
an und bietet unter einem abweichenden Host keine neue Wallet-Erstellung an.
Vorhandene Schlüssel lassen sich nicht automatisch zwischen diesen Speichern
verschieben. Bei einer geänderten Workshop-Domain die Moderation ansprechen.

## Notebook → Handy → Signieren → Kiosk

**„Meine Wallet“ öffnet immer deine Ausweisablage**, auch wenn du vorher
eine Präsentationsanfrage geöffnet hattest. Dort ist kein Check-in-Schritt aktiv.
Eine Anfrage erscheint erst über den Empfangs-QR beziehungsweise dessen bewusst
geöffneten oder eingefügten QR-Link, nicht durch den Wallet-Navigationslink.
Der Anfrage-Link wird nach dem Laden aus der Adresszeile entfernt. Auch
Neuladen öffnet daher wieder die Ausweisablage; für einen neuen Versuch den
Empfangs-QR erneut scannen.

1. **Notebook:** Im Issuer-Dashboard Vor-/Nachname, Organisation und Rolle
   ausfüllen. **„QR-Angebot erstellen – noch nicht signieren“** anklicken.
2. **Handy:** Angebots-QR scannen. Er öffnet die Wallet unter der festen
   **zentralen HTTPS-Adresse**, nicht unter deiner Issuer-Adresse.
   Eine vorhandene Wallet wird direkt verwendet. Nur beim allerersten Besuch
   einmalig einrichten; das geöffnete Angebot bleibt dabei erhalten.
3. **Handy:** Den sechsstelligen **Ausgabecode direkt unter dem Angebots-QR am Notebook** in der Wallet
   eingeben und **„Ausgabecode prüfen & Wallet verbinden“** wählen. Die Wallet
   zeigt den erwarteten Code nicht selbst an. Bei einer falschen Eingabe
   erscheint direkt am Formular ein Fehler; nach fünf falschen Codes ist ein
   neues Angebot nötig. Der Code ist kein Wallet-Passwort. Zusätzlich weist
   die Wallet kryptografisch den Besitz ihres eigenen Schlüssels nach.
4. **Notebook:** Angaben prüfen und ausdrücklich
   **„Mitarbeiterausweis jetzt signieren“** anklicken. Scannen allein signiert
   noch nichts.
5. **Handy:** Ausweis prüfen, annehmen und speichern. Er erscheint in der
   Ausweisablage; technische DID-Details sind nicht der erste Einstieg.
6. **Kiosk:** Gemeinsamen Empfangs-QR scannen. Auch bei gleichzeitigen Scans
   erhält jede Person ihre eigene einmalige Anfrage. Freizugebende Angaben
   und Hinweis zur Kiosk-Anzeige lesen, dann bewusst zustimmen.

Das Dashboard zeigt **„Issuer registriert“**, **„Issuer vertrauenswürdig“**
und **„Eingecheckt“** als getrennte Zustände. Einzelne Credentials benötigen
keine Freigabe durch den Empfang. Die Wallet zeigt gespeicherte, signierte
Ausweise, keine vermeintlich noch ausstehende Credential-Freigabe.

Das Dashboard zeigt außerdem den persönlichen Versuch samt Prüfschritten oder
Fehler. Der **Versuchscode** steht auch auf dem Handy: Er ordnet nur den
Check-in-Versuch am Kiosk zu und ist kein Geheimnis oder Ausgabecode.
Bei abgelehnten Versuchen wird der
angegebene Name ausdrücklich als ungeprüft markiert. Nicht freigegebene Angaben
bleiben verborgen. Wird einem Issuer nachträglich das Vertrauen entzogen, kann
der Empfang seine Ausweise beim nächsten Versuch ablehnen. Der Nachweis bleibt
unverändert in der Wallet; dies ist eine Verifier-Entscheidung über den Issuer,
keine nachträgliche Genehmigung oder Änderung des Credentials.

## Ausweisstatus und lokales Löschen

Die Ausweisablage prüft ungefähr alle fünf Sekunden die Signatur und eine
aktuelle, signierte Widerrufsliste der registrierten Ausweisstelle. Dabei wird
die ganze Liste geladen, **keine Ausweis-ID an den Issuer geschickt**.
**Aktiv** bedeutet gültig und laut aktueller Liste nicht widerrufen, nicht
automatisch „vom Empfang akzeptiert“: Issuer-Vertrauen bleibt eine getrennte
Prüfung. **Widerrufen** und **Abgelaufen** erlauben keinen Check-in.

Ohne erreichbare, authentifizierte und aktuelle Liste steht dort **Status nicht
prüfbar**, mit Grund und Zeitpunkt der letzten Prüfung. Auch dann ist kein
Check-in möglich; gespeicherte Ausweise und Rohdaten bleiben offline lesbar.
Ältere Ausweise ohne signierte Statusreferenz bitte neu ausstellen lassen.
Vor der Freigabe und nochmals vor dem Senden wird der Status frisch geprüft;
eine spätere Statusänderung öffnet niemals selbstständig eine Freigabe.
Auch der Empfang prüft den aktuellen Widerrufsstatus unabhängig.

**„Ausweis aus diesem Browser löschen“** entfernt nach einer Rückfrage nur
diesen lokalen Ausweis. Wallet-Schlüssel und andere Ausweise bleiben erhalten.
Das ist **kein Widerruf durch die Ausweisstelle** und löscht keine Kopie in
einem anderen Browser. Für einen Widerruf die Ausweisstelle ansprechen.

Alle Handy-Schritte im selben normalen Safari-/Chrome-Browser durchführen,
keine PWA-Installation nötig. Private Wallet-Schlüssel bleiben in diesem Browser.
Angebots-QR und -Link nicht weitergeben: Sie enthalten den vertraulichen
Angebotszugang. Das Angebot gilt zehn Minuten und bindet nur eine Wallet;
deren Abruf kann bis zum Ablauf wiederholt werden. Persönliche
Check-in-Anfragen gelten fünf Minuten. Nach Server-Neustart offene Vorgänge
neu beginnen; Details zu URLs und Verbindung stehen im [Issuer-Setup](ISSUER.md).
