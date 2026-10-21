import type { AnnotatedDocument, StoredAnnotation } from './model'
import { textOffsetsAt } from './text-offsets'
import { exportDocx, exportEpub, exportSqlite, exportDuckDb } from './binary-formats'

export type ExchangeFormat =
  | 'markdown' | 'html' | 'combined-txt' | 'json' | 'critic-markup' | 'csv' | 'tsv'
  | 'w3c' | 'pandoc' | 'tei' | 'obsidian' | 'hypothesis' | 'docx' | 'epub' | 'sqlite' | 'duckdb'
  | 'markdown-blockquote' | 'markdown-callout'

export interface ExportFormatDefinition {
  id: ExchangeFormat
  label: string
  extension: string
  mime: string
  serialize(document: AnnotatedDocument): string | Uint8Array | Promise<string | Uint8Array>
}

function annotations(document: AnnotatedDocument): StoredAnnotation[] {
  return [...document.annotations].sort((left, right) => {
    if (!left.range) return right.range ? 1 : left.id.localeCompare(right.id)
    if (!right.range) return -1
    return left.range.start - right.range.start || right.range.end - left.range.end || left.id.localeCompare(right.id)
  })
}

function lineAt(text: string, offset: number): number {
  let line = 1
  for (let index = 0; index < Math.min(offset, text.length); index += 1) if (text[index] === '\n') line += 1
  return line
}

function escapeHtml(text: string): string {
  return text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;')
}

function escapeXml(text: string): string {
  return escapeHtml(text)
}

function quoteMarkdown(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('[', '\\[').replaceAll(']', '\\]').replaceAll('`', '\\`')
}

function csvCell(value: string): string {
  return `"${value.replaceAll('"', '""')}"`
}

function textProjection(document: AnnotatedDocument, style: 'footnote' | 'blockquote' | 'callout'): string {
  const items = annotations(document).filter((item) => item.range)
  const starts = new Map<number, Array<{ item: StoredAnnotation; index: number }>>()
  for (const [index, item] of items.entries()) {
    const list = starts.get(item.range!.end) ?? []
    list.push({ item, index: index + 1 })
    starts.set(item.range!.end, list)
  }
  let output = ''
  for (let position = 0; position <= document.text.length; position += 1) {
    output += (starts.get(position) ?? []).map(({ index }) => `[^${index}]`).join('')
    if (position < document.text.length) output += document.text[position]
  }
  if (!items.length) return output
  const heading = style === 'callout' ? '### Аннотации' : '### Аннотации'
  const bodies = items.map((item, index) => {
    const number = index + 1
    const exact = quoteMarkdown(item.quote.exact)
    const body = item.body.trim() || 'Без заметки'
    const label = `${item.type} · ${item.status ?? (item.resolved ? 'resolved' : 'open')} · строка ${item.range ? lineAt(document.text, item.range.start) : '—'}`
    if (style === 'blockquote') return `> **${number}. ${label}**\n>\n> ${exact}\n>\n> ${body}`
    if (style === 'callout') return `> [!${item.type === 'question' ? 'question' : item.type === 'todo' ? 'todo' : 'note'}] ${number}. ${label}\n> ${exact}\n>\n> ${body}`
    return `[^${number}]: **${label}**\n    > ${exact}\n\n    ${body}`
  })
  return `${output}\n\n---\n\n${heading}\n\n${bodies.join('\n\n')}`
}

function htmlExport(document: AnnotatedDocument): string {
  const items = annotations(document)
  let body = ''
  const boundaries = [...new Set([0, document.text.length, ...items.flatMap((item) => item.range ? [item.range.start, item.range.end] : [])])].sort((a, b) => a - b)
  for (let segment = 0; segment < boundaries.length - 1; segment += 1) {
    const start = boundaries[segment]!
    const end = boundaries[segment + 1]!
    const active = items.filter((item) => item.range && item.range.start <= start && item.range.end >= end)
    const text = escapeHtml(document.text.slice(start, end))
    body += active.reduceRight((content, item) => `<mark data-annotation-id="${escapeHtml(item.id)}" data-type="${escapeHtml(item.type)}">${content}</mark>`, text)
  }
  const paragraphs = body.split(/\n\n+/).map((paragraph) => `<p>${paragraph.replaceAll('\n', '<br>')}</p>`).join('\n')
  const notes = annotations(document).map((item, index) => `<aside id="note-${escapeHtml(item.id)}" data-for="${escapeHtml(item.id)}"><h2>${index + 1}. ${escapeHtml(item.type)} · ${escapeHtml(item.status ?? (item.resolved ? 'resolved' : 'open'))}</h2><blockquote>${escapeHtml(item.quote.exact)}</blockquote><p>${escapeHtml(item.body)}</p></aside>`).join('\n')
  const payload = JSON.stringify(document).replaceAll('<', '\\u003c').replaceAll('>', '\\u003e').replaceAll('&', '\\u0026')
  return `<!doctype html>\n<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.document.title)}</title><style>:root{color-scheme:light dark}body{max-width:850px;margin:2rem auto;padding:0 1.5rem;font:16px/1.7 system-ui,sans-serif}article{white-space:normal}mark{background:#fde68a;border-bottom:2px solid #facc15}aside{margin:1rem 0;padding:1rem;border-left:3px solid #facc15;background:color-mix(in srgb,#facc15 12%,Canvas)}@media print{body{max-width:none}aside{break-inside:avoid}}</style></head><body><article>${paragraphs}</article><section aria-label="Аннотации">${notes}</section><script type="application/json" id="annotator-document">${payload}</script></body></html>`
}

function combinedText(document: AnnotatedDocument): string {
  const items = annotations(document)
  const rows = items.map((item, index) => {
    const start = item.range?.start ?? null
    const end = item.range?.end ?? null
    return `[${index + 1}] TYPE=${item.type} STATUS=${item.status ?? (item.resolved ? 'resolved' : 'open')} LINE=${start === null ? '-' : lineAt(document.text, start)} POS=${start ?? '-'}-${end ?? '-'}\nQUOTE: ${JSON.stringify(item.quote.exact)}\nNOTE: ${JSON.stringify(item.body)}\nTAGS: ${item.tags.map((tag) => `#${tag}`).join(' ')}`
  })
  return `--- META ---\nhash: sha256:${document.document.textSha256}\ncount: ${items.length}\nexported: ${new Date().toISOString()}\n\n--- ORIGINAL ---\n${document.text}\n\n--- ANNOTATIONS ---\n${rows.join('\n\n')}\n`
}

function criticMarkup(document: AnnotatedDocument): string {
  const items = annotations(document).filter((item) => item.range)
  const edits = [...items].sort((a, b) => a.range!.start - b.range!.start || a.range!.end - b.range!.end)
  let cursor = 0
  let output = ''
  for (const item of edits) {
    if (item.range!.start < cursor) continue
    output += document.text.slice(cursor, item.range!.start)
    const quote = document.text.slice(item.range!.start, item.range!.end)
    if (item.type === 'critic_add') output += `{++${quote}${item.body ? ` ${item.body}` : ''}++}`
    else if (item.type === 'critic_del') output += `{--${quote}--}`
    else if (item.type === 'critic_sub') output += `{~~${quote}~>${item.body}~~}`
    else if (item.type === 'critic_comment') output += `{==${quote}==}{>>${item.body}<<}`
    else if (item.type === 'critic_highlight' || item.type === 'highlight') output += `{==${quote}==}`
    else output += `{==${quote}==}{>>${item.body}<<}`
    cursor = item.range!.end
  }
  output += document.text.slice(cursor)
  return `${output}\n\n<!-- annotator:document ${BufferlessBase64(JSON.stringify(document))} -->\n`
}

function BufferlessBase64(value: string): string {
  const bytes = new TextEncoder().encode(value)
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

function csvExport(document: AnnotatedDocument, delimiter: ',' | '\t'): string {
  const headers = ['id', 'start', 'end', 'start_utf8', 'end_utf8', 'start_grapheme', 'end_grapheme', 'quote', 'note', 'type', 'tags', 'line', 'status', 'color', 'author']
  const rows = annotations(document).map((item) => {
    const start = item.range?.start ?? null
    const end = item.range?.end ?? null
    const startOffsets = start === null ? null : textOffsetsAt(document.text, start)
    const endOffsets = end === null ? null : textOffsetsAt(document.text, end)
    return [item.id, start, end, startOffsets?.utf8, endOffsets?.utf8, startOffsets?.grapheme, endOffsets?.grapheme,
      item.quote.exact, item.body, item.type, item.tags.join('|'), start === null ? '' : lineAt(document.text, start),
      item.status ?? (item.resolved ? 'resolved' : 'open'), item.color ?? '', item.author ?? '']
      .map((value) => csvCell(value === null || value === undefined ? '' : String(value))).join(delimiter)
  })
  return `\uFEFF${headers.map(csvCell).join(delimiter)}\r\n${rows.join('\r\n')}\r\n`
}

function w3cExport(document: AnnotatedDocument): string {
  const items = annotations(document).map((item) => ({
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: `urn:uuid:${item.id}`,
    type: 'Annotation',
    body: [{ type: 'TextualBody', value: item.body, purpose: item.type === 'highlight' ? 'highlighting' : 'commenting', format: 'text/markdown' }],
    target: {
      source: document.document.source ?? document.document.title,
      selector: item.range ? [
        { type: 'TextQuoteSelector', exact: item.quote.exact, prefix: item.quote.prefix, suffix: item.quote.suffix },
        { type: 'TextPositionSelector', start: item.range.start, end: item.range.end },
      ] : { type: 'TextQuoteSelector', exact: item.quote.exact, prefix: item.quote.prefix, suffix: item.quote.suffix },
    },
    created: item.created,
    modified: item.modified,
    creator: item.author ? { type: 'Person', name: item.author } : undefined,
    tags: item.tags,
    status: item.status ?? (item.resolved ? 'resolved' : 'open'),
  }))
  return JSON.stringify({
    '@context': 'http://www.w3.org/ns/anno.jsonld',
    id: `urn:uuid:annotator-${document.document.textSha256}`,
    type: 'AnnotationCollection',
    total: items.length,
    annotatorDocument: document,
    items,
  }, null, 2)
}

function pandocExport(document: AnnotatedDocument): string {
  const blocks = document.text.split(/\n\n+/).map((paragraph) => {
    const start = document.text.indexOf(paragraph)
    const end = start + paragraph.length
    const items = annotations(document).filter((item) => item.range && item.range.start >= start && item.range.end <= end)
    const inline: unknown[] = []
    let cursor = start
    for (const item of items) {
      if (item.range!.start < cursor) continue
      if (item.range!.start > cursor) inline.push({ t: 'Str', c: document.text.slice(cursor, item.range!.start) })
      inline.push({ t: 'Span', c: [['', ['annotation', item.type], [['data-id', item.id], ['data-note', item.body], ['data-status', item.status ?? (item.resolved ? 'resolved' : 'open')]]], [{ t: 'Str', c: item.quote.exact }]] })
      cursor = item.range!.end
    }
    if (cursor < end) inline.push({ t: 'Str', c: document.text.slice(cursor, end) })
    return { t: 'Para', c: inline.length ? inline : [{ t: 'Str', c: paragraph }] }
  })
  return JSON.stringify({ 'pandoc-api-version': [1, 23], meta: {}, blocks }, null, 2)
}

function teiExport(document: AnnotatedDocument): string {
  const body = document.text.split(/\n\n+/).map((paragraph) => `<p>${escapeXml(paragraph)}</p>`).join('\n')
  const annotationsXml = annotations(document).map((item) => `<annotation xml:id="${escapeXml(item.id)}" type="${escapeXml(item.type)}" status="${escapeXml(item.status ?? (item.resolved ? 'resolved' : 'open'))}"><note>${escapeXml(item.body)}</note><quote>${escapeXml(item.quote.exact)}</quote></annotation>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>\n<TEI xmlns="http://www.tei-c.org/ns/1.0"><teiHeader><fileDesc><titleStmt><title>${escapeXml(document.document.title)}</title></titleStmt><publicationStmt><p>Exported by Annotator</p></publicationStmt><sourceDesc><p>${escapeXml(document.document.source ?? '')}</p></sourceDesc></fileDesc></teiHeader><text><body>${body}</body></text><standOff>${annotationsXml}</standOff></TEI>`
}

function obsidianExport(document: AnnotatedDocument): string {
  const payload = JSON.stringify(document, null, 2).replaceAll('-->', '--\\u003e')
  return `${document.text}\n\n%% annotator:start %%\n${payload}\n%% annotator:end %%\n`
}

function hypothesisExport(document: AnnotatedDocument): string {
  return JSON.stringify({ rows: annotations(document).map((item) => ({
    id: item.id,
    text: item.body,
    tags: item.tags,
    created: item.created,
    updated: item.modified,
    user: item.author ?? 'acct:annotator@localhost',
    uri: document.document.source ?? document.document.title,
    target: [{ source: document.document.source ?? document.document.title, selector: [
      { type: 'TextQuoteSelector', exact: item.quote.exact, prefix: item.quote.prefix, suffix: item.quote.suffix },
      ...(item.range ? [{ type: 'TextPositionSelector', start: item.range.start, end: item.range.end }] : []),
    ] }],
    permissions: { read: [], update: [], delete: [], admin: [] },
  })), annotatorDocument: document }, null, 2)
}

export const exportFormats: ExportFormatDefinition[] = [
  { id: 'markdown', label: 'Markdown (сноски)', extension: 'md', mime: 'text/markdown;charset=utf-8', serialize: (doc) => textProjection(doc, 'footnote') },
  { id: 'markdown-blockquote', label: 'Markdown (blockquote)', extension: 'md', mime: 'text/markdown;charset=utf-8', serialize: (doc) => textProjection(doc, 'blockquote') },
  { id: 'markdown-callout', label: 'Markdown (Obsidian Callouts)', extension: 'md', mime: 'text/markdown;charset=utf-8', serialize: (doc) => textProjection(doc, 'callout') },
  { id: 'html', label: 'HTML (самостоятельный)', extension: 'html', mime: 'text/html;charset=utf-8', serialize: htmlExport },
  { id: 'combined-txt', label: 'TXT (оригинал + аннотации)', extension: 'txt', mime: 'text/plain;charset=utf-8', serialize: combinedText },
  { id: 'json', label: 'JSON (полный документ)', extension: 'json', mime: 'application/json;charset=utf-8', serialize: (doc) => JSON.stringify(doc, null, 2) },
  { id: 'critic-markup', label: 'CriticMarkup', extension: 'critic.md', mime: 'text/markdown;charset=utf-8', serialize: criticMarkup },
  { id: 'csv', label: 'CSV', extension: 'csv', mime: 'text/csv;charset=utf-8', serialize: (doc) => csvExport(doc, ',') },
  { id: 'tsv', label: 'TSV', extension: 'tsv', mime: 'text/tab-separated-values;charset=utf-8', serialize: (doc) => csvExport(doc, '\t') },
  { id: 'w3c', label: 'W3C Web Annotation', extension: 'web-annotation.json', mime: 'application/ld+json;charset=utf-8', serialize: w3cExport },
  { id: 'pandoc', label: 'Pandoc AST JSON', extension: 'pandoc.json', mime: 'application/json;charset=utf-8', serialize: pandocExport },
  { id: 'tei', label: 'TEI XML', extension: 'tei.xml', mime: 'application/xml;charset=utf-8', serialize: teiExport },
  { id: 'obsidian', label: 'Obsidian / Logseq', extension: 'md', mime: 'text/markdown;charset=utf-8', serialize: obsidianExport },
  { id: 'hypothesis', label: 'Hypothesis JSON', extension: 'hypothesis.json', mime: 'application/json;charset=utf-8', serialize: hypothesisExport },
  { id: 'docx', label: 'DOCX с комментариями', extension: 'docx', mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', serialize: exportDocx },
  { id: 'epub', label: 'EPUB', extension: 'epub', mime: 'application/epub+zip', serialize: exportEpub },
  { id: 'sqlite', label: 'SQLite', extension: 'sqlite', mime: 'application/vnd.sqlite3', serialize: exportSqlite },
  { id: 'duckdb', label: 'DuckDB', extension: 'duckdb', mime: 'application/vnd.duckdb', serialize: exportDuckDb },
]

export async function serializeExchange(document: AnnotatedDocument, format: ExchangeFormat): Promise<string | Uint8Array> {
  const definition = exportFormats.find((item) => item.id === format)
  if (!definition) throw new Error(`Формат экспорта «${format}» не поддерживается.`)
  return await definition.serialize(document)
}
