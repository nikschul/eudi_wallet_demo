# Eigener Issuer

[Projekt und Installation](../README.md) · [Kiosk](KIOSK.md) ·
[Hands-on](PARTICIPANTS.md)

Docker und cloudflared wie im README unter Linux/WSL einrichten. Du betreibst
deine Ausweisstelle auf deinem Notebook; die Smartphone-Wallet liegt weiterhin
bei der Zentrale. **Nur erfundene Daten verwenden. Der private Freischalt-Link
bleibt auf deinem Notebook, nicht auf dem Smartphone oder am Kiosk.**

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
   ordnet die Person zu und gibt den Issuer zentral frei.
   **„Verbindung & Vertrauen aktualisieren“** lädt den aktuellen Status.

Nach Registrierung kannst du bereits
**„QR-Angebot erstellen – noch nicht signieren“** anklicken, auch wenn die
Freigabe noch aussteht. Für die Kopplung und die bewusste Signatur weiter mit
dem [Hands-on](PARTICIPANTS.md).

## Beenden und erneut starten

```bash
docker compose -p eudi-issuer --env-file .env.issuer -f compose.issuer.yaml down
```

Tunnel mit Strg+C beenden. Das eigene Volume erhält Schlüssel und Issuer-DID;
offene Angebote gehen beim Neustart verloren. Bei neuer Tunnel-Adresse
`PUBLIC_URL` ändern, App neu erstellen und erneut registrieren. Auch nach
Namensänderungen erneut registrieren. `down -v` löscht die Issuer-Identität;
eine neue DID muss erneut freigegeben werden.
