import { describe, expect, it, vi } from 'vitest'
import { loadSelectedInterchange, saveSelectedExport } from './interchange-io'

describe('interchange file dialog operations', () => {
  it('treats canceled import as a no-op', async () => {
    const readFile = vi.fn()
    const registerRoot = vi.fn()
    await expect(loadSelectedInterchange({ canceled: true }, readFile, registerRoot)).resolves.toBeNull()
    expect(readFile).not.toHaveBeenCalled()
    expect(registerRoot).not.toHaveBeenCalled()
  })

  it('preserves binary inputs and refuses an oversized file before registering its folder', async () => {
    const bytes = new Uint8Array([0, 255, 1])
    const readFile = vi.fn(async () => bytes)
    const registerRoot = vi.fn()
    const loaded = await loadSelectedInterchange({ canceled: false, filePaths: ['C:/docs/file.docx'] }, readFile, registerRoot)
    expect(loaded?.content).toEqual(bytes)
    await expect(loadSelectedInterchange({ canceled: false, filePaths: ['C:/docs/file.txt'] }, async () => new Uint8Array(5), registerRoot, 4)).rejects.toThrow('exceeds')
    const failedRoot = vi.fn()
    await expect(loadSelectedInterchange({ canceled: false, filePaths: ['C:/docs/broken.json'] }, async () => { throw new Error('read failed') }, failedRoot)).rejects.toThrow('read failed')
    expect(failedRoot).not.toHaveBeenCalled()
  })

  it('leaves canceled exports untouched and forwards write failures', async () => {
    const writeFile = vi.fn(async () => {})
    const registerRoot = vi.fn()
    await expect(saveSelectedExport({ canceled: true }, 'text', writeFile, registerRoot)).resolves.toBeNull()
    expect(writeFile).not.toHaveBeenCalled()
    await expect(saveSelectedExport({ canceled: false, filePath: 'C:/docs/out.txt' }, new Uint8Array([1, 2]), writeFile, registerRoot)).resolves.toMatch(/out\.txt$/)
    expect(writeFile).toHaveBeenCalledWith(expect.stringMatching(/out\.txt$/), new Uint8Array([1, 2]))
    await expect(saveSelectedExport({ canceled: false, filePath: 'C:/docs/fail.txt' }, 'text', async () => { throw new Error('disk full') }, registerRoot)).rejects.toThrow('disk full')
  })
})
