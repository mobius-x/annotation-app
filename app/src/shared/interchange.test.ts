import { describe, expect, it } from 'vitest'
import { createAnnotatedDocument } from '../renderer/format/json-format'
import { exportFormats, serializeExchange } from './interchange'
import type { Annotation } from './model'
import { unzipSync, zipSync } from 'fflate'
import { extractDocxText } from './binary-formats'
import { parseExternalDocument } from '../renderer/format/import-format'
import initSqlJs from 'sql.js/dist/sql-wasm-inline.js'

const sample = `Р’ РґРѕРјРµ РћР±Р»РѕРЅСЃРєРёС… РІСЃРµ СЃРјРµС€Р°Р»РѕСЃСЊ.\n\nР–РµРЅР° СѓР·РЅР°Р»Р°, С‡С‚Рѕ РјСѓР¶ Р±С‹Р» РІ СЃРІСЏР·Рё.`
const annotations: Annotation[] = [
  { id: 'one', type: 'question', text: 'РџСЂРѕРІРµСЂРёС‚СЊ РёСЃС‚РѕС‡РЅРёРє', start: 23, end: 34, quote: '', tags: ['РїСЂРѕРІРµСЂРёС‚СЊ'], resolved: false, status: 'open', color: null, created: '2026-01-01T00:00:00.000Z', modified: '2026-01-01T00:00:00.000Z' },
  { id: 'two', type: 'critic_comment', text: '<script>alert(1)</script>', start: 29, end: 40, quote: '', tags: ['РІР°Р¶РЅРѕ'], resolved: true, status: 'resolved', color: '#ffeeaa', created: '2026-01-02T00:00:00.000Z', modified: '2026-01-02T00:00:00.000Z' },
  { id: 'orphan', type: 'note', text: 'РЈС‚СЂР°С‡РµРЅРѕ', start: 0, end: 0, quote: 'СЃС‚Р°СЂС‹Р№ С„СЂР°РіРјРµРЅС‚', tags: [], resolved: false, color: null, created: '2026-01-03T00:00:00.000Z', modified: '2026-01-03T00:00:00.000Z', orphan: true },
]

describe('interchange exporters', () => {
  it('offers every current export with a stable id and extension', () => {
    expect(exportFormats.map(({ id, extension }) => [id, extension])).toEqual([
      ['markdown', 'md'], ['markdown-blockquote', 'md'], ['markdown-callout', 'md'], ['html', 'html'], ['combined-txt', 'txt'], ['json', 'json'],
      ['critic-markup', 'critic.md'], ['csv', 'csv'], ['tsv', 'tsv'], ['w3c', 'web-annotation.json'],
      ['pandoc', 'pandoc.json'], ['tei', 'tei.xml'], ['obsidian', 'md'], ['hypothesis', 'hypothesis.json'],
      ['docx', 'docx'], ['epub', 'epub'], ['sqlite', 'sqlite'], ['duckdb', 'duckdb'],
    ])
  })

  it('exports layered HTML safely and embeds a full round-trip document', async () => {
    const document = await createAnnotatedDocument(sample, annotations, 'example.txt')
    const html = await serializeExchange(document, 'html') as string
    expect(html).toContain('data-annotation-id="one"')
    expect(html).toContain('data-annotation-id="two"')
    expect(html).not.toContain('<script>alert(1)</script>')
    expect(html).toContain('id="annotator-document"')
    expect(html).toContain('&lt;script&gt;')
  })

  it('exports CSV fields with quoting and includes UTF-8/grapheme offsets', async () => {
    const document = await createAnnotatedDocument('😀,цитата', [{ ...annotations[0]!, start: 3, end: 9, text: 'say "yes"' }], 'unicode.txt')
    const csv = await serializeExchange(document, 'csv') as string
    expect(csv).toContain('цитата')
    expect(csv).toContain('цитата')
    expect(csv).toContain('цитата')
  })

  it('emits embedded round-trip data in CriticMarkup, W3C and Obsidian exports', async () => {
    const document = await createAnnotatedDocument(sample, annotations, 'example.txt')
    expect(await serializeExchange(document, 'critic-markup')).toContain('annotator:document')
    expect(await serializeExchange(document, 'w3c')).toContain('"type": "AnnotationCollection"')
    expect(await serializeExchange(document, 'w3c')).toContain('"annotatorDocument"')
    expect(await serializeExchange(document, 'obsidian')).toContain('%% annotator:start %%')
  })

  it('escapes XML and keeps metadata for non-markup formats', async () => {
    const document = await createAnnotatedDocument(sample, annotations, 'example.txt')
    expect(await serializeExchange(document, 'tei')).toContain('&lt;script&gt;alert(1)&lt;/script&gt;')
    const pandoc = JSON.parse(await serializeExchange(document, 'pandoc') as string) as { blocks: unknown[] }
    expect(pandoc.blocks.length).toBeGreaterThan(0)
    expect(await serializeExchange(document, 'combined-txt')).toContain('STATUS=resolved')
    expect(await serializeExchange(document, 'markdown')).toContain('[^1]')
    expect(await serializeExchange(document, 'markdown-blockquote')).toContain('> **1.')
    expect(await serializeExchange(document, 'markdown-callout')).toContain('> [!question]')
    expect(await serializeExchange(document, 'tsv')).toContain('\t')
    await expect(serializeExchange(document, 'unsupported' as never)).rejects.toThrow()
  })

  it('writes readable DOCX comments, EPUB package, and SQLite tables', async () => {
    const document = await createAnnotatedDocument('A marked sentence.', [{ ...annotations[0]!, start: 2, end: 8, text: 'Check this' }], 'binary.txt')
    const docx = await serializeExchange(document, 'docx') as Uint8Array
    const extracted = extractDocxText(docx)
    expect(extracted.comments.has('__annotator_document__')).toBe(true)
    const roundtrip = await parseExternalDocument('roundtrip.docx', '', docx)
    expect(roundtrip.text).toBe(document.text)
    expect(roundtrip.annotations[0]?.body).toBe('Check this')
    const externalDocx = unzipSync(docx)
    delete externalDocx['customXml/annotator-document.json']
    const importedDocx = await parseExternalDocument('external.docx', '', zipSync(externalDocx))
    expect(importedDocx.text).toBe(document.text)
    expect(importedDocx.annotations[0]?.body).toBe('Check this')

    const epubBytes = await serializeExchange(document, 'epub') as Uint8Array
    const epub = unzipSync(epubBytes)
    expect(new TextDecoder().decode(epub.mimetype)).toBe('application/epub+zip')
    expect(epub['OEBPS/chapter.xhtml']).toBeDefined()
    const epubRoundtrip = await parseExternalDocument('roundtrip.epub', '', await serializeExchange(document, 'epub') as Uint8Array)
    expect(epubRoundtrip.text).toBe(document.text)
    delete epub['OEBPS/annotator-document.json']
    const importedEpub = await parseExternalDocument('external.epub', '', zipSync(epub))
    expect(importedEpub.text).toBe(document.text)
    expect(importedEpub.annotations[0]?.body).toBe('Check this')
    const sqlite = await serializeExchange(document, 'sqlite') as Uint8Array
    const SQL = await initSqlJs()
    const database = new SQL.Database(sqlite)
    expect(database.exec('SELECT title FROM documents')[0]?.values[0]?.[0]).toBe('binary')
    expect(database.exec('SELECT body FROM annotations')[0]?.values[0]?.[0]).toBe('Check this')
    database.close()
  })
})
