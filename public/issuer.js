import { el, api, explain, raw, attributes, action, formAction, run, showError, clearError } from './lib/ui.js';
import { sha256b64 } from './lib/sdjwt.js';

const root = document.getElementById('app');
const tokenKey = 'issuerAdminToken';
let token = '';
let config;
let pollTimer;
let pollGeneration = 0;
let activeOffer;

const adminApi = (route, options = {}) => api(`/issuer${route}`, { ...options, token });

function field(name, label, { value = '', required = true, type = 'text', ...options } = {}) {
  return el('label', { class: 'field' }, label,
    el('input', { name, type, value, required, maxlength: 120, autocomplete: 'off', ...options }));
}

function stopPolling() {
  clearTimeout(pollTimer);
  pollGeneration += 1;
}

function clearToken() {
  token = '';
  sessionStorage.removeItem(tokenKey);
  activeOffer = null;
  stopPolling();
}

function showLogin() {
  stopPolling();
  const form = formAction(el('form', { class: 'stack' },
    field('token', 'Admin-Token', { type: 'password', maxlength: 256 }),
    el('button', { type: 'submit' }, 'Verwaltung entsperren')), async (data) => {
    token = String(data.get('token')).trim();
    try {
      const status = await adminApi('/status');
      sessionStorage.setItem(tokenKey, token);
      await dashboard(status);
    } catch (error) {
      token = '';
      throw error;
    }
  });
  root.replaceChildren(el('section', { class: 'card login-card' },
    el('span', { class: 'step-number' }, '01'), el('h2', {}, 'Verwaltung entsperren'),
    el('p', {}, 'Nutze das Admin-Token dieses Issuer-Servers, nicht das Token der Workshop-Zentrale. Du findest es beim Serverstart.'),
    form, el('p', { class: 'muted' }, 'Das Token bleibt nur für diesen Browser-Tab im Sitzungsspeicher. Es ist kein Wallet-Schlüssel und gehört nicht in den QR-Code.')));
}

function connectionCard(status) {
  return el('section', { class: 'card connection-card' },
    el('h2', {}, 'Getrennte Systeme, klarer Weg'),
    el('ol', { class: 'workflow' },
      el('li', {}, 'Desktop: Identität und Verbindung zur Zentrale einrichten.'),
      el('li', {}, 'Smartphone: QR-Code mit der Workshop-Wallet öffnen und verbinden.'),
      el('li', {}, 'Desktop: Angaben und Vergleichscode prüfen, dann ausdrücklich signieren.')),
    el('dl', { class: 'attributes' },
      el('dt', {}, 'Diese Ausweisstelle'), el('dd', { class: 'break-anywhere' }, config.publicUrl),
      el('dt', {}, 'Workshop-Zentrale'), el('dd', {}, el('a', {
        href: config.workshopUrl, target: '_blank', rel: 'noopener noreferrer',
      }, config.workshopUrl))),
    el('p', {}, 'Beide Adressen müssen über HTTPS erreichbar sein (HTTP nur auf localhost). Das Smartphone muss sowohl die Zentrale als auch diese Ausweisstelle erreichen können. Ein localhost-Link auf dem Smartphone zeigt auf das Smartphone selbst.'),
    el('p', { class: 'muted' }, 'Der Server speichert seinen privaten Schlüssel geschützt in identity.json. Ein Neustart behält die Identität; offene QR-Angebote enden beim Neustart.'),
    status.did ? raw({ did: status.did }, 'Öffentliche Issuer-DID anzeigen') : null);
}

async function dashboard(status = null) {
  stopPolling();
  activeOffer = null;
  status ||= await adminApi('/status');
  const fingerprint = status.did ? (await sha256b64(status.did)).slice(0, 16) : null;
  const trustPanel = el('section', { class: 'card stack' });
  const offerPanel = el('section', { class: 'card stack' });
  const transferPanel = el('section', { class: 'card stack transfer-panel', hidden: true });
  let canOffer = false;

  const identityForm = formAction(el('form', { class: 'stack' },
    field('name', 'Name der Ausweisstelle *', { value: status.name || 'Meine Ausweisstelle' }),
    field('employeeName', 'Dein Name als ausstellende Person *', { value: status.employeeName || '' }),
    el('p', { class: 'muted' }, 'Nach Namensänderungen musst du die Ausweisstelle erneut bei der Zentrale registrieren. Der Schlüssel bleibt derselbe.'),
    el('button', { type: 'submit' }, status.did ? 'Angaben speichern' : 'Issuer-Identität anlegen')),
  async (data) => {
    const updated = await adminApi('/setup', { body: {
      name: String(data.get('name')).trim(), employeeName: String(data.get('employeeName')).trim(),
    } });
    await dashboard(updated);
  });

  const signOut = action(el('button', { type: 'button', class: 'secondary' }, 'Verwaltung sperren'), () => {
    clearToken();
    clearError();
    showLogin();
  });
  root.replaceChildren(
    el('div', { class: 'dashboard-toolbar' },
      el('p', { class: 'muted' }, 'Admin-Zugriff aktiv · Schlüssel ausschließlich auf dem Server'), signOut),
    el('div', { class: 'dashboard-grid' },
      el('div', { class: 'stack' },
        el('section', { class: 'card stack' }, el('span', { class: 'eyebrow' }, '01 / Identität'),
          el('h2', {}, 'Wer stellt aus?'),
          fingerprint ? el('div', { class: 'issuer-fingerprint' },
            el('span', {}, 'Öffentlicher DID-Fingerabdruck'),
            el('code', {}, fingerprint),
            el('p', {}, 'Vergleiche diesen Fingerabdruck zusammen mit dem Namen mit der Anzeige am Empfang. Er wird hier direkt aus deiner öffentlichen Issuer-DID berechnet.')) : null,
          identityForm),
        connectionCard(status)),
      el('div', { class: 'stack' }, trustPanel, offerPanel)),
    transferPanel);

  function renderOfferForm() {
    if (!status.did || !canOffer) {
      offerPanel.replaceChildren(el('span', { class: 'eyebrow' }, '03 / Ausstellungsangebot'),
        el('h2', {}, 'Zuerst Identität registrieren'),
        el('p', {}, 'Ein Eintrag mit den aktuellen Namen und dieser Issuer-Adresse muss in der Zentrale vorhanden sein. Die Vertrauensfreigabe darf noch ausstehen.'));
      return;
    }
    const form = formAction(el('form', { class: 'stack' },
      el('div', { class: 'form-grid' },
        field('given_name', 'Vorname *'), field('family_name', 'Nachname *')),
      field('organisation', 'Organisation *'),
      field('role', 'Rolle *', { value: 'Mitarbeitende' }),
      el('p', { class: 'muted' }, 'Alle Felder höchstens 120 Zeichen. Der signierte Ausweis gilt einen Tag; das QR-Angebot zehn Minuten.'),
      el('button', { type: 'submit' }, 'QR-Angebot erstellen – noch nicht signieren')),
    async (data) => {
      const claims = Object.fromEntries([...data.entries()].map(([key, value]) => [key, String(value).trim()]));
      const offer = await adminApi('/offers', { body: { claims } });
      activeOffer = offer;
      identityForm.querySelector('button').disabled = true;
      register.disabled = true;
      form.querySelector('button').disabled = true;
      offerPanel.hidden = true;
      transferPanel.hidden = false;
      renderTransfer(offer);
      schedulePoll();
      transferPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
    offerPanel.hidden = false;
    offerPanel.replaceChildren(el('span', { class: 'eyebrow' }, '03 / Ausstellungsangebot'),
      el('h2', {}, 'Welche Angaben werden bestätigt?'), form);
  }

  async function refreshTrust() {
    try {
      const record = await adminApi('/trust');
      canOffer = typeof record.did === 'string' && record.status !== 'unregistered';
      const trusted = record.trusted === true;
      trustStatus.textContent = !canOffer ? 'Noch nicht mit den aktuellen Angaben registriert.'
        : trusted ? `Von der Zentrale als vertrauenswürdig freigegeben${record.ownerName ? ` · ${record.ownerName}` : ''}.`
          : 'Registriert · wartet auf Vertrauensfreigabe durch den Empfang.';
      trustStatus.className = `message ${trusted ? 'notice' : 'warning'}`;
      connectionStatus.textContent = 'Verbindung zur Workshop-Zentrale: erreichbar (Vertrauensliste gelesen).';
      connectionStatus.className = 'connection-ok';
      trustDetails.replaceChildren(raw(record, 'Öffentlichen Registereintrag anzeigen'));
    } catch (error) {
      canOffer = false;
      trustStatus.textContent = 'Der aktuelle Registerstatus konnte nicht geprüft werden.';
      trustStatus.className = 'message warning';
      connectionStatus.textContent = error.message;
      connectionStatus.className = 'connection-failed';
    }
    if (!activeOffer) renderOfferForm();
  }

  const trustStatus = el('p', { class: 'message warning', role: 'status' }, 'Vertrauensstatus wird geprüft …');
  const connectionStatus = el('p', { class: 'muted' }, 'Verbindung wird geprüft …');
  const trustDetails = el('div');
  const register = action(el('button', { type: 'button', disabled: !status.did }, 'Bei der Zentrale registrieren'), async () => {
    await adminApi('/register', { body: {} });
    await refreshTrust();
  });
  const refresh = action(el('button', { type: 'button', class: 'secondary' }, 'Verbindung & Vertrauen aktualisieren'), refreshTrust);
  trustPanel.replaceChildren(el('span', { class: 'eyebrow' }, '02 / Registrierung & Vertrauen'),
    el('h2', {}, 'Kennt die Zentrale diese Ausweisstelle?'), trustStatus, connectionStatus,
    el('div', { class: 'actions' }, register, refresh),
    el('p', {}, 'Registrierung beweist den Besitz des Issuer-Schlüssels. Nur der Empfang kann Vertrauen freigeben. Dieses Dashboard kann die Freigabe weder setzen noch umgehen.'),
    el('p', {}, 'Signatur und Vertrauen sind unabhängig: Du kannst bereits signieren, während die Freigabe aussteht. Ein Check-in wird erst mit vertrauenswürdigem Issuer akzeptiert.'),
    trustDetails);
  await refreshTrust();

  function renderTransfer(offer) {
    const next = action(el('button', { type: 'button' }, 'Weiteren Mitarbeiterausweis vorbereiten'), async () => {
      stopPolling();
      activeOffer = null;
      identityForm.querySelector('button').disabled = false;
      register.disabled = false;
      transferPanel.hidden = true;
      await refreshTrust();
    });
    const qr = el('div', { class: 'qr-column' },
      el('img', { class: 'offer-qr', src: activeOffer.qrDataUrl, alt: 'QR-Code zum Verbinden der Smartphone-Wallet', width: 360, height: 360 }),
      el('p', { class: 'muted' }, 'Mit der Smartphone-Wallet scannen. Alternativ den Link auf dem Smartphone öffnen:'),
      el('a', { class: 'break-anywhere', href: activeOffer.url, target: '_blank', rel: 'noopener noreferrer' }, 'Wallet mit diesem Angebot öffnen'),
      el('p', { class: 'muted' }, `Gültig bis ${new Date(offer.expiresAt).toLocaleTimeString('de-DE')}. Link und QR enthalten einen vertraulichen Zugangscode.`));
    const details = el('div', { class: 'stack' },
      el('span', { class: 'eyebrow' }, '04 / Wallet verbinden & bewusst signieren'),
      el('h2', {}, 'Angebot prüfen'), attributes(offer.claims));
    if (offer.status === 'offered') {
      details.append(el('p', { class: 'message notice' }, 'Wartet auf eine Wallet. Nur Scannen oder Öffnen stellt noch keinen Ausweis aus.'),
        el('p', {}, 'Die Wallet muss den Besitz ihres eigenen Schlüssels nachweisen. Erst danach erscheint hier ein Vergleichscode.'));
    } else if (offer.status === 'bound') {
      const code = el('p', { class: 'pairing-code', 'aria-label': `Vergleichscode ${offer.pairingCode}` }, offer.pairingCode);
      const approve = formAction(el('form', { class: 'stack' },
        el('p', {}, 'Vergleiche diesen Code mit dem Code auf dem Smartphone. Prüfe, dass es die richtige Person und die richtige Wallet sind.'),
        code,
        field('pairingCode', 'Code vom Smartphone zur Bestätigung eingeben', {
          maxlength: 6, minlength: 6, pattern: '[0-9]{6}', inputmode: 'numeric',
        }),
        el('button', { type: 'submit' }, 'Mitarbeiterausweis jetzt signieren')),
      async (data) => {
        const updated = await adminApi(`/offers/${offer.id}/approve`, { body: {
          pairingCode: String(data.get('pairingCode')).trim(),
        } });
        activeOffer = { ...activeOffer, ...updated };
        renderTransfer(updated);
      });
      details.append(el('p', { class: 'message warning' }, 'Wallet verbunden · noch nicht signiert'), approve,
        raw({ holderDid: offer.holderDid }, 'Gebundene Wallet-DID anzeigen'));
    } else if (offer.status === 'issued') {
      details.append(el('p', { class: 'message notice' }, 'Signiert · die gebundene Wallet kann den Ausweis jetzt abholen.'),
        el('p', {}, 'Warte auf die Empfangsbestätigung. Bei Verbindungsproblemen kann dieselbe Wallet denselben Ausweis erneut abrufen – es wird kein zweiter ausgestellt.'));
    } else if (offer.status === 'accepted') {
      details.append(el('p', { class: 'message notice' }, 'Erfolgreich übergeben · die Wallet hat den Empfang bestätigt.'),
        el('p', {}, 'Der Ausweis ist an den Smartphone-Schlüssel gebunden. Die Vertrauensfreigabe der Zentrale bleibt eine separate Voraussetzung für den Check-in.'), next);
      stopPolling();
    } else {
      details.append(el('p', { class: 'message warning' }, 'Dieses Angebot wurde abgebrochen.'), next);
      stopPolling();
    }
    if (['offered', 'bound'].includes(offer.status)) {
      details.append(action(el('button', { type: 'button', class: 'secondary' }, 'Angebot abbrechen'), async () => {
        const updated = await adminApi(`/offers/${offer.id}/cancel`, { body: {} });
        activeOffer = { ...activeOffer, ...updated };
        renderTransfer(updated);
      }));
    }
    details.append(explain('issuer'), raw(offer, 'Öffentliche Angebotsdaten anzeigen'));
    transferPanel.replaceChildren(el('div', { class: 'transfer-grid' }, qr, details));
  }

  function schedulePoll() {
    const generation = pollGeneration;
    pollTimer = setTimeout(async () => {
      if (!activeOffer || generation !== pollGeneration) return;
      try {
        const updated = await adminApi(`/offers/${activeOffer.id}`);
        if (generation !== pollGeneration || !activeOffer) return;
        const order = { offered: 0, bound: 1, issued: 2, accepted: 3, cancelled: 3 };
        if (order[updated.status] < order[activeOffer.status]) {
          schedulePoll();
          return;
        }
        const changed = updated.status !== activeOffer.status || updated.holderDid !== activeOffer.holderDid;
        activeOffer = { ...activeOffer, ...updated };
        if (changed) renderTransfer(updated);
      } catch (error) {
        if (generation !== pollGeneration) return;
        if ([404, 410].includes(error.status)) {
          stopPolling();
          transferPanel.replaceChildren(el('h2', {}, 'QR-Angebot nicht mehr verfügbar'),
            el('p', { class: 'message warning' }, error.message),
            action(el('button', { type: 'button' }, 'Neues Angebot vorbereiten'), () => dashboard()));
          return;
        }
        showError(error);
      }
      if (generation === pollGeneration) schedulePoll();
    }, 1800);
  }
}

run(async () => {
  config = await api('/config');
  if (config.role !== 'issuer') throw new Error('Diese Adresse gehört nicht zu einem eigenständigen Issuer-Server.');
  token = sessionStorage.getItem(tokenKey) || '';
  if (!token) return showLogin();
  try {
    await dashboard();
  } catch (error) {
    if (error.status !== 401) throw error;
    clearToken();
    showLogin();
    showError(error);
  }
});
window.addEventListener('pagehide', stopPolling);
