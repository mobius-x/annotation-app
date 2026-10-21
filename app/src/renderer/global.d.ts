import type { Channel } from '../shared/ipc-contract'
import type { OpenedFile } from '../shared/model'

declare global {
  interface Window {
    annotator: {
      invoke(channel: Channel, payload?: unknown): Promise<unknown>
      onOpenFile(callback: (file: OpenedFile) => void): () => void
      onWorkspaceRefresh(callback: () => void): () => void
      onFileChanged(callback: (change: { path: string }) => void): () => void
    }
  }
}

export {}
