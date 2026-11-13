export const verificationChecks = [
  'Nachweis und Schlüsselbeweis lesen',
  'Vertrauen zur ausstellenden Organisation prüfen',
  'Digitale Signatur des Ausweises prüfen',
  'Gültigkeitsdauer prüfen',
  'Geteilte Angaben mit den signierten Hashes abgleichen',
  'Besitz des Wallet-Schlüssels prüfen',
  'Einmalige Anfrage und richtigen Check-In prüfen',
  'Aktuelle signierte Widerrufsliste prüfen',
];

export async function readVerificationStream(response, onProgress) {
  if (!response.body) throw new Error('Der Server hat keinen Prüfverlauf gesendet.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';
  let received = 0;
  let completed = 0;
  let frames = 0;
  let result;
  function consume(line) {
    if (!line.trim()) return;
    if (result || ++frames > 12) throw new Error('Der Prüfverlauf enthält unerwartete Nachrichten.');
    const frame = JSON.parse(line);
    if (frame.type === 'result' && typeof frame.result?.ok === 'boolean' && Array.isArray(frame.result.steps)) {
      if (frame.result.ok && frame.result.steps.length !== verificationChecks.length) {
        throw new Error('Der erfolgreiche Prüfverlauf ist unvollständig.');
      }
      result = frame.result;
      return;
    }
    if (frame.type !== 'progress' || frame.total !== verificationChecks.length
      || !Number.isInteger(frame.completed) || frame.completed < completed || frame.completed > frame.total
      || !Array.isArray(frame.steps) || frame.steps.length !== frame.completed
      || frame.steps.some((step) => typeof step !== 'string' || step.length > 2000)) {
      throw new Error('Der Server hat einen ungültigen Prüfverlauf gesendet.');
    }
    completed = frame.completed;
    onProgress({ completed, total: frame.total, steps: frame.steps });
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > 65536) throw new Error('Der Prüfverlauf ist zu groß.');
      buffer += decoder.decode(value, { stream: true });
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        consume(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
      }
    }
    buffer += decoder.decode();
    consume(buffer);
    if (!result) throw new Error('Die Verbindung endete ohne bestätigtes Prüfergebnis. Prüfe die Check-In-Anzeige.');
    return result;
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}
