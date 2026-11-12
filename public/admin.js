import { el, api, steps, raw, action, formAction, run, setupPage, notify, showError } from './lib/ui.js';

let token = '';
let lastIssuers;
let refreshTimer;
let stopped = false;
function admin(route, body) {
  if (!token) throw new Error('Bitte gib zuerst das Admin-Token der Workshop-Zentrale ein, nicht das Token eines Issuers.');
  return api(`/admin${route}`, { body, token });
}

async function refresh(force = false) {
  const issuers = await api('/issuers');
  document.getElementById('trust-summary').textContent = `${issuers.length} registriert · ${issuers.filter((issuer) => issuer.trusted && issuer.proofVerified).length} freigegeben · ${issuers.filter((issuer) => !issuer.trusted || !issuer.proofVerified).length} warten auf Prüfung`;
  document.getElementById('empty').hidden = issuers.length !== 0;
  const json = JSON.stringify(issuers);
  if (!force && json === lastIssuers) return;
  lastIssuers = json;
  document.getElementById('issuers').replaceChildren(...issuers.map((issuer) => {
    const assigned = el('input', {
      name: 'ownerName', required: true, maxlength: 120, value: issuer.ownerName || issuer.employeeName || '',
      placeholder: 'Geprüfter Name der Person', autocomplete: 'off',
    });
    const approve = el('button', { type: 'submit', disabled: !issuer.proofVerified }, issuer.trusted ? 'Zuordnung bestätigen' : 'Diesem Issuer vertrauen');
    const form = formAction(el('form', { class: 'inline-form' },
      el('label', { class: 'field grow' }, 'Dieser Issuer gehört zu Mitarbeitendem', assigned), approve), async (data) => {
      const ownerName = data.get('ownerName').trim();
      if (!ownerName) throw new Error('Trage zuerst ein, zu welcher Person dieser Issuer gehört.');
      await admin(`/issuers/${encodeURIComponent(issuer.did)}/trust`, { trusted: true, ownerName });
      notify(`Der Empfang vertraut jetzt dem Issuer von ${ownerName}. Bitte einen neuen Check-in-QR scannen.`);
      await refresh(true);
    });
    const revoke = action(el('button', { type: 'button', class: 'secondary danger', disabled: !issuer.trusted }, 'Vertrauen entziehen'), async () => {
      if (!confirm(`Dem Issuer von ${issuer.ownerName || issuer.employeeName || issuer.name} das Vertrauen entziehen? Bereits ausgestellte Ausweise werden beim nächsten Check-in abgelehnt.`)) return;
      await admin(`/issuers/${encodeURIComponent(issuer.did)}/trust`, { trusted: false });
      notify('Vertrauen entzogen. Bestehende Check-in-Protokolle bleiben als historischer Stand erhalten.');
      await refresh(true);
    });
    return el('article', { class: 'issuer-approval' },
      el('div', { class: 'card-top' }, el('h3', {}, issuer.name),
        el('span', { class: `badge ${issuer.trusted && issuer.proofVerified ? '' : 'badge-warn'}` },
          issuer.trusted && issuer.proofVerified ? 'Vertrauenswürdig' : 'Wartet auf Freigabe')),
      el('p', {}, `Angemeldet als: ${issuer.employeeName || 'Altbestand – erneute Anmeldung erforderlich'}`),
      el('p', { class: 'did fingerprint' }, `Fingerabdruck: ${issuer.fingerprint || 'kein Schlüsselbeweis'}`),
      el('p', { class: 'muted' }, issuer.proofVerified ? '✓ Schlüsselbesitz nachgewiesen. Person jetzt außerhalb der App zuordnen.'
        : 'Dieser Eintrag stammt aus der alten Demo und kann nicht ohne neue Anmeldung freigegeben werden.'),
      form, revoke, raw({
        did: issuer.did, publicUrl: issuer.publicUrl, proofVerified: issuer.proofVerified,
        approvedFor: issuer.ownerName, trustedAt: issuer.trustedAt,
      }, 'Öffentliche Issuer-Daten'));
  }));
}

async function watch() {
  if (stopped) return;
  try { await refresh(); } catch (error) { showError(error); }
  if (!stopped) refreshTimer = setTimeout(watch, 5000);
}

run(async () => {
  try {
    token = sessionStorage.getItem('adminToken') || '';
    document.getElementById('token').value = token;
  } catch (error) {
    showError(new Error('Das Token kann hier nicht für die Sitzung gespeichert werden. Du kannst es trotzdem eingeben.', { cause: error }));
  }
  formAction(document.getElementById('token-form'), async (data) => {
    token = data.get('token').trim();
    if (!token) throw new Error('Bitte gib ein Admin-Token ein.');
    try { sessionStorage.setItem('adminToken', token); } catch (error) {
      throw new Error('Das Token gilt für diese Seite, konnte aber nicht für die Sitzung gespeichert werden.', { cause: error });
    }
    notify('Token übernommen. Bei der nächsten Freigabe wird es geprüft.');
    await refresh(true);
  });
  action(document.getElementById('refresh'), () => refresh(true));
  action(document.getElementById('replay'), async () => {
    const result = await admin('/replay', {});
    document.getElementById('replay-result').replaceChildren(
      el('h3', {}, result.ok ? 'Unerwartet akzeptiert' : 'Replay erkannt'), steps(result), raw(result));
  });
  action(document.getElementById('reset'), async () => {
    if (!confirm('Alle öffentlichen Check-in-Protokolle und laufenden Anfragen löschen? Die Vertrauensliste bleibt bestehen.')) return;
    await admin('/reset', {});
    notify('Check-ins und Anfragen geleert.');
  });
  await setupPage();
  await watch();
});
window.addEventListener('pagehide', () => { stopped = true; clearTimeout(refreshTimer); });
window.addEventListener('pageshow', (event) => {
  if (event.persisted) { stopped = false; run(watch); }
});
