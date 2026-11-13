import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fixture } from './helpers/hosted.js';

const source = (file) => readFile(new URL(`../public/${file}`, import.meta.url), 'utf8');

test('The landing page is the live Check-In and old kiosk links lead to the same entry point', async (t) => {
  const f = await fixture(t);
  const root = await f.call('/');
  assert.equal(root.status, 200);
  assert.match(root.data, /id="checkin-qr"/);
  assert.match(root.data, /src="\/kiosk.js"/);
  assert.match(root.data, /id="wallet-start"[^>]+href="\/wallet.html"[^>]*>Wallet öffnen/);
  for (const route of ['/kiosk', '/kiosk.html']) {
    const response = await fetch(`${f.base}${route}?display=tv`, { redirect: 'manual' });
    assert.equal(response.status, 302);
    assert.equal(response.headers.get('location'), '/?display=tv');
    assert.equal((await f.call(route)).data, root.data);
  }
});

test('Every app area has the same navigation, neutral branding and its own area theme', async () => {
  for (const [file, area, current] of [
    ['index.html', 'checkin', '/'],
    ['issuer.html', 'issuer', '/issuer.html'],
    ['wallet.html', 'wallet', '/wallet.html'],
    ['admin.html', 'checkin', undefined],
  ]) {
    const html = await source(file);
    assert.match(html, new RegExp(`<body[^>]+data-area="${area}"`), file);
    assert.match(html, /Wallet &amp; Check-In/, file);
    assert.doesNotMatch(html, /EUDI|Empfang|Wallet schon|HttpOnly/, file);
    const header = html.match(/<header\b[\s\S]*?<\/header>/)?.[0];
    assert.ok(header, file);
    const nav = header.match(/<nav\b[\s\S]*?<\/nav>/)?.[0];
    assert.ok(nav, file);
    assert.doesNotMatch(nav, /target="_blank"|neuer Tab/, file);
    const links = [...nav.matchAll(/<a\b([^>]*)>([^<]*)<\/a>/g)];
    assert.deepEqual(links.map(([, attrs, label]) => [attrs.match(/href="([^"]*)"/)?.[1], label.trim()]),
      [['/', 'Check-In'], ['/issuer.html', 'Aussteller'], ['/wallet.html', 'Wallet']], file);
    const active = links.filter(([, attrs]) => attrs.includes('aria-current="page"'));
    assert.equal(active.length, current ? 1 : 0, file);
    if (current) assert.ok(active[0][1].includes(`href="${current}"`), file);
  }
});

test('Only the organisation setup entry opens a separate, isolated tab', async () => {
  const html = await source('index.html');
  const links = [...html.matchAll(/<a\b([^>]*href="\/issuer.html"[^>]*)>/g)];
  assert.equal(links.length, 2);
  for (const [, attributes] of links) {
    if (attributes.includes('id="issuer-setup-link"')) {
      assert.match(attributes, /target="_blank"/);
      assert.match(attributes, /rel="noopener noreferrer"/);
    } else {
      assert.doesNotMatch(attributes, /target=|neuer Tab/);
    }
  }
});

test('Installed wallet retains its direct entry point and generic app name', async () => {
  const manifest = JSON.parse(await source('manifest.webmanifest'));
  assert.equal(manifest.name, 'Wallet & Check-In');
  assert.equal(manifest.start_url, '/wallet.html');
  const wallet = await source('wallet.js');
  assert.doesNotMatch(wallet, /Wallet schon erstellt|Wallet auf diesem Handy erstellen|function journey/);
  const page = await source('wallet.html');
  assert.match(page, /<button[^>]+id="install"[^>]+hidden/);
});
