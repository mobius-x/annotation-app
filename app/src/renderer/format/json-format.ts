import { z } from 'zod'
import type { Annotation, AnnotatedDocument } from '../../shared/model'
import { quoteContext, restoreQuoteAnchor, textOffsetsAt } from '../../shared/text-offsets'

const rangeSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().positive(),
}).passthrough()

const annotationSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  range: rangeSchema.nullable(),
  quote: z.object({
    exact: z.string(),
    prefix: z.string(),
    suffix: z.string(),
  }).passthrough(),
  body: z.string(),
  tags: z.array(z.string()),
  color: z.string().nullable(),
  resolved: z.boolean(),
  status: z.enum(['open', 'resolved', 'archived']).optional(),
  created: z.string(),
  modified: z.string(),
  author: z.string().optional(),
  parentId: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
}).passthrough()

export const annotatedDocumentSchema = z.object({
  format: z.literal('annotator-document'),
  version: z.number().int().positive(),
  document: z.object({
    title: z.string(),
    source: z.string().nullable(),
    eol: z.enum(['lf', 'crlf', 'cr']),
    language: z.enum(['plain', 'markdown']),
    textSha256: z.string(),
    created: z.string(),
    modified: z.string(),
  }).passthrough(),
  text: z.string(),
  annotations: z.array(annotationSchema),
  extra: z.record(z.string(), z.unknown()).default({}),
}).passthrough()

export function parseAnnotatedDocument(source: string): AnnotatedDocument {
  let input: unknown
  try {
    input = JSON.parse(source)
  } catch (error) {
    throw new Error(`Некорректный JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = annotatedDocumentSchema.safeParse(input)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(`Некорректный файл аннотаций (${issue.path.join('.') || 'корень'}): ${issue.message}`)
  }
  if (result.data.version > 1) throw new Error(`Версия формата ${result.data.version} новее поддерживаемой.`)
  for (const [index, annotation] of result.data.annotations.entries()) {
    if (annotation.range && (annotation.range.end <= annotation.range.start || annotation.range.end > result.data.text.length)) {
      throw new Error(`Некорректный файл аннотаций (annotations.${index}.range): диапазон выходит за границы текста.`)
    }
  }
  return result.data as unknown as AnnotatedDocument
}

export async function createAnnotatedDocument(
  text: string,
  annotations: Annotation[],
  source: string | null,
  previous?: AnnotatedDocument,
  sourceEol: 'lf' | 'crlf' | 'cr' = 'lf',
): Promise<AnnotatedDocument> {
  const now = new Date().toISOString()
  const sorted = [...annotations].sort((left, right) => left.start - right.start || right.end - left.end || left.id.localeCompare(right.id))
  const digest = await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  const textSha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
  const records = sorted.map((annotation) => {
    const start = Math.max(0, Math.min(text.length, annotation.start))
    const end = Math.min(text.length, Math.max(start + 1, annotation.end))
    const exact = annotation.orphan ? annotation.quote : text.slice(start, end)
    const context = annotation.orphan
      ? { exact, prefix: annotation.quotePrefix ?? '', suffix: annotation.quoteSuffix ?? '' }
      : quoteContext(text, start, end)
    const { text: body, start: _start, end: _end, quote: _quote, quotePrefix: _quotePrefix, quoteSuffix: _quoteSuffix, orphan: _orphan, startUtf8: _startUtf8, endUtf8: _endUtf8, startGrapheme: _startGrapheme, endGrapheme: _endGrapheme, ...extra } = annotation
    return {
      ...extra,
      range: annotation.orphan || !exact ? null : { start, end },
      quote: context,
      body,
    }
  }).filter((annotation) => annotation.range !== null || annotation.quote.exact)
  return {
    ...(previous ?? {}),
    format: 'annotator-document',
    version: 1,
    document: {
      ...(previous?.document ?? {}),
      title: previous?.document.title ?? source?.replace(/\.[^.]+$/, '') ?? 'Новый документ',
      source,
      eol: previous?.document.eol ?? sourceEol,
      language: source?.toLowerCase().endsWith('.md') ? 'markdown' : 'plain',
      textSha256,
      created: previous?.document.created ?? now,
      modified: now,
    },
    text,
    annotations: records,
    extra: previous?.extra ?? {},
  }
}

export function toPlainAnnotatedDocument(document: AnnotatedDocument): AnnotatedDocument {
  return JSON.parse(JSON.stringify(document)) as AnnotatedDocument
}

export function restoreAnnotations(document: AnnotatedDocument): { annotations: Annotation[]; shifted: number; orphaned: number } {
  let shifted = 0
  let orphaned = 0
  const annotations = document.annotations.map((record) => {
    let range = record.range
    if (!range || document.text.slice(range.start, range.end) !== record.quote.exact) {
      const restored = restoreQuoteAnchor(document.text, record.quote, range?.start ?? 0)
      if (restored && !restored.ambiguous) {
        range = { start: restored.start, end: restored.end }
        shifted += 1
      } else {
        range = null
        orphaned += 1
      }
    }
    const status = record.status ?? (record.resolved ? 'resolved' : 'open')
    const offsets = range ? { start: textOffsetsAt(document.text, range.start), end: textOffsetsAt(document.text, range.end) } : null
    return {
      id: record.id,
      type: record.type,
      text: record.body,
      start: range?.start ?? 0,
      end: range?.end ?? 0,
      quote: record.quote.exact,
      quotePrefix: record.quote.prefix,
      quoteSuffix: record.quote.suffix,
      tags: record.tags,
      resolved: record.resolved,
      status,
      color: record.color,
      created: record.created,
      modified: record.modified,
      ...(record.author ? { author: record.author } : {}),
      ...(record.parentId ? { parentId: record.parentId } : {}),
      ...(record.metadata ? { metadata: record.metadata } : {}),
      ...(offsets ? {
        startUtf8: offsets.start.utf8,
        endUtf8: offsets.end.utf8,
        startGrapheme: offsets.start.grapheme,
        endGrapheme: offsets.end.grapheme,
      } : {}),
      orphan: range === null,
    }
  })
  return { annotations, shifted, orphaned }
}
