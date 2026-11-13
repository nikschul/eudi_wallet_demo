import { el, api, steps, raw, action, run, setupPage, notify, showError, formatTime } from './lib/ui.js';
import { managementAccess } from './lib/management.js';

const issuerViews = new Map();
let refreshVersion = 0;
let refreshTimer;
let stopped = true;
let unlocked = false;
let accessGeneration = 0;
const access = managementAccess({
  prefix: '/admin',
  content: document.getElementById('admin-content'),
  onUnlock: async () => {
    unlocked = true;
    stopped = false;
    await watch();
  },
  onLock: () => {
    unlocked = false;
    accessGeneration += 1;
    stopped = true;
    refreshVersion += 1;
    clearTimeout(refreshTimer);
    for (const view of issuerViews.values()) {
      view.recoveryLink.value = '';
      view.recoveryResult.hidden = true;
    }
    issuerViews.clear();
    document.getElementById('issuers').replaceChildren();
    document.getElementById('replay-result').replaceChildren();
  },
});
function admin(route, body) {
  return access.request(route, { body });
}

function filterIssuers() {
  const query = document.getElementById('issuer-search').value.trim().toLocaleLowerCase('de');
  const status = document.getElementById('issuer-filter').value;
  let visible = false;
  for (const view of issuerViews.values()) {
    view.node.hidden = !view.search.includes(query) || (status !== 'all' && status !== view.status);
    visible ||= !view.node.hidden;
  }
  document.getElementById('empty').hidden = issuerViews.size !== 0;
  document.getElementById('issuer-no-match').hidden = visible || issuerViews.size === 0;
}

function createIssuerView(issuer) {
  const view = { issuer, busy: false };
  view.name = el('strong');
  view.label = el('span', { class: 'muted' });
  view.badge = el('span');
  view.checkins = el('span', { class: 'issuer-checkins' });
  view.identity = el('p');
  view.did = el('p', { class: 'did' });
  view.fingerprint = el('p', { class: 'did fingerprint' });
  view.proof = el('p', { class: 'muted' });
  view.approve = el('button', { type: 'button' });
  view.approve.addEventListener('click', () => run(async () => {
    if (view.busy || view.issuer.state === 'approved') return;
    if (!confirm(`Organisation „${view.issuer.name}“ freigeben? Ihren Ausweisen wird dann beim Check-In vertraut.`)) return;
    view.busy = true;
    updateIssuerActions(view);
    try {
      await admin(`/issuers/${encodeURIComponent(issuer.did)}/trust`, { trusted: true });
      notify(`Organisation „${view.issuer.name}“ freigegeben. Sie kann jetzt am Laptop Ausweise ausstellen.`);
      await refresh();
    } finally {
      view.busy = false;
      updateIssuerActions(view);
    }
  }));
  view.revoke = el('button', { type: 'button', class: 'secondary danger' }, 'Organisation sperren');
  view.revoke.addEventListener('click', () => run(async () => {
    if (view.busy || view.issuer.state !== 'approved') return;
    const current = view.issuer;
    if (!confirm(`Organisation „${current.name}“ sperren? Ihre Ausweise werden bei künftigen Check-ins abgelehnt. Das widerruft keine einzelnen Ausweise und ändert keine historischen Protokolle.`)) return;
    view.busy = true;
    updateIssuerActions(view);
    try {
      await admin(`/issuers/${encodeURIComponent(issuer.did)}/trust`, { trusted: false });
      notify('Organisation gesperrt. Bestehende Check-in-Protokolle bleiben als historischer Stand erhalten.');
      await refresh();
    } finally {
      view.busy = false;
      updateIssuerActions(view);
    }
  }));
  view.recoveryLink = el('input', { type: 'text', readonly: true, autocomplete: 'off', spellcheck: 'false' });
  view.recoveryExpiry = el('p', { class: 'muted' });
  view.copyRecovery = action(el('button', { type: 'button', class: 'secondary' }, 'Privaten Link kopieren'), async () => {
    if (!navigator.clipboard) throw new Error('Kopieren ist hier nicht möglich. Markiere den privaten Link im Feld und kopiere ihn manuell.');
    await navigator.clipboard.writeText(view.recoveryLink.value);
    notify('Privaten Wiederherstellungslink kopiert. Nur der berechtigten Organisation mitteilen.');
  });
  view.recoveryResult = el('div', { class: 'stack organisation-recovery-result', hidden: true },
    el('label', { class: 'field' }, 'Privater, einmaliger Wiederherstellungslink', view.recoveryLink),
    view.recoveryExpiry, view.copyRecovery,
    el('p', { class: 'muted' }, 'Falls Kopieren nicht erlaubt ist: das Feld markieren und den Link manuell kopieren.'),
    el('p', { class: 'message warning' }, 'Nicht veröffentlichen, nicht am Kiosk zeigen. Dies ist kein Host-Admin-Token. Nur der berechtigten Organisation über einen privaten Kanal geben. Der Link ersetzt keine Freigabe.'));
  view.recover = el('button', { type: 'button', class: 'secondary' }, 'Privaten Wiederherstellungslink erstellen');
  view.recover.addEventListener('click', () => run(async () => {
    if (view.busy) return;
    if (!confirm(`Browserzugang für „${view.issuer.name}“ wiederherstellen? Prüfe zuerst die Berechtigung. Sobald der einmalige Link erfolgreich geöffnet und eingelöst wurde, wird der bisherige Organisationszugang ungültig.`)) return;
    const generation = accessGeneration;
    view.busy = true;
    view.recoveryResult.hidden = true;
    view.recoveryLink.value = '';
    view.recoveryExpiry.textContent = '';
    updateIssuerActions(view);
    try {
      const result = await admin(`/organisations/${encodeURIComponent(view.issuer.id)}/recovery`, {});
      if (!unlocked || generation !== accessGeneration || issuerViews.get(issuer.did) !== view) return;
      if (!result?.url || !Number.isFinite(Date.parse(result.expiresAt))) {
        throw new Error('Der Server hat keinen gültigen Wiederherstellungslink mit Ablaufzeit geliefert.');
      }
      view.recoveryLink.value = result.url;
      view.recoveryExpiry.textContent = `Gültig bis ${formatTime(result.expiresAt)} · nur einmal einlösbar.`;
      view.recoveryResult.hidden = false;
      view.recoveryLink.focus();
      view.recoveryLink.select();
      notify('Privater Wiederherstellungslink erstellt. Der alte Browserzugang bleibt bis zur erfolgreichen Einlösung gültig.');
    } finally {
      view.busy = false;
      updateIssuerActions(view);
    }
  }));
  view.recovery = el('details', { class: 'organisation-recovery' },
    el('summary', {}, 'Organisationszugang wiederherstellen · nur Host'),
    el('p', {}, 'Nur nach Prüfung der Berechtigung: Der Link ist privat, läuft ab und kann einmal eingelöst werden. Erfolgreiches Einlösen widerruft den bisherigen Browserzugang dieser Organisation. Name, Schlüssel, Ausweise und Freigabestatus bleiben unverändert.'),
    view.recover, view.recoveryResult);
  view.metadata = raw({}, 'Öffentliche Organisationsdaten');
  view.node = el('details', { class: 'issuer-registration' },
    el('summary', {},
      el('span', { class: 'issuer-heading' }, view.name, view.label),
      el('span', { class: 'issuer-status' }, view.badge, view.checkins)),
    el('div', { class: 'issuer-approval' }, view.identity, view.did, view.fingerprint, view.proof,
      el('div', { class: 'actions' }, view.approve, view.revoke), view.metadata, view.recovery));
  return view;
}

function updateIssuerActions(view) {
  view.approve.disabled = view.busy || view.issuer.state === 'approved';
  view.revoke.disabled = view.busy || view.issuer.state !== 'approved';
  view.recover.disabled = view.busy;
}

function updateIssuerView(view, issuer) {
  const signature = JSON.stringify(issuer);
  if (signature === view.signature) return;
  view.signature = signature;
  view.issuer = issuer;
  view.status = issuer.state;
  view.name.textContent = issuer.name;
  view.label.textContent = issuer.did;
  view.badge.className = `badge ${issuer.state === 'approved' ? '' : 'badge-warn'}`;
  view.badge.textContent = { pending: 'Ausstehend · Freigabe fehlt', approved: 'Freigegeben · aktuell vertraut', suspended: 'Gesperrt · aktuell nicht vertraut' }[issuer.state];
  view.checkins.textContent = `${issuer.checkinCount} erfolgreiche Check-in(s)`;
  view.identity.textContent = `Organisation: ${issuer.name} · Name nach Registrierung unveränderlich.`;
  view.did.textContent = `Öffentliche DID: ${issuer.did}`;
  view.fingerprint.textContent = `Fingerabdruck: ${issuer.fingerprint}`;
  view.proof.textContent = 'Der zentrale Server erzeugt und speichert für jede Organisation einen eigenen dauerhaften Signaturschlüssel. Vergleiche Name, DID und Fingerabdruck mit dem Organisationsbildschirm am Laptop.';
  view.approve.textContent = issuer.state === 'approved' ? 'Organisation freigegeben'
    : issuer.state === 'suspended' ? 'Organisation erneut freigeben' : 'Organisation freigeben';
  updateIssuerActions(view);
  view.metadata.querySelector('pre').textContent = JSON.stringify({
    id: issuer.id, name: issuer.name, did: issuer.did, fingerprint: issuer.fingerprint,
    publicUrl: issuer.publicUrl, statusListUrl: issuer.statusListUrl,
    state: issuer.state, trusted: issuer.trusted, proofVerified: issuer.proofVerified,
    createdAt: issuer.createdAt, approvedAt: issuer.approvedAt,
  }, null, 2);
  view.search = [issuer.name, issuer.did, issuer.fingerprint]
    .filter(Boolean).join(' ').toLocaleLowerCase('de');
}

async function refresh() {
  const version = ++refreshVersion;
  const { issuers, stats } = await api('/dashboard');
  if (!unlocked || version !== refreshVersion) return;
  for (const [id, value] of [['registered-count', stats.registered], ['checkin-count', stats.checkins]]) {
    const node = document.getElementById(id);
    if (node.textContent !== String(value)) node.textContent = value;
  }
  const present = new Set(issuers.map((issuer) => issuer.did));
  for (const [did, view] of issuerViews) {
    if (!present.has(did)) {
      view.node.remove();
      issuerViews.delete(did);
    }
  }
  for (const issuer of issuers) {
    let view = issuerViews.get(issuer.did);
    if (!view) {
      view = createIssuerView(issuer);
      issuerViews.set(issuer.did, view);
      document.getElementById('issuers').prepend(view.node);
    }
    updateIssuerView(view, issuer);
  }
  filterIssuers();
}

async function watch() {
  if (stopped) return;
  try {
    await access.request('/session');
    if (!stopped) await refresh();
  } catch (error) { showError(error); }
  if (!stopped) refreshTimer = setTimeout(watch, 5000);
}

run(async () => {
  document.getElementById('issuer-search').addEventListener('input', filterIssuers);
  document.getElementById('issuer-filter').addEventListener('change', filterIssuers);
  action(document.getElementById('refresh'), refresh);
  action(document.getElementById('replay'), async () => {
    const result = await admin('/replay', {});
    document.getElementById('replay-result').replaceChildren(
      el('h3', {}, result.ok ? 'Unerwartet akzeptiert' : 'Replay erkannt'), steps(result), raw(result));
  });
  action(document.getElementById('reset'), async () => {
    if (!confirm('Alle öffentlichen Check-in-Protokolle und laufenden Anfragen löschen? Die Vertrauensliste bleibt bestehen.')) return;
    await admin('/reset', {});
    notify('Check-ins und Anfragen geleert.');
    await refresh();
  });
  await setupPage();
  await access.start();
});
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(refreshTimer); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted && unlocked) { stopped = false; run(watch); }
});
