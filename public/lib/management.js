import { api, el, action, formAction, clearError, run } from './ui.js';

export function consumeAdminToken(url = new URL(location.href), browserHistory = history) {
  const fragment = new URLSearchParams(url.hash.slice(1));
  const token = fragment.get('admin-token');
  if (token !== null) {
    fragment.delete('admin-token');
    url.hash = fragment.toString();
    browserHistory.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  }
  return token;
}

export function managementAccess({ prefix, content, onUnlock, onLock = () => {} }) {
  const key = `eudi-management:${prefix}`;
  let linkToken = consumeAdminToken();
  let started = false;
  let token = '';
  let generation = 0;
  const panel = el('section', { class: 'card stack' });
  content.before(panel);
  content.hidden = true;

  function lock() {
    generation += 1;
    token = '';
    sessionStorage.removeItem(key);
    content.hidden = true;
    onLock();
    const input = el('input', {
      name: 'token', type: 'password', required: true, autocomplete: 'off',
      placeholder: 'Admin-Token aus den Server-Logs',
    });
    panel.replaceChildren(el('h2', {}, 'Verwaltung freischalten'),
      el('p', {}, 'Dieser Zugang ist nur für den Host. Öffne den privaten Freischalt-Link aus den Server-Logs oder gib den dort erzeugten Admin-Token ein. Organisationseinrichtung, Wallet und Check-in benötigen keinen Admin-Token.'),
      formAction(el('form', { class: 'stack' },
        el('label', { class: 'field' }, 'Admin-Token', input),
        el('button', { type: 'submit' }, 'Verwaltung freischalten')),
      (data) => unlock(String(data.get('token')).trim())),
      el('p', { class: 'muted' }, 'Gilt nur für diesen Browser-Tab. Bei jedem Serverneustart entsteht ein neuer Token. Link und Token nicht weitergeben.'));
  }

  async function unlock(candidate) {
    const current = ++generation;
    await api(`${prefix}/session`, { adminToken: candidate });
    if (current !== generation) return;
    token = candidate;
    sessionStorage.setItem(key, token);
    content.hidden = false;
    clearError();
    panel.replaceChildren(el('div', { class: 'card-top' },
      el('p', {}, 'Verwaltung für diesen Tab freigeschaltet.'),
      action(el('button', { type: 'button', class: 'secondary' }, 'Verwaltung sperren'), () => {
        lock();
        clearError();
      })));
    await onUnlock();
  }

  window.addEventListener('hashchange', () => {
    const candidate = consumeAdminToken();
    if (candidate === null) return;
    linkToken = candidate;
    if (started) {
      lock();
      run(() => unlock(candidate));
    }
  });

  return {
    async request(route, options = {}) {
      const current = generation;
      try {
        return await api(`${prefix}${route}`, { ...options, adminToken: token });
      } catch (error) {
        if (error.status === 401 && current === generation) lock();
        throw error;
      }
    },
    async start() {
      started = true;
      const candidate = linkToken ?? sessionStorage.getItem(key);
      lock();
      if (candidate) await unlock(candidate);
    },
  };
}
