'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['snapshot','autoTranslate','translateTexts','translationCache','translationEngine','claudeAccount','titleBar','browserHide','viewerOpen','viewerBounds','viewerClose','browserAction','browserImport','browserDownload','authorBookmark','authorRemove','completionNotification','fileNameTranslation','scanPresence','maxImport','maxConfig','browse','bookmark','login','refreshAccount','logout','settings','folder','openFolder','load','refresh','selection','selectMissing','start','cancel','openPost']);
contextBridge.exposeInMainWorld('aplay', {
  call: (method,...args) => { if(!allowed.has(method)) return Promise.reject(new Error('허용되지 않은 요청')); return ipcRenderer.invoke(method,...args); },
  onBrowserDownload: callback => ipcRenderer.on('browser-download-started',()=>callback()),
  onViewer: callback => ipcRenderer.on('viewer-state',(_event,state)=>callback(state)),
  onBrowser: callback => ipcRenderer.on('browser-state',(_event,state)=>callback(state)),
  onState: callback => ipcRenderer.on('state',(_event,state)=>callback(state)),
  onFinished: callback => ipcRenderer.on('download-finished',(_event,result)=>callback(result)),
  onAuthor: callback => ipcRenderer.on('author-selected',(_event,url)=>callback(url)),
  onUpdate: callback => ipcRenderer.on('update-state',(_event,state)=>callback(state))
});
