import { el, api, steps, raw, action, formAction, run, setupPage, notify, showError } from './lib/ui.js';
import { managementAccess } from './lib/management.js';

const issuerViews = new Map();
let refreshVersion = 0;
let refreshTimer;
let stopped = true;
let unlocked = false;
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
    stopped = true;
    refreshVersion += 1;
    clearTimeout(refreshTimer);
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
  const view = { issuer, savedOwner: issuer.ownerName || issuer.employeeName || '', busy: false };
  view.name = el('strong');
  view.label = el('span', { class: 'muted' });
  view.badge = el('span');
  view.checkins = el('span', { class: 'issuer-checkins' });
  view.employee = el('p');
  view.fingerprint = el('p', { class: 'did fingerprint' });
  view.proof = el('p', { class: 'muted' });
  view.assigned = el('input', {
    name: 'ownerName', required: true, maxlength: 120, value: view.savedOwner,
    placeholder: 'Geprüfter Name der Person', autocomplete: 'off',
  });
  view.approve = el('button', { type: 'submit' });
  const form = formAction(el('form', { class: 'inline-form' },
    el('label', { class: 'field grow' }, 'Dieser Issuer gehört zu Mitarbeitendem', view.assigned), view.approve),
    async (data) => {
      if (view.busy) return;
      if (!view.issuer.proofVerified) throw new Error('Zuerst muss der Issuer seinen Schlüsselbesitz nachweisen.');
      const ownerName = data.get('ownerName').trim();
      if (!ownerName) throw new Error('Trage zuerst ein, zu welcher Person dieser Issuer gehört.');
      view.busy = true;
      updateIssuerActions(view);
      try {
        await admin(`/issuers/${encodeURIComponent(issuer.did)}/trust`, { trusted: true, ownerName });
        notify(`Der Empfang vertraut jetzt dem Issuer von ${ownerName}. Das Issuer-Setup ist abgeschlossen; am Notebook kannst du jetzt Ausweise ausstellen.`);
        await refresh();
      } finally {
        view.busy = false;
        updateIssuerActions(view);
      }
    });
  view.revoke = el('button', { type: 'button', class: 'secondary danger' }, 'Vertrauen entziehen');
  view.revoke.addEventListener('click', () => run(async () => {
    if (view.busy || !view.issuer.trusted) return;
    const current = view.issuer;
    if (!confirm(`Dem Issuer von ${current.ownerName || current.employeeName || current.name} das Vertrauen entziehen? Bereits ausgestellte Ausweise werden beim nächsten Check-in abgelehnt.`)) return;
    view.busy = true;
    updateIssuerActions(view);
    try {
      await admin(`/issuers/${encodeURIComponent(issuer.did)}/trust`, { trusted: false });
      notify('Vertrauen entzogen. Bestehende Check-in-Protokolle bleiben als historischer Stand erhalten.');
      await refresh();
    } finally {
      view.busy = false;
      updateIssuerActions(view);
    }
  }));
  view.metadata = raw({}, 'Öffentliche Issuer-Daten');
  view.node = el('details', { class: 'issuer-registration' },
    el('summary', {},
      el('span', { class: 'issuer-heading' }, view.name, view.label),
      el('span', { class: 'issuer-status' }, view.badge, view.checkins)),
    el('div', { class: 'issuer-approval' }, view.employee, view.fingerprint, view.proof, form, view.revoke, view.metadata));
  return view;
}

function updateIssuerActions(view) {
  view.approve.disabled = view.busy || !view.issuer.proofVerified;
  view.revoke.disabled = view.busy || !view.issuer.trusted;
}

function updateIssuerView(view, issuer) {
  const signature = JSON.stringify(issuer);
  if (signature === view.signature) return;
  view.signature = signature;
  view.issuer = issuer;
  const trusted = issuer.trusted && issuer.proofVerified && issuer.ownerName;
  view.status = !issuer.proofVerified ? 'unverified' : trusted ? 'trusted' : 'untrusted';
  view.name.textContent = issuer.ownerName || issuer.employeeName || issuer.name;
  view.label.textContent = issuer.name;
  view.badge.className = `badge ${trusted ? '' : 'badge-warn'}`;
  view.badge.textContent = trusted ? 'Issuer vertrauenswürdig' : issuer.proofVerified
    ? 'Registriert · nicht vertraut' : 'Registriert · Schlüsselbeweis fehlt';
  view.checkins.textContent = `${issuer.checkinCount} erfolgreiche Check-in(s)`;
  view.employee.textContent = `Angemeldet als: ${issuer.employeeName || 'Altbestand – erneute Anmeldung erforderlich'}`;
  view.fingerprint.textContent = `Fingerabdruck: ${issuer.fingerprint || 'kein Schlüsselbeweis'}`;
  view.proof.textContent = issuer.proofVerified ? '✓ Schlüsselbesitz nachgewiesen. Person außerhalb der App zuordnen.'
    : 'Dieser Eintrag stammt aus der alten Demo. Vor der Vertrauensentscheidung muss sich der Issuer erneut registrieren.';
  const savedOwner = issuer.ownerName || issuer.employeeName || '';
  if (view.assigned.value === view.savedOwner && document.activeElement !== view.assigned) {
    view.assigned.value = savedOwner;
  }
  view.savedOwner = savedOwner;
  view.approve.textContent = issuer.trusted ? 'Zuordnung bestätigen' : 'Diesem Issuer vertrauen';
  updateIssuerActions(view);
  view.metadata.querySelector('pre').textContent = JSON.stringify({
    did: issuer.did, publicUrl: issuer.publicUrl, proofVerified: issuer.proofVerified,
    approvedFor: issuer.ownerName, trustedAt: issuer.trustedAt,
  }, null, 2);
  view.search = [issuer.name, issuer.ownerName, issuer.employeeName, issuer.did, issuer.fingerprint]
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
