import { describe, expect, it } from 'vitest'
import { createAnnotatedDocument, parseAnnotatedDocument, restoreAnnotations, toPlainAnnotatedDocument } from './json-format'
import type { Annotation } from '../../shared/model'

const annotation: Annotation = {
  id: 'a123abc',
  type: 'note',
  text: 'Проверить',
  start: 6,
  end: 15,
  quote: 'Проверить',
  tags: ['глава 1'],
  resolved: false,
  color: null,
  created: '2026-10-21T00:00:00.000Z',
  modified: '2026-10-21T00:00:00.000Z',
}

describe('JSON annotated documents', () => {
  it('round-trips a Cyrillic annotation and validates offsets', async () => {
    const serialized = await createAnnotatedDocument('Текст Проверить здесь', [annotation], 'chapter.txt')
    const parsed = parseAnnotatedDocument(JSON.stringify(serialized))
    expect(restoreAnnotations(parsed).annotations[0]).toMatchObject({ start: 6, end: 15, quote: 'Проверить' })
    expect(parsed.document.textSha256).toMatch(/^[a-f0-9]{64}$/)
  })

  it('restores a shifted range using its exact quote', async () => {
    const document = await createAnnotatedDocument('Вставка Текст Проверить здесь', [annotation], 'chapter.txt')
    document.text = `Новая строка\n${document.text}`
    const restored = restoreAnnotations(document)
    expect(restored.annotations[0].start).toBe(19)
    expect(restored.shifted).toBe(1)
  })

  it('rejects malformed ranges rather than partially opening the file', async () => {
    const document = await createAnnotatedDocument('Коротко', [annotation], 'chapter.txt')
    document.annotations[0].range!.end = 99
    expect(() => parseAnnotatedDocument(JSON.stringify(document))).toThrow('range')
  })

  it('converts nested reactive proxies to structured-clone-safe IPC data', async () => {
    const document = await createAnnotatedDocument('Текст Проверить здесь', [annotation], 'chapter.txt')
    const proxiedDocument = new Proxy(document, {
      get: (target, property, receiver) => {
        const value: unknown = Reflect.get(target, property, receiver)
        return Array.isArray(value)
          ? new Proxy(value, { get: (array, key, nestedReceiver) => Reflect.get(array, key, nestedReceiver) })
          : value
      },
    })
    expect(() => structuredClone(proxiedDocument)).toThrow()

    const ipcDocument = toPlainAnnotatedDocument(proxiedDocument)
    expect(structuredClone(ipcDocument)).toEqual(document)
  })
})
