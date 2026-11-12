import { el, api, explain, raw, attributes, action, formAction, run, showError } from './lib/ui.js';
import { sha256b64 } from './lib/sdjwt.js';
import { managementAccess } from './lib/management.js';
import { offerTransactionCode } from './lib/protocol.js';

const root = document.getElementById('app');
let config;
let activeOffer;
let dashboardGeneration = 0;
let pageActive = document.visibilityState !== 'hidden';
let suspendDashboard = () => {};
let resumeDashboard = () => {};

const access = managementAccess({
  prefix: '/issuer', content: root, onUnlock: () => dashboard(),
  onLock: () => {
    invalidateDashboard();
    root.replaceChildren();
  },
});
const issuerApi = (route, options = {}) => access.request(route, options);

function field(name, label, { value = '', required = true, type = 'text', ...options } = {}) {
  return el('label', { class: 'field' }, label,
    el('input', { name, type, value, required, maxlength: 120, autocomplete: 'off', ...options }));
}

function invalidateDashboard() {
  dashboardGeneration += 1;
  suspendDashboard();
  suspendDashboard = () => {};
  resumeDashboard = () => {};
  activeOffer = null;
}

// A suspended request may finish later; never overlap it or apply its stale result.
function periodicRefresh(work, interval, isCurrent) {
  let timer;
  let pending;
  let pendingVersion;
  let version = 0;
  let running = false;
  let again = false;

  function schedule() {
    clearTimeout(timer);
    if (running && isCurrent()) timer = setTimeout(refresh, interval);
  }

  function refresh() {
    clearTimeout(timer);
    if (!running || !isCurrent()) return;
    if (pending) {
      if (pendingVersion !== version) again = true;
      return pending;
    }
    const current = version;
    pendingVersion = current;
    pending = (async () => {
      try {
        await work(() => running && current === version && isCurrent());
      } finally {
        pending = null;
        if (again) {
          again = false;
          refresh();
        } else schedule();
      }
    })();
    return pending;
  }

  return {
    refresh,
    invalidate() { version += 1; },
    start() {
      if (running) return pending;
      running = true;
      return refresh();
    },
    stop() {
      running = false;
      version += 1;
      again = false;
      clearTimeout(timer);
    },
  };
}

function setText(node, text) {
  if (node.textContent !== text) node.textContent = text;
}

function timestamp(value) {
  return value ? el('time', { datetime: value }, new Date(value).toLocaleString('de-DE', {
    dateStyle: 'medium', timeStyle: 'medium',
  })) : '—';
}

function connectionCard(status) {
  return el('section', { class: 'card connection-card' },
    el('h2', {}, 'Ablauf'),
    el('ol', { class: 'workflow' },
      el('li', {}, 'Einmaliges Setup: Issuer registrieren und vom Empfang als vertrauenswürdig kennzeichnen lassen.'),
      el('li', {}, 'Smartphone: vorhandene Wallet nutzen oder einmalig einrichten, Angebots-QR öffnen und Ausgabecode vom Notebook eingeben.'),
      el('li', {}, 'Desktop: Angaben und verbundene Wallet prüfen, dann ausdrücklich signieren.')),
    el('dl', { class: 'attributes' },
      el('dt', {}, 'Diese Ausweisstelle'), el('dd', { class: 'break-anywhere' }, config.publicUrl),
      el('dt', {}, 'Workshop-Zentrale'), el('dd', {}, el('a', {
        href: config.workshopUrl, target: '_blank', rel: 'noopener noreferrer',
      }, config.workshopUrl))),
    el('p', {}, 'Wallet nur einmalig auf dem Handy einrichten, nicht auf diesem Notebook. Bei jedem Angebots-QR wird die vorhandene Wallet unter derselben Workshop-Adresse verwendet. Wird erneut eine Einrichtung angeboten, zuerst Browser und Adresse vergleichen.'),
    el('p', {}, 'Beide Adressen müssen über HTTPS erreichbar sein (HTTP nur auf localhost). Das Smartphone muss sowohl die Zentrale als auch diese Ausweisstelle erreichen können. Ein localhost-Link auf dem Smartphone zeigt auf das Smartphone selbst.'),
    el('p', { class: 'muted' }, 'Der Server speichert seinen privaten Schlüssel geschützt in identity.json. Ein Neustart behält die Identität; offene QR-Angebote enden beim Neustart.'),
    status.did ? raw({ did: status.did }, 'Öffentliche Issuer-DID anzeigen') : null);
}

async function dashboard(status = null) {
  invalidateDashboard();
  const generation = dashboardGeneration;
  const isCurrent = () => generation === dashboardGeneration && !root.hidden;
  status ||= await issuerApi('/status');
  if (!isCurrent()) return;
  const fingerprint = status.did ? (await sha256b64(status.did)).slice(0, 16) : null;
  if (!isCurrent()) return;
  const trustPanel = el('section', { class: 'card stack' });
  const offerPanel = el('section', { class: 'card stack' });
  const transferPanel = el('section', { class: 'card stack transfer-panel', hidden: true });
  const credentialsPanel = el('section', { class: 'card stack credentials-panel' });
  let canOffer;
  let wasTrusted = false;
  let offerVersion = 0;
  let trustPoll;
  let credentialsPoll;
  let offerPoll;

  const identityForm = formAction(el('form', { class: 'stack' },
    field('name', 'Name der Ausweisstelle *', { value: status.name || 'Meine Ausweisstelle' }),
    field('employeeName', 'Dein Name als ausstellende Person *', { value: status.employeeName || '' }),
    el('p', { class: 'muted' }, 'Nach Namensänderungen musst du die Ausweisstelle erneut bei der Zentrale registrieren. Der Schlüssel bleibt derselbe.'),
    el('button', { type: 'submit' }, status.did ? 'Angaben speichern' : 'Issuer-Identität anlegen')),
  async (data) => {
    const updated = await issuerApi('/setup', { body: {
      name: String(data.get('name')).trim(), employeeName: String(data.get('employeeName')).trim(),
    } });
    if (isCurrent()) await dashboard(updated);
  });

  root.replaceChildren(
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
    transferPanel, credentialsPanel);

  const offerHeading = el('h2');
  const offerGate = el('p', { class: 'message warning' });
  const offerFields = el('fieldset', { class: 'stack offer-fields', disabled: true },
    el('legend', { class: 'visually-hidden' }, 'Angaben zum Mitarbeiterausweis'),
      el('div', { class: 'form-grid' },
        field('given_name', 'Vorname *'), field('family_name', 'Nachname *')),
      field('organisation', 'Organisation *'),
      field('role', 'Rolle *', { value: 'Mitarbeitende' }),
      el('p', { class: 'muted' }, 'Alle Felder höchstens 120 Zeichen. Der signierte Ausweis gilt einen Tag; das QR-Angebot zehn Minuten.'),
      el('button', { type: 'submit' }, 'QR-Angebot erstellen – noch nicht signieren'));
  const offerForm = formAction(el('form', { class: 'stack' }, offerFields),
    async (data) => {
      if (!isCurrent() || activeOffer) return;
      if (!canOffer) throw new Error('Zuerst den aktuellen Vertrauensstatus prüfen und das Issuer-Setup abschließen.');
      const claims = Object.fromEntries([...data.entries()].map(([key, value]) => [key, String(value).trim()]));
      const offer = await issuerApi('/offers', { body: { claims } });
      if (!isCurrent()) return;
      offerTransactionCode(offer);
      activeOffer = offer;
      identityForm.querySelector('button').disabled = true;
      register.disabled = true;
      offerPanel.hidden = true;
      transferPanel.hidden = false;
      renderTransfer(offer);
      if (pageActive) offerPoll.start();
      transferPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  offerPanel.append(el('span', { class: 'eyebrow' }, '03 / Ausstellungsangebot'),
    offerHeading, offerGate, offerForm);

  function updateOfferGate(allowed) {
    if (canOffer === allowed) return;
    canOffer = allowed;
    offerFields.disabled = !allowed;
    offerHeading.textContent = allowed ? 'Welche Angaben werden bestätigt?' : 'Zuerst Issuer-Setup abschließen';
    offerGate.hidden = allowed;
    offerGate.textContent = 'Neue Angebote sind nur mit aktueller Registrierung und Vertrauen möglich. Bereits eingegebene Angaben und offene QR-Angebote bleiben erhalten. Vor jeder Signatur prüft der Server das aktuelle Vertrauen erneut.';
  }

  async function refreshTrust(valid) {
    try {
      const record = await issuerApi('/trust');
      if (!valid()) return;
      const registered = typeof record.did === 'string' && record.status !== 'unregistered' && record.proofVerified === true;
      const trusted = registered && record.trusted === true && Boolean(record.ownerName);
      const withdrawn = registered && !trusted && (wasTrusted || Boolean(record.ownerName));
      wasTrusted = registered && (wasTrusted || trusted);
      updateOfferGate(trusted);
      setText(trustStatus, !registered ? 'Nicht registriert · Issuer noch nicht mit den aktuellen Angaben registriert.'
        : trusted ? `Registriert und vertrauenswürdig · ${record.ownerName}. Setup abgeschlossen.`
          : withdrawn ? 'Vertrauen entzogen · Issuer weiterhin registriert, aber derzeit nicht vertrauenswürdig.'
            : 'Registriert · wartet auf Vertrauen. Der Empfang muss den Issuer noch als vertrauenswürdig kennzeichnen.');
      trustStatus.className = `message ${trusted ? 'notice' : 'warning'}`;
      setText(connectionStatus, 'Verbindung zur Workshop-Zentrale: erreichbar (Vertrauensliste gelesen).');
      connectionStatus.className = 'connection-ok';
      setText(trustChecked, `Zuletzt geprüft: ${new Date().toLocaleString('de-DE')}. Automatische Prüfung etwa alle 5 Sekunden.`);
      setText(trustDetails.querySelector('pre'), JSON.stringify(record, null, 2));
    } catch (error) {
      if (!valid()) return;
      updateOfferGate(false);
      trustStatus.textContent = 'Der aktuelle Registerstatus konnte nicht geprüft werden.';
      trustStatus.className = 'message warning';
      connectionStatus.textContent = error.message;
      connectionStatus.className = 'connection-failed';
    }
  }

  const trustStatus = el('p', { class: 'message warning', role: 'status' }, 'Vertrauensstatus wird geprüft …');
  const connectionStatus = el('p', { class: 'muted' }, 'Verbindung wird geprüft …');
  const trustChecked = el('p', { class: 'muted', 'aria-live': 'off' });
  const trustDetails = raw({}, 'Öffentlichen Registereintrag anzeigen');
  const register = action(el('button', { type: 'button', disabled: !status.did }, 'Bei der Zentrale registrieren'), async () => {
    trustPoll.invalidate();
    await issuerApi('/register', { body: {} });
    if (!isCurrent()) return;
    trustPoll.invalidate();
    await trustPoll.refresh();
  });
  const refresh = action(el('button', { type: 'button', class: 'secondary' }, 'Verbindung & Vertrauen aktualisieren'),
    () => trustPoll.refresh());
  trustPanel.replaceChildren(el('span', { class: 'eyebrow' }, '02 / Registrierung & Vertrauen'),
    el('h2', {}, 'Aktueller Registrierungs- und Vertrauensstatus'), trustStatus, connectionStatus, trustChecked,
    el('div', { class: 'actions' }, register, refresh),
    el('p', {}, 'Registrierung beweist den Besitz des Issuer-Schlüssels. Der Empfang kann Vertrauen jederzeit erteilen oder entziehen. Änderungen erscheinen hier automatisch; dieses Dashboard kann diese Entscheidung nicht setzen oder umgehen.'),
    el('p', {}, 'Vertrauen gilt dem Issuer, nicht einzelnen Ausweisen. Vertrauensentzug ist kein Ausweiswiderruf: Der Empfang prüft beim Check-in sowohl seine aktuelle Vertrauensregel als auch Gültigkeit und Widerrufsstatus des Ausweises.'),
    trustDetails);
  updateOfferGate(false);

  let credentialRecords = [];
  let credentialsLoaded = false;
  let credentialPage = 0;
  const pageSize = 20;
  const credentialEntries = new Map();
  const listError = el('p', { class: 'message error', role: 'alert', hidden: true });
  const listStatus = el('p', { class: 'muted', role: 'status' }, 'Ausgestellte Ausweise werden geladen …');
  const listChecked = el('p', { class: 'muted', 'aria-live': 'off' });
  const listMutationStatus = el('p', { class: 'message notice', role: 'status', hidden: true });
  const list = el('div', { class: 'credential-list' });
  const search = el('input', { type: 'search', placeholder: 'Name, Organisation, Rolle oder Ausweis-ID', autocomplete: 'off' });
  const filter = el('select', {},
    el('option', { value: 'all' }, 'Alle Status'),
    el('option', { value: 'valid' }, 'Gültig (nicht widerrufen)'),
    el('option', { value: 'revoked' }, 'Widerrufen'),
    el('option', { value: 'expired' }, 'Abgelaufen (nicht widerrufen)'));
  const previous = el('button', { type: 'button', class: 'secondary' }, 'Vorherige Seite');
  const nextPage = el('button', { type: 'button', class: 'secondary' }, 'Nächste Seite');
  const pageStatus = el('span');
  const pagination = el('nav', { class: 'actions credential-pagination', 'aria-label': 'Ausweisliste durchblättern', hidden: true },
    previous, pageStatus, nextPage);
  credentialsPanel.append(el('span', { class: 'eyebrow' }, '05 / Ausgestellte Ausweise'),
    el('h2', {}, 'Ausweise verwalten & endgültig widerrufen'),
    el('p', {}, 'Diese geschützte Liste bleibt auf dem Issuer-Server auch nach einem Neustart erhalten. Ein Widerruf ist dauerhaft und kann nicht rückgängig gemacht werden. Für einen Ersatz muss ein neuer Ausweis ausgestellt werden.'),
    el('p', {}, 'Löschen in der Wallet entfernt nur die lokale Kopie und widerruft keinen Ausweis. Vertrauen in die Ausweisstelle und Widerruf eines einzelnen Ausweises sind getrennte Entscheidungen.'),
    el('div', { class: 'credential-controls' },
      el('label', { class: 'field' }, 'Ausweise suchen', search),
      el('label', { class: 'field' }, 'Nach Status filtern', filter)),
    action(el('button', { type: 'button', class: 'secondary' }, 'Ausweisliste aktualisieren'), () => credentialsPoll.refresh()),
    listError, listMutationStatus, listStatus, list, pagination, listChecked);

  function credentialState(record) {
    if (record.revokedAt) return 'revoked';
    return Date.parse(record.expiresAt) <= Date.now() ? 'expired' : 'valid';
  }

  function credentialEntry(record) {
    let entry = credentialEntries.get(record.id);
    if (entry) {
      entry.update(record);
      return entry.node;
    }
    const name = `${record.claims.given_name} ${record.claims.family_name}`;
    const state = el('span', { class: 'credential-state' });
    const revokedAt = el('dd');
    const confirmation = el('div', { class: 'revoke-confirmation', hidden: true });
    const acknowledgment = el('input', { type: 'checkbox', name: 'confirmRevocation', required: true });
    const mutationStatus = el('p', { role: 'status', class: 'muted', hidden: true });
    const cancel = el('button', { type: 'button', class: 'secondary' }, 'Nicht widerrufen');
    const revoke = el('button', { type: 'button', class: 'danger' }, 'Diesen Ausweis endgültig widerrufen');
    let current = record;
    let busy = false;
    let previousRevokedAt;
    const confirmForm = formAction(el('form', { class: 'stack' },
      el('p', {}, el('strong', {}, `${name}: Diesen einzelnen Ausweis unwiderruflich ungültig machen?`),
        ' Die Wallet-Kopie wird dadurch nicht gelöscht. Es gibt keine Wiederherstellung.'),
      el('p', {}, 'Ausgestellt: ', timestamp(record.issuedAt), ' · Ausweis-ID: ', el('code', {}, record.id)),
      el('label', { class: 'revocation-acknowledgment' }, acknowledgment, 'Ich bestätige den endgültigen Widerruf dieses Ausweises.'),
      el('div', { class: 'actions' },
        el('button', { type: 'submit', class: 'danger' }, 'Ja, endgültig widerrufen'), cancel)),
    async () => {
      if (!isCurrent() || busy || current.revokedAt) return;
      if (!acknowledgment.checked) throw new Error('Bitte bestätige zuerst den endgültigen Widerruf.');
      busy = true;
      cancel.disabled = true;
      credentialsPoll.invalidate();
      try {
        const updated = await issuerApi(`/credentials/${encodeURIComponent(record.id)}/revoke`, { body: {} });
        if (!isCurrent()) return;
        if (updated.id !== record.id || !updated.revokedAt) throw new Error('Der Server hat den Widerruf nicht bestätigt. Bitte die Liste aktualisieren.');
        credentialsPoll.invalidate();
        credentialRecords = credentialRecords.map((item) => item.id === updated.id ? updated : item);
        entry.update(updated);
        renderCredentialList();
        mutationStatus.hidden = false;
        mutationStatus.textContent = `Endgültig widerrufen am ${new Date(updated.revokedAt).toLocaleString('de-DE')}. Keine Wiederherstellung möglich.`;
        listMutationStatus.hidden = false;
        listMutationStatus.textContent = `${name} · ${updated.id}: ${mutationStatus.textContent}`;
      } finally {
        busy = false;
        cancel.disabled = false;
        if (isCurrent()) credentialsPoll.refresh();
      }
    });
    confirmation.append(confirmForm);
    revoke.addEventListener('click', () => {
      if (current.revokedAt) return;
      confirmation.hidden = false;
      revoke.hidden = true;
      acknowledgment.focus();
    });
    cancel.addEventListener('click', () => {
      confirmation.hidden = true;
      acknowledgment.checked = false;
      revoke.hidden = false;
      revoke.focus();
    });
    const node = el('details', { class: 'credential-entry' },
      el('summary', {},
        el('span', { class: 'credential-title' }, el('strong', {}, name),
          el('span', { class: 'muted' }, `${record.claims.organisation} · ${record.claims.role}`)),
        state,
        el('span', { class: 'credential-issued' }, 'Ausgestellt: ', timestamp(record.issuedAt))),
      el('div', { class: 'stack credential-body' },
        attributes(record.claims),
        el('dl', { class: 'attributes' },
          el('dt', {}, 'Ausgestellt am'), el('dd', {}, timestamp(record.issuedAt)),
          el('dt', {}, 'Gültig bis'), el('dd', {}, timestamp(record.expiresAt)),
          el('dt', {}, 'Endgültig widerrufen am'), revokedAt,
          el('dt', {}, 'Ausweis-ID'), el('dd', {}, el('code', {}, record.id))),
        raw({ holderDid: record.holderDid, issuerDid: record.issuerDid, statusIndex: record.statusIndex }, 'Wallet-Bindung und Statusindex anzeigen'),
        revoke, confirmation, mutationStatus));
    entry = {
      node,
      update(updated) {
        current = updated;
        const status = credentialState(updated);
        setText(state, status === 'revoked' ? 'Endgültig widerrufen' : status === 'expired' ? 'Abgelaufen' : 'Gültig · nicht widerrufen');
        state.className = `credential-state credential-${status}`;
        if (previousRevokedAt !== (updated.revokedAt || '')) {
          revokedAt.replaceChildren(updated.revokedAt ? timestamp(updated.revokedAt) : 'Nicht widerrufen');
          previousRevokedAt = updated.revokedAt || '';
        }
        revoke.hidden = Boolean(updated.revokedAt) || !confirmation.hidden;
        if (updated.revokedAt) {
          confirmation.hidden = true;
          acknowledgment.checked = false;
        }
      },
    };
    entry.update(record);
    credentialEntries.set(record.id, entry);
    return node;
  }

  function renderCredentialList() {
    if (!credentialsLoaded) return;
    const query = search.value.trim().toLocaleLowerCase('de-DE');
    const matches = credentialRecords.filter((record) => (
      (filter.value === 'all' || credentialState(record) === filter.value)
      && (!query || [record.id, record.holderDid, ...Object.values(record.claims)].join(' ').toLocaleLowerCase('de-DE').includes(query))
    ));
    const pages = Math.max(1, Math.ceil(matches.length / pageSize));
    credentialPage = Math.min(credentialPage, pages - 1);
    const visible = matches.slice(credentialPage * pageSize, (credentialPage + 1) * pageSize).map(credentialEntry);
    // Reusing unchanged nodes retains open details, confirmations, focus and scroll.
    if (visible.length !== list.children.length || visible.some((node, index) => node !== list.children[index])) {
      list.replaceChildren(...visible);
    }
    setText(listStatus, !credentialRecords.length ? 'Noch keine Ausweise ausgestellt.'
      : !matches.length ? 'Keine Ausweise passen zur Suche oder zum Statusfilter.'
        : `${matches.length} von ${credentialRecords.length} Ausweisen · Seite ${credentialPage + 1} von ${pages}.`);
    pagination.hidden = matches.length <= pageSize;
    previous.disabled = credentialPage === 0;
    nextPage.disabled = credentialPage === pages - 1;
    setText(pageStatus, `Seite ${credentialPage + 1} / ${pages}`);
  }

  for (const [control, event] of [[search, 'input'], [filter, 'change']]) {
    control.addEventListener(event, () => {
      credentialPage = 0;
      renderCredentialList();
    });
  }
  previous.addEventListener('click', () => {
    credentialPage = Math.max(0, credentialPage - 1);
    renderCredentialList();
  });
  nextPage.addEventListener('click', () => {
    credentialPage += 1;
    renderCredentialList();
  });

  async function refreshCredentials(valid) {
    try {
      const records = await issuerApi('/credentials');
      if (!valid()) return;
      if (!Array.isArray(records) || records.some((record) => !record || typeof record.id !== 'string'
        || !record.claims || !Number.isFinite(Date.parse(record.issuedAt)) || !Number.isFinite(Date.parse(record.expiresAt)))) {
        throw new Error('Die Ausweisliste hat ein ungültiges Format.');
      }
      credentialRecords = records.sort((a, b) => b.issuedAt.localeCompare(a.issuedAt) || a.id.localeCompare(b.id));
      credentialsLoaded = true;
      listError.hidden = true;
      for (const record of records) credentialEntries.get(record.id)?.update(record);
      const ids = new Set(records.map((record) => record.id));
      for (const id of credentialEntries.keys()) if (!ids.has(id)) credentialEntries.delete(id);
      renderCredentialList();
      setText(listChecked, `Liste zuletzt geladen: ${new Date().toLocaleString('de-DE')}. Automatische Aktualisierung etwa alle 5 Sekunden.`);
    } catch (error) {
      if (!valid()) return;
      listError.hidden = false;
      listError.textContent = `Ausweisliste konnte nicht ${credentialsLoaded ? 'aktualisiert' : 'geladen'} werden: ${error.message}`;
      setText(listStatus, credentialsLoaded ? 'Achtung: Angezeigte Daten sind möglicherweise nicht aktuell.'
        : 'Keine verlässliche Ausweisliste verfügbar. Bitte erneut laden; dies bedeutet nicht, dass keine Ausweise existieren.');
    }
  }

  function renderTransfer(offer) {
    const transactionCode = offerTransactionCode(offer);
    const next = action(el('button', { type: 'button' }, 'Weiteren Mitarbeiterausweis vorbereiten'), async () => {
      offerPoll.stop();
      activeOffer = null;
      identityForm.querySelector('button').disabled = false;
      register.disabled = !status.did;
      transferPanel.hidden = true;
      offerPanel.hidden = false;
      offerForm.reset();
      await trustPoll.refresh();
    });
    const qr = el('div', { class: 'qr-column' },
      el('img', { class: 'offer-qr', src: activeOffer.qrDataUrl, alt: 'QR-Code zum Verbinden der Smartphone-Wallet', width: 360, height: 360 }),
      transactionCode === null ? el('p', { class: 'message notice' }, offer.status === 'cancelled'
        ? 'Dieses Angebot ist beendet; der Ausgabecode ist nicht mehr verwendbar.'
        : 'Ausgabecode bereits geprüft. Die Wallet ist verbunden; eine erneute Codeeingabe ist nicht nötig.')
        : el('section', { class: 'issuance-code', 'aria-label': 'Ausgabecode für dieses Angebot' },
          el('h3', {}, 'Ausgabecode für die Wallet'),
          el('p', { class: 'pairing-code', 'aria-label': 'Ausgabecode' }, transactionCode),
          el('p', {}, 'Diese sechs Ziffern auf dem Handy in der Wallet eingeben. Nicht am Notebook.')),
      el('p', { class: 'muted' }, 'Mit der Kamera scannen und im selben Smartphone-Browser wie deine Wallet öffnen. Beim ersten Mal kannst du sie dort einmalig einrichten. Alternativ den Link auf dem Smartphone öffnen:'),
      el('a', { class: 'break-anywhere', href: activeOffer.url, target: '_blank', rel: 'noopener noreferrer' }, 'Wallet mit diesem Angebot öffnen'),
      el('p', { class: 'muted' }, `Gültig bis ${new Date(offer.expiresAt).toLocaleTimeString('de-DE')}. Link und QR enthalten einen vertraulichen Zugangscode.`));
    const details = el('div', { class: 'stack' },
      el('span', { class: 'eyebrow' }, '04 / Wallet verbinden & bewusst signieren'),
      el('h2', {}, 'Angebot prüfen'), attributes(offer.claims));
    if (offer.status === 'offered') {
      details.append(el('p', { class: 'message notice' }, 'Wartet auf eine Wallet. Nur Scannen oder Öffnen stellt noch keinen Ausweis aus.'),
        el('p', {}, 'Diesen Code auf dem Smartphone in der Wallet eingeben. Er steht nur hier, nicht im QR und nicht bereits in der Wallet. Er gilt für dieses Angebot; nach fünf falschen Eingaben ist ein neues Angebot nötig.'),
        el('p', {}, 'Die Wallet weist zusätzlich den Besitz ihres eigenen Schlüssels nach. Erst danach kannst du den Ausweis hier signieren.'));
    } else if (offer.status === 'bound') {
      const approve = formAction(el('form', { class: 'stack' },
        el('p', {}, 'Der Ausgabecode und der Wallet-Schlüsselbesitz wurden geprüft. Prüfe die Angaben und die Person, bevor du mit deinem Issuer-Schlüssel signierst.'),
        el('button', { type: 'submit' }, 'Mitarbeiterausweis jetzt signieren')),
      async () => {
        offerVersion += 1;
        const updated = await issuerApi(`/offers/${offer.id}/approve`, { body: {} });
        if (!isCurrent() || activeOffer?.id !== offer.id) return;
        offerVersion += 1;
        activeOffer = { ...activeOffer, ...updated };
        renderTransfer(updated);
        credentialsPoll.invalidate();
        credentialsPoll.refresh();
      });
      details.append(el('p', { class: 'message warning' }, 'Wallet verbunden · noch nicht signiert'), approve,
        raw({ holderDid: offer.holderDid }, 'Gebundene Wallet-DID anzeigen'));
    } else if (offer.status === 'issued') {
      details.append(el('p', { class: 'message notice' }, 'Signiert · die gebundene Wallet kann den Ausweis jetzt abholen.'),
        el('p', {}, 'Warte auf die Empfangsbestätigung. Bei Verbindungsproblemen kann dieselbe Wallet denselben Ausweis erneut abrufen – es wird kein zweiter ausgestellt.'));
    } else if (offer.status === 'accepted') {
      details.append(el('p', { class: 'message notice' }, 'Erfolgreich übergeben · die Wallet hat den Empfang bestätigt.'),
        el('p', {}, 'Der Ausweis ist an den Smartphone-Schlüssel gebunden. Eine zusätzliche Ausweisfreigabe durch den Empfang ist nicht erforderlich.'), next);
      offerPoll.stop();
    } else {
      details.append(el('p', { class: 'message warning' }, offer.cancellationReason || 'Dieses Angebot wurde abgebrochen.'), next);
      offerPoll.stop();
    }
    if (['offered', 'bound'].includes(offer.status)) {
      details.append(action(el('button', { type: 'button', class: 'secondary' }, 'Angebot abbrechen'), async () => {
        offerVersion += 1;
        const updated = await issuerApi(`/offers/${offer.id}/cancel`, { body: {} });
        if (!isCurrent() || activeOffer?.id !== offer.id) return;
        offerVersion += 1;
        activeOffer = { ...activeOffer, ...updated };
        renderTransfer(updated);
      }));
    }
    const { transactionCode: privateCode, ...metadata } = offer;
    details.append(explain('issuer'), raw(metadata, 'Technische Angebotsdaten anzeigen'));
    transferPanel.replaceChildren(el('div', { class: 'transfer-grid' }, qr, details));
  }

  async function refreshOffer(valid) {
    if (!activeOffer) return;
    const id = activeOffer.id;
    const version = offerVersion;
    try {
      const updated = await issuerApi(`/offers/${id}`);
      if (!valid() || activeOffer?.id !== id || version !== offerVersion) return;
      const order = { offered: 0, bound: 1, issued: 2, accepted: 3, cancelled: 3 };
      if (order[updated.status] < order[activeOffer.status]) return;
      offerTransactionCode(updated);
      const changed = updated.status !== activeOffer.status || updated.holderDid !== activeOffer.holderDid;
      activeOffer = { ...activeOffer, ...updated };
      if (changed) {
        renderTransfer(updated);
        if (['issued', 'accepted'].includes(updated.status)) credentialsPoll.refresh();
      }
    } catch (error) {
      if (!valid() || activeOffer?.id !== id || version !== offerVersion) return;
      if ([404, 410].includes(error.status)) {
        offerPoll.stop();
        transferPanel.replaceChildren(el('h2', {}, 'QR-Angebot nicht mehr verfügbar'),
          el('p', { class: 'message warning' }, error.message),
          action(el('button', { type: 'button' }, 'Neues Angebot vorbereiten'), () => dashboard()));
        return;
      }
      showError(error);
    }
  }

  trustPoll = periodicRefresh(refreshTrust, 5000, isCurrent);
  credentialsPoll = periodicRefresh(refreshCredentials, 5000, isCurrent);
  offerPoll = periodicRefresh(refreshOffer, 1800, isCurrent);
  suspendDashboard = () => {
    trustPoll.stop();
    credentialsPoll.stop();
    offerPoll.stop();
  };
  resumeDashboard = () => {
    if (!isCurrent() || !pageActive) return;
    trustPoll.start();
    credentialsPoll.start();
    if (activeOffer && ['offered', 'bound', 'issued'].includes(activeOffer.status)) offerPoll.start();
  };
  if (pageActive) await Promise.all([trustPoll.start(), credentialsPoll.start()]);
}

run(async () => {
  config = await api('/config');
  if (config.role !== 'issuer') throw new Error('Diese Adresse gehört nicht zu einem eigenständigen Issuer-Server.');
  await access.start();
});
window.addEventListener('pagehide', () => {
  pageActive = false;
  suspendDashboard();
});
window.addEventListener('pageshow', () => {
  pageActive = document.visibilityState !== 'hidden';
  if (pageActive) resumeDashboard();
});
document.addEventListener('visibilitychange', () => {
  pageActive = document.visibilityState !== 'hidden';
  if (pageActive) resumeDashboard();
  else suspendDashboard();
});
