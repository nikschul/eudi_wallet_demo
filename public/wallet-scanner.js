import { decodeOffer, publicOrigin } from './lib/protocol.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

export function validateWalletQr(value, configuredOrigin) {
  const invalid = () => new Error('Bitte scanne einen Ausstellungs- oder Empfangs-QR dieser Workshop-Zentrale.');
  if (typeof value !== 'string' || value.length > 8192) throw invalid();
  let url;
  try { url = new URL(value); } catch { throw invalid(); }
  if (url.origin !== publicOrigin(configuredOrigin, 'Workshop-Adresse') || url.pathname !== '/wallet.html'
    || url.username || url.password || url.search) throw invalid();
  if (url.hash.startsWith('#req=')) {
    if (!UUID.test(url.hash.slice(5))) throw invalid();
  } else {
    const offer = decodeOffer(url.hash);
    if (!offer || !UUID.test(offer.id)) throw invalid();
  }
  return url;
}

async function loadDecoder() {
  const [{ default: QrScanner }, { createWorker }] = await Promise.all([
    import('/vendor/qr-scanner/qr-scanner.min.js'),
    import('/vendor/qr-scanner/qr-scanner-worker.min.js'),
  ]);
  return {
    NO_QR_CODE_FOUND: QrScanner.NO_QR_CODE_FOUND,
    createQrEngine: createWorker,
    scanImage: (image, options) => QrScanner.scanImage(image, options),
  };
}

function cameraError(error) {
  if (['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error?.name)) {
    return 'Kamerazugriff nicht erlaubt. Erlaube die Kamera für diese Workshop-Adresse in den Browser-Einstellungen und versuche es erneut. Alternativ kannst du den QR-Link einfügen.';
  }
  if (['NotFoundError', 'DevicesNotFoundError', 'OverconstrainedError'].includes(error?.name)) {
    return 'Keine geeignete Kamera gefunden. Nutze ein Gerät mit Kamera oder füge den QR-Link ein.';
  }
  if (['NotReadableError', 'TrackStartError', 'AbortError'].includes(error?.name)) {
    return 'Die Kamera ist gerade nicht verfügbar. Schließe andere Kamera-Apps und versuche es erneut oder füge den QR-Link ein.';
  }
  return 'Der QR-Scanner konnte nicht gestartet oder ausgeführt werden. Prüfe deine Verbindung, lade die Wallet neu und versuche es erneut. Alternativ kannst du den QR-Link einfügen.';
}

export function createCameraScanner({
  video, origin, onDecode, onState,
  decoderLoader = loadDecoder,
  mediaDevices = globalThis.navigator?.mediaDevices,
  secureContext = globalThis.isSecureContext,
  isHidden = () => document.hidden,
  schedule = (callback) => setTimeout(callback, 125),
  unschedule = (timer) => clearTimeout(timer),
}) {
  let session;

  function release(current) {
    if (!current) return;
    unschedule(current.timer);
    for (const [track, handler] of current.trackHandlers || []) track.removeEventListener('ended', handler);
    current.trackHandlers = [];
    for (const track of current.stream?.getTracks() || []) track.stop();
    current.stream = null;
    current.engine?.terminate?.();
    current.engine = null;
    if (current.attachedStream && video.srcObject === current.attachedStream) {
      video.pause();
      video.srcObject = null;
    }
  }

  function stop() {
    const previous = session;
    session = null;
    release(previous);
  }

  const active = (current) => session === current && !isHidden();

  function fail(current, message) {
    if (session !== current) return;
    stop();
    onState('error', message);
  }

  async function start() {
    stop();
    const current = {};
    session = current;
    onState('starting', 'Kamera wird geöffnet …');
    if (!secureContext) {
      fail(current, 'Die Kamera braucht eine sichere HTTPS-Adresse (oder localhost). Öffne die öffentliche Workshop-Adresse oder füge den QR-Link ein.');
      return;
    }
    if (!mediaDevices?.getUserMedia) {
      fail(current, 'Dieser Browser stellt keine Kamera bereit. Öffne die Wallet in Safari oder Chrome und erlaube die Kamera oder füge den QR-Link ein.');
      return;
    }
    if (!active(current)) { release(current); return; }
    try {
      // Own acquisition so a late permission response cannot attach to a closed view.
      current.stream = await mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' } } });
      if (!active(current)) { release(current); return; }
      current.attachedStream = current.stream;
      current.trackHandlers = current.stream.getTracks().map((track) => {
        const handler = () => fail(current, 'Die Kameraverbindung wurde unterbrochen. Versuche es erneut oder füge den QR-Link ein.');
        track.addEventListener('ended', handler);
        return [track, handler];
      });
      video.playsInline = true;
      video.muted = true;
      video.srcObject = current.stream;
      await video.play();
      if (!active(current)) { release(current); return; }
      current.decoder = await decoderLoader();
      if (!active(current)) { release(current); return; }
      current.engine = await current.decoder.createQrEngine();
      if (!active(current)) { release(current); return; }
      onState('scanning', 'Halte den Ausstellungs- oder Empfangs-QR in die Kamera. Es werden keine Bilder übertragen.');
      current.timer = schedule(() => scan(current));
    } catch (error) {
      if (active(current)) fail(current, cameraError(error));
      else release(current);
    }
  }

  async function scan(current) {
    if (!active(current)) { release(current); return; }
    let url;
    try {
      if (video.readyState >= 2 && video.videoWidth && video.videoHeight) {
        const scale = Math.min(1, 960 / Math.max(video.videoWidth, video.videoHeight));
        const result = await current.decoder.scanImage(video, {
          qrEngine: current.engine, returnDetailedScanResult: true,
          scanRegion: {
            x: 0, y: 0, width: video.videoWidth, height: video.videoHeight,
            downScaledWidth: Math.round(video.videoWidth * scale),
            downScaledHeight: Math.round(video.videoHeight * scale),
          },
        });
        if (!active(current)) { release(current); return; }
        try { url = validateWalletQr(result.data, origin); } catch (error) {
          fail(current, error.message);
          return;
        }
      }
    } catch (error) {
      if (!active(current)) { release(current); return; }
      if (error !== current.decoder.NO_QR_CODE_FOUND) {
        fail(current, cameraError(error));
        return;
      }
    }
    if (url) {
      stop();
      onState('success', 'QR-Code erkannt. Die Kamera ist ausgeschaltet.');
      await onDecode(url);
      return;
    }
    if (active(current)) current.timer = schedule(() => scan(current));
  }

  return { start, stop };
}
