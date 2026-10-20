import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { createAnnotatedDocument } from '../renderer/format/json-format'
import { parseMarkdownDocument, serializeMarkdownDocument } from './markdown-format'
import type { Annotation } from './model'

function annotation(id: string, start: number, end: number, body = `Заметка ${id}`): Annotation {
  return {
    id,
    type: 'comment',
    text: body,
    start,
    end,
    quote: '',
    tags: ['русский тег'],
    resolved: false,
    color: null,
    created: '2026-10-21T00:00:00.000Z',
    modified: '2026-10-21T00:00:00.000Z',
  }
}

describe('Markdown annotated documents', () => {
  it('round-trips nested annotations and reserved literal sequences', async () => {
    const text = 'Текст == и \\== и [^1], <!-- annotator:notes --> и a\\'
    const document = await createAnnotatedDocument(text, [annotation('outer', 0, 10), annotation('inner', 3, 7)], 'chapter.txt')
    const parsed = parseMarkdownDocument(serializeMarkdownDocument(document))
    expect(parsed.text).toBe(text)
    expect(parsed.annotations.map((item) => item.range)).toEqual(document.annotations.map((item) => item.range))
    expect(parsed.annotations.map((item) => item.body)).toEqual(document.annotations.map((item) => item.body))
  })

  it('round-trips crossing ranges by writing mergeable segments', async () => {
    const document = await createAnnotatedDocument('0123456789abcdefghij', [annotation('first', 0, 10), annotation('second', 5, 15)], 'chapter.txt')
    const parsed = parseMarkdownDocument(serializeMarkdownDocument(document))
    expect(parsed.annotations.map((item) => [item.id, item.range?.start, item.range?.end])).toEqual([
      ['first', 0, 10],
      ['second', 5, 15],
    ])
  })

  it('preserves orphan annotations and requested newline style', async () => {
    const document = await createAnnotatedDocument('Текст', [annotation('orphan', 0, 4)], 'chapter.txt')
    document.annotations[0]!.range = null
    document.annotations[0]!.quote = { exact: 'утрачено', prefix: 'раньше ', suffix: ' позже' }
    const output = serializeMarkdownDocument(document, '\r\n')
    expect(output).toContain('\r\n')
    const parsed = parseMarkdownDocument(output)
    expect(parsed.annotations[0]).toMatchObject({
      id: 'orphan',
      range: null,
      quote: { exact: 'утрачено', prefix: 'раньше ', suffix: ' позже' },
    })
  })

  it('preserves arbitrary reserved-character text and annotation ranges', async () => {
    await fc.assert(fc.asyncProperty(
      fc.array(fc.constantFrom('=', '[', '^', '<', '!', '-', '\\', ']', 'а', '\n', '😀'), { maxLength: 40 }),
      fc.integer(),
      fc.integer(),
      async (characters, first, second) => {
        const text = characters.join('')
        const start = text.length ? Math.abs(first) % text.length : 0
        const end = text.length ? start + 1 + Math.abs(second) % (text.length - start) : 0
        const annotations = text.length ? [annotation('random', start, end)] : []
        const document = await createAnnotatedDocument(text, annotations, 'chapter.txt')
        const parsed = parseMarkdownDocument(serializeMarkdownDocument(document))
        expect(parsed.text).toBe(text)
        expect(parsed.annotations.map((item) => item.range)).toEqual(document.annotations.map((item) => item.range))
      },
    ), { numRuns: 100 })
  })
})
