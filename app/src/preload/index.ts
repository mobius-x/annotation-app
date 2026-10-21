import { contextBridge, ipcRenderer } from 'electron'
import type { Channel } from '../shared/ipc-contract'

const channelNames: Channel[] = [
  'dialog:openFile',
  'dialog:openFolder',
  'fs:list',
  'fs:read',
  'fs:watchAck',
  'fs:save',
  'settings:get',
  'settings:save',
  'recovery:save',
  'recovery:list',
  'recovery:delete',
  'shell:openExternal',
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
  onFileChanged(callback: (change: { path: string }) => void): () => void {
    const listener = (_event: Electron.IpcRendererEvent, change: { path: string }) => callback(change)
    ipcRenderer.on('file:changed', listener)
    return () => ipcRenderer.removeListener('file:changed', listener)
  },
}

contextBridge.exposeInMainWorld('annotator', api)
