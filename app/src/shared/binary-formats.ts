import {
  CommentRangeEnd, CommentRangeStart, CommentReference, Document, HighlightColor, Packer, Paragraph, TextRun,
} from 'docx'
import { zipSync, unzipSync } from 'fflate'
import initSqlJs from 'sql.js/dist/sql-wasm-inline.js'
import * as duckdb from '@duckdb/duckdb-wasm'
import duckdbWasmUrl from '@duckdb/duckdb-wasm/dist/duckdb-mvp.wasm?url'
import duckdbWorkerUrl from '@duckdb/duckdb-wasm/dist/duckdb-browser-mvp.worker.js?url'
import type { AnnotatedDocument, StoredAnnotation } from './model'

function sortedAnnotations(document: AnnotatedDocument): StoredAnnotation[] {
  return [...document.annotations].sort((left, right) => {
    const a = left.range?.start ?? Number.MAX_SAFE_INTEGER
    const b = right.range?.start ?? Number.MAX_SAFE_INTEGER
    return a - b || (right.range?.end ?? 0) - (left.range?.end ?? 0) || left.id.localeCompare(right.id)
  })
}

function escapeXml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function sqlText(text: string): string { return `'${text.replaceAll("'", "''")}'` }

export async function exportDocx(document: AnnotatedDocument): Promise<Uint8Array> {
  const linked = sortedAnnotations(document).filter((item) => item.range)
  const idByAnnotation = new Map(linked.map((item, index) => [item.id, index]))
  const paragraphs: Paragraph[] = []
  let absoluteStart = 0
  for (const paragraphText of document.text.split('\n')) {
    const absoluteEnd = absoluteStart + paragraphText.length
    const relevant = linked.filter((item) => item.range!.start < absoluteEnd && item.range!.end > absoluteStart)
    const boundaries = [...new Set([absoluteStart, absoluteEnd, ...relevant.flatMap((item) => [
      Math.max(absoluteStart, item.range!.start), Math.min(absoluteEnd, item.range!.end),
    ])])].sort((a, b) => a - b)
    const children: Array<CommentRangeStart | CommentRangeEnd | CommentReference | TextRun> = []
    for (let index = 0; index < boundaries.length; index += 1) {
      const position = boundaries[index]!
      const ending = relevant.filter((item) => item.range!.end === position).sort((a, b) => b.range!.start - a.range!.start)
      for (const item of ending) {
        const commentId = idByAnnotation.get(item.id)!
        children.push(new CommentRangeEnd(commentId), new CommentReference(commentId))
      }
      const opening = relevant.filter((item) => item.range!.start === position).sort((a, b) => b.range!.end - a.range!.end)
      for (const item of opening) children.push(new CommentRangeStart(idByAnnotation.get(item.id)!))
      const next = boundaries[index + 1]
      if (next === undefined || next <= position) continue
      const text = document.text.slice(position, next)
      const highlighted = relevant.some((item) => item.type === 'highlight' || item.type === 'critic_highlight')
      if (text) children.push(new TextRun({ text, ...(highlighted ? { highlight: HighlightColor.YELLOW } : {}) }))
    }
    paragraphs.push(new Paragraph({ children: children.length ? children : [new TextRun(paragraphText)] }))
    absoluteStart = absoluteEnd + 1
  }
  const comments = linked.map((item, index) => ({
    id: index,
    author: item.author ?? 'Annotator',
    date: new Date(item.created),
    children: [new Paragraph(`[Annotator:${item.type}:${item.status ?? (item.resolved ? 'resolved' : 'open')}]`), new Paragraph(item.body || 'No note')],
  }))
  const docx = new Document({
    title: document.document.title,
    creator: 'Annotator',
    comments: { children: comments },
    sections: [{ children: paragraphs }],
  })
  const blob = await Packer.toBlob(docx)
  const zipped = unzipSync(new Uint8Array(await blob.arrayBuffer()))
  zipped['customXml/annotator-document.json'] = new TextEncoder().encode(JSON.stringify(document))
  return zipSync(zipped, { level: 6 })
}

function epubHtml(document: AnnotatedDocument): string {
  const linked = sortedAnnotations(document).filter((item) => item.range)
  const points = [...new Set([0, document.text.length, ...linked.flatMap((item) => [item.range!.start, item.range!.end])])].sort((a, b) => a - b)
  let body = ''
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index]!
    const end = points[index + 1]!
    let value = escapeXml(document.text.slice(start, end))
    for (const item of [...linked].reverse().filter((candidate) => candidate.range!.start <= start && candidate.range!.end >= end)) {
      value = `<mark id="mark-${escapeXml(item.id)}" data-annotation-id="${escapeXml(item.id)}">${value}</mark>`
    }
    body += value
  }
  const paragraphs = body.split(/\n\n+/).map((paragraph) => `<p>${paragraph.replaceAll('\n', '<br/>')}</p>`).join('\n')
  const notes = sortedAnnotations(document).map((item) => `<aside id="note-${escapeXml(item.id)}"><h2>${escapeXml(item.type)} · ${escapeXml(item.status ?? (item.resolved ? 'resolved' : 'open'))}</h2><blockquote>${escapeXml(item.quote.exact)}</blockquote><p>${escapeXml(item.body)}</p></aside>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="ru"><head><title>${escapeXml(document.document.title)}</title><meta charset="UTF-8"/><style>body{font:1em/1.7 serif;margin:5%}mark{background:#fde68a}aside{border-left:.2em solid #d6a800;padding:.8em;margin:1em 0}</style></head><body><article>${paragraphs}</article><section epub:type="annotations"><h1>Аннотации</h1>${notes}</section></body></html>`
}

export function exportEpub(document: AnnotatedDocument): Uint8Array {
  const id = `urn:sha256:${document.document.textSha256 || 'annotator-document'}`
  const container = `<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/package.opf" media-type="application/oebps-package+xml"/></rootfiles></container>`
  const packageOpf = `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book-id">${escapeXml(id)}</dc:identifier><dc:title>${escapeXml(document.document.title)}</dc:title><dc:language>ru</dc:language><meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d{3}Z$/, 'Z')}</meta></metadata><manifest><item id="chapter" href="chapter.xhtml" media-type="application/xhtml+xml"/><item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/></manifest><spine><itemref idref="chapter"/></spine></package>`
  const nav = `<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops"><head><title>Содержание</title></head><body><nav epub:type="toc"><h1>Содержание</h1><ol><li><a href="chapter.xhtml">${escapeXml(document.document.title)}</a></li></ol></nav></body></html>`
  return zipSync({
    mimetype: [new TextEncoder().encode('application/epub+zip'), { level: 0 }],
    'META-INF/container.xml': new TextEncoder().encode(container),
    'OEBPS/package.opf': new TextEncoder().encode(packageOpf),
    'OEBPS/nav.xhtml': new TextEncoder().encode(nav),
    'OEBPS/chapter.xhtml': new TextEncoder().encode(epubHtml(document)),
    'OEBPS/annotator-document.json': new TextEncoder().encode(JSON.stringify(document)),
  }, { level: 6 })
}

export async function exportSqlite(document: AnnotatedDocument): Promise<Uint8Array> {
  const SQL = await initSqlJs()
  const database = new SQL.Database()
  database.run('CREATE TABLE documents (id TEXT PRIMARY KEY, title TEXT NOT NULL, source TEXT, text TEXT NOT NULL, text_sha256 TEXT NOT NULL, language TEXT NOT NULL, created TEXT NOT NULL, modified TEXT NOT NULL)')
  database.run('CREATE TABLE annotations (id TEXT PRIMARY KEY, document_id TEXT NOT NULL, type TEXT NOT NULL, start_utf16 INTEGER, end_utf16 INTEGER, start_utf8 INTEGER, end_utf8 INTEGER, start_grapheme INTEGER, end_grapheme INTEGER, quote TEXT NOT NULL, prefix TEXT NOT NULL, suffix TEXT NOT NULL, body TEXT NOT NULL, tags_json TEXT NOT NULL, status TEXT NOT NULL, color TEXT, author TEXT, parent_id TEXT, metadata_json TEXT NOT NULL)')
  const doc = document.document
  database.run(`INSERT INTO documents VALUES (${[
    sqlText(doc.textSha256 || 'document-1'), sqlText(doc.title), sqlText(doc.source ?? ''), sqlText(document.text),
    sqlText(doc.textSha256), sqlText(doc.language), sqlText(doc.created), sqlText(doc.modified),
  ].join(', ')})`)
  for (const item of sortedAnnotations(document)) {
    const range = item.range
    const utf8At = (offset: number) => new TextEncoder().encode(document.text.slice(0, offset)).length
    const graphemesAt = (offset: number) => typeof Intl.Segmenter === 'function'
      ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(document.text.slice(0, offset))].length
      : [...document.text.slice(0, offset)].length
    const fields = [
      sqlText(item.id), sqlText(doc.textSha256 || 'document-1'), sqlText(item.type), range?.start === undefined ? 'NULL' : String(range.start),
      range?.end === undefined ? 'NULL' : String(range.end), range ? String(utf8At(range.start)) : 'NULL', range ? String(utf8At(range.end)) : 'NULL',
      range ? String(graphemesAt(range.start)) : 'NULL', range ? String(graphemesAt(range.end)) : 'NULL', sqlText(item.quote.exact),
      sqlText(item.quote.prefix), sqlText(item.quote.suffix), sqlText(item.body), sqlText(JSON.stringify(item.tags)),
      sqlText(item.status ?? (item.resolved ? 'resolved' : 'open')), item.color ? sqlText(item.color) : 'NULL',
      item.author ? sqlText(item.author) : 'NULL', item.parentId ? sqlText(item.parentId) : 'NULL', sqlText(JSON.stringify(item.metadata ?? {})),
    ]
    database.run(`INSERT INTO annotations VALUES (${fields.join(', ')})`)
  }
  const output = database.export()
  database.close()
  return output
}

export async function exportDuckDb(document: AnnotatedDocument): Promise<Uint8Array> {
  const worker = new Worker(duckdbWorkerUrl)
  const database = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(), worker)
  try {
    await database.instantiate(duckdbWasmUrl)
    const connection = await database.connect()
    try {
      await connection.query("ATTACH 'annotator.duckdb' AS annotator")
      await connection.query('CREATE TABLE annotator.documents (id VARCHAR PRIMARY KEY, title VARCHAR, source VARCHAR, text VARCHAR, text_sha256 VARCHAR, language VARCHAR, created TIMESTAMPTZ, modified TIMESTAMPTZ)')
      await connection.query('CREATE TABLE annotator.annotations (id VARCHAR PRIMARY KEY, document_id VARCHAR, type VARCHAR, start_utf16 BIGINT, end_utf16 BIGINT, start_utf8 BIGINT, end_utf8 BIGINT, start_grapheme BIGINT, end_grapheme BIGINT, quote VARCHAR, prefix VARCHAR, suffix VARCHAR, body VARCHAR, tags_json JSON, status VARCHAR, color VARCHAR, author VARCHAR, parent_id VARCHAR, metadata_json JSON)')
      const doc = document.document
      const docValues = [doc.textSha256 || 'document-1', doc.title, doc.source ?? '', document.text, doc.textSha256, doc.language, doc.created, doc.modified].map(sqlText).join(', ')
      await connection.query(`INSERT INTO annotator.documents VALUES (${docValues})`)
      for (const item of sortedAnnotations(document)) {
        const range = item.range
        const utf8At = (offset: number) => new TextEncoder().encode(document.text.slice(0, offset)).length
        const graphemesAt = (offset: number) => typeof Intl.Segmenter === 'function'
          ? [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(document.text.slice(0, offset))].length
          : [...document.text.slice(0, offset)].length
        const values = [
          sqlText(item.id), sqlText(doc.textSha256 || 'document-1'), sqlText(item.type), range?.start === undefined ? 'NULL' : String(range.start),
          range?.end === undefined ? 'NULL' : String(range.end), range ? String(utf8At(range.start)) : 'NULL', range ? String(utf8At(range.end)) : 'NULL',
          range ? String(graphemesAt(range.start)) : 'NULL', range ? String(graphemesAt(range.end)) : 'NULL', sqlText(item.quote.exact),
          sqlText(item.quote.prefix), sqlText(item.quote.suffix), sqlText(item.body), `${sqlText(JSON.stringify(item.tags))}::JSON`,
          sqlText(item.status ?? (item.resolved ? 'resolved' : 'open')), item.color ? sqlText(item.color) : 'NULL',
          item.author ? sqlText(item.author) : 'NULL', item.parentId ? sqlText(item.parentId) : 'NULL', `${sqlText(JSON.stringify(item.metadata ?? {}))}::JSON`,
        ]
        await connection.query(`INSERT INTO annotator.annotations VALUES (${values.join(', ')})`)
      }
      await connection.query('DETACH annotator')
      return await database.copyFileToBuffer('annotator.duckdb')
    } finally {
      await connection.close()
    }
  } finally {
    await database.terminate()
  }
}

export function extractDocxText(bytes: Uint8Array): { text: string; comments: Map<string, { text: string; author: string }> } {
  const archive = unzipSync(bytes)
  const embedded = archive['customXml/annotator-document.json']
  if (embedded) return { text: '', comments: new Map([['__annotator_document__', { text: new TextDecoder().decode(embedded), author: 'Annotator' }]]) }
  const xml = new TextDecoder().decode(archive['word/document.xml'] ?? new Uint8Array())
  const commentsXml = new TextDecoder().decode(archive['word/comments.xml'] ?? new Uint8Array())
  const comments = new Map<string, { text: string; author: string }>()
  for (const match of commentsXml.matchAll(/<w:comment\b([^>]*)>([\s\S]*?)<\/w:comment>/g)) {
    const commentId = match[1]!.match(/w:id="([^"]+)"/)?.[1]
    if (!commentId) continue
    const author = match[1]!.match(/w:author="([^"]+)"/)?.[1] ?? 'Annotator'
    const body = [...match[2]!.matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g)].map((item) => item[1]).join(' ')
    comments.set(commentId, { text: decodeXml(body), author: decodeXml(author) })
  }
  let text = ''
  const ranges = new Map<string, { start?: number; end?: number }>()
  const paragraphs = [...xml.matchAll(/<w:p(?:\s[^>]*)?>([\s\S]*?)<\/w:p>/g)]
  for (const paragraph of paragraphs) {
    const content = paragraph[1]!
    for (const token of content.matchAll(/<w:commentRangeStart\b[^>]*w:id="([^"]+)"[^>]*\/>|<w:commentRangeEnd\b[^>]*w:id="([^"]+)"[^>]*\/>|<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) {
      if (token[1]) ranges.set(token[1], { ...ranges.get(token[1]), start: text.length })
      else if (token[2]) ranges.set(token[2], { ...ranges.get(token[2]), end: text.length })
      else if (token[3]) text += decodeXml(token[3])
      else if (token[0].startsWith('<w:tab')) text += '\t'
      else if (token[0].startsWith('<w:br')) text += '\n'
    }
    text += '\n'
  }
  text = text.replace(/\n+$/, '')
  for (const [commentId, range] of ranges) {
    const comment = comments.get(commentId)
    if (comment && range.start !== undefined && range.end !== undefined) comments.set(commentId, { ...comment, text: `${range.start}:${range.end}\n${comment.text}` })
  }
  return { text, comments }
}

export function extractEpub(bytes: Uint8Array): { document?: AnnotatedDocument; text: string; annotations: Array<{ id: string; quote: string; note: string; start?: number; end?: number }> } {
  const archive = unzipSync(bytes)
  const embedded = archive['OEBPS/annotator-document.json']
  if (embedded) return { document: JSON.parse(new TextDecoder().decode(embedded)) as AnnotatedDocument, text: '', annotations: [] }
  const xhtml = new TextDecoder().decode(archive['OEBPS/chapter.xhtml'] ?? new Uint8Array())
  const article = xhtml.match(/<article\b[^>]*>([\s\S]*?)<\/article>/i)?.[1] ?? xhtml
  const text = decodeXml(article.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]*>/g, '')).trim()
  const annotations = [...xhtml.matchAll(/<aside\b[^>]*id="note-([^"]+)"[^>]*>[\s\S]*?<blockquote>([\s\S]*?)<\/blockquote>[\s\S]*?<p>([\s\S]*?)<\/p>[\s\S]*?<\/aside>/gi)].map((match) => ({ id: match[1]!, quote: decodeXml(match[2]!.replace(/<[^>]*>/g, '')), note: decodeXml(match[3]!.replace(/<[^>]*>/g, '')) }))
  return { text, annotations }
}

function decodeXml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|apos);/g, (_whole, entity: string) => ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity]!)
}
