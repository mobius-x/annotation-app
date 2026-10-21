import { describe, expect, it } from 'vitest'
import path from 'node:path'
import { parseWorkspaceFile, serializeWorkspaceFile, workspacePathFromFile } from './workspace-format'

describe('workspace files', () => {
  it('stores paths relative to the workspace file and restores them', () => {
    const workspaceFile = path.resolve('projects', 'reader.annotator-workspace')
    const folder = path.resolve('projects', 'books')
    const tab = path.resolve('projects', 'books', 'chapter.txt')
    const parsed = parseWorkspaceFile(serializeWorkspaceFile(workspaceFile, [folder], [tab], 0))

    expect(parsed.folders[0]?.path).toBe('books')
    expect(parsed.state?.openTabs[0]).toBe('books/chapter.txt')
    expect(workspacePathFromFile(workspaceFile, parsed.folders[0]!.path)).toBe(folder)
    expect(workspacePathFromFile(workspaceFile, parsed.state!.openTabs[0]!)).toBe(tab)
  })

  it('accepts absolute paths and preserves unknown workspace fields', () => {
    const source = JSON.stringify({
      version: 1,
      folders: [{ path: path.resolve('C:\\other-drive\\books'), name: 'Books' }],
      settings: { theme: 'nord' },
      state: { openTabs: [], activeTab: 0 },
      extensionData: true,
    })
    expect(parseWorkspaceFile(source)).toMatchObject({
      folders: [{ name: 'Books' }],
      settings: { theme: 'nord' },
      extensionData: true,
    })
  })

  it('rejects unsupported or incomplete workspace documents', () => {
    expect(() => parseWorkspaceFile('{')).toThrow('Некорректный файл workspace')
    expect(() => parseWorkspaceFile(JSON.stringify({ version: 2, folders: [] }))).toThrow('version')
  })
})
