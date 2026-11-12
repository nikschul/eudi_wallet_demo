# Eigener Issuer

[Projekt und Installation](../README.md) · [Kiosk](KIOSK.md) ·
[Hands-on](PARTICIPANTS.md)

Docker und cloudflared wie im README unter Linux/WSL einrichten. Du betreibst
deine Ausweisstelle auf deinem Notebook; die Smartphone-Wallet liegt weiterhin
bei der Zentrale. **Nur erfundene Daten verwenden. Der private Freischalt-Link
bleibt auf deinem Notebook, nicht auf dem Smartphone oder am Kiosk.**

**Einfachster lokaler Start (Variante C):** Die Anleitung
[Lokale Tunnel starten und verwalten](TUNNELS.md) erklärt den gemeinsamen
Starter. Mit der öffentlichen HTTPS-Adresse der bereits gestarteten Zentrale:

```bash
bash scripts/demo.sh issuer --workshop-url https://DEINE-ZENTRALE
```

Der Starter ermittelt die eigene Quick-Tunnel-Adresse automatisch. Vorhandene
Env-Dateien und Volumes bleiben erhalten. Die folgenden Schritte sind der
manuelle Fallback.

## 1. Zentrale eintragen und starten

In der mitgelieferten `.env.issuer` die Demo-Adresse bei `WORKSHOP_URL` durch
die tatsächliche **öffentliche HTTPS-Adresse der Moderation** ersetzen.
Kein Unterpfad; exakt der Origin, den der Smartphone-Browser verwendet.
`APP_ROLE=issuer`, `PORT=3001` und anfangs `PUBLIC_URL=http://localhost:3001`
beibehalten. Eigene Issuer- und zentrale Adresse müssen verschieden sein.

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml up --build --wait
curl --fail http://localhost:3001/api/health
```

Host-Port 3001 ist nur lokal gebunden; im Container bleibt Port 3000.

## 2. Eigenen Tunnel öffnen

In einem zweiten Bash-Terminal derselben Linux-/WSL-Umgebung:

```bash
export PATH="$HOME/.local/bin:$PATH"
cloudflared tunnel --url http://localhost:3001
```

Die ausgegebene eigene HTTPS-Adresse als `PUBLIC_URL` in `.env.issuer`
eintragen. `WORKSHOP_URL` bleibt die Adresse der **Zentrale**. Danach:

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml up --wait app
```

Denselben Tunnel während der Runde laufen lassen. Das Smartphone muss beide
öffentlichen URLs erreichen können. Bei CORS-Fehlern den tatsächlichen
Wallet-Origin mit `WORKSHOP_URL` vergleichen; kein `localhost` auf dem Handy.

## 3. Identität registrieren

Den privaten lokalen Freischalt-Link aus dem **neuesten Startblock** öffnen:

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml logs --tail 20 app
```

Der Server erzeugt automatisch einen eigenen Admin-Token, ohne Env-Einrichtung.
Der Link öffnet das Dashboard auf deinem Notebook und schaltet es frei.
Alternativ unter <http://localhost:3001/issuer.html> den Token aus denselben Logs
eingeben. Beim Neuladen bleibt die Freischaltung in diesem Tab erhalten;
„Verwaltung sperren“ entfernt sie. Nach jedem Serverneustart den neuen Link
verwenden. Der Token deiner Ausweisstelle ist **nicht** der Token der Zentrale
und muss nicht an die Moderation übergeben werden.

1. Namen der Ausweisstelle und deinen Demo-Namen als ausstellende Person
   eingeben; **„Issuer-Identität anlegen“** anklicken.
2. **„Bei der Zentrale registrieren“** anklicken. Eine signierte
   Nonce-Challenge beweist den Besitz deines Schlüssels.
3. Der Moderation den sichtbaren Fingerprint zeigen. Sie vergleicht ihn,
   ordnet die Person zu und kennzeichnet **den Issuer** als vertrauenswürdig.
   Das Dashboard zeigt den **aktuellen** Status: nicht registriert,
   registriert und auf Vertrauen wartend, registriert und vertrauenswürdig
   oder Vertrauen entzogen. Es prüft etwa alle fünf Sekunden automatisch;
   **„Verbindung & Vertrauen aktualisieren“** prüft zusätzlich manuell.
   Auch späteres Erteilen oder Entziehen des Vertrauens durch die Moderation
   erscheint automatisch. Bei Verbindungsfehlern ist der Status ausdrücklich
   ungeprüft; neue Angebote sind dann gesperrt.
4. Erst bei abgeschlossenem Setup erscheint
   **„QR-Angebot erstellen – noch nicht signieren“**. Ohne registrierten und
   vertrauenswürdigen Issuer lehnt auch die API die Angebotserstellung ab.
   Vor der Signatur wird das aktuelle Vertrauen erneut geprüft.
   Eingegebene Ausweisdaten bleiben bei automatischen Prüfungen und
   Vertrauensänderungen erhalten. Ein bereits angezeigtes QR-Angebot bleibt
   sichtbar; Vertrauensentzug wird nicht mit Angebotsabbruch verwechselt.
   Beim Zurückkehren in den Tab oder über die Browser-Zurück-Funktion werden
   die Prüfungen wieder aufgenommen. „Verwaltung sperren“ beendet sie und
   entfernt die angezeigten Verwaltungsdaten.

Das ist eine Vertrauensentscheidung des Empfangs über den **Aussteller**,
keine Freigabe einzelner Credentials. Danach stellst du selbstständig aus.
Der sechsstellige **Ausgabecode** steht direkt unter dem Angebots-QR auf
dem Notebook und wird in der Smartphone-Wallet eingegeben. Nach erfolgreicher
Verbindung ersetzt ein Hinweis „Ausgabecode bereits geprüft“ die Zahl.
Fehlt bei einem offenen Angebot der Code in der Serverantwort, zeigt die
Verwaltung einen Fehler statt eines leeren Codefelds. In diesem Fall
Issuer-Image mit `--build` aktualisieren, die Seite neu laden und ein neues
Angebot erstellen. Es gibt keinen zweiten, am Notebook
abzutippenden Vergleichscode. Fünf falsche Eingaben beenden das Angebot;
dann ein neues erstellen. Für die bewusste Signatur weiter mit dem
[Hands-on](PARTICIPANTS.md).

## Ausgestellte Ausweise verwalten und widerrufen

Unter **„Ausweise verwalten & endgültig widerrufen“** findest du die dauerhaft
auf deinem Issuer-Server gespeicherten Ausgaben, auch nach einem Neustart.
Die geschützte Liste aktualisiert sich etwa alle fünf Sekunden, ohne offene
Details, Eingaben oder die laufende QR-Übergabe zu schließen. Suche, Statusfilter
und Seiten mit jeweils 20 Ausweisen helfen bei vielen Einträgen. Ladefehler
werden angezeigt – sie bedeuten nicht, dass die Liste leer ist.

**Ausweise aus älteren Demo-Versionen neu ausstellen:** Vor Einführung der
dauerhaften Ausgabeliste wurden Ausgaben nicht dauerhaft erfasst. Solche
Alt-Ausweise erscheinen deshalb nicht nachträglich in dieser Liste und
besitzen keinen unterstützten Widerrufsstatus. Sie müssen neu ausgestellt
werden; es gibt keine automatische Übernahme aus den Wallet-Kopien.

Öffne einen Eintrag und prüfe Name, Organisation, Rolle, Ausweis-ID sowie
**Ausstellungs-, Ablauf- und gegebenenfalls Widerrufszeitpunkt**. Wallet-DID,
Issuer-DID und Statusindex sind in den technischen Details sichtbar.
**„Diesen Ausweis endgültig widerrufen“** öffnet eine zusätzliche Bestätigung
für genau diesen Ausweis. Erst nach Bestätigungs-Häkchen und
**„Ja, endgültig widerrufen“** wird der Widerruf gespeichert. Auch ein
abgelaufener Ausweis kann widerrufen werden.

**Ein Widerruf ist unwiderruflich.** Es gibt kein „Entsperren“ oder
Rückgängigmachen; bei Bedarf einen neuen Ausweis ausstellen. Die Wallet-Kopie
wird nicht fern-gelöscht, der Ausweis wird aber bei einer aktuellen
Widerrufsprüfung abgelehnt. Die Prüfstelle liest dafür eine signierte,
indexierte Bit-Statusliste (EUDI-inspiriert), keine öffentliche Einzelabfrage
mit der Identität des Ausweisinhabers. Die Verwaltungsliste mit Demo-Personendaten
ist nur mit deinem Admin-Token zugänglich.

Diese drei Vorgänge sind verschieden:

- **In der Wallet löschen:** entfernt nur die lokale Kopie, kein Widerruf.
- **Einzelnen Ausweis widerrufen:** macht genau diesen Ausweis dauerhaft ungültig.
- **Issuer-Vertrauen entziehen:** ändert die aktuelle Vertrauensentscheidung
  der Zentrale für den Aussteller; kein Widerruf einzelner Ausweise. Erneutes
  Vertrauen hebt einen bestehenden Ausweiswiderruf nicht auf.

## Beenden und erneut starten

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml down
```

Tunnel mit Strg+C beenden. Das eigene Volume erhält Schlüssel und Issuer-DID;
die Liste ausgestellter Ausweise und ihre Widerrufe bleiben ebenfalls erhalten.
Offene Angebote gehen beim Neustart verloren. Bei neuer Tunnel-Adresse
`PUBLIC_URL` ändern, App neu erstellen und erneut registrieren. Auch nach
Namensänderungen erneut registrieren.

**Bei einem Wechsel der öffentlichen Issuer-Domain die Ausweise neu
ausstellen:** Die signierte Statuslisten-Adresse eines Ausweises ist fest an
den damaligen Issuer-Origin gebunden. Eine neue Tunnel-Domain oder ein anderer
Origin lässt sich nicht nachträglich in bereits signierten Ausweisen ändern.
Erneute Registrierung allein migriert diese Ausweise nicht.

`down -v` löscht die Issuer-Identität sowie die dauerhafte Ausgabeliste mit
ihren Widerrufen; diese Daten nicht für noch verwendete Ausweise entfernen.
Eine neue DID braucht eine neue Vertrauensentscheidung im Setup und neu
ausgestellte Ausweise.
