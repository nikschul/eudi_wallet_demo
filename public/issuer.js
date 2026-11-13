import { el, api, raw, attributes, action, formAction, run, showError, clearError } from './lib/ui.js';
import { offerTransactionCode, publicOrigin } from './lib/protocol.js';

const root = document.getElementById('app');
const roles = ['Mitarbeitende', 'Teamleitung', 'Gast'];
let config;
let activeOffer;
let dashboardGeneration = 0;
let pageActive = document.visibilityState !== 'hidden';
let suspendDashboard = () => {};
let resumeDashboard = () => {};

let recoveryVersion = 0;
const issuerApi = (route, options = {}) => api(`/issuer${route}`, { ...options, credentials: 'same-origin' });

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
  return el('section', { class: 'card connection-card stack' },
    el('h2', {}, 'Organisation angelegt'),
    el('dl', { class: 'attributes' },
      el('dt', {}, 'Fester Organisationsname'), el('dd', {}, status.name),
      el('dt', {}, 'Zentrale Workshop-Adresse'), el('dd', { class: 'break-anywhere' }, config.publicUrl)),
    el('p', {}, 'Der Organisationsname ist unveränderlich. Ausweise bestätigen diese Organisation und die empfangende Wallet, nicht die Identität einer ausstellenden Person.'),
    browserAccessNote());
}

function browserAccessNote() {
  return el('p', { class: 'muted' }, 'Der Zugang gehört diesem Laptop-Browser und bleibt durch ein geschütztes HttpOnly-Cookie erhalten. Website-Daten nicht löschen; keinen privaten Browsermodus verwenden. Bei verlorenem Zugang kann nur die Moderation einen privaten Wiederherstellungslink erzeugen. Die persönliche Wallet bleibt auf dem Smartphone.');
}

function progress(current) {
  return el('ol', { class: 'issuer-progress', 'aria-label': 'Drei Schritte zum Ausweis' },
    ['Organisation anlegen', 'Freigabe abwarten', 'Mitarbeiterausweis ausstellen'].map((label, index) =>
      el('li', { 'aria-current': index + 1 === current ? 'step' : null,
        class: index + 1 < current ? 'completed' : '' }, `${index + 1}. ${label}`)));
}

function readSession(data) {
  if (!data || !Array.isArray(data.roles) || data.roles.length !== roles.length
    || !roles.every((role) => data.roles.includes(role))
    || (data.organisation !== null && (!data.organisation || typeof data.organisation.id !== 'string'
      || typeof data.organisation.name !== 'string' || !['pending', 'approved', 'suspended'].includes(data.organisation.state)))) {
    throw new Error('Die Organisationssitzung hat ein ungültiges Format. Bitte die Seite neu laden oder die Moderation fragen.');
  }
  return data.organisation;
}

function onboarding() {
  invalidateDashboard();
  const generation = dashboardGeneration;
  root.hidden = false;
  root.replaceChildren(progress(1),
    el('section', { class: 'card stack onboarding-panel' },
      el('span', { class: 'eyebrow' }, 'Schritt 1 / Organisation'),
      el('h2', {}, 'Wie heißt eure Organisation?'),
      el('p', {}, 'Jeder Laptop-Browser kann eine eigene Organisation anlegen. Du brauchst nur den Organisationsnamen, keinen persönlichen Namen. Die Moderation gibt eure Organisation anschließend frei.'),
      formAction(el('form', { class: 'stack' },
        field('name', 'Organisationsname *'),
        el('p', { class: 'muted' }, 'Bitte sorgfältig wählen: Der Name ist danach nicht mehr änderbar und steht auf allen Ausweisen dieser Organisation. Nur erfundene Daten verwenden.'),
        el('button', { type: 'submit' }, 'Organisation anlegen')),
      async (data) => {
        const session = await api('/organisations', {
          credentials: 'same-origin', body: { name: String(data.get('name')).trim() },
        });
        if (generation !== dashboardGeneration) return;
        const organisation = readSession(session);
        if (!organisation) throw new Error('Der Server hat die neue Organisation nicht bestätigt.');
        await dashboard(organisation);
      }), browserAccessNote()));
}

async function dashboard(status) {
  invalidateDashboard();
  root.hidden = false;
  const generation = dashboardGeneration;
  const isCurrent = () => generation === dashboardGeneration && !root.hidden;
  const trustPanel = el('section', { class: 'card stack' });
  const offerPanel = el('section', { class: 'card stack' });
  const transferPanel = el('section', { class: 'card stack transfer-panel', hidden: true });
  const credentialsPanel = el('section', { class: 'card stack credentials-panel' });
  let canOffer;
  let offerVersion = 0;
  let trustPoll;
  let credentialsPoll;
  let offerPoll;
  let transfer;

  const steps = progress(status.state === 'approved' ? 3 : 2);
  root.replaceChildren(
    steps,
    el('div', { class: 'dashboard-grid' },
      el('div', { class: 'stack' }, connectionCard(status), trustPanel),
      offerPanel),
    transferPanel, credentialsPanel);

  const offerHeading = el('h2');
  const offerGate = el('p', { class: 'message warning' });
  const offerFields = el('fieldset', { class: 'stack offer-fields', disabled: true },
    el('legend', { class: 'visually-hidden' }, 'Angaben zum Mitarbeiterausweis'),
      el('div', { class: 'fixed-organisation' },
        el('span', {}, 'Organisation (fest)'), el('strong', {}, status.name)),
      el('div', { class: 'form-grid' },
        field('given_name', 'Vorname *'), field('family_name', 'Nachname *')),
      el('label', { class: 'field' }, 'Rolle *',
        el('select', { name: 'role', required: true }, roles.map((role) => el('option', { value: role }, role)))),
      el('p', { class: 'muted' }, 'Alle Felder höchstens 120 Zeichen. Der signierte Ausweis gilt einen Tag; das QR-Angebot zehn Minuten.'),
      el('p', {}, 'Nach Wallet-Schlüsselbeweis und richtigem Ausgabecode signiert der Server automatisch. Am Laptop ist kein weiterer Signatur-Schritt nötig.'),
      el('button', { type: 'submit' }, 'QR-Angebot erstellen'));
  const offerForm = formAction(el('form', { class: 'stack' }, offerFields),
    async (data) => {
      if (!isCurrent() || activeOffer) return;
      if (!canOffer) throw new Error('Die Organisation muss aktuell von der Moderation freigegeben sein.');
      const claims = Object.fromEntries(['given_name', 'family_name', 'role'].map((key) => [key, String(data.get(key)).trim()]));
      const offer = await issuerApi('/offers', { body: { claims } });
      if (!isCurrent()) return;
      activeOffer = offer;
      offerPanel.hidden = true;
      transferPanel.hidden = false;
      renderTransfer(offer);
      if (pageActive) offerPoll.start();
      transferPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  offerPanel.append(el('span', { class: 'eyebrow' }, 'Schritt 3 / Mitarbeiterausweis'),
    offerHeading, offerGate, offerForm);

  function updateOfferGate(allowed) {
    if (canOffer === allowed) return;
    canOffer = allowed;
    offerFields.disabled = !allowed;
    offerHeading.textContent = 'Für wen wird der Ausweis ausgestellt?';
    offerGate.hidden = allowed;
    offerGate.textContent = 'Neue Angebote sind erst nach Freigabe der Organisation möglich. Eingaben und ein offenes QR-Angebot bleiben bei Statusänderungen erhalten. Der Server prüft die Freigabe auch vor der automatischen Signatur.';
  }

  async function refreshTrust(valid) {
    try {
      const organisation = readSession(await issuerApi('/status'));
      if (!valid()) return;
      if (!organisation) {
        onboarding();
        return;
      }
      if (organisation.id !== status.id) {
        await dashboard(organisation);
        return;
      }
      status = organisation;
      const approved = status.state === 'approved';
      updateOfferGate(approved);
      setText(trustStatus, approved ? 'Freigegeben · Du kannst Mitarbeiterausweise ausstellen.'
        : status.state === 'suspended' ? 'Gesperrt · Neue Ausgaben sind ausgesetzt. Bereits ausgestellte Ausweise kannst du weiterhin verwalten und widerrufen.'
          : 'Wartet auf Freigabe · Die Moderation muss eure Organisation einmalig freigeben. Du musst nichts registrieren oder übertragen.');
      trustStatus.className = `message ${approved ? 'notice' : 'warning'}`;
      const currentStep = approved ? 3 : 2;
      for (let index = 0; index < steps.children.length; index += 1) {
        const step = steps.children[index];
        if (index + 1 === currentStep) step.setAttribute('aria-current', 'step');
        else step.removeAttribute('aria-current');
        step.className = index + 1 < currentStep ? 'completed' : '';
      }
      setText(trustChecked, `Zuletzt geprüft: ${new Date().toLocaleString('de-DE')}. Automatische Prüfung etwa alle 5 Sekunden.`);
      setText(trustDetails.querySelector('pre'), JSON.stringify({
        id: status.id, did: status.did, fingerprint: status.fingerprint, state: status.state,
      }, null, 2));
    } catch (error) {
      if (!valid()) return;
      updateOfferGate(false);
      trustStatus.textContent = `Der aktuelle Organisationsstatus konnte nicht geprüft werden: ${error.message}`;
      trustStatus.className = 'message warning';
    }
  }

  const trustStatus = el('p', { class: 'message warning', role: 'status' }, 'Organisationsstatus wird geprüft …');
  const trustChecked = el('p', { class: 'muted', 'aria-live': 'off' });
  const trustDetails = raw({}, 'Technische Organisationsdaten anzeigen');
  const refresh = action(el('button', { type: 'button', class: 'secondary' }, 'Organisationsstatus aktualisieren'),
    () => trustPoll.refresh());
  trustPanel.replaceChildren(el('span', { class: 'eyebrow' }, 'Schritt 2 / Freigabe'),
    el('h2', {}, 'Freigabe durch die Moderation'), trustStatus, trustChecked, refresh,
    el('p', {}, 'Die Moderation sieht eure Organisation zentral und kann sie freigeben oder sperren. Ein DID-Fingerabdruck muss dafür nicht übergeben werden. Die Freigabe gilt der Organisation, nicht einzelnen Ausweisen. Eine Sperre ist kein Widerruf einzelner Ausweise.'),
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
  credentialsPanel.append(el('span', { class: 'eyebrow' }, 'Verwaltung / Auch bei gesperrter Organisation'),
    el('h2', {}, 'Ausweise verwalten & endgültig widerrufen'),
    el('p', {}, 'Diese geschützte Liste eurer Organisation bleibt zentral auch nach einem Neustart erhalten. Ein Widerruf ist dauerhaft und kann nicht rückgängig gemacht werden. Für einen Ersatz muss ein neuer Ausweis ausgestellt werden.'),
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
    if (!transfer || transfer.id !== offer.id) {
      const code = el('p', { class: 'pairing-code', 'aria-label': 'Ausgabecode' });
      const codePanel = el('section', { class: 'issuance-code', 'aria-label': 'Ausgabecode für dieses Angebot' },
        el('h3', {}, 'Ausgabecode für die Wallet'), code,
        el('p', {}, 'Diese sechs Ziffern auf dem Smartphone in der Wallet eingeben. Der Code steht nur hier auf dem Laptop, nicht im QR.'));
      const codeStatus = el('p', { class: 'message notice', role: 'status' });
      const progressStatus = el('p', { class: 'message notice', role: 'status' });
      const guidance = el('p');
      const offerError = el('p', { class: 'message error', role: 'alert', hidden: true });
      const metadata = raw({}, 'Technische Angebotsdaten anzeigen');
      const next = action(el('button', { type: 'button', hidden: true }, 'Weiteren Mitarbeiterausweis vorbereiten'), async () => {
        offerPoll.stop();
        offerVersion += 1;
        activeOffer = null;
        transfer = null;
        transferPanel.hidden = true;
        transferPanel.replaceChildren();
        offerPanel.hidden = false;
        offerForm.reset();
        offerForm.querySelector('input').focus();
        await trustPoll.refresh();
      });
      const qr = el('div', { class: 'qr-column' },
        el('img', { class: 'offer-qr', src: offer.qrDataUrl, alt: 'Angebots-QR für die Smartphone-Wallet', width: 360, height: 360 }),
        codePanel, codeStatus,
        el('p', {}, 'In der Smartphone-Wallet „QR-Code scannen“ verwenden – auch direkt in der installierten Wallet (PWA). Alternativ mit der Smartphone-Kamera scannen oder den Angebotslink auf dem Handy öffnen. Beim ersten Mal die Wallet dort einmalig einrichten. Eine vorhandene Wallet im selben Browser weiterverwenden.'),
        el('a', { class: 'break-anywhere', href: offer.url, target: '_blank', rel: 'noopener noreferrer' }, 'Angebotslink für das Smartphone'),
        el('p', { class: 'muted' }, `Angebot gültig bis ${new Date(offer.expiresAt).toLocaleTimeString('de-DE')}. QR und Link nicht öffentlich teilen.`));
      const details = el('div', { class: 'stack' },
        el('span', { class: 'eyebrow' }, 'Schritt 3 / Übergabe ans Smartphone'),
        el('h2', {}, 'Ausweis auf dem Smartphone speichern'), attributes(offer.claims),
        progressStatus, guidance, offerError, next, metadata);
      transferPanel.replaceChildren(el('div', { class: 'transfer-grid' }, qr, details));
      transfer = { id: offer.id, code, codePanel, codeStatus, progressStatus, guidance, offerError, next, metadata };
    }
    const terminal = ['accepted', 'cancelled', 'expired'].includes(offer.status);
    transfer.offerError.hidden = true;
    let transactionCode = null;
    try {
      transactionCode = offerTransactionCode(offer);
    } catch (error) {
      transfer.offerError.textContent = error.message;
      transfer.offerError.hidden = false;
    }
    setText(transfer.code, transactionCode || '');
    transfer.codePanel.hidden = transactionCode === null;
    transfer.codeStatus.hidden = offer.status === 'offered';
    setText(transfer.codeStatus, ['cancelled', 'expired'].includes(offer.status)
      ? 'Angebot beendet · Der Ausgabecode ist nicht mehr verwendbar.'
      : 'Ausgabecode und Wallet-Schlüsselbeweis geprüft. Keine erneute Codeeingabe nötig.');
    const states = {
      offered: ['Angeboten · Wartet auf Smartphone und Ausgabecode.',
        'Auf dem Handy Angebot öffnen, Ausgabecode eingeben und anschließend den Ausweis in der Wallet speichern. Nach richtigem Code und Schlüsselbeweis wird automatisch signiert – ohne weiteren Klick am Laptop. Nach fünf falschen Codeeingaben ist ein neues Angebot nötig.'],
      bound: ['Wallet geprüft · Automatische Signatur läuft.',
        'Code und Schlüsselbeweis sind geprüft. Auf dem Smartphone fortfahren; am Laptop ist keine Freigabe nötig.'],
      issued: ['Automatisch signiert · Wartet auf Speichern in der Wallet.',
        'Jetzt auf dem Smartphone den Ausweis in der Wallet speichern. Erst die Empfangsbestätigung schließt diese Übergabe ab. Bei Verbindungsproblemen dasselbe Angebot mit derselben Wallet erneut öffnen.'],
      accepted: ['Gespeichert · Die Wallet hat den Empfang bestätigt.',
        'Der Ausweis ist an die Organisation und den Smartphone-Schlüssel gebunden. Für die nächste Person ausdrücklich „Weiteren Mitarbeiterausweis vorbereiten“ wählen.'],
      cancelled: ['Angebot abgebrochen.', offer.cancellationReason || 'Dieses Angebot kann nicht mehr verwendet werden. Bitte bewusst ein neues Angebot vorbereiten.'],
      expired: ['Angebot abgelaufen oder nicht mehr verfügbar.', offer.cancellationReason || 'Dieses Angebot kann nicht mehr verwendet werden. Bitte bewusst ein neues Angebot vorbereiten.'],
    };
    if (!states[offer.status]) throw new Error('Das Angebot hat einen unbekannten Status. Bitte die Moderation fragen.');
    setText(transfer.progressStatus, states[offer.status][0]);
    setText(transfer.guidance, states[offer.status][1]);
    transfer.next.hidden = !terminal;
    const { transactionCode: privateCode, ...metadata } = offer;
    setText(transfer.metadata.querySelector('pre'), JSON.stringify(metadata, null, 2));
    if (terminal) offerPoll.stop();
  }

  async function refreshOffer(valid) {
    if (!activeOffer) return;
    const id = activeOffer.id;
    const version = offerVersion;
    try {
      const updated = await issuerApi(`/offers/${id}`);
      if (!valid() || activeOffer?.id !== id || version !== offerVersion) return;
      const order = { offered: 0, bound: 1, issued: 2, accepted: 3, cancelled: 3, expired: 3 };
      if (!(updated.status in order)) throw new Error('Das Angebot hat einen unbekannten Status. Bitte die Moderation fragen.');
      if (order[updated.status] < order[activeOffer.status]) return;
      const changed = updated.status !== activeOffer.status;
      activeOffer = { ...activeOffer, ...updated,
        transactionCode: updated.status === 'offered' ? updated.transactionCode : undefined };
      renderTransfer(activeOffer);
      if (changed && ['issued', 'accepted'].includes(updated.status)) credentialsPoll.refresh();
    } catch (error) {
      if (!valid() || activeOffer?.id !== id || version !== offerVersion) return;
      if ([404, 410].includes(error.status)) {
        activeOffer = { ...activeOffer, status: 'expired', transactionCode: undefined, cancellationReason: error.message };
        renderTransfer(activeOffer);
        return;
      }
      transfer.offerError.textContent = `Angebotsstatus konnte nicht aktualisiert werden: ${error.message}`;
      transfer.offerError.hidden = false;
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

function consumeRecovery() {
  const url = new URL(location.href);
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get('org-access');
  if (token !== null) {
    fragment.delete('org-access');
    url.hash = fragment.toString();
    history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return token;
}

function canonicalOriginGuard(token) {
  const origin = publicOrigin(config.publicUrl, 'Workshop-Adresse');
  if (origin === location.origin) return true;
  const url = new URL('/issuer.html', origin);
  url.search = location.search;
  const fragment = new URLSearchParams(location.hash.slice(1));
  if (token !== null) fragment.set('org-access', token);
  url.hash = fragment.toString();
  root.replaceChildren(el('section', { class: 'card stack canonical-origin-panel' },
    el('h2', {}, 'Organisation unter der Workshop-Adresse öffnen'),
    el('p', { class: 'message warning' }, 'Du hast die Zentrale unter einer anderen Adresse geöffnet. Lege hier keine zweite Organisation an. Einrichtung, Wiederherstellung und Verwaltung verwenden dieselbe öffentliche Workshop-Adresse.'),
    el('p', { class: 'break-anywhere' }, `Workshop-Adresse: ${origin}`),
    el('p', {}, 'Das Organisations-Cookie gehört zur Workshop-Adresse, nicht zu localhost oder anderen Adressen. Bereits vorhandene Zugänge werden nicht zwischen Adressen übertragen. Nutze denselben Laptop-Browser; bei verlorenem Zugang hilft dir die Moderation.'),
    token === null ? null : el('p', {}, 'Der private Wiederherstellungslink wurde aus der Adresszeile entfernt. Er wird erst unter der Workshop-Adresse eingelöst, wenn du dem folgenden Link folgst.'),
    el('a', { class: 'button', href: url.href, rel: 'noreferrer' }, 'Zur Organisation der Workshop-Zentrale')));
  return false;
}

async function loadSession(token = null) {
  const version = ++recoveryVersion;
  invalidateDashboard();
  clearError();
  root.hidden = false;
  root.replaceChildren(el('p', {}, token === null ? 'Organisation wird geladen …' : 'Organisationszugang wird wiederhergestellt …'));
  try {
    config ||= await api('/config');
    if (version !== recoveryVersion) return;
    if (!canonicalOriginGuard(token)) return;
    const session = token === null ? await issuerApi('/session')
      : await issuerApi('/recover', { body: { token } });
    if (version !== recoveryVersion) return;
    const organisation = readSession(session);
    if (token !== null && !organisation) throw new Error('Der Server hat die Wiederherstellung nicht bestätigt.');
    if (organisation) await dashboard(organisation);
    else onboarding();
  } catch (error) {
    if (version !== recoveryVersion) return;
    root.replaceChildren(el('section', { class: 'card stack' },
      el('h2', {}, token === null ? 'Organisation konnte nicht geladen werden' : 'Wiederherstellung fehlgeschlagen'),
      el('p', {}, token === null ? 'Bitte die Seite erneut laden. Bei verlorenem Browser-Zugang die Moderation um einen privaten Wiederherstellungslink bitten.'
        : 'Der private Link wurde aus der Adresszeile entfernt. Bitte die Moderation um einen neuen Wiederherstellungslink bitten. Es wurde keine neue Organisation angelegt.')));
    throw error;
  }
}

run(() => loadSession(consumeRecovery()));
window.addEventListener('hashchange', () => {
  const token = consumeRecovery();
  if (token !== null) run(() => loadSession(token));
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
