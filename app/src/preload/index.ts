import { contextBridge, ipcRenderer } from 'electron'
import type { Channel } from '../shared/ipc-contract'

const channelNames: Channel[] = [
  'dialog:openFile',
  'dialog:openFolder',
  'dialog:openWorkspace',
  'dialog:chooseEncoding',
  'state:get',
  'state:save',
  'dialog:saveWorkspace',
  'fs:list',
  'fs:create',
  'fs:rename',
  'fs:transfer',
  'fs:undo',
  'fs:delete',
  'fs:read',
  'fs:readSource',
  'fs:watchAck',
  'fs:applyText',
  'fs:save',
  'settings:get',
  'settings:save',
  'settings:openFile',
  'themes:list',
  'themes:save',
  'themes:delete',
  'app:relaunch',
  'recovery:save',
  'recovery:list',
  'recovery:delete',
  'shell:openExternal',
  'shell:showItemInFolder',
  'shell:copyPath',
]

const api = {
  invoke(channel: Channel, payload?: unknown): Promise<unknown> {
    if (!channelNames.includes(channel)) {
      return Promise.reject(new Error('IPC-канал не разрешён.'))
    }
    return payload === undefined
      ? ipcRenderer.invoke(channel)
      : ipcRenderer.invoke(channel, payload)
  },
  onOpenFile(callback: (file: import('../shared/model').OpenedFile) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, file: import('../shared/model').OpenedFile) => callback(file)
    ipcRenderer.on('file:open', listener)
    return () => ipcRenderer.removeListener('file:open', listener)
  },
  onWorkspaceRefresh(callback: () => void): () => void {
    const listener = () => callback()
    ipcRenderer.on('workspace:refresh', listener)
    return () => ipcRenderer.removeListener('workspace:refresh', listener)
  },
  onEntryRenamed(callback: (change: { oldPath: string; newPath: string; sidecars: Array<{ oldPath: string; newPath: string }> }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, change: { oldPath: string; newPath: string; sidecars: Array<{ oldPath: string; newPath: string }> }) => callback(change)
    ipcRenderer.on('workspace:entryRenamed', listener)
    return () => ipcRenderer.removeListener('workspace:entryRenamed', listener)
  },
  onEntriesTransferred(callback: (change: { pairs: Array<{ source: string; target: string }>; copy: boolean }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, change: { pairs: Array<{ source: string; target: string }>; copy: boolean }) => callback(change)
    ipcRenderer.on('workspace:entriesTransferred', listener)
    return () => ipcRenderer.removeListener('workspace:entriesTransferred', listener)
  },
  onFileChanged(callback: (change: { path: string }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, change: { path: string }) => callback(change)
    ipcRenderer.on('file:changed', listener)
    return () => ipcRenderer.removeListener('file:changed', listener)
  },
  onSystemThemeChanged(callback: (dark: boolean) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, dark: boolean) => callback(dark)
    ipcRenderer.on('theme:systemChanged', listener)
    return () => ipcRenderer.removeListener('theme:systemChanged', listener)
  },
}

contextBridge.exposeInMainWorld('annotator', api)
