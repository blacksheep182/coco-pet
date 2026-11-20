'use strict';

const { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, net, protocol, screen, session, shell } = require('electron');
const path = require('node:path');
const { createCocoPet, registerCocoPetScheme } = require('./lib/coco-pet');
const { localOrigin, watchCowork } = require('./lib/cowork-activity');

function launch() {
  if (!app.requestSingleInstanceLock()) { app.quit(); return; }
  registerCocoPetScheme(protocol);
  app.setAppUserModelId('com.netlive.coco.pet');
  const origin = localOrigin(process.env.COCO_COWORK_PORT ?? process.env.NLC_BACKEND_PORT);
  let pet, tray, stopWatching;
  let connected = false;
  let visible = true;

  function showPet() { pet?.setEnabled(true); }
  function coworkMenu() {
    return [
      { label: connected ? 'CoWork 已连接' : 'CoWork 未连接', enabled: false },
      ...(connected ? [{ label: '打开 CoWork 网页', click: () => shell.openExternal(origin).catch(console.error) }] : []),
    ];
  }
  function refreshTray() {
    tray?.setContextMenu(Menu.buildFromTemplate([
      { label: visible ? '隐藏小络' : '显示小络', click: () => pet.setEnabled(!visible) },
      ...coworkMenu(),
      { type: 'separator' },
      { label: '退出小络', click: () => app.quit() },
    ]));
  }

  app.on('second-instance', showPet);
  app.on('window-all-closed', () => { /* The tray restores a hidden pet. */ });
  app.on('before-quit', () => {
    stopWatching?.();
    pet?.dispose();
    tray?.destroy();
  });
  app.whenReady().then(() => {
    const assetsDir = path.join(__dirname, 'assets/coco-pet');
    const icon = nativeImage.createFromPath(path.join(__dirname, 'assets/tray.png'));
    tray = new Tray(icon);
    tray.setToolTip('小络 CoCo');
    tray.on('click', showPet);
    pet = createCocoPet({
      BrowserWindow, Menu, ipcMain, screen, session, net, assetsDir,
      dataDir: app.getPath('userData'), coworkMenu, quit: () => app.quit(),
      onChange(enabled) { visible = enabled; refreshTray(); },
      log: console.error,
    });
    showPet();
    stopWatching = watchCowork(origin, state => {
      pet.setActivity(state.activity);
      if (connected !== state.connected) {
        connected = state.connected;
        refreshTray();
      }
    });
  }).catch(error => { console.error(error); app.exit(1); });
}

launch();
