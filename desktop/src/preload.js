const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('napcat', {
  onStatus(cb) {
    ipcRenderer.on('status', (_e, payload) => cb(payload))
  },
  ready() {
    ipcRenderer.send('splash-ready')
  },
})
