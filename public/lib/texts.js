export const texts = {
  keypair: 'Dein Handy hat gerade ein Schlüsselpaar erzeugt. Der private Schlüssel bleibt in diesem Browser und verlässt ihn nie. Mit ihm beweist du später, dass ein Nachweis wirklich dir gehört.',
  did: 'Eine DID (Decentralized Identifier) ist eine Kennung, die du selbst erzeugst – ohne Anmeldung bei einer zentralen Stelle. Diese hier (did:jwk) enthält direkt deinen öffentlichen Schlüssel. Wer sie kennt, kann deine Signaturen prüfen.',
  issuer: 'Ein Issuer stellt Nachweise aus, zum Beispiel ein Amt, eine Hochschule oder ein Arbeitgeber. Auch er hat ein Schlüsselpaar und eine DID. Damit andere seinen Nachweisen glauben, muss er auf einer Vertrauensliste stehen. In der echten EUDI-Welt pflegen das die Mitgliedstaaten.',
  credential: 'Der Gastausweis ist ein Verifiable Credential: Der Issuer hat ihn mit seinem privaten Schlüssel signiert. Jede Veränderung würde die Signatur ungültig machen. Er ist außerdem an den Schlüssel deiner Wallet gebunden.',
  sd: 'Im signierten Teil stehen deine Angaben nur als Hashwerte. Die Klartexte (Disclosures) hält deine Wallet. Beim Vorzeigen gibst du nur die Disclosures heraus, die du teilen willst – der Rest bleibt verborgen. Das heißt Selective Disclosure.',
  binding: 'Der Empfang schickt eine Zufallszahl (Nonce). Deine Wallet unterschreibt sie mit deinem privaten Schlüssel. So sieht der Empfang: Der Nachweis wird gerade von seinem rechtmäßigen Besitzer vorgezeigt und ist keine alte Kopie.',
  verify: 'Der Empfang prüft: Steht der Issuer auf der Vertrauensliste? Ist die Signatur echt? Passen die freigegebenen Angaben zu den Hashwerten? Ist der Nachweis noch gültig? Stammt er von der richtigen Wallet und wurde er frisch erzeugt?',
  real: 'Das ist eine Simulation zum Lernen. Die echte EUDI Wallet nutzt dieselben Bausteine, aber zertifizierte Apps, staatliche Vertrauenslisten und die Protokolle OpenID4VCI und OpenID4VP.',
};
