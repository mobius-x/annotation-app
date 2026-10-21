import { describe, expect, it } from 'vitest'
import { isPathWithin, resolveDropDestination, uniqueTransferName, validateFileEntryName } from './file-operations'

describe('validateFileEntryName', () => {
  it('adds the default text extension and accepts supported documents', () => {
    expect(validateFileEntryName('chapter', 'C:\\texts', 'file')).toBe('chapter.txt')
    expect(validateFileEntryName('chapter.md', 'C:\\texts', 'file')).toBe('chapter.md')
    expect(validateFileEntryName('draft', 'C:\\texts', 'directory')).toBe('draft')
  })

  it.each(['', ' name', 'name ', 'bad/name', 'bad:name', 'bad?.txt', 'CON', 'nul.txt', 'ends.'])(
    'rejects invalid Windows name %j',
    (name) => {
      expect(() => validateFileEntryName(name, 'C:\\texts', 'file')).toThrow()
    },
  )

  it('rejects unsupported file types and paths that exceed the Windows limit', () => {
    expect(() => validateFileEntryName('document.json', 'C:\\texts', 'file')).toThrow('.txt и .md')
    expect(() => validateFileEntryName('a'.repeat(250) + '.txt', 'C:\\texts', 'file')).toThrow('259')
  })

  it('resolves drop destinations from row kind and drop zone', () => {
    expect(resolveDropDestination('C:\\texts\\sub', 'directory', true))
      .toBe('C:\\texts\\sub')
    expect(resolveDropDestination('C:\\texts\\b.txt', 'file', false))
      .toBe('C:\\texts')
  })

  it('detects paths inside a directory and generates stable conflict suffixes', () => {
    expect(isPathWithin('C:\\texts', 'C:\\texts\\sub\\a.txt')).toBe(true)
    expect(isPathWithin('C:\\texts', 'C:\\elsewhere\\a.txt')).toBe(false)
    const existing = new Set(['C:\\texts\\chapter.txt', 'C:\\texts\\chapter (2).txt'])
    expect(uniqueTransferName('chapter.txt', 'C:\\texts', (target) => existing.has(target))).toBe('chapter (3).txt')
  })
})
