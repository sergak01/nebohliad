'use strict';

// Bridge for our own UI windows. Only "ui:" channels are allowed.

const { contextBridge, ipcRenderer } = require('electron');

const allowed = (channel) => typeof channel === 'string' && channel.startsWith('ui:');

contextBridge.exposeInMainWorld('overlay', {
  send(channel, data) {
    if (allowed(channel)) ipcRenderer.send(channel, data);
  },
  invoke(channel, data) {
    if (!allowed(channel)) return Promise.reject(new Error(`Channel not allowed: ${channel}`));
    return ipcRenderer.invoke(channel, data);
  },
  on(channel, callback) {
    if (allowed(channel)) ipcRenderer.on(channel, (_event, data) => callback(data));
  },
});
