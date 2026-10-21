import { describe, expect, it } from 'vitest'
import { serializeExchange } from '../../shared/interchange'
import { createAnnotatedDocument, restoreAnnotations } from './json-format'
import { parseExternalDocument } from './import-format'
import type { Annotation } from '../../shared/model'

const source = 'Здесь находится важная цитата в тексте.'
const annotation: Annotation = {
  id: 'note-1', type: 'note', text: 'Проверить', start: 20, end: 34, quote: source.slice(20, 34), tags: ['факт'],
  resolved: false, status: 'open', color: null, created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z',
}

describe('external document import', () => {
  it('opens internal JSON without losing old or new annotation data', async () => {
    const document = await createAnnotatedDocument(source, [annotation], 'source.txt')
    const parsed = await parseExternalDocument('notes.json', JSON.stringify(document))
    expect(restoreAnnotations(parsed).annotations[0]).toMatchObject({ id: 'note-1', quote: annotation.quote, tags: ['факт'] })
  })

  it('round-trips exports with embedded data through HTML, CriticMarkup, W3C and Obsidian', async () => {
    const document = await createAnnotatedDocument(source, [annotation], 'source.txt')
    for (const format of ['html', 'critic-markup', 'w3c', 'obsidian'] as const) {
      const extension = format === 'critic-markup' ? 'critic.md' : format === 'w3c' ? 'web-annotation.json' : format === 'obsidian' ? 'md' : 'html'
      const parsed = await parseExternalDocument(`roundtrip.${extension}`, await serializeExchange(document, format) as string)
      expect(parsed.text).toBe(document.text)
      expect(restoreAnnotations(parsed).annotations[0]?.id).toBe('note-1')
    }
  })

  it('imports standard W3C records as unlinked notes when source text is not embedded', async () => {
    const w3c = JSON.stringify([{ type: 'Annotation', body: [{ value: 'Найти источник' }], target: { selector: { type: 'TextQuoteSelector', exact: 'цитата', prefix: 'до ', suffix: ' после' } } }])
    const parsed = await parseExternalDocument('external.jsonld', w3c)
    expect(parsed.text).toBe('')
    expect(parsed.annotations[0]).toMatchObject({ range: null, quote: { exact: 'цитата', prefix: 'до ', suffix: ' после' }, body: 'Найти источник' })
  })

  it('imports CriticMarkup and preserves the original quote in the text layer', async () => {
    const parsed = await parseExternalDocument('review.critic.md', 'Фраза {~~старый текст~>новая версия~~}.')
    expect(parsed.text).toBe('Фраза старый текст.')
    expect(restoreAnnotations(parsed).annotations[0]).toMatchObject({ type: 'critic_sub', quote: 'старый текст', text: 'новая версия' })
  })

  it('imports basic Markdown footnotes and HTML text safely', async () => {
    const markdown = await parseExternalDocument('notes.md', 'Фраза цитата[^1].\n\n[^1]: Комментарий\n    > цитата')
    expect(markdown.annotations[0]).toMatchObject({ quote: { exact: 'цитата' }, body: 'Комментарий' })
    const html = await parseExternalDocument('plain.html', '<article><p>Безопасный &lt;текст&gt;</p></article>')
    expect(html.text).toBe('Безопасный <текст>')
  })

  it('rejects malformed JSON instead of returning a partial document', async () => {
    await expect(parseExternalDocument('broken.json', '{no json')).rejects.toThrow()
  })
})
