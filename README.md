# EUDI Wallet Workshop

Deutschsprachige Lernsimulation mit **getrennter Workshop-Zentrale und eigenen
Ausweisstellen**: Die Moderation betreibt Wallet-Webapp, Kiosk und Administration
auf ihrem Notebook. Jede teilnehmende Person betreibt einen Docker-Issuer auf
ihrem eigenen Rechner; ihre Smartphone-Wallet bleibt unter der zentralen URL.

- **[Administration/Moderation](docs/ADMIN.md)** – Zentrale starten, öffentliche
  cloudflared-Adresse verteilen, Personen und Issuer freigeben, Workshop moderieren.
- **[Teilnehmende/Mitarbeitende](docs/PARTICIPANTS.md)** – eigenen Issuer starten,
  Smartphone koppeln, Mitarbeiterausweis ausstellen und am Empfang einchecken.

Voraussetzungen: Linux oder WSL2 mit Bash, Docker mit Compose v2 und
`--wait`-Unterstützung, Internet und cloudflared. Auf dem Host ist kein Node.js
nötig. Nur Demo-Namen verwenden:
Die Tunnel machen die Demo öffentlich erreichbar.

**Keine offizielle EUDI Wallet, EU-Vertrauensliste oder Produktions-PKI.**
Echte Signaturen und vereinfachte Protokolle erklären, warum eine Signatur
allein noch kein Vertrauen in eine Person begründet. Es gibt keine Benutzerkonten.

[Entwicklungsprüfungen, Grenzen und noch offene Abnahme](NOTES.md)
