import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { createCameraScanner, validateWalletQr } from '../public/wallet-scanner.js';
import { generateKeyPair, jsonB64 } from '../public/lib/sdjwt.js';

const origin = 'https://workshop.example.org';
const requestUrl = `${origin}/wallet.html#req=46841686-66d6-4fdb-b7ca-a3a6cd9ac79d`;

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function stream() {
  const tracks = [new EventTarget(), new EventTarget()];
  for (const track of tracks) {
    track.stops = 0;
    track.stop = () => { track.stops++; };
  }
  return { getTracks: () => tracks };
}

function fixture(options = {}) {
  const cameraStream = stream();
  const states = [];
  const decoded = [];
  const constraints = [];
  const frames = new Map();
  let frameId = 0;
  let hidden = false;
  const engine = { terminations: 0, terminate() { this.terminations++; } };
  const video = {
    srcObject: null, readyState: 4, videoWidth: 1280, videoHeight: 720,
    pauses: 0, pause() { this.pauses++; }, play: async () => {},
  };
  const decoder = {
    NO_QR_CODE_FOUND: 'No QR code found',
    createQrEngine: async () => engine,
    scanImage: async () => { throw decoder.NO_QR_CODE_FOUND; },
  };
  const scanner = createCameraScanner({
    video, origin,
    onState: (state, message) => states.push({ state, message }),
    onDecode: (url) => {
      assert.equal(video.srcObject, null, 'Stop the stream before navigation starts');
      assert.ok(cameraStream.getTracks().every((track) => track.stops > 0));
      assert.equal(engine.terminations, 1, 'Terminate the decoder before navigation starts');
      decoded.push(url.href);
    },
    decoderLoader: async () => decoder,
    mediaDevices: {
      getUserMedia: async (value) => { constraints.push(value); return cameraStream; },
    },
    secureContext: true,
    isHidden: () => hidden,
    schedule: (callback) => { frames.set(++frameId, callback); return frameId; },
    unschedule: (id) => frames.delete(id),
    ...options,
  });
  return {
    scanner, states, decoded, cameraStream, engine, video, decoder, frames, constraints,
    hide: () => { hidden = true; scanner.stop(); },
    async frame() {
      const [id, callback] = frames.entries().next().value;
      frames.delete(id);
      await callback();
    },
  };
}

test('QR validation accepts only central wallet UUID requests or DID offers, never arbitrary navigation', async () => {
  assert.equal(validateWalletQr(requestUrl, origin).href, requestUrl);
  const issuer = await generateKeyPair();
  const offer = { issuer: issuer.did, id: crypto.randomUUID(), token: 'a'.repeat(43) };
  const offerUrl = `${origin}/wallet.html#offer=${jsonB64(offer)}`;
  assert.equal(validateWalletQr(offerUrl, origin).href, offerUrl);
  for (const value of [
    'not a URL', '/wallet.html#req=46841686-66d6-4fdb-b7ca-a3a6cd9ac79d',
    requestUrl.replace(origin, 'https://external.example.org'),
    requestUrl.replace(origin, `${origin}.attacker.example.org`),
    requestUrl.replace('https://', 'http://'), requestUrl.replace('https://', 'https://user:password@'),
    requestUrl.replace('/wallet.html', '/admin.html'), requestUrl.replace('#req=', '?req='),
    requestUrl.replace('#req=', '?next=external#req='), `${origin}/wallet.html`,
    `${origin}/wallet.html#req=${'a'.repeat(36)}`, `${requestUrl}&other=1`,
    `${origin}/wallet.html#offer=bad`, `${origin}/wallet.html#offer=${jsonB64({ ...offer, issuer: origin })}`,
    `${origin}/wallet.html#offer=${jsonB64({ ...offer, id: 'a'.repeat(36) })}`,
    `${origin}/wallet.html#offer=${jsonB64({ ...offer, token: '' })}`,
    offerUrl.replace(origin, 'https://external.example.org'), 'a'.repeat(8193),
  ]) {
    assert.throws(() => validateWalletQr(value, origin), /QR|Angebot/);
  }
});

test('Camera is user-started, rear-facing, inline and local; success stops every track/worker before exactly one callback', async () => {
  const state = fixture();
  assert.equal(state.constraints.length, 0);
  assert.deepEqual(state.states, []);
  await state.scanner.start();
  assert.deepEqual(state.constraints, [{ audio: false, video: { facingMode: { ideal: 'environment' } } }]);
  assert.equal(state.video.playsInline, true);
  assert.equal(state.video.muted, true);
  assert.strictEqual(state.video.srcObject, state.cameraStream);
  state.decoder.scanImage = async (video, options) => {
    assert.strictEqual(video, state.video);
    assert.strictEqual(options.qrEngine, state.engine);
    assert.equal(options.returnDetailedScanResult, true);
    assert.equal(options.scanRegion.downScaledWidth, 960);
    assert.equal(options.scanRegion.downScaledHeight, 540);
    return { data: requestUrl };
  };
  const duplicate = [...state.frames.values()][0];
  await state.frame();
  await duplicate();
  assert.deepEqual(state.decoded, [requestUrl]);
  assert.equal(state.frames.size, 0);
  assert.equal(state.engine.terminations, 1);
  assert.ok(state.cameraStream.getTracks().every((track) => track.stops === 1));
});

test('Permission denial, missing/in-use camera, insecure contexts and decoder failures have explicit retryable errors', async () => {
  for (const [name, expected] of [
    ['NotAllowedError', /nicht erlaubt/], ['SecurityError', /nicht erlaubt/],
    ['NotFoundError', /Keine geeignete Kamera/], ['NotReadableError', /gerade nicht verfügbar/],
  ]) {
    const state = fixture({
      mediaDevices: { getUserMedia: async () => { throw Object.assign(new Error('private data'), { name }); } },
    });
    await state.scanner.start();
    assert.equal(state.states.at(-1).state, 'error');
    assert.match(state.states.at(-1).message, expected);
    assert.doesNotMatch(state.states.at(-1).message, /private data/);
    assert.equal(state.frames.size, 0);
  }
  for (const options of [{ secureContext: false }, { mediaDevices: undefined }]) {
    const state = fixture(options);
    await state.scanner.start();
    assert.equal(state.constraints.length, 0);
    assert.equal(state.states.at(-1).state, 'error');
    assert.match(state.states.at(-1).message, /HTTPS|keine Kamera/);
  }
  const state = fixture({ decoderLoader: async () => { throw new Error('module unavailable'); } });
  await state.scanner.start();
  assert.equal(state.video.srcObject, null);
  assert.ok(state.cameraStream.getTracks().every((track) => track.stops > 0));
  assert.equal(state.states.at(-1).state, 'error');
});

test('No-QR frames keep scanning; invalid QR and a disconnected camera stop with visible errors and allow retry', async () => {
  const state = fixture();
  await state.scanner.start();
  await state.frame();
  assert.equal(state.frames.size, 1);
  assert.deepEqual(state.decoded, []);
  state.decoder.scanImage = async () => ({ data: 'https://external.example.org/secret' });
  await state.frame();
  assert.match(state.states.at(-1).message, /dieser Workshop-Zentrale/);
  assert.equal(state.states.at(-1).state, 'error');
  assert.equal(state.video.srcObject, null);
  assert.equal(state.frames.size, 0);
  assert.deepEqual(state.decoded, []);
  await state.scanner.start();
  assert.equal(state.states.at(-1).state, 'scanning');
  state.cameraStream.getTracks()[0].dispatchEvent(new Event('ended'));
  assert.match(state.states.at(-1).message, /unterbrochen/);
  assert.equal(state.video.srcObject, null);
  assert.equal(state.frames.size, 0);
});

test('Cancel before permission settles stops all late tracks without creating a decoder or callback', async () => {
  const permission = deferred();
  let decoderLoads = 0;
  const state = fixture({
    mediaDevices: { getUserMedia: () => permission.promise },
    decoderLoader: async () => { decoderLoads++; throw new Error('must not load'); },
  });
  const starting = state.scanner.start();
  state.scanner.stop();
  permission.resolve(state.cameraStream);
  await starting;
  assert.ok(state.cameraStream.getTracks().every((track) => track.stops === 1));
  assert.equal(state.video.srcObject, null);
  assert.equal(decoderLoads, 0);
  assert.deepEqual(state.decoded, []);
  assert.deepEqual(state.states.map(({ state }) => state), ['starting']);
});

test('Cancel during worker startup terminates the late worker; an old start cannot stop the replacement camera', async () => {
  const engineReady = deferred();
  const state = fixture();
  state.decoder.createQrEngine = () => engineReady.promise;
  const starting = state.scanner.start();
  await new Promise((resolve) => setImmediate(resolve));
  state.scanner.stop();
  engineReady.resolve(state.engine);
  await starting;
  assert.equal(state.engine.terminations, 1);
  assert.equal(state.video.srcObject, null);
  assert.equal(state.frames.size, 0);

  const oldPermission = deferred();
  const lateStream = stream();
  let calls = 0;
  const replacement = fixture({
    mediaDevices: { getUserMedia: () => ++calls === 1 ? oldPermission.promise : Promise.resolve(lateStream) },
  });
  const oldStart = replacement.scanner.start();
  await replacement.scanner.start();
  oldPermission.resolve(replacement.cameraStream);
  await oldStart;
  assert.strictEqual(replacement.video.srcObject, lateStream);
  assert.ok(replacement.cameraStream.getTracks().every((track) => track.stops === 1));
  assert.ok(lateStream.getTracks().every((track) => track.stops === 0));
  replacement.scanner.stop();
  assert.ok(lateStream.getTracks().every((track) => track.stops === 1));
});

test('Cancel during inline playback or decoder loading stops tracks immediately and suppresses late startup', async () => {
  for (const phase of ['playback', 'decoder']) {
    const pending = deferred();
    const state = fixture(phase === 'decoder' ? { decoderLoader: () => pending.promise } : {});
    if (phase === 'playback') state.video.play = () => pending.promise;
    const starting = state.scanner.start();
    await new Promise((resolve) => setImmediate(resolve));
    assert.strictEqual(state.video.srcObject, state.cameraStream);
    state.scanner.stop();
    assert.equal(state.video.srcObject, null);
    assert.ok(state.cameraStream.getTracks().every((track) => track.stops === 1));
    pending.resolve(state.decoder);
    await starting;
    assert.equal(state.engine.terminations, 0, 'No engine should be created after cancellation');
    assert.equal(state.frames.size, 0);
    assert.deepEqual(state.states.map(({ state }) => state), ['starting']);
  }
});

test('Hidden/pagehide/navigation cancellation invalidates late decoding and does not resume automatically', async () => {
  const result = deferred();
  const state = fixture();
  state.decoder.scanImage = () => result.promise;
  await state.scanner.start();
  const scanning = state.frame();
  state.hide();
  result.resolve({ data: requestUrl });
  await scanning;
  assert.deepEqual(state.decoded, []);
  assert.equal(state.video.srcObject, null);
  assert.equal(state.engine.terminations, 1);
  assert.equal(state.frames.size, 0);
  assert.deepEqual(state.states.map(({ state }) => state), ['starting', 'scanning']);
});

test('PWA v9 caches only explicit same-origin shell/decoder assets, never APIs, camera media or arbitrary QR targets', async () => {
  const handlers = new Map();
  let shell;
  const context = {
    URL,
    self: { location: { origin }, addEventListener: (name, handler) => handlers.set(name, handler) },
    caches: {
      open: async (name) => {
        assert.equal(name, 'eudi-shell-v9');
        return { addAll: async (paths) => { shell = Array.from(paths); } };
      },
    },
  };
  vm.runInNewContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), context);
  let installing;
  handlers.get('install')({ waitUntil: (promise) => { installing = promise; } });
  await installing;
  for (const path of [
    '/wallet.html', '/wallet.js', '/issuer.html', '/issuer.js', '/issuer.css', '/wallet-scanner.js', '/wallet-scanner.css',
    '/wallet-presentation.css', '/kiosk.css', '/lib/verification.js',
    '/vendor/qr-scanner/qr-scanner.min.js', '/vendor/qr-scanner/qr-scanner-worker.min.js',
  ]) assert.ok(shell.includes(path), `Missing shell asset: ${path}`);
  assert.ok(shell.every((path) => path.startsWith('/') && !path.includes('/api/') && !path.includes('#') && !path.includes('?')));
  for (const [url, method] of [
    [`${origin}/api/config`, 'GET'], [`${origin}/api/offers/sensitive-id`, 'GET'],
    [`${origin}/api/requests/sensitive-id`, 'POST'], [`${origin}/api/status-lists/org-id`, 'GET'],
    [`${origin}/camera-photo.png`, 'GET'], ['blob:https://workshop.example.org/camera-frame', 'GET'],
    ['https://external.example.org/wallet.html', 'GET'], [`${origin}/wallet-scanner.js`, 'POST'],
  ]) {
    handlers.get('fetch')({
      request: { url, method },
      respondWith() { assert.fail(`Must not cache/intercept ${method} ${url}`); },
    });
  }
});
