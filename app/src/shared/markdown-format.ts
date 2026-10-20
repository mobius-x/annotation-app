import { parse as parseYaml, stringify as stringifyYaml } from 'yaml'
import type { AnnotatedDocument, StoredAnnotation } from './model'

interface MarkdownFrontMatter {
  annotator: number
  title: string
  source: string | null
  eol: 'lf' | 'crlf' | 'cr'
  language: 'plain' | 'markdown'
  text_sha256: string
  created: string
  modified: string
  extra?: Record<string, unknown>
  [key: string]: unknown
}

const separator = '<!-- annotator:notes -->'
const closingMarker = /^==\[\^([A-Za-z0-9_~-]+)\]/

function fail(message: string): never {
  throw new Error(`Некорректный Markdown-файл аннотаций: ${message}`)
}

function escapeCharacter(text: string, index: number, markerPositions: Set<number>): string {
  const char = text[index]!
  const previous = text[index - 1]
  const next = text[index + 1]
  const markerAdjacent = markerPositions.has(index) || markerPositions.has(index + 1)
  if (char === '=' && (previous === '=' || next === '=' || markerAdjacent)) return '\\='
  if (char === '[' && next === '^') return '\\['
  if (char === '<' && text.slice(index + 1, index + 4) === '!--') return '\\<'
  if (char === '\\' && (['\\', '=', '[', '<'].includes(next ?? '') || markerPositions.has(index + 1))) return '\\\\'
  return char
}

function readAnnotatedText(source: string): { text: string; ranges: Map<string, { start: number; end: number }> } {
  const stack: Array<{ id?: string; start: number }> = []
  const ranges = new Map<string, { start: number; end: number }>()
  let text = ''
  for (let index = 0; index < source.length;) {
    const char = source[index]!
    if (char === '\\' && ['\\', '=', '[', '<'].includes(source[index + 1] ?? '')) {
      text += source[index + 1]!
      index += 2
      continue
    }
    if (source.startsWith('==', index)) {
      const close = source.slice(index).match(closingMarker)
      if (close) {
        const opening = stack.pop()
        if (!opening) {
          ranges.set(close[1]!, { start: text.length, end: text.length })
        } else {
          ranges.set(close[1]!, { start: opening.start, end: text.length })
        }
        index += close[0].length
      } else {
        stack.push({ start: text.length })
        index += 2
      }
      continue
    }
    text += char
    index += 1
  }
  for (const opening of stack) {
    if (opening.id) ranges.set(opening.id, { start: opening.start, end: text.length })
  }
  return { text, ranges }
}

function annotationRecord(
  id: string,
  metadata: Record<string, unknown>,
  body: string,
  range: { start: number; end: number } | null,
  text: string,
): StoredAnnotation {
  const orphan = range === null || metadata.orphan === true || range.start >= range.end || range.end > text.length
  const start = orphan ? 0 : range.start
  const end = orphan ? 0 : range.end
  const storedQuote = metadata.quote && typeof metadata.quote === 'object' && !Array.isArray(metadata.quote)
    ? metadata.quote as { exact?: unknown; prefix?: unknown; suffix?: unknown }
    : undefined
  const exact = typeof storedQuote?.exact === 'string'
    ? storedQuote.exact
    : typeof metadata.quote === 'string'
      ? metadata.quote
    : orphan ? '' : text.slice(start, end)
  return {
    ...metadata,
    id,
    type: typeof metadata.type === 'string' ? metadata.type : 'comment',
    range: orphan ? null : { start, end },
    quote: {
      exact,
      prefix: orphan
        ? typeof storedQuote?.prefix === 'string' ? storedQuote.prefix : ''
        : text.slice(Math.max(0, start - 30), start),
      suffix: orphan
        ? typeof storedQuote?.suffix === 'string' ? storedQuote.suffix : ''
        : text.slice(end, end + 30),
    },
    body,
    tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === 'string') : [],
    color: typeof metadata.color === 'string' ? metadata.color : null,
    resolved: metadata.resolved === true,
    created: typeof metadata.created === 'string' ? metadata.created : new Date(0).toISOString(),
    modified: typeof metadata.modified === 'string' ? metadata.modified : new Date(0).toISOString(),
    ...(orphan ? { orphan: true } : {}),
  }
}

function readNotes(source: string, text: string, ranges: Map<string, { start: number; end: number }>): StoredAnnotation[] {
  const definitions = new Map<string, { metadata: Record<string, unknown>; body: string }>()
  const pattern = /^\[\^([A-Za-z0-9_~-]+)\]:(?: <!--(.*?)-->)?\r?\n?((?:(?: {4}.*| *)\r?\n?)*)/gm
  for (const match of source.matchAll(pattern)) {
    const id = match[1]!
    let metadata: Record<string, unknown> = {}
    if (match[2]) {
      try {
        const parsed: unknown = JSON.parse(match[2].replace(/\\u003e/gi, '>'))
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(`метаданные сноски ${id} должны быть JSON-объектом`)
        metadata = parsed as Record<string, unknown>
      } catch (error) {
        if (error instanceof Error && error.message.startsWith('Некорректный Markdown')) throw error
        fail(`не удалось разобрать метаданные сноски ${id}`)
      }
    }
    const body = match[3]!
      .split(/\r?\n/)
      .map((line) => line.startsWith('    ') ? line.slice(4) : line)
      .join('\n')
      .replace(/\n+$/, '')
    definitions.set(id, { metadata, body })
  }

  const ids = new Set([...definitions.keys(), ...ranges.keys()])
  const records = [...ids].map((id) => {
    const definition = definitions.get(id) ?? { metadata: {}, body: '' }
    const range = ranges.get(id) ?? null
    return annotationRecord(id, definition.metadata, definition.body, range, text)
  })
  const parts = new Map<string, StoredAnnotation[]>()
  for (const record of records) {
    const parent = record.part_of
    if (typeof parent !== 'string') continue
    const group = parts.get(parent) ?? []
    group.push(record)
    parts.set(parent, group)
  }
  const merged = records.filter((record) => typeof record.part_of !== 'string').map((record) => {
    const group = parts.get(record.id)
    if (!group?.length || !record.range) return record
    const rangesToMerge = [record.range, ...group.flatMap((part) => part.range ? [part.range] : [])]
    const start = Math.min(...rangesToMerge.map((range) => range.start))
    const end = Math.max(...rangesToMerge.map((range) => range.end))
    return {
      ...record,
      range: { start, end },
      quote: {
        exact: text.slice(start, end),
        prefix: text.slice(Math.max(0, start - 30), start),
        suffix: text.slice(end, end + 30),
      },
    }
  })
  return merged.sort((left, right) => {
    if (!left.range) return right.range ? 1 : left.id.localeCompare(right.id)
    if (!right.range) return -1
    return left.range.start - right.range.start || right.range.end - left.range.end || left.id.localeCompare(right.id)
  })
}

export function parseMarkdownDocument(source: string): AnnotatedDocument {
  const normalized = source.replace(/\r\n?/g, '\n')
  const front = normalized.match(/^---\n([\s\S]*?)\n---\n/)
  if (!front) fail('не найден YAML front matter')
  let metadata: unknown
  try {
    metadata = parseYaml(front[1]!)
  } catch (error) {
    fail(`ошибка YAML front matter: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) fail('front matter должен быть YAML-объектом')
  const header = metadata as MarkdownFrontMatter
  if (header.annotator !== 1) fail(`версия формата ${String(header.annotator)} не поддерживается`)
  const content = normalized.slice(front[0].length).replace(/^\n/, '')
  const divider = `\n\n${separator}\n`
  const dividerIndex = content.lastIndexOf(divider)
  if (dividerIndex < 0) fail('не найден разделитель заметок')
  const encodedText = content.slice(0, dividerIndex)
  const noteSource = content.slice(dividerIndex + divider.length)
  const parsedText = readAnnotatedText(encodedText)
  const docKnown = new Set(['annotator', 'title', 'source', 'eol', 'language', 'text_sha256', 'created', 'modified', 'extra'])
  const extra = {
    ...(header.extra && typeof header.extra === 'object' && !Array.isArray(header.extra) ? header.extra : {}),
    ...Object.fromEntries(Object.entries(header).filter(([key]) => !docKnown.has(key))),
  }
  return {
    format: 'annotator-document',
    version: 1,
    document: {
      title: typeof header.title === 'string' ? header.title : 'Новый документ',
      source: typeof header.source === 'string' ? header.source : null,
      eol: header.eol === 'crlf' || header.eol === 'cr' ? header.eol : 'lf',
      language: header.language === 'markdown' ? 'markdown' : 'plain',
      textSha256: typeof header.text_sha256 === 'string' ? header.text_sha256 : '',
      created: typeof header.created === 'string' ? header.created : new Date(0).toISOString(),
      modified: typeof header.modified === 'string' ? header.modified : new Date(0).toISOString(),
    },
    text: parsedText.text,
    annotations: readNotes(noteSource, parsedText.text, parsedText.ranges),
    extra,
  }
}

export function serializeMarkdownDocument(document: AnnotatedDocument, fileEol: '\n' | '\r\n' | '\r' = '\n'): string {
  const endpoints = new Set<number>()
  for (const annotation of document.annotations) {
    if (annotation.range) {
      endpoints.add(annotation.range.start)
      endpoints.add(annotation.range.end)
    }
  }
  const boundaries = [...endpoints].sort((left, right) => left - right)
  const segments: Array<{ annotation: StoredAnnotation; start: number; end: number; id: string; part: number }> = []
  for (const annotation of document.annotations) {
    if (!annotation.range) continue
    const cuts = [annotation.range.start, ...boundaries.filter((point) => point > annotation.range!.start && point < annotation.range!.end), annotation.range.end]
    cuts.slice(0, -1).forEach((start, index) => {
      const end = cuts[index + 1]!
      const part = index + 1
      segments.push({
        annotation,
        start,
        end,
        id: part === 1 ? annotation.id : `${annotation.id}~${part}`,
        part,
      })
    })
  }
  const starts = new Map<number, typeof segments>()
  const ends = new Map<number, typeof segments>()
  for (const segment of segments) {
    const atStart = starts.get(segment.start) ?? []
    atStart.push(segment)
    starts.set(segment.start, atStart)
    const atEnd = ends.get(segment.end) ?? []
    atEnd.push(segment)
    ends.set(segment.end, atEnd)
  }
  const markerPositions = new Set<number>([...starts.keys(), ...ends.keys()])
  let encoded = ''
  const writeMarkers = (position: number) => {
    const ending = (ends.get(position) ?? []).sort((left, right) => right.id.localeCompare(left.id))
    for (const segment of ending) encoded += `==[^${segment.id}]`
    const opening = (starts.get(position) ?? []).sort((left, right) => right.end - left.end || left.id.localeCompare(right.id))
    for (const segment of opening) encoded += '=='
  }
  for (let position = 0; position <= document.text.length; position += 1) {
    writeMarkers(position)
    if (position < document.text.length) encoded += escapeCharacter(document.text, position, markerPositions)
  }

  const annotations = [...document.annotations].sort((left, right) => {
    if (!left.range) return right.range ? 1 : left.id.localeCompare(right.id)
    if (!right.range) return -1
    return left.range.start - right.range.start || right.range.end - left.range.end || left.id.localeCompare(right.id)
  })
  const notes = annotations.map((annotation) => {
    const { id, range, quote, body, ...metadata } = annotation
    const annotationSegments = segments.filter((segment) => segment.annotation.id === id)
    const definitions = annotationSegments.length ? annotationSegments : [{ id, part: 1, annotation, start: 0, end: 0 }]
    return definitions.map((segment) => {
      const partMetadata = segment.part === 1
        ? { ...metadata, quote: range ? quote.exact : quote, ...(range ? {} : { orphan: true }) }
        : { type: annotation.type, part_of: id, quote: quote.exact, created: annotation.created, modified: annotation.modified }
      const json = JSON.stringify(partMetadata).replace(/>/g, '\\u003e')
      const lines = segment.part === 1 ? body.replace(/\n+$/, '').split('\n') : ['']
      return `[^${segment.id}]: <!--${json}-->\n${lines.map((line) => `    ${line}`).join('\n')}`
    }).join('\n\n')
  }).join('\n\n')

  const { title, source, eol, language, textSha256, created, modified, ...documentExtra } = document.document
  const frontMatter: MarkdownFrontMatter = {
    annotator: 1,
    title,
    source,
    eol,
    language,
    text_sha256: textSha256,
    created,
    modified,
    extra: { ...document.extra, ...documentExtra },
  }
  const output = `---\n${stringifyYaml(frontMatter).trimEnd()}\n---\n\n${encoded}\n\n${separator}\n${notes}${notes ? '\n' : ''}`
  return fileEol === '\n' ? output : output.replace(/\n/g, fileEol)
}
