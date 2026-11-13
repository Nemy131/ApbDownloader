'use strict';
const { contextBridge, ipcRenderer } = require('electron');
const allowed = new Set(['snapshot','autoTranslate','translateTexts','translationCache','translationEngine','claudeAccount','codexAccount','titleBar','browserHide','viewerOpen','viewerBounds','viewerClose','browserAction','browserImport','browserDownload','browserPreview','uploaderUrl','authorBookmark','authorRemove','authorDefaultsRestore','authorOrder','completionNotification','downloadOptions','fileNameTranslation','scanPresence','maxImport','maxImportPlan','maxImportForget','downloadForget','progressForget','appAnswer','maxConfig','browse','bookmark','login','refreshAccount','logout','settings','folder','openFolder','load','refresh','selection','selectMissing','start','cancel','openPost']);
contextBridge.exposeInMainWorld('aplay', {
  call: (method,...args) => { if(!allowed.has(method)) return Promise.reject(new Error('허용되지 않은 요청')); return ipcRenderer.invoke(method,...args); },
  onBrowserDownload: callback => ipcRenderer.on('browser-download-started',()=>callback()),
  onClaudeLogin: callback => ipcRenderer.on('claude-login',(_event,state)=>callback(state)),
  onAsk: callback => ipcRenderer.on('app-ask',(_event,question)=>callback(question)),
  onViewerAction: callback => ipcRenderer.on('viewer-action',(_event,action)=>callback(action)),
  onViewer: callback => ipcRenderer.on('viewer-state',(_event,state)=>callback(state)),
  onBrowser: callback => ipcRenderer.on('browser-state',(_event,state)=>callback(state)),
  onState: callback => ipcRenderer.on('state',(_event,state)=>callback(state)),
  onTaskFailed: callback => ipcRenderer.on('task-failed',(_event,message)=>callback(message)),
  onFinished: callback => ipcRenderer.on('download-finished',(_event,result)=>callback(result)),
  onAuthor: callback => ipcRenderer.on('author-selected',(_event,url)=>callback(url)),
  onUpdate: callback => ipcRenderer.on('update-state',(_event,state)=>callback(state))
});
