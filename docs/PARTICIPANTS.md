# Hands-on für Teilnehmende

[Projekt](../README.md) · [Organisation einrichten](ISSUER.md) · [Kiosk einrichten](KIOSK.md)

Vorbereitung: Die Moderation stellt **eine zentrale HTTPS-Workshop-Adresse**
bereit. Alle verwenden dieselbe Adresse; du betreibst keinen eigenen Server.
Öffne dort am Notebook die Organisationseinrichtung und verwalte deine eigene
Organisation im Browser. Die Moderation gibt sie vor der ersten Ausstellung
frei. Der Organisationsname ist fest und wird im Ausweis signiert; er bezeichnet
nicht die Person, die die Organisation verwaltet. Nur erfundene Daten verwenden.
Der private Verwaltungszugang bleibt am Notebook und wird nicht weitergegeben.
Auf dem Smartphone ist **kein Admin-Token** nötig; dort nur die Angebots- und
Empfangs-QR-Codes scannen, niemals den Verwaltungslink.

## Wallet öffnen

Die Startseite `/` ist der **Check-In**. Über die einheitliche Navigation
wechselst du zwischen **Check-In**, **Aussteller** und **Wallet**.
**„Wallet öffnen“** auf der Startseite oder **„Wallet“** im Menü führt direkt
zu deinen Ausweisen. Es gibt keine zusätzliche Abfrage zur Wallet-Einrichtung.

Die Wallet gehört zum Smartphone-Browser unter der festen öffentlichen
**Workshop-Adresse**, nicht zum Issuer und nicht zum Notebook. Öffne sie vorab
oder direkt über den Angebots-QR. Die Vorbereitung läuft automatisch im
Hintergrund, ohne Einrichtungsdialog oder Bestätigung einer vorhandenen Wallet.
Jeder weitere Angebots- oder Empfangs-QR verwendet deren gespeicherten Schlüssel.

Links von der Gerätekamera und Scans in der Wallet verwenden unter derselben
Adresse und im selben Browserspeicher automatisch die vorhandene Wallet.
Lokale Alias-Adressen leiten zur konfigurierten Workshop-Adresse weiter,
einschließlich des geöffneten Angebots oder Check-ins. Private Fenster, andere
Browser und insbesondere installierte iOS-PWAs können getrennte Speicher haben.
Ohne Anmeldung werden Schlüssel nicht zwischen diesen Speichern übertragen.

Bei einem bestätigten Adresswechsel bleiben Organisationen, Freigaben und
Widerrufe auf dem Server erhalten. Alte Angebots-QRs sind dann ungültig; für
die neue Adresse müssen neue Angebote und Ausweise ausgestellt werden.
Am Notebook überträgt sich auch der Organisationszugang nicht automatisch auf
eine andere Domain. Die Moderation hilft bei der Wiederherstellung des Zugangs.
Keine Website-Daten oder Serverdaten vorschnell löschen.

## QR-Codes direkt in der Wallet scannen

**„QR-Code scannen“** ist sowohl vor der ersten Einrichtung als auch in der
Ausweisablage erreichbar. Die Kamera öffnet sich erst nach diesem Klick
innerhalb der Wallet/PWA, bevorzugt mit der Rückkamera. Halte den Angebots-QR am
Notebook oder den Empfangs-QR in die Vorschau. Die Wallet akzeptiert nur
Ausstellungs- und Empfangslinks derselben zentralen Workshop-Adresse.
Ein anderes QR-Ziel wird mit einem Fehler abgelehnt, niemals extern geöffnet.

Erlaube den Kamerazugriff in Safari/Chrome. Falls er abgelehnt wird oder keine
Kamera verfügbar ist, siehst du einen Hinweis und kannst **„Kamera erneut
versuchen“** oder **„Scannen abbrechen“** wählen. Über **„QR-Link öffnen“**
kannst du den bewusst kopierten Angebots- oder Empfangslink weiterhin einfügen,
auch vor der ersten Wallet-Einrichtung.

Der QR-Decoder läuft lokal und wird von der Workshop-Zentrale ausgeliefert:
keine Bilder, Videos oder QR-Inhalte an externe Dienste/CDNs. Nach einem
erfolgreichen Scan, beim Abbrechen, Verlassen oder Ausblenden der Seite werden
Kamera und Decoder beendet. Nach der Rückkehr startet die Kamera nicht selbst.
Ausstellung und Check-in brauchen weiterhin eine Verbindung zur Zentrale.

## Notebook → Handy → Kiosk

**„Wallet“ im Menü öffnet immer deine Ausweisablage**, auch wenn du vorher
eine Präsentationsanfrage geöffnet hattest. Dort ist kein Check-in-Schritt aktiv.
Eine Anfrage erscheint erst über den Empfangs-QR beziehungsweise dessen bewusst
geöffneten oder eingefügten QR-Link, nicht durch den Wallet-Navigationslink.
Der Anfrage-Link wird nach dem Laden aus der Adresszeile entfernt. Auch
Neuladen öffnet daher wieder die Ausweisablage; für einen neuen Versuch den
Empfangs-QR erneut scannen.

1. **Notebook:** In deiner freigegebenen Organisation Vor-/Nachname und Rolle
   auswählen: **Mitarbeitende**, **Teamleitung** oder **Gast**. Die signierte
   Organisation ist fest vorgegeben. Ein QR-Angebot erstellen.
2. **Handy:** In der Wallet **„QR-Code scannen“** wählen und den Angebots-QR
   scannen. Alles bleibt unter der festen **zentralen HTTPS-Adresse**.
   Die Wallet wird direkt verwendet und bei Bedarf automatisch vorbereitet.
   Das geöffnete Angebot bleibt dabei erhalten.
3. **Handy:** Den sechsstelligen **Ausgabecode direkt unter dem Angebots-QR am Notebook** in der Wallet
   eingeben und **„Ausgabecode prüfen & Ausweis empfangen“** wählen. Die Wallet
   zeigt den erwarteten Code nicht selbst an. Bei einer falschen Eingabe
   erscheint direkt am Formular ein Fehler; nach fünf falschen Codes ist ein
   neues Angebot nötig. Der Code ist kein Wallet-Passwort. Zusätzlich weist
   die Wallet kryptografisch den Besitz ihres eigenen Schlüssels nach.
4. **Handy:** Auf dem Handy bleiben. Nach dem richtigen Code und dem
   Schlüsselbeweis signiert die Organisation **automatisch**; am Notebook
   ist kein weiterer Signier-Klick nötig. Scannen allein genügt nicht.
   Den erhaltenen Ausweis prüfen und **„Ausweis in Wallet speichern“** wählen.
   Er erscheint in der Ausweisablage; technische DID-Details sind nicht der erste Einstieg.
5. **Kiosk:** In der Wallet den gemeinsamen Empfangs-QR scannen. Auch bei gleichzeitigen Scans
   erhält jede Person ihre eigene einmalige Anfrage. Bei mehreren passenden
   Ausweisen zuerst die gewünschte Organisation beziehungsweise den Ausweis
   auswählen. Es wird nicht automatisch der neueste verwendet.
6. **Datenfreigabe:** Vor-/Nachname sind für die Anwesenheitskontrolle
   erforderlich. Die Vorschau zeigt **„Beim Check-In geteilt“** und **„Nicht als
   Attribut geteilt“**. Die Rolle bleibt freiwillig; die ausstellende
   Organisation ist über ihre Signatur ohnehin erkennbar.
7. **Bestätigen:** **„Freigeben & einchecken“** öffnet die abbrechbare
   **Demo-Biometrie**. Diese simuliert nur eine Gerätebestätigung, erfasst
   keine Biometrie und schützt den Schlüssel nicht zusätzlich. Erst nach
   **„Demo-Biometrie bestätigen“** signiert und sendet die Wallet.
8. **Prüfung verfolgen:** Der Ladebalken zeigt die tatsächlich vom Empfang
   abgeschlossenen acht Prüfungen. Bei Erfolg erscheint die Bestätigung,
   bei Ablehnung der konkrete Prüfgrund. Keine künstlich verzögerten
   Erfolgsmeldungen; schnelle Prüfungen können entsprechend schnell enden.

Die Einrichtung und Freigabe der Organisation sowie der persönliche Check-in
sind getrennte Schritte. Einzelne Ausweise benötigen keine nachträgliche
Freigabe durch den Empfang. Die Wallet zeigt gespeicherte, signierte Ausweise,
keine vermeintlich noch ausstehende Credential-Freigabe.

Der Kiosk zeigt den persönlichen Versuch mit Ergebnis oder Fehler; die
ausführlichen Prüfschritte bleiben auf deinem Smartphone sichtbar.
Der **Versuchscode** steht auch auf dem Handy: Er ordnet nur den
Check-in-Versuch am Kiosk zu und ist kein Geheimnis oder Ausgabecode.
Bei abgelehnten Versuchen wird der
angegebene Name ausdrücklich als ungeprüft markiert. Nicht freigegebene Angaben
bleiben verborgen. Wird einem Issuer nachträglich das Vertrauen entzogen, kann
der Empfang seine Ausweise beim nächsten Versuch ablehnen. Der Nachweis bleibt
unverändert in der Wallet; dies ist eine Verifier-Entscheidung über den Issuer,
keine nachträgliche Genehmigung oder Änderung des Credentials.

## Ausweisstatus und lokales Löschen

Die Ausweisablage prüft ungefähr alle fünf Sekunden die Signatur und eine
aktuelle, signierte Widerrufsliste der registrierten Organisation. Jede
Organisation hat einen eigenen DID-Schlüssel und eine eigene Statusliste unter
derselben Workshop-Adresse. Dabei wird die ganze Liste geladen,
**keine Ausweis-ID zur Statusprüfung geschickt**.
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

Alle Handy-Schritte im selben Safari-/Chrome-Browser oder derselben
installierten PWA durchführen; eine Installation ist nicht nötig.
Private Wallet-Schlüssel bleiben in diesem Speicher.
Angebots-QR und -Link nicht weitergeben: Sie enthalten den vertraulichen
Angebotszugang. Das Angebot gilt zehn Minuten und bindet nur eine Wallet;
deren Abruf kann bis zum Ablauf wiederholt werden. Persönliche
Check-in-Anfragen gelten fünf Minuten. Bei abgelaufenen Vorgängen einen neuen
QR öffnen; Details stehen unter
[Organisation einrichten](ISSUER.md).
