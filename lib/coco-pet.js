'use strict';

const path = require('path');
const { pathToFileURL } = require('node:url');
const { releaseVelocity, throwStep } = require('./coco-pet-physics');
const { RUN_MS, RUN_DISTANCE, runProgress } = require('./coco-pet-run');
const { isCocoActivity } = require('./coco-pet-ipc');
const { cocoPetPreferences } = require('./coco-pet-preferences');

const ACTIONS = Object.freeze({
  wave: '挥手', stretch: '伸懒腰', run: '跑步', tower: '爬基站',
  router: '修路由器', topology: '设计网络拓扑', computer: '组装电脑', reaction: '表情互动',
});
const SCHEME = 'coco-pet';
const HOST = 'app';
const PAGE_URL = `${SCHEME}://${HOST}/pet.html`;
const ASSETS = new Set([
  'pet.html', 'pet.css', 'pet.js', 'idle-frame.png', 'idle.webm', 'work.webm', 'success.webm',
  ...Object.keys(ACTIONS).map(action => `${action}.webm`),
]);
const WIDTH = 384;
const HEIGHT = 216;
const FIRST_RELOAD_DELAY = 1000;
const MAX_RELOAD_DELAY = 30000;
const STABLE_RENDERER_MS = 30000;

function registerCocoPetScheme(protocol) {
  protocol.registerSchemesAsPrivileged([
    { scheme: SCHEME, privileges: { standard: true, secure: true, stream: true } },
  ]);
}

// Runs inside the pet process and owns its sandboxed renderer.
function createCocoPet({
  BrowserWindow, Menu, ipcMain, screen, session, net, dataDir, assetsDir,
  coworkMenu = () => [], quit, onChange = () => {}, log = () => {},
}) {
  // Serve the page and media from one origin so the renderer can read canvas pixels.
  const petSession = session.fromPartition(SCHEME);
  petSession.protocol.handle(SCHEME, request => {
    const { host, pathname } = new URL(request.url);
    const name = pathname.slice(1);
    if (host !== HOST || !ASSETS.has(name)) return new Response(null, { status: 404 });
    if (request.method !== 'GET') return new Response(null, { status: 405 });
    const range = request.headers.get('range');
    return net.fetch(pathToFileURL(path.join(assetsDir, name)).href, range ? { headers: { range } } : undefined);
  });
  const preferences = cocoPetPreferences(dataDir, log);
  let savedPosition = preferences.readPosition();
  let enabled = false;
  let window = null;
  let moveTimer = null;
  let dragTimer = null;
  let dragState = null;
  let activeThrow = null;
  let reloadTimer = null;
  let reloadDelay = FIRST_RELOAD_DELAY;
  let rendererReadyAt = null;
  let activity = 'idle';
  let interactive = true;
  let disposed = false;
  const ipcHandlers = [];

  function current() { return window && !window.isDestroyed() ? window : null; }
  function fromMainFrame(event, contents) {
    if (!contents || event.sender !== contents) return false;
    const frame = event.senderFrame;
    return !!frame && frame === contents.mainFrame;
  }
  function validSender(event) {
    return !disposed && rendererReadyAt !== null && fromMainFrame(event, current()?.webContents);
  }
  function clamp(value, low, high) { return Math.min(Math.max(value, low), Math.max(low, high)); }
  function fit(x, y) {
    const bounds = { x: Math.round(x), y: Math.round(y), width: WIDTH, height: HEIGHT };
    const area = screen.getDisplayMatching(bounds).workArea;
    return { x: clamp(bounds.x, area.x, area.x + area.width - WIDTH), y: clamp(bounds.y, area.y, area.y + area.height - HEIGHT) };
  }
  function position() {
    if (savedPosition) return fit(savedPosition.x, savedPosition.y);
    const area = screen.getPrimaryDisplay().workArea;
    return fit(area.x + area.width - WIDTH - 20, area.y + area.height - HEIGHT - 20);
  }
  function rememberPosition() {
    const w = current();
    if (!w) return;
    const [x, y] = w.getPosition();
    if (savedPosition?.x === x && savedPosition?.y === y) return;
    savedPosition = { x, y };
    preferences.writePosition(savedPosition);
  }
  function stopMove() { if (moveTimer) clearInterval(moveTimer); moveTimer = null; }
  function stopDrag() { if (dragTimer) clearInterval(dragTimer); dragTimer = null; }
  function stopThrow(notify = false) {
    if (!activeThrow) return;
    const { id, timer } = activeThrow;
    clearInterval(timer);
    activeThrow = null;
    const w = current();
    if (notify && w) w.webContents.send('coco-pet:physics', { id, type: 'settled' });
  }
  function stopMotion() {
    const moved = moveTimer || activeThrow || dragState?.moved;
    stopMove();
    stopDrag();
    stopThrow();
    dragState = null;
    if (moved) rememberPosition();
  }
  function fitCurrentWindow() {
    const w = current();
    if (!w) return;
    const { x, y, width, height } = w.getBounds();
    const next = fit(x, y);
    const changed = next.x !== x || next.y !== y || width !== WIDTH || height !== HEIGHT;
    const moving = moveTimer || activeThrow;
    stopMove();
    stopThrow(true);
    if (changed) w.setBounds({ ...next, width: WIDTH, height: HEIGHT }, false);
    if (changed || moving) rememberPosition();
  }
  function onDisplayMetricsChanged(_event, _display, metrics) {
    if (metrics.some(key => ['bounds', 'workArea', 'scaleFactor', 'rotation'].includes(key))) fitCurrentWindow();
  }
  function addDragSample(state, cursor, now) {
    state.trail.push({ x: cursor.x, y: cursor.y, t: now });
    while (state.trail.length > 2 && now - state.trail[0].t > 220) state.trail.shift();
  }
  function startThrow(id, velocity) {
    const w = current(); if (!w) return false;
    const [x, y] = w.getPosition();
    const area = screen.getDisplayMatching(w.getBounds()).workArea;
    let state = { x, y, ...velocity }, previous = performance.now(), start = previous, lastImpact = 0;
    let lastX = x, lastY = y;
    w.webContents.send('coco-pet:physics', { id, type: 'release', flying: true, moved: true });
    const timer = setInterval(() => {
      const pet = current(); if (!pet) return stopThrow();
      const now = performance.now();
      state = throwStep(state, (now - previous) / 1000, area, { width: WIDTH, height: HEIGHT });
      previous = now;
      if (now - start > 10000 && !state.atRest) {
        state.y = Math.max(area.y, area.y + area.height - HEIGHT);
        state.atRest = true;
      }
      const nextX = Math.round(state.x), nextY = Math.round(state.y);
      if (nextX !== lastX || nextY !== lastY) {
        pet.setBounds({ x: nextX, y: nextY, width: WIDTH, height: HEIGHT }, false);
        lastX = nextX; lastY = nextY;
      }
      if (state.impact > 100 && now - lastImpact > 120) {
        lastImpact = now;
        pet.webContents.send('coco-pet:physics', { id, type: 'impact', speed: state.impact });
      }
      if (state.atRest) {
        stopThrow(true); rememberPosition();
      }
    }, 16);
    activeThrow = { id, timer };
    return true;
  }
  function assertTopmost(w) {
    if (!w || w.isDestroyed()) return;
    // Reinsert into the OS topmost band; the flag alone may survive after Windows
    // has changed the actual z-order (notably around click-through changes).
    try { w.setAlwaysOnTop(true, process.platform === 'darwin' ? 'floating' : 'screen-saver'); }
    catch (error) { log('小络置顶失败: ' + error.message); }
  }
  function play(name) {
    const w = current();
    if (!w || rendererReadyAt === null || !Object.hasOwn(ACTIONS, name)) return;
    if (moveTimer || activeThrow) rememberPosition();
    stopMove();
    stopThrow(true);
    w.webContents.send('coco-pet:play', name);
  }
  function popup() {
    const w = current(); if (!w) return;
    Menu.buildFromTemplate([
      { label: '小络的动作', submenu: Object.entries(ACTIONS).map(([key, label]) => ({ label, click: () => play(key) })) },
      ...coworkMenu(),
      { type: 'separator' },
      { label: '隐藏小络', click: () => setEnabled(false) },
      { label: '退出小络', click: quit },
    ]).popup({ window: w });
  }
  function setInteractive(w, value) {
    if (interactive === value) return;
    interactive = value;
    w.setIgnoreMouseEvents(!value, { forward: true });
    assertTopmost(w);
  }
  function cancelReload() {
    clearTimeout(reloadTimer);
    reloadTimer = null;
  }
  function resetRenderer(w) {
    if (rendererReadyAt !== null && Date.now() - rendererReadyAt >= STABLE_RENDERER_MS) reloadDelay = FIRST_RELOAD_DELAY;
    rendererReadyAt = null;
    stopMotion();
    setInteractive(w, true);
  }
  function loadPage(w) {
    w.loadURL(PAGE_URL).catch(error => recoverPage(w, error.message));
  }
  function recoverPage(w, reason) {
    if (disposed || w !== current() || !enabled || reloadTimer !== null) return;
    resetRenderer(w);
    w.hide();
    log('小络窗口加载失败: ' + reason);
    reloadTimer = setTimeout(() => {
      reloadTimer = null;
      if (w === current() && enabled) loadPage(w);
    }, reloadDelay);
    reloadDelay = Math.min(reloadDelay * 2, MAX_RELOAD_DELAY);
  }
  function show() {
    if (disposed) return;
    const existing = current();
    if (existing) {
      if (rendererReadyAt !== null) existing.showInactive();
      return;
    }
    interactive = true;
    reloadDelay = FIRST_RELOAD_DELAY;
    const pos = position();
    window = new BrowserWindow({
      ...pos, width: WIDTH, height: HEIGHT, frame: false, transparent: true, resizable: false,
      skipTaskbar: true, alwaysOnTop: true, show: false, backgroundColor: '#00000000',
      webPreferences: { session: petSession, preload: path.join(assetsDir, 'preload.js'), contextIsolation: true, sandbox: true,
        nodeIntegration: false, backgroundThrottling: false },
    });
    const w = window;
    assertTopmost(w);
    w.webContents.setBackgroundThrottling(false);
    w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    w.webContents.on('will-navigate', event => event.preventDefault());
    w.webContents.on('did-start-navigation', (event, _url, isInPlace, isMainFrame) => {
      if (w !== current() || !(event.isMainFrame ?? isMainFrame) || (event.isSameDocument ?? isInPlace)) return;
      cancelReload();
      resetRenderer(w);
    });
    w.webContents.on('did-finish-load', () => {
      if (w !== current()) return;
      rendererReadyAt = Date.now();
      w.webContents.send('coco-pet:activity', activity);
      w.showInactive();
      assertTopmost(w);
    });
    w.webContents.on('render-process-gone', (_event, details) => recoverPage(w, details.reason));
    w.on('restore', () => assertTopmost(w));
    w.on('always-on-top-changed', (_event, onTop) => { if (!onTop) assertTopmost(w); });
    w.on('close', stopMotion);
    screen.on('display-removed', fitCurrentWindow);
    screen.on('display-metrics-changed', onDisplayMetricsChanged);
    w.once('closed', () => {
      screen.removeListener('display-removed', fitCurrentWindow);
      screen.removeListener('display-metrics-changed', onDisplayMetricsChanged);
      cancelReload();
      stopMotion();
      rendererReadyAt = null;
      window = null;
      if (enabled && !disposed) {
        enabled = false;
        onChange(false);
      }
    });
    loadPage(w);
  }
  function closeWindow() {
    cancelReload();
    stopMotion();
    current()?.destroy();
  }
  function dispose() {
    if (disposed) return;
    disposed = true;
    try {
      closeWindow();
    } finally {
      for (const [channel, handler] of ipcHandlers) ipcMain.removeListener(channel, handler);
      ipcHandlers.length = 0;
      petSession.protocol.unhandle(SCHEME);
    }
  }
  function setEnabled(value) {
    if (disposed || enabled === (value === true)) return;
    enabled = value === true;
    if (enabled) show();
    else closeWindow();
    onChange(enabled);
  }
  function setActivity(value) {
    if (disposed || !isCocoActivity(value) || value === activity) return;
    if (moveTimer) rememberPosition();
    stopMove();
    activity = value;
    const w = current();
    if (w && rendererReadyAt !== null) w.webContents.send('coco-pet:activity', value);
  }
  function onIpc(channel, handler) {
    ipcMain.on(channel, handler);
    ipcHandlers.push([channel, handler]);
  }
  onIpc('coco-pet:menu', event => { if (validSender(event)) popup(); });
  onIpc('coco-pet:interactive', (event, value) => {
    if (validSender(event) && typeof value === 'boolean') setInteractive(current(), value);
  });
  onIpc('coco-pet:drag-start', (event, id) => {
    if (!validSender(event) || !Number.isSafeInteger(id) || id <= 0) return;
    stopMotion();
    const origin = screen.getCursorScreenPoint(), [x, y] = current().getPosition();
    const now = performance.now();
    const state = { id, origin, x, y, vx: 0, vy: 0, lastX: x, lastY: y, lastTime: now, moved: false, trail: [] };
    dragState = state; addDragSample(state, origin, now);
    dragTimer = setInterval(() => {
      const w = current(); if (!w) return stopDrag();
      const cursor = screen.getCursorScreenPoint(), now = performance.now();
      addDragSample(state, cursor, now);
      const dx = cursor.x - origin.x, dy = cursor.y - origin.y;
      if (!state.moved && Math.hypot(dx, dy) < 5) { state.lastTime = now; return; }
      state.moved = true;
      const target = fit(x + dx, y + dy);
      const dt = Math.min(Math.max((now - state.lastTime) / 1000, 0), 0.033); state.lastTime = now;
      state.vx += ((target.x - state.x) * 200 - state.vx * 30) * dt;
      state.vy += ((target.y - state.y) * 200 - state.vy * 30) * dt;
      state.x += state.vx * dt; state.y += state.vy * dt;
      const next = fit(state.x, state.y);
      if (next.x === state.lastX && next.y === state.lastY) return;
      // Electron's Windows DIP/physical-pixel round trips can grow a frameless
      // window on every setPosition at fractional DPI. Set the intended size
      // explicitly on every move, and skip calls while the pointer is still.
      w.setBounds({ x: next.x, y: next.y, width: WIDTH, height: HEIGHT }, false);
      state.lastX = next.x; state.lastY = next.y;
    }, 16);
  });
  onIpc('coco-pet:drag-end', (event, details) => {
    const state = dragState;
    if (!validSender(event) || !state || details?.id !== state.id) return;
    stopDrag();
    dragState = null;
    const { id } = state;
    const cancelled = details.cancelled === true;
    const now = performance.now(), cursor = screen.getCursorScreenPoint();
    addDragSample(state, cursor, now);
    const moved = state.moved || Math.hypot(cursor.x - state.origin.x, cursor.y - state.origin.y) >= 5 || details.moved === true;
    const velocity = moved && !cancelled ? releaseVelocity(state.trail, now) : null;
    if (velocity && startThrow(id, velocity)) return;
    rememberPosition();
    current()?.webContents.send('coco-pet:physics', { id, type: 'release', flying: false, moved, cancelled });
  });
  onIpc('coco-pet:run', (event, mediaSeconds) => {
    if (!validSender(event) || dragTimer || activeThrow) return;
    stopMove();
    const w = current(), [x, y] = w.getPosition(), area = screen.getDisplayMatching(w.getBounds()).workArea;
    const maxX = area.x + area.width - WIDTH;
    const left = clamp(x - RUN_DISTANCE, area.x, maxX);
    const right = clamp(x + RUN_DISTANCE, area.x, maxX);
    const target = right - x >= x - left ? right : left;
    if (target === x) return;
    w.webContents.send('coco-pet:run-direction', target < x ? 'left' : 'right');
    const offset = Number.isFinite(mediaSeconds) ? clamp(mediaSeconds*1000, 0, RUN_MS) : 0;
    const started = Date.now() - offset;
    let lastX = x;
    moveTimer = setInterval(() => {
      if (!current()) return stopMove();
      const t = Math.min(1, (Date.now() - started) / RUN_MS);
      const nextX = Math.round(x + (target - x) * runProgress(t));
      if (nextX !== lastX) {
        current().setBounds({ x: nextX, y, width: WIDTH, height: HEIGHT }, false);
        lastX = nextX;
      }
      if (t >= 1) { stopMove(); rememberPosition(); }
    }, 16);
  });
  return { setEnabled, setActivity, dispose };
}

module.exports = { createCocoPet, registerCocoPetScheme, ACTIONS };
