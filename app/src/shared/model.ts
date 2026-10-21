export interface Annotation {
  id: string
  type: string
  text: string
  start: number
  end: number
  quote: string
  quotePrefix?: string
  quoteSuffix?: string
  tags: string[]
  resolved: boolean
  status?: 'open' | 'resolved' | 'archived'
  color: string | null
  created: string
  modified: string
  author?: string
  parentId?: string
  metadata?: Record<string, unknown>
  startUtf8?: number
  endUtf8?: number
  startGrapheme?: number
  endGrapheme?: number
  orphan?: boolean
}

export interface AnnotatedDocument {
  format: 'annotator-document'
  version: 1
  document: {
    title: string
    source: string | null
    eol: 'lf' | 'crlf' | 'cr'
    language: 'plain' | 'markdown'
    textSha256: string
    created: string
    modified: string
  }
  text: string
  annotations: StoredAnnotation[]
  extra: Record<string, unknown>
}

export interface StoredAnnotation {
  id: string
  type: string
  range: { start: number; end: number } | null
  quote: { exact: string; prefix: string; suffix: string }
  body: string
  tags: string[]
  color: string | null
  resolved: boolean
  status?: 'open' | 'resolved' | 'archived'
  created: string
  modified: string
  author?: string
  parentId?: string
  metadata?: Record<string, unknown>
  [key: string]: unknown
}

export interface FileEntry {
  name: string
  path: string
  kind: 'file' | 'directory'
  annotated: boolean
  annotationConflict?: boolean
}

export interface OpenedFile {
  path: string
  text: string
  encoding: string
  eol: '\n' | '\r\n' | '\r'
  hasBom: boolean
  originalText?: string | null
  mixedEol?: boolean
  annotationDocument?: unknown
  annotationPath?: string | null
}

export interface SavedFile {
  path: string
  annotationPath: string | null
}

export interface SaveRequest {
  path: string | null
  annotationPath: string | null
  text: string
  encoding: string
  eol: '\n' | '\r\n' | '\r'
  hasBom: boolean
  document: AnnotatedDocument | null
  backupIntervalMin: number
  saveFormat: 'json' | 'md'
}

export interface ApplyTextRequest {
  path: string
  text: string
  encoding: string
  eol: '\n' | '\r\n' | '\r'
  hasBom: boolean
}

export interface RecoverySnapshot {
  path: string | null
  text: string
  annotations: Annotation[]
  modified: string
}
