import type { Channel } from '../shared/ipc-contract'
import type { OpenedFile } from '../shared/model'

declare global {
  interface Window {
    annotator: {
      invoke(channel: Channel, payload?: unknown): Promise<unknown>
      onOpenFile(callback: (file: OpenedFile) => void): () => void
      onWorkspaceRefresh(callback: () => void): () => void
      onEntryRenamed(callback: (change: { oldPath: string; newPath: string; sidecars: Array<{ oldPath: string; newPath: string }> }) => void): () => void
      onEntriesTransferred(callback: (change: { pairs: Array<{ source: string; target: string }>; copy: boolean }) => void): () => void
      onFileChanged(callback: (change: { path: string }) => void): () => void
      onSystemThemeChanged(callback: (dark: boolean) => void): () => void
    }
  }
}

export {}
