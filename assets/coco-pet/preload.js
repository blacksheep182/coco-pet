'use strict';
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('coco', {
  menu: () => ipcRenderer.send('coco-pet:menu'),
  interactive: value => ipcRenderer.send('coco-pet:interactive', value),
  dragStart: id => ipcRenderer.send('coco-pet:drag-start', id),
  dragEnd: details => ipcRenderer.send('coco-pet:drag-end', details),
  run: seconds => ipcRenderer.send('coco-pet:run', seconds),
  onRunDirection: callback => ipcRenderer.on('coco-pet:run-direction', (_event, direction) => callback(direction)),
  onPlay: callback => ipcRenderer.on('coco-pet:play', (_event, value) => callback(value)),
  onActivity: callback => ipcRenderer.on('coco-pet:activity', (_event, value) => callback(value)),
  onPhysics: callback => ipcRenderer.on('coco-pet:physics', (_event, value) => callback(value)),
});
