import type { Annotation, AnnotatedDocument, StoredAnnotation } from '../../shared/model'
import { restoreQuoteAnchor } from '../../shared/text-offsets'
import { parseAnnotatedDocument, createAnnotatedDocument } from './json-format'
import { extractDocxText, extractEpub } from '../../shared/binary-formats'

interface ImportedAnnotation {
  id: string
  type: string
  quote: string
  note: string
  start?: number
  end?: number
  prefix?: string
  suffix?: string
  tags?: string[]
  status?: 'open' | 'resolved' | 'archived'
  author?: string
}

function id(): string { return `import-${crypto.randomUUID()}` }

function decodeHtml(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, name: string) => {
    if (name[0] === '#') {
      const point = name[1]?.toLowerCase() === 'x' ? Number.parseInt(name.slice(2), 16) : Number.parseInt(name.slice(1), 10)
      return Number.isFinite(point) ? String.fromCodePoint(point) : entity
    }
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' } as Record<string, string>)[name.toLowerCase()] ?? entity
  })
}

function plainHtml(source: string): string {
  return decodeHtml(source.replace(/<br\s*\/?\s*>/gi, '\n').replace(/<\/(?:p|div|article|section|li|h[1-6])\s*>/gi, '\n\n').replace(/<[^>]*>/g, '')).replace(/\n{3,}/g, '\n\n').trim()
}

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function quoteFromSelector(value: unknown): { exact: string; prefix: string; suffix: string; start?: number; end?: number } | null {
  const items = Array.isArray(value) ? value : [value]
  let exact = ''
  let prefix = ''
  let suffix = ''
  let start: number | undefined
  let end: number | undefined
  for (const item of items) {
    const record = asObject(item)
    if (record?.type === 'TextQuoteSelector') {
      if (typeof record.exact === 'string') exact = record.exact
      if (typeof record.prefix === 'string') prefix = record.prefix
      if (typeof record.suffix === 'string') suffix = record.suffix
    } else if (record?.type === 'TextPositionSelector') {
      if (typeof record.start === 'number') start = record.start
      if (typeof record.end === 'number') end = record.end
    }
  }
  return exact ? { exact, prefix, suffix, start, end } : null
}

function importW3c(input: Record<string, unknown>): { text: string; annotations: ImportedAnnotation[]; title: string } {
  const embedded = asObject(input.annotatorDocument)
  if (embedded) return { text: '', annotations: [], title: '' }
  const items = Array.isArray(input.items) ? input.items : Array.isArray(input) ? input : []
  const annotations: ImportedAnnotation[] = []
  for (const [index, raw] of items.entries()) {
    const item = asObject(raw)
    const target = asObject(item?.target)
    const selector = target?.selector
    const quote = quoteFromSelector(selector)
    if (!item || !quote) continue
    const bodies = Array.isArray(item.body) ? item.body : [item.body]
    const body = asObject(bodies[0])
    const creator = asObject(item.creator)
    annotations.push({
      id: typeof item.id === 'string' ? item.id.split(':').at(-1) ?? id() : `w3c-${index + 1}`,
      type: body?.purpose === 'highlighting' ? 'highlight' : 'comment',
      quote: quote.exact,
      note: typeof body?.value === 'string' ? body.value : '',
      ...(quote.start !== undefined ? { start: quote.start } : {}),
      ...(quote.end !== undefined ? { end: quote.end } : {}),
      prefix: quote.prefix,
      suffix: quote.suffix,
      tags: Array.isArray(item.tags) ? item.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      status: item.status === 'resolved' || item.status === 'archived' ? item.status : 'open',
      ...(typeof creator?.name === 'string' ? { author: creator.name } : {}),
    })
  }
  return { text: '', annotations, title: 'Импорт W3C' }
}

function importMarkdown(source: string): { text: string; annotations: ImportedAnnotation[] } {
  const separator = source.lastIndexOf('\n\n### Аннотации')
  const definitionsStart = source.search(/^\[\^[^\]]+\]:/m)
  const endOfOriginal = separator >= 0 ? separator : definitionsStart >= 0 ? definitionsStart : source.length
  const original = source.slice(0, endOfOriginal).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '').trimEnd()
  const definitions = new Map<string, string>()
  const lines = source.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const match = lines[index]!.match(/^\[\^([^\]]+)\]:[ \t]*(.*)$/)
    if (!match) continue
    const body = [match[2]!]
    while (index + 1 < lines.length && (/^ {4}/.test(lines[index + 1]!) || lines[index + 1] === '')) {
      index += 1
      body.push(lines[index]!.replace(/^ {4}/, ''))
    }
    definitions.set(match[1]!, body.join('\n').trim())
  }
  const annotations: ImportedAnnotation[] = []
  const exactText = original.replace(/\[\^([^\]]+)\]/g, (_match, ref: string) => {
    const definition = definitions.get(ref) ?? ''
    const quote = definition.match(/^>\s*(.+)$/m)?.[1]?.replace(/^"|"$/g, '') ?? ''
    const note = definition.split(/\r?\n/).filter((line) => !/^>\s*/.test(line) && line.trim()).join('\n').trim()
    if (quote) annotations.push({ id: `md-${ref}`, type: 'comment', quote, note, start: original.indexOf(quote), end: original.indexOf(quote) + quote.length })
    return ''
  })
  return { text: exactText, annotations }
}

function importCritic(source: string): { text: string; annotations: ImportedAnnotation[] } {
  const embedded = source.match(/<!--\s*annotator:document\s+([A-Za-z0-9+/=]+)\s*-->/)
  if (embedded) {
    const binary = atob(embedded[1]!)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    const doc = parseAnnotatedDocument(new TextDecoder().decode(bytes))
    return { text: doc.text, annotations: [] }
  }
  let text = ''
  const annotations: ImportedAnnotation[] = []
  const pattern = /\{\+\+([\s\S]*?)\+\+\}|\{--([\s\S]*?)--\}|\{~~([\s\S]*?)~>([\s\S]*?)~~\}|\{==([\s\S]*?)==\}(?:\{>>([\s\S]*?)<<\})?/g
  let cursor = 0
  for (const match of source.matchAll(pattern)) {
    const index = match.index ?? 0
    text += source.slice(cursor, index)
    const token = match[0]
    const start = text.length
    let type = 'critic_comment'
    let quote = ''
    let note = ''
    if (token.startsWith('{++')) { type = 'critic_add'; quote = match[1] ?? ''; note = quote; }
    else if (token.startsWith('{--')) { type = 'critic_del'; quote = match[2] ?? ''; }
    else if (token.startsWith('{~~')) { type = 'critic_sub'; quote = match[3] ?? ''; note = match[4] ?? ''; }
    else { quote = match[5] ?? ''; note = match[6] ?? ''; type = note ? 'critic_comment' : 'critic_highlight'; }
    text += quote
    annotations.push({ id: id(), type, quote, note, start, end: text.length })
    cursor = index + token.length
  }
  text += source.slice(cursor)
  return { text, annotations }
}

function importHypothesis(input: Record<string, unknown>): { text: string; annotations: ImportedAnnotation[] } {
  const rows = Array.isArray(input.rows) ? input.rows : Array.isArray(input) ? input : []
  const annotations: ImportedAnnotation[] = []
  for (const [index, raw] of rows.entries()) {
    const row = asObject(raw)
    const target = Array.isArray(row?.target) ? asObject(row.target[0]) : null
    const selector = Array.isArray(target?.selector) ? target.selector : []
    const quote = quoteFromSelector(selector)
    if (!row || !quote) continue
    annotations.push({
      id: typeof row.id === 'string' ? row.id : `hypothesis-${index + 1}`,
      type: 'comment', quote: quote.exact, note: typeof row.text === 'string' ? row.text : '',
      ...(quote.start !== undefined ? { start: quote.start } : {}), ...(quote.end !== undefined ? { end: quote.end } : {}),
      prefix: quote.prefix, suffix: quote.suffix,
      tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === 'string') : [],
      status: 'open',
    })
  }
  return { text: '', annotations }
}

function importW3cEmbedded(source: string): AnnotatedDocument | null {
  try {
    const parsed = JSON.parse(source) as unknown
    const value = asObject(parsed)
    const document = asObject(value?.annotatorDocument)
    return document ? parseAnnotatedDocument(JSON.stringify(document)) : null
  } catch { return null }
}

function importObsidian(source: string): AnnotatedDocument | null {
  const match = source.match(/%%\s*annotator:start\s*%%\s*([\s\S]*?)\s*%%\s*annotator:end\s*%%/)
  if (!match) return null
  try { return parseAnnotatedDocument(match[1]!) } catch { return null }
}

function importCriticEmbedded(source: string): AnnotatedDocument | null {
  const embedded = source.match(/<!--\s*annotator:document\s+([A-Za-z0-9+/=]+)\s*-->/)
  if (!embedded) return null
  try {
    const binary = atob(embedded[1]!)
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
    return parseAnnotatedDocument(new TextDecoder().decode(bytes))
  } catch { return null }
}

export async function parseExternalDocument(name: string, source: string, binary?: Uint8Array): Promise<AnnotatedDocument> {
  const extension = name.toLowerCase()
  if (extension.endsWith('.epub') && binary) {
    const extracted = extractEpub(binary)
    if (extracted.document) return extracted.document
    return buildImportedDocument(extracted.text, extracted.annotations.map((item) => ({ ...item, type: 'comment', note: item.note })), name)
  }
  if (extension.endsWith('.docx') && binary) {
    const extracted = extractDocxText(binary)
    const embedded = extracted.comments.get('__annotator_document__')
    if (embedded) return parseAnnotatedDocument(embedded.text)
    const records: ImportedAnnotation[] = []
    for (const [commentId, comment] of extracted.comments) {
      const match = comment.text.match(/^(\d+):(\d+)\n([\s\S]*)$/)
      records.push({ id: `docx-${commentId}`, type: 'comment', quote: match ? extracted.text.slice(Number(match[1]), Number(match[2])) : '', note: match ? match[3]! : comment.text,
        ...(match ? { start: Number(match[1]), end: Number(match[2]) } : {}), author: comment.author })
    }
    return buildImportedDocument(extracted.text, records, name)
  }
  if (extension.endsWith('.json') || extension.endsWith('.jsonld')) {
    const parsed = JSON.parse(source) as unknown
    const object = asObject(parsed)
    if (!object && !Array.isArray(parsed)) throw new Error('JSON должен содержать объект документа или список аннотаций.')
    if (Array.isArray(parsed)) {
      const imported = importW3c({ items: parsed })
      return buildImportedDocument(imported.text, imported.annotations, name)
    }
    if (!object) throw new Error('JSON должен содержать объект документа.')
    if (object.format === 'annotator-document') return parseAnnotatedDocument(source)
    if (object.type === 'AnnotationCollection' && object.annotatorDocument) return parseAnnotatedDocument(JSON.stringify(object.annotatorDocument))
    if (object.rows) {
      if (object.annotatorDocument) return parseAnnotatedDocument(JSON.stringify(object.annotatorDocument))
      const imported = importHypothesis(object)
      return buildImportedDocument(imported.text, imported.annotations, name)
    }
    const imported = importW3c(object)
    return buildImportedDocument(imported.text, imported.annotations, name)
  }
  if (extension.endsWith('.critic.md')) {
    const document = importCriticEmbedded(source)
    if (document) return document
  }
  const embedded = importW3cEmbedded(source) ?? importObsidian(source)
  if (embedded) return embedded
  let imported: { text: string; annotations: ImportedAnnotation[] }
  if (extension.endsWith('.html') || extension.endsWith('.htm')) {
    const payload = source.match(/<script[^>]+id=["']annotator-document["'][^>]*>([\s\S]*?)<\/script>/i)?.[1]
    if (payload) return parseAnnotatedDocument(payload)
    imported = { text: plainHtml(source), annotations: [] }
  } else if (extension.endsWith('.critic.md') || /\{(?:\+\+|--|~~|==)/.test(source)) imported = importCritic(source)
  else if (extension.endsWith('.md')) imported = importMarkdown(source)
  else throw new Error(`Формат файла «${name}» не поддерживается.`)
  return buildImportedDocument(imported.text, imported.annotations, name)
}

async function buildImportedDocument(text: string, records: ImportedAnnotation[], sourceName: string): Promise<AnnotatedDocument> {
  const annotations: Annotation[] = records.map((record) => {
    const quote = { exact: record.quote, prefix: record.prefix, suffix: record.suffix }
    const candidate = record.start !== undefined && record.end !== undefined && text.slice(record.start, record.end) === record.quote
      ? { start: record.start, end: record.end, ambiguous: false }
      : restoreQuoteAnchor(text, quote, record.start ?? 0)
    const linked = candidate && !candidate.ambiguous
    const now = new Date().toISOString()
    return {
      id: record.id || id(), type: record.type, text: record.note,
      start: linked ? candidate.start : 0, end: linked ? candidate.end : 0, quote: record.quote,
      quotePrefix: record.prefix,
      quoteSuffix: record.suffix,
      tags: record.tags ?? [], resolved: record.status === 'resolved', status: record.status ?? 'open', color: null,
      created: now, modified: now, ...(record.author ? { author: record.author } : {}), orphan: !linked,
    }
  })
  return createAnnotatedDocument(text, annotations, sourceName)
}
