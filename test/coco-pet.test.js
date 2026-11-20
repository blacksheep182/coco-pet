'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createCocoPet, registerCocoPetScheme, ACTIONS } = require('../lib/coco-pet');

function fixture(dir, { loadFailures = 0, ipcMain = new EventEmitter(), protocolHandlers = new Map() } = {}) {
  const windows = [];
  class FakeWindow extends EventEmitter {
    constructor(options) {
      super(); this.options = options; this.destroyed = false;
      this.webContents = new EventEmitter(); this.webContents.sent = []; this.webContents.mainFrame = {};
      this.webContents.send = (...args) => this.webContents.sent.push(args);
      this.webContents.setWindowOpenHandler = handler => { this.openHandler = handler; };
      this.webContents.setBackgroundThrottling = value => { this.backgroundThrottling = value; };
      this.xy = [options.x, options.y]; windows.push(this);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    showInactive() { this.shown = true; }
    hide() { this.shown = false; }
    loadURL(url) {
      this.url = url;
      this.loadCount = (this.loadCount || 0) + 1;
      this.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, url, false, true);
      if (loadFailures > 0) {
        loadFailures--;
        return Promise.reject(new Error('failed to load pet.html'));
      }
      this.webContents.emit('did-finish-load');
      return Promise.resolve();
    }
    getPosition() { return this.xy; }
    getBounds() { return { x: this.xy[0], y: this.xy[1], width: 384, height: 216 }; }
    setPosition(x, y) { this.xy = [x, y]; }
    setBounds(bounds) { this.xy = [bounds.x, bounds.y]; (this.moves ||= []).push(bounds); }
    setIgnoreMouseEvents(value) { this.ignored = value; }
    setAlwaysOnTop(value, level) { this.topmost = { value, level }; this.topmostCalls = (this.topmostCalls || 0) + 1; }
  }
  let area = { x: 0, y: 0, width: 1200, height: 800 };
  let cursor = { x: 0, y: 0 };
  const screen = Object.assign(new EventEmitter(), {
    getDisplayMatching: () => ({ workArea: area }),
    getPrimaryDisplay: () => ({ workArea: area }),
    getCursorScreenPoint: () => cursor,
  });
  let menu;
  const Menu = { buildFromTemplate: template => ({ popup: () => { menu = template; } }) };
  const changes = [];
  const petSession = { protocol: {
    handle(scheme, handler) {
      assert.equal(scheme, 'coco-pet');
      assert.ok(!protocolHandlers.has(scheme), 'a protocol can only have one owner');
      protocolHandlers.set(scheme, handler);
    },
    unhandle(scheme) { assert.ok(protocolHandlers.delete(scheme), 'only an installed protocol can be removed'); },
  } };
  const session = { fromPartition(name) { assert.equal(name, 'coco-pet'); return petSession; } };
  const fetched = [];
  const net = { fetch(url, options) { fetched.push({ url, options }); return new Response('asset'); } };
  const pet = createCocoPet({ BrowserWindow: FakeWindow, Menu, ipcMain, screen, session, net, dataDir: dir,
    assetsDir: path.join(dir, 'assets'),
    quit() {}, onChange: enabled => changes.push(enabled) });
  return { pet, petSession, assetHandler: protocolHandlers.get('coco-pet'), fetched,
    ipcMain, screen, windows, changes, menu: () => menu,
    setCursor: next => { cursor = next; }, setWorkArea: next => { area = next; } };
}

test('Coco can be disposed and recreated in the same Electron host without leaving resources behind', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-'));
  const shared = { ipcMain: new EventEmitter(), protocolHandlers: new Map() };
  const hostListener = () => {};
  shared.ipcMain.on('coco-pet:run', hostListener);
  const first = fixture(dir, shared);
  t.after(() => first.pet.dispose());
  first.pet.setEnabled(true);
  first.pet.dispose();
  first.pet.dispose();
  assert.deepEqual(shared.ipcMain.eventNames(), ['coco-pet:run']);
  assert.deepEqual(shared.ipcMain.listeners('coco-pet:run'), [hostListener]);
  assert.equal(shared.protocolHandlers.size, 0);
  assert.equal(first.screen.listenerCount('display-removed'), 0);
  assert.equal(first.screen.listenerCount('display-metrics-changed'), 0);
  first.pet.setEnabled(true);
  assert.equal(first.windows.length, 1, 'a disposed instance cannot create windows');

  const second = fixture(dir, shared);
  t.after(() => second.pet.dispose());
  second.pet.setEnabled(true);
  const w = second.windows[0];
  assert.equal(w.shown, true);
  second.pet.setActivity('working');
  assert.deepEqual(w.webContents.sent.at(-1), ['coco-pet:activity', 'working']);
});

function senderOf(w) {
  return { sender: w.webContents, senderFrame: w.webContents.mainFrame };
}

test('the isolated pet window restores its position without writing the host opt-in', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-'));
  const first = fixture(dir); assert.equal(first.windows.length, 0);
  first.pet.setEnabled(true); const w = first.windows[0];
  assert.equal(w.options.transparent, true); assert.equal(w.options.webPreferences.sandbox, true);
  assert.equal(w.options.webPreferences.nodeIntegration, false);
  assert.equal(w.options.webPreferences.session, first.petSession);
  assert.equal(w.url, 'coco-pet://app/pet.html');
  assert.equal(w.options.webPreferences.backgroundThrottling, false);
  assert.equal(w.backgroundThrottling, false);
  assert.equal(w.topmost.value, true);
  assert.deepEqual(w.openHandler(), { action: 'deny' });
  first.ipcMain.emit('coco-pet:run', senderOf(w));
  w.xy = [150, 250];
  first.pet.dispose(); // Position is saved even when motion has not settled.
  const second = fixture(dir); second.pet.setEnabled(true); assert.equal(second.windows.length, 1);
  assert.deepEqual(second.windows[0].xy, [150, 250]);
  second.pet.setEnabled(false); assert.equal(second.windows[0].destroyed, true);
  assert.equal(fs.existsSync(path.join(dir, 'coco-pet.json')), false);
  second.pet.dispose();
});

test('the private Coco origin serves only known assets and forwards media ranges', async (t) => {
  registerCocoPetScheme({ registerSchemesAsPrivileged(schemes) {
    assert.deepEqual(schemes, [{ scheme: 'coco-pet', privileges: { standard: true, secure: true, stream: true } }]);
  } });
  const f = fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-')));
  t.after(() => f.pet.dispose());
  const response = await f.assetHandler(new Request('coco-pet://app/work.webm', { headers: { range: 'bytes=0-' } }));
  assert.equal(await response.text(), 'asset');
  assert.match(f.fetched[0].url, /^file:\/\/.+\/assets\/work\.webm$/);
  assert.deepEqual(f.fetched[0].options, { headers: { range: 'bytes=0-' } });
  for (const url of ['coco-pet://other/work.webm', 'coco-pet://app/preload.js', 'coco-pet://app/..%2fwork.webm']) {
    assert.equal(f.assetHandler(new Request(url)).status, 404);
  }
  assert.equal(f.assetHandler(new Request('coco-pet://app/pet.html', { method: 'POST' })).status, 405);
  assert.equal(f.fetched.length, 1);
});

test('a renderer reload resets mouse input and cancels an interrupted drag', async (t) => {
  const f = fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-')));
  t.after(() => f.pet.dispose());
  f.pet.setEnabled(true);
  const w = f.windows[0], sender = senderOf(w);
  f.ipcMain.emit('coco-pet:interactive', sender, false);
  f.ipcMain.emit('coco-pet:drag-start', sender, 1);
  w.webContents.emit('did-start-navigation', { isMainFrame: true, isSameDocument: false }, '/pet/pet.html', false, true);
  w.webContents.emit('did-finish-load');
  f.setCursor({ x: -200, y: -100 });
  await new Promise(resolve => setTimeout(resolve, 70));
  assert.equal(w.ignored, false, 'a newly loaded renderer starts with mouse input enabled');
  assert.equal(w.moves?.length || 0, 0, 'a lost pointer cannot move the new renderer');
});

test('a renderer crash reloads only while Coco is enabled and redelivers the latest activity', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-')));
  t.after(() => f.pet.dispose());
  f.pet.setEnabled(true);
  const w = f.windows[0];
  w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  assert.equal(w.shown, false, 'a dead transparent window must not cover the desktop');
  f.pet.setActivity('working');
  t.mock.timers.tick(1000);
  assert.equal(w.loadCount, 2);
  assert.equal(w.shown, true);
  assert.deepEqual(w.webContents.sent.at(-1), ['coco-pet:activity', 'working']);

  w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  f.pet.setEnabled(false);
  t.mock.timers.tick(1000);
  assert.equal(w.loadCount, 2, 'turning Coco off cancels pending recovery');
});

test('page load failures delay subsequent retries and leave the window hidden until it is ready', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const f = fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-')), { loadFailures: 2 });
  t.after(() => f.pet.dispose());
  f.pet.setEnabled(true);
  const w = f.windows[0];
  await Promise.resolve();
  assert.equal(w.shown, false);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(w.loadCount, 2);
  t.mock.timers.tick(1999);
  assert.equal(w.loadCount, 2);
  t.mock.timers.tick(1);
  assert.equal(w.loadCount, 3);
  assert.equal(w.shown, true);
});

test('repeated crashes after successful loads back off until the renderer is healthy', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] });
  const f = fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-')));
  t.after(() => f.pet.dispose());
  f.pet.setEnabled(true);
  const w = f.windows[0];
  const expectedDelays = [1000, 2000, 4000, 8000, 16000, 30000, 30000];
  for (const [i, delay] of expectedDelays.entries()) {
    w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
    t.mock.timers.tick(delay - 1);
    assert.equal(w.loadCount, i + 1);
    t.mock.timers.tick(1);
    assert.equal(w.loadCount, i + 2);
  }
  t.mock.timers.tick(60000);
  w.webContents.emit('render-process-gone', {}, { reason: 'crashed' });
  t.mock.timers.tick(1000);
  assert.equal(w.loadCount, expectedDelays.length + 2, 'a healthy renderer resets recovery to one second');
});

test('disconnecting a display stops roaming and restores Coco into the remaining work area', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-'));
  const f = fixture(dir);
  t.after(() => f.pet.dispose());
  f.setWorkArea({ x: 1200, y: 0, width: 1200, height: 800 });
  f.pet.setEnabled(true);
  const w = f.windows[0], sender = senderOf(w);
  f.ipcMain.emit('coco-pet:run', sender);
  f.setWorkArea({ x: 0, y: 0, width: 1024, height: 700 });
  f.screen.emit('display-removed', {}, { id: 2 });
  assert.deepEqual(w.xy, [640, 484]);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'coco-pet-position.json'))).position, { x: 640, y: 484 });
  f.pet.setEnabled(false);
  assert.equal(f.screen.listenerCount('display-removed'), 0);
});

test('dragging fixes the window size and does not move while the pointer is still', async () => {
  const f = fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-'))); f.pet.setEnabled(true);
  const w = f.windows[0], sender = senderOf(w);
  try {
    f.ipcMain.emit('coco-pet:drag-start', sender, 1);
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.equal(w.moves?.length || 0, 0, 'a still pointer should not move the window');
    f.setCursor({ x: -100, y: -50 });
    await new Promise(resolve => setTimeout(resolve, 75));
    assert.ok(w.moves.length, 'the spring should follow a moving pointer');
    for (const move of w.moves) { assert.equal(move.width, 384); assert.equal(move.height, 216); }
  } finally { f.ipcMain.emit('coco-pet:drag-end', sender, { id: 1, moved: true, cancelled: true }); f.pet.dispose(); }
});

test('a delayed drag-end cannot release a newer grab, and interrupting movement saves its position', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-'));
  const f = fixture(dir);
  t.after(() => f.pet.dispose());
  f.pet.setEnabled(true);
  const w = f.windows[0], sender = senderOf(w);
  f.ipcMain.emit('coco-pet:run', sender);
  w.xy = [160, 320];
  f.ipcMain.emit('coco-pet:drag-start', sender, 1);
  f.ipcMain.emit('coco-pet:drag-start', sender, 2);
  const messages = w.webContents.sent.length;
  f.ipcMain.emit('coco-pet:drag-end', sender, { id: 1, cancelled: true });
  assert.equal(w.webContents.sent.length, messages, 'an old release cannot finish the new drag');
  f.pet.dispose();
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'coco-pet-position.json'))).position, { x: 160, y: 320 });
});

test('automatic roaming also preserves the intended window dimensions', async () => {
  const f = fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-'))); f.pet.setEnabled(true);
  const w = f.windows[0], sender = senderOf(w);
  try {
    f.ipcMain.emit('coco-pet:run', sender);
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.ok(w.moves?.length, 'roaming should change position');
    for (const move of w.moves) {
      assert.equal(move.width, 384);
      assert.equal(move.height, 216);
    }
  } finally { f.pet.dispose(); }
});

test('tight work areas keep automatic roaming on the current monitor', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  const f = fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-')));
  t.after(() => f.pet.dispose());
  f.screen.getDisplayMatching = bounds => ({
    workArea: bounds.x < 0 ? { x: -800, y: 0, width: 800, height: 600 } : { x: 0, y: 0, width: 500, height: 600 },
  });
  f.pet.setEnabled(true);
  const w = f.windows[0];
  w.xy = [0, 100];
  f.ipcMain.emit('coco-pet:run', senderOf(w));
  t.mock.timers.tick(3100);
  assert.deepEqual(w.xy, [116, 100]);
});

test('a flick continues after release, and grabbing or hiding stops its physics', (t) => {
  t.mock.timers.enable({ apis: ['setInterval', 'Date'] });
  t.mock.method(performance, 'now', () => Date.now());
  const f = fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-'))); f.pet.setEnabled(true);
  const w = f.windows[0], sender = senderOf(w);
  try {
    f.ipcMain.emit('coco-pet:drag-start', sender, 1);
    t.mock.timers.tick(35);
    f.setCursor({ x: -150, y: -70 });
    t.mock.timers.tick(35);
    f.ipcMain.emit('coco-pet:drag-end', sender, { id: 1, moved: true });
    assert.equal(w.webContents.sent.at(-1)[1].flying, true);
    const count = w.moves.length;
    t.mock.timers.tick(50);
    assert.ok(w.moves.length > count, 'the pet continues moving after release');
    f.ipcMain.emit('coco-pet:drag-start', sender, 2);
    const grabbedAt = w.moves.length;
    t.mock.timers.tick(50);
    assert.equal(w.moves.length, grabbedAt, 'a new grab stops the throw');
    f.setCursor({ x: -300, y: -140 });
    t.mock.timers.tick(35);
    f.ipcMain.emit('coco-pet:drag-end', sender, { id: 2, moved: true });
    assert.equal(w.webContents.sent.at(-1)[1].flying, true);
    f.pet.setEnabled(false);
    const hiddenAt = w.moves.length;
    t.mock.timers.tick(50);
    assert.equal(w.moves.length, hiddenAt, 'hiding cancels the physics timer');
  } finally { f.pet.dispose(); }
});

test('only the pet renderer may control its window; menu exposes all actions', () => {
  const f = fixture(fs.mkdtempSync(path.join(os.tmpdir(), 'coco-'))); f.pet.setEnabled(true);
  const w = f.windows[0], attacker = { sender: {} }, sender = senderOf(w);
  f.ipcMain.emit('coco-pet:interactive', attacker, false); assert.equal(w.ignored, undefined);
  f.ipcMain.emit('coco-pet:interactive', { ...sender, senderFrame: {} }, false);
  assert.equal(w.ignored, undefined, 'a stale frame in the same webContents does not control the window');
  const previousTopmostCalls = w.topmostCalls;
  f.ipcMain.emit('coco-pet:interactive', sender, false); assert.equal(w.ignored, true);
  assert.equal(w.topmostCalls, previousTopmostCalls + 1);
  w.emit('always-on-top-changed', {}, false);
  assert.equal(w.topmostCalls, previousTopmostCalls + 2);
  f.ipcMain.emit('coco-pet:menu', attacker); assert.equal(f.menu(), undefined);
  f.ipcMain.emit('coco-pet:menu', sender);
  const submenu = f.menu().find(item => item.submenu).submenu;
  assert.deepEqual(submenu.map(item => item.label), Object.values(ACTIONS));
  submenu.find(item => item.label === '爬基站').click();
  assert.deepEqual(w.webContents.sent.at(-1), ['coco-pet:play', 'tower']);
  f.pet.setActivity('working'); assert.deepEqual(w.webContents.sent.at(-1), ['coco-pet:activity', 'working']);
  f.pet.dispose();
});
