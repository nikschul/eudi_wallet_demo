import { run, setupPage, readStored } from './lib/ui.js';

run(async () => {
  if (readStored('wallet')) {
    document.getElementById('wallet-hint').hidden = false;
    document.querySelector('a.button').textContent = 'Vorhandene Wallet öffnen';
  }
  await setupPage();
});
