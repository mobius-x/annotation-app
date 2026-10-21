import path from 'node:path'

export interface FileDialogResult {
  canceled: boolean
  filePaths?: string[]
  filePath?: string
}

export async function loadSelectedInterchange(
  result: FileDialogResult,
  readFile: (filePath: string) => Promise<Uint8Array>,
  registerRoot: (directory: string) => void,
  maxBytes = 50 * 1024 * 1024,
): Promise<{ name: string; path: string; content: string | Uint8Array } | null> {
  const selected = result.filePaths?.[0]
  if (result.canceled || !selected) return null
  const filePath = path.resolve(selected)
  const bytes = await readFile(filePath)
  if (bytes.byteLength > maxBytes) throw new Error(`Import file exceeds ${maxBytes} bytes.`)
  registerRoot(path.dirname(filePath))
  const name = path.basename(filePath)
  const binary = /\.(docx|epub)$/i.test(name)
  return { name, path: filePath, content: binary ? new Uint8Array(bytes) : new TextDecoder('utf-8').decode(bytes) }
}

export async function saveSelectedExport(
  result: FileDialogResult,
  content: string | Uint8Array,
  writeFile: (filePath: string, bytes: Uint8Array) => Promise<void>,
  registerRoot: (directory: string) => void,
): Promise<string | null> {
  if (result.canceled || !result.filePath) return null
  const target = path.resolve(result.filePath)
  await writeFile(target, typeof content === 'string' ? new TextEncoder().encode(content) : content)
  registerRoot(path.dirname(target))
  return target
}
