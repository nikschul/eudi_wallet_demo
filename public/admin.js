import { el, api, steps, raw, shortDid, action, formAction, run, setupPage, notify, showError } from './lib/ui.js';

let token = '';
function admin(route, body) {
  if (!token) throw new Error('Bitte gib zuerst das Admin-Token ein.');
  return api(`/admin${route}`, { body, token });
}

async function refresh() {
  const [issuers, config] = await Promise.all([api('/issuers'), api('/config')]);
  document.getElementById('mode').value = config.trustMode;
  document.getElementById('empty').hidden = issuers.length !== 0;
  document.getElementById('issuers').replaceChildren(...issuers.map((issuer) => {
    const checkbox = el('input', {
      type: 'checkbox', checked: issuer.trusted, 'aria-label': `${issuer.name} vertrauen`,
    });
    checkbox.addEventListener('change', () => run(async () => {
      checkbox.disabled = true;
      try {
        await admin(`/issuers/${encodeURIComponent(issuer.did)}/trust`, { trusted: checkbox.checked });
        notify(`Vertrauensstatus für ${issuer.name} gespeichert.`);
        await refresh();
      } catch (error) {
        checkbox.checked = issuer.trusted;
        throw error;
      } finally {
        checkbox.disabled = false;
      }
    }));
    return el('tr', {}, el('td', {}, issuer.name),
      el('td', {}, el('span', { class: 'did', title: issuer.did }, shortDid(issuer.did)), raw({ did: issuer.did })),
      el('td', {}, checkbox));
  }));
}

run(async () => {
  try {
    token = sessionStorage.getItem('adminToken') || '';
    document.getElementById('token').value = token;
  } catch (error) {
    showError(new Error('Das Admin-Token kann in diesem Browser nicht für die Sitzung gespeichert werden. Du kannst es trotzdem eingeben.', { cause: error }));
  }
  formAction(document.getElementById('token-form'), async (data) => {
    token = data.get('token').trim();
    if (!token) throw new Error('Bitte gib ein Admin-Token ein.');
    try {
      sessionStorage.setItem('adminToken', token);
    } catch (error) {
      throw new Error('Das Token gilt für diese Seite, konnte aber nicht für die Sitzung gespeichert werden.', { cause: error });
    }
    notify('Token übernommen. Es wird bei der nächsten Admin-Aktion geprüft.');
    await refresh();
  });
  formAction(document.getElementById('mode-form'), async (data) => {
    await admin('/trust-mode', { mode: data.get('mode') });
    notify('Vertrauensmodus gespeichert.');
    await refresh();
  });
  action(document.getElementById('refresh'), refresh);
  action(document.getElementById('replay'), async () => {
    const result = await admin('/replay', {});
    document.getElementById('replay-result').replaceChildren(
      el('h3', {}, result.ok ? 'Unerwartet akzeptiert' : 'Replay erkannt'),
      steps(result), raw(result));
  });
  action(document.getElementById('reset'), async () => {
    if (!confirm('Check-in-Liste und alle laufenden Anfragen wirklich leeren? Die Issuer bleiben erhalten.')) return;
    await admin('/reset', {});
    notify('Check-in-Liste und Anfragen geleert.');
    await refresh();
  });
  await setupPage();
  await refresh();
});
