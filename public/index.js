import { run, setupPage, readStored } from './lib/ui.js';

run(async () => {
  if (readStored('wallet')) {
    document.getElementById('wallet-hint').hidden = false;
    document.getElementById('wallet-start').textContent = 'Vorhandene Wallet öffnen';
  }
  const config = await setupPage();
  document.getElementById('organisation-start').href = config.issuerSetupUrl;
  document.getElementById('wallet-start').href = new URL('/wallet.html', config.publicUrl).href;
});
