# Organisation und Mitarbeiterausweise

[Projekt und Host-Betrieb](../README.md) · [Kiosk](KIOSK.md) ·
[Hands-on](PARTICIPANTS.md)

Du brauchst einen Laptop-Browser und ein Smartphone. **Nichts installieren oder
starten:** Alle Organisationen, Wallet-Seiten und der Kiosk laufen unter
derselben zentralen Workshop-Adresse. Nur die Moderation betreibt die zentrale
App mit einem nativen Cloudflare-Tunnel im Terminal, nicht mit einem
Tunnel-Container. Host-Start und Konfiguration stehen im [README](../README.md).
Das frühere Zwei-Server-Setup wird vollständig ersetzt; alte Issuer-Daten werden
nicht migriert. **Nur erfundene Daten verwenden.**

## 1. Organisation am Laptop anlegen

Öffne die zentrale Adresse mit `/issuer.html` **im Laptop-Browser**.
Die Moderation zeigt die Einrichtungsadresse und den zugehörigen QR am Kiosk.
Der Einrichtungs-QR öffnet diese Organisationsseite, nicht ein Ausweisangebot.

Wird die Seite direkt über `localhost` oder eine andere Adresse als die
konfigurierte öffentliche Workshop-Adresse geöffnet, zeigt sie zuerst
**„Organisation unter der Workshop-Adresse öffnen“**. Folge dem angezeigten
Link; unter der abweichenden Adresse werden weder eine Organisationssitzung
geladen noch eine Organisation angelegt oder ein Wiederherstellungslink
eingelöst. Das Organisations-Cookie gehört zur öffentlichen Adresse, nicht zu
ihren lokalen Aliasen. Bestehende Zugänge werden nicht zwischen Adressen
übertragen. Ein privates Wiederherstellungsfragment wird sofort aus der
Adresszeile entfernt und nur im Fragment des Links zur richtigen Adresse
weitergegeben, nicht als URL-Abfrage oder API-Anfrage an die falsche Adresse.
Bei verlorenem Zugang hilft die Moderation. Für rein lokale Entwicklung bleibt
eine übereinstimmende konfigurierte Loopback-Adresse nutzbar.

Gib nur den **Organisationsnamen** ein und wähle **„Organisation anlegen“**.
Der Name ist danach **unveränderlich** und wird vom Server fest in jeden
Mitarbeiterausweis eingesetzt. Es gibt keine Identität oder Namensabfrage einer
ausstellenden Person. Jeder neue Laptop-Browser kann eine eigene Organisation
anlegen; ein vorhandener Organisationszugang wird nicht überschrieben.

Der Zugang gehört diesem Browser. Ein geschütztes **HttpOnly-Cookie** merkt ihn
sich bis zu 30 Tage lang, auch nach dem Schließen des Tabs. Verwende denselben Browser ohne
privaten Modus und lösche seine Website-Daten nicht. Die Organisationsverwaltung
ist nicht die persönliche Wallet; die Wallet samt privatem Schlüssel bleibt auf
dem Smartphone.

## 2. Freigabe abwarten

Die Organisation erscheint automatisch bei der Moderation. Du musst nichts bei
einer zweiten Zentrale registrieren und keinen DID-Fingerabdruck übertragen.
Die Moderation kann technische Organisationsdaten bei Bedarf selbst prüfen.
Nur der Host hat den privaten Verwaltungszugang; Teilnehmende benötigen ihn nie.

Die Seite prüft den Status etwa alle fünf Sekunden:

- **Wartet auf Freigabe:** Die Moderation muss die Organisation einmalig freigeben.
- **Freigegeben:** Neue Mitarbeiterausweise dürfen ausgestellt werden.
- **Gesperrt:** Keine neuen Ausgaben; die bestehende Ausweisliste und der
  endgültige Widerruf bleiben zugänglich.

**„Organisationsstatus aktualisieren“** prüft zusätzlich manuell. Bei einem
Verbindungsfehler ist der Status ausdrücklich ungeprüft und die Angebotserstellung
gesperrt. Eingegebene Namen, die Rolle, ein offener Angebots-QR und offene
Ausweisdetails bleiben bei automatischen Prüfungen und Statuswechseln erhalten.
Beim Zurückkehren in den Tab werden pausierte Prüfungen wieder aufgenommen.
Auch vor einer automatischen Signatur prüft der Server die aktuelle Freigabe.

## 3. Ausweis anbieten und auf dem Smartphone speichern

1. In der freigegebenen Organisation **Vorname** und **Nachname** der empfangenden
   Person eingeben. Die Organisation steht fest und ist kein editierbares Feld.
2. Genau eine Rolle auswählen: **Mitarbeitende**, **Teamleitung** oder **Gast**.
3. **„QR-Angebot erstellen“** wählen. Das Angebot ist zehn Minuten gültig.
   Auf dem Laptop erscheinen der Angebots-QR und ein **sechsstelliger Ausgabecode**.
   Der Code steht nur dort, nicht im QR oder Angebotslink.
4. Auf dem Smartphone das Angebot mit **„QR-Code scannen“ in der Wallet** öffnen.
   Das funktioniert auch direkt in der installierten Wallet (PWA); für die Kamera
   muss die PWA nicht verlassen werden. Alternativ die Smartphone-Kamera nutzen
   oder den Angebotslink auf dem Smartphone öffnen.
5. Falls noch keine Wallet vorhanden ist, diese dort **einmalig** einrichten und
   mit dem Angebot fortfahren. Danach dieselbe Wallet unter derselben zentralen
   Adresse und im selben Smartphone-Browser weiterverwenden.
6. Den am Laptop angezeigten **Ausgabecode auf dem Smartphone** eingeben.
   Die Wallet beweist zusätzlich den Besitz ihres eigenen Schlüssels.
   Nach richtigem Code und Schlüsselbeweis **signiert der Server automatisch**.
   Es gibt **keinen zusätzlichen Signieren- oder Freigabe-Knopf am Laptop**.
7. Auf dem Smartphone den Ausweis **in der Wallet speichern**. Der Laptop zeigt
   automatisch **Angeboten → Automatisch signiert → Gespeichert**.
   Sobald Code und Schlüsselbeweis geprüft sind, verschwindet die Zahl und wird
   durch eine klare Bestätigung ersetzt. Eine kurz sichtbare automatische
   Signaturphase benötigt keinen Eingriff.
8. Erst nach abgeschlossener Übergabe ausdrücklich
   **„Weiteren Mitarbeiterausweis vorbereiten“** wählen. Erst dann werden die
   Formularfelder für die nächste Person zurückgesetzt. Es wird nicht automatisch
   ein weiteres Angebot erzeugt.

Nach fünf falschen Codeeingaben ist ein neues Angebot nötig. Abgelaufene,
abgebrochene oder nicht mehr vorhandene Angebote werden ausdrücklich angezeigt;
dann bewusst ein neues vorbereiten. Fehlt bei einem offenen Angebot der gültige
Code in der Serverantwort, zeigt die Seite einen Fehler statt eines leeren
Codefelds. Bei Verbindungsproblemen die Moderation fragen und dasselbe Angebot
mit derselben Wallet erneut öffnen, statt unbemerkt einen zweiten Ausweis
auszustellen. QR, Angebotslink und Code nicht öffentlich teilen.

Der Ausweis gilt einen Tag. Er bindet die Organisation und die empfangende
Wallet; eine ausstellende Person wird weder als Claim erfasst noch zugeordnet.
Die Freigabe der Organisation ist keine Freigabe einzelner Credentials.

## Ausweise verwalten und endgültig widerrufen

Unter **„Ausweise verwalten & endgültig widerrufen“** findest du die dauerhaft
zentral gespeicherten Ausgaben **deiner Organisation**, auch nach einem Neustart
oder bei gesperrter Organisation. Die geschützte Liste aktualisiert sich etwa
alle fünf Sekunden. Suche, Statusfilter und Seiten mit jeweils 20 Einträgen
helfen bei vielen Ausweisen. Ladefehler bedeuten nicht, dass die Liste leer ist.

Öffne einen Eintrag und prüfe Name, Organisation, Rolle, Ausweis-ID sowie
Ausstellungs-, Ablauf- und gegebenenfalls Widerrufszeitpunkt. Wallet-DID,
Issuer-DID und Statusindex stehen in den technischen Details.
**„Diesen Ausweis endgültig widerrufen“** öffnet die Bestätigung für genau
diesen Ausweis. Erst das Bestätigungs-Häkchen und **„Ja, endgültig widerrufen“**
speichern den Widerruf. Auch ein abgelaufener Ausweis kann widerrufen werden.

**Ein Widerruf ist unwiderruflich.** Es gibt kein Entsperren; für einen Ersatz
ist ein neuer Ausweis nötig. Diese Vorgänge sind verschieden:

- **In der Wallet löschen:** entfernt nur die lokale Kopie, kein Widerruf.
- **Einzelnen Ausweis widerrufen:** macht genau diesen Ausweis dauerhaft ungültig.
  Die Wallet-Kopie wird nicht fern-gelöscht, aber bei aktueller Statusprüfung
  abgelehnt.
- **Organisation sperren:** ändert die aktuelle Freigabe und verhindert neue
  Ausgaben. Es widerruft nicht automatisch einzelne Ausweise. Erneute Freigabe
  hebt bestehende Widerrufe nicht auf.

Die Prüfstelle verwendet eine signierte, indexierte Bit-Statusliste, keine
öffentliche Einzelabfrage mit der Identität der Person. Die Verwaltungsliste ist
nur mit dem Organisations-Cookie in diesem Browser zugänglich.

## Browser-Zugang verloren?

Bei gelöschten Cookies, Browserwechsel oder verlorenem Laptop **die Moderation
fragen**, statt eine Ersatzorganisation mit demselben Namen anzulegen.
Nur der Host kann einen privaten Wiederherstellungslink für die bestehende
Organisation erzeugen. Öffne diesen Link im gewünschten Laptop-Browser.
Der Link ist einmalig verwendbar und zehn Minuten gültig. Eine erfolgreiche
Wiederherstellung ersetzt den bisherigen Organisationszugang; zuvor berechtigte
Browser verlieren dadurch ihren Zugriff.

Der Link enthält vorübergehend `#org-access=…`. Die Seite entfernt dieses
Fragment sofort aus der Adresszeile, tauscht es serverseitig gegen ein neues
geschütztes Cookie und lädt die Organisation. Das Geheimnis wird nicht in
JavaScript-Browserspeicher geschrieben; es gibt kein manuelles Token-Eingabefeld.
Bei ungültigem oder nicht mehr verwendbarem Link erscheint ein ausdrücklicher
Fehler. Dann einen neuen Link beim Host anfordern. Den privaten Link nicht am
Kiosk zeigen und nicht weitergeben.

## Wenn sich die öffentliche Workshop-Adresse ändert

Bei einem neuen Tunnel-Hostnamen bleibt die bestehende Organisation auf dem
zentralen Server erhalten: Schlüssel, Freigabe, Ausweishistorie und Widerrufe
werden nicht zurückgesetzt. Es ist kein Löschen der Serverdaten nötig.
Das Browser-Cookie wird jedoch nicht auf die neue Domain übertragen.
Die Moderation muss einen privaten Wiederherstellungslink **unter der neuen
Workshop-Adresse** erzeugen. Damit die vorhandene Organisation öffnen, statt
sie erneut anzulegen.

Offene Angebote unter der alten Adresse sind danach abgelaufen. An der neuen
Adresse bewusst neue Angebote erstellen. Bereits unter der alten Adresse
ausgestellte Ausweise müssen für die neue Workshop-Adresse **neu ausgestellt**
werden: Ihre bisherigen Statusverweise gelten nicht für die neue Adresse.
Die Ausweishistorie und gespeicherte Widerrufe bleiben dennoch erhalten.
Auch die private Smartphone-Wallet und ihre Schlüssel werden nicht automatisch
zwischen Adressen übertragen; bei einer vorhandenen Wallet die Moderation
einbeziehen.
