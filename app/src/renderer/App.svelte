<script lang="ts">
  import { onMount } from 'svelte'
  import { Compartment, EditorState, Transaction } from '@codemirror/state'
  import { history, historyKeymap } from '@codemirror/commands'
  import { defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
  import { markdown } from '@codemirror/lang-markdown'
  import { searchKeymap } from '@codemirror/search'
  import { EditorView, drawSelection, highlightActiveLine, keymap } from '@codemirror/view'
  import MarkdownIt from 'markdown-it'
  import DOMPurify from 'dompurify'
  import type { Annotation, AnnotatedDocument, FileEntry, OpenedFile, RecoverySnapshot, SavedFile } from '../shared/model'
  import { annotationField, annotationHistory, focusDecorations, focusViewField, setAnnotationRanges, setFocusView } from './editor/annotation-field'
  import { createLineStarts, createOutlineRows } from './editor/outline'
  import { parseTags } from './editor/annotation-tags'
  import { createAnnotatedDocument, parseAnnotatedDocument, restoreAnnotations } from './format/json-format'
  import { resolveTheme, settingsSchema, themes, type AppSettings } from '../shared/settings'

  interface DocumentTab {
    id: string
    path: string | null
    annotationPath: string | null
    text: string
    encoding: string
    eol: '\n' | '\r\n' | '\r'
    hasBom: boolean
    annotations: Annotation[]
    selectedId: string | null
    dirty: boolean
    status: string
    focusMode: boolean
    lastSavedDocument?: AnnotatedDocument
    revision: number
    recoveryDigest: string
    selection: { anchor: number; head: number }
    externalChangePaths: string[]
  }

  let editorHost: HTMLDivElement
  let editor = $state<EditorView>()
  let tabs = $state<DocumentTab[]>([])
  let activeTabId = $state('')
  let closeTabId = $state<string | null>(null)
  let savingTabId: string | null = null
  let externalPromptPath: string | null = null
  let filePath = $state<string | null>(null)
  let annotationPath = $state<string | null>(null)
  let text = $state('')
  let encoding = $state('utf-8')
  let eol = $state<'\n' | '\r\n' | '\r'>('\n')
  let hasBom = $state(false)
  let annotations = $state<Annotation[]>([])
  let selectedId = $state<string | null>(null)
  let folder = $state<string | null>(null)
  let files = $state<FileEntry[]>([])
  let expanded = $state(new Set<string>())
  let children = $state<Record<string, FileEntry[]>>({})
  let dirty = $state(false)
  let status = $state('Готово')
  let noteDraft = $state('')
  let noteType = $state('comment')
  let query = $state('')
  let filterType = $state('all')
  let hideResolved = $state(false)
  let tagDrafts = $state<Record<string, string>>({})
  let showOrphans = $state(true)
  let focusMode = $state(false)
  const focusCompartment = new Compartment()
  let showExplorer = $state(true)
  let showOutline = $state(true)
  let outlineListHost = $state<HTMLDivElement>()
  let outlineScrollTop = $state(0)
  let outlineHeight = $state(200)
  let showAnnotations = $state(true)
  let showSettings = $state(false)
  let settings = $state<AppSettings>(settingsSchema.parse({}))
  let lastSavedDocument: AnnotatedDocument | undefined
  let suppressEditorUpdate = false
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined
  let pendingSelection = $state({ from: 0, to: 0 })
  let editNoteId = $state<string | null>(null)
  let revision = 0
  let lastRecoveryDigest = ''

  const annotationTypes = [
    { id: 'comment', label: 'Комментарий' },
    { id: 'note', label: 'Заметка' },
    { id: 'question', label: 'Вопрос' },
    { id: 'idea', label: 'Идея' },
    { id: 'todo', label: 'Задача' },
    { id: 'important', label: 'Важно' },
  ]
  const markdownParser = new MarkdownIt({ html: false, linkify: true, breaks: true })
  const outlineRows = $derived(createOutlineRows(annotations, createLineStarts(text)))
  const outlineRowHeight = 38
  const outlineStart = $derived(Math.max(0, Math.floor(outlineScrollTop / outlineRowHeight) - 4))
  const outlineEnd = $derived(Math.min(outlineRows.length, Math.ceil((outlineScrollTop + outlineHeight) / outlineRowHeight) + 4))
  const visibleOutlineRows = $derived(outlineRows.slice(outlineStart, outlineEnd))

  const visibleAnnotations = $derived(
    [...annotations]
      .filter((annotation) => filterType === 'all' || annotation.type === filterType)
      .filter((annotation) => !hideResolved || !annotation.resolved)
      .filter((annotation) => !query || `${annotation.type} ${annotation.text} ${annotation.quote} ${annotation.tags.join(' ')}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')))
      .sort((left, right) => Number(Boolean(left.orphan)) - Number(Boolean(right.orphan)) || left.start - right.start || right.end - left.end),
  )
  const visibleLinkedAnnotations = $derived(visibleAnnotations.filter((annotation) => !annotation.orphan))
  const visibleOrphanAnnotations = $derived(visibleAnnotations.filter((annotation) => annotation.orphan))

  function invoke<T>(channel: Parameters<typeof window.annotator.invoke>[0], payload?: unknown): Promise<T> {
    return window.annotator.invoke(channel, payload) as Promise<T>
  }

  function applyTheme(): void {
    const palette = resolveTheme(settings.theme, settings.colorOverrides)
    const root = document.documentElement
    const variableNames: Record<string, string> = {
      'ui.bg': '--ui-bg',
      'ui.fg': '--ui-fg',
      'ui.fgMuted': '--fg-muted',
      'ui.border': '--border',
      'ui.accent': '--accent',
      'ui.accentFg': '--accent-fg',
      'ui.hover': '--hover',
      'ui.danger': '--danger',
      'editor.bg': '--editor-bg',
      'editor.fg': '--editor-fg',
      'editor.selection': '--selection',
      'editor.gutterFg': '--gutter-fg',
      'annot.default': '--annot-default',
      'annot.comment': '--annot-comment',
      'annot.note': '--annot-note',
      'annot.question': '--annot-question',
      'annot.idea': '--annot-idea',
      'annot.todo': '--annot-todo',
      'annot.important': '--annot-important',
    }
    for (const [key, variable] of Object.entries(variableNames)) {
      root.style.setProperty(variable, palette.colors[key]!)
    }
    root.style.setProperty('--editor-font-family', settings.editor.fontFamily)
    root.style.setProperty('--editor-font-size', `${settings.editor.fontSize}px`)
    root.style.setProperty('--editor-line-height', String(settings.editor.lineHeight))
    root.style.setProperty('--card-bg', palette.colors['ui.bg']!)
    root.style.colorScheme = palette.kind
  }

  async function loadSettings(): Promise<void> {
    try {
      const result = await invoke<{ settings: AppSettings; error: string | null }>('settings:get')
      settings = settingsSchema.parse(result.settings)
      applyTheme()
      if (result.error) status = `Настройки не загружены: ${result.error}`
    } catch (error) {
      status = `Не удалось загрузить настройки: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function saveSettings(): Promise<void> {
    try {
      const validated = settingsSchema.parse(settings)
      const plainSettings = JSON.parse(JSON.stringify(validated)) as AppSettings
      const result = await invoke<{ settings: AppSettings; error: null }>('settings:save', plainSettings)
      settings = settingsSchema.parse(result.settings)
      applyTheme()
      showSettings = false
      status = 'Настройки сохранены'
    } catch (error) {
      status = `Не удалось сохранить настройки: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  function syncRanges(undoable = false): void {
    if (!editor) return
    editor.dispatch({
      effects: setAnnotationRanges.of(annotations),
      annotations: Transaction.addToHistory.of(undoable),
    })
  }

  function rangeUpdate(ranges: Annotation[]): void {
    const view = editor
    if (!view) return
    let changed = false
    annotations = annotations.map((annotation) => {
      const range = ranges.find((item) => item.id === annotation.id)
      if (!range || (annotation.start === range.start && annotation.end === range.end && Boolean(annotation.orphan) === Boolean(range.orphan))) return annotation
      changed = true
      return { ...annotation, start: range.start, end: range.end, orphan: range.orphan, quote: range.orphan ? annotation.quote : view.state.doc.sliceString(range.start, range.end) }
    })
    if (changed) markDirty()
  }

  function markDirty(): void {
    revision += 1
    dirty = true
    captureActiveTab()
  }

  function captureActiveTab(): void {
    if (!activeTabId) return
    const selection = editor?.state.selection.main ?? { anchor: 0, head: 0 }
    const snapshot: DocumentTab = {
      id: activeTabId,
      path: filePath,
      annotationPath,
      text,
      encoding,
      eol,
      hasBom,
      annotations,
      selectedId,
      dirty,
      status,
      focusMode,
      lastSavedDocument,
      revision,
      recoveryDigest: lastRecoveryDigest,
      selection: { anchor: selection.anchor, head: selection.head },
      externalChangePaths: tabs.find((tab) => tab.id === activeTabId)?.externalChangePaths ?? [],
    }
    tabs = tabs.map((tab) => tab.id === activeTabId ? snapshot : tab)
  }

  function createCurrentTab(id = `untitled:${crypto.randomUUID()}`): DocumentTab {
    const selection = editor?.state.selection.main ?? { anchor: 0, head: 0 }
    return {
      id,
      path: filePath,
      annotationPath,
      text,
      encoding,
      eol,
      hasBom,
      annotations,
      selectedId,
      dirty,
      status,
      focusMode,
      lastSavedDocument,
      revision,
      recoveryDigest: lastRecoveryDigest,
      selection: { anchor: selection.anchor, head: selection.head },
      externalChangePaths: [],
    }
  }

  function activateTab(id: string): void {
    if (id === activeTabId) return
    if (savingTabId) {
      status = 'Дождитесь завершения сохранения текущей вкладки.'
      return
    }
    captureActiveTab()
    const tab = tabs.find((item) => item.id === id)
    if (!tab) return
    activeTabId = id
    filePath = tab.path
    annotationPath = tab.annotationPath
    text = tab.text
    encoding = tab.encoding
    eol = tab.eol
    hasBom = tab.hasBom
    annotations = tab.annotations
    selectedId = tab.selectedId
    dirty = tab.dirty
    status = tab.status
    lastSavedDocument = tab.lastSavedDocument
    revision = tab.revision
    lastRecoveryDigest = tab.recoveryDigest
    pendingSelection = { from: 0, to: 0 }
    noteDraft = ''
    suppressEditorUpdate = true
    editor?.dispatch({
      changes: { from: 0, to: editor.state.doc.length, insert: text },
      effects: [
        setAnnotationRanges.of(annotations),
        setFocusView.of(tab.focusMode),
        focusCompartment.reconfigure(tab.focusMode
          ? [
              EditorState.readOnly.of(true),
              EditorState.transactionFilter.of((transaction) => transaction.docChanged ? [] : transaction),
            ]
          : []),
    ],
      selection: {
        anchor: Math.min(tab.selection.anchor, text.length),
        head: Math.min(tab.selection.head, text.length),
      },
    })
    focusMode = tab.focusMode
    suppressEditorUpdate = false
    editor?.focus()
    if (tab.externalChangePaths.length) void resolveExternalChanges(tab.externalChangePaths[0]!)
  }

  async function handleExternalChange(changedPath: string): Promise<void> {
    const resolved = changedPath.toLocaleLowerCase('ru')
    const affected = tabs.filter((tab) => [tab.path, tab.annotationPath]
      .some((candidate) => candidate?.toLocaleLowerCase('ru') === resolved))
    if (!affected.length) return
    tabs = tabs.map((tab) => affected.some((item) => item.id === tab.id) && !tab.externalChangePaths.includes(changedPath)
      ? { ...tab, externalChangePaths: [...tab.externalChangePaths, changedPath], status: 'Файл изменён вне приложения' }
      : tab)
    if (affected.some((tab) => tab.id === activeTabId)) await resolveExternalChanges(changedPath)
  }

  async function resolveExternalChanges(changedPath: string): Promise<void> {
    if (externalPromptPath || !filePath) return
    externalPromptPath = changedPath
    const sourceName = changedPath.split(/[\\/]/).at(-1) ?? changedPath
    const reload = window.confirm(`Файл «${sourceName}» изменён в другой программе.\n\nОК — перезагрузить документ и заменить несохранённые изменения.\nОтмена — оставить текущую версию открытой.`)
    if (!reload) {
      try {
        await invoke('fs:watchAck', { path: changedPath })
        tabs = tabs.map((tab) => tab.id === activeTabId
          ? { ...tab, externalChangePaths: tab.externalChangePaths.filter((item) => item !== changedPath), status: 'Внешнее изменение оставлено без загрузки' }
          : tab)
        status = 'Внешнее изменение оставлено без загрузки'
      } catch (error) {
        status = `Не удалось подтвердить внешнее изменение: ${error instanceof Error ? error.message : String(error)}`
      } finally {
        externalPromptPath = null
      }
      return
    }
    try {
      const result = await invoke<OpenedFile>('fs:read', { path: changedPath })
      normalizeSource(result)
      tabs = tabs.map((tab) => tab.id === activeTabId
        ? { ...tab, externalChangePaths: tab.externalChangePaths.filter((item) => item !== changedPath) }
        : tab)
      captureActiveTab()
      status = 'Документ перезагружен после внешнего изменения'
    } catch (error) {
      status = `Не удалось перезагрузить документ: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      externalPromptPath = null
    }
  }

  function switchToDocument(file: OpenedFile): void {
    if (savingTabId) {
      status = 'Дождитесь завершения сохранения текущей вкладки.'
      return
    }
    const existing = tabs.find((tab) => tab.path === file.path && tab.annotationPath === (file.annotationPath ?? null))
    if (existing) {
      activateTab(existing.id)
      return
    }
    captureActiveTab()
    normalizeSource(file)
    const id = file.annotationPath ? `${file.path}|${file.annotationPath}` : `file:${file.path}`
    const previous = tabs.find((tab) => tab.id === id)
    if (previous) {
      tabs = tabs.map((tab) => tab.id === id ? createCurrentTab(id) : tab)
    } else {
      tabs = [...tabs, createCurrentTab(id)]
    }
    activeTabId = id
    captureActiveTab()
  }

  function setFocusMode(enabled: boolean): void {
    focusMode = enabled
    editor?.dispatch({
      effects: [
        setFocusView.of(enabled),
        focusCompartment.reconfigure(enabled
          ? [
              EditorState.readOnly.of(true),
              EditorState.transactionFilter.of((transaction) => transaction.docChanged ? [] : transaction),
            ]
          : []),
      ],
    })
    captureActiveTab()
  }

  function normalizeSource(file: OpenedFile): void {
    revision += 1
    focusMode = false
    editor?.dispatch({
      effects: [
        setFocusView.of(false),
        focusCompartment.reconfigure([]),
      ],
    })
    filePath = file.path
    annotationPath = file.annotationPath ?? null
    text = file.text
    encoding = file.encoding
    eol = file.eol
    hasBom = file.hasBom
    annotations = []
    lastSavedDocument = undefined
    pendingSelection = { from: 0, to: 0 }
    let loadMessage = file.path.split(/[\\/]/).at(-1) ?? 'Документ открыт'
    if (file.annotationDocument) {
      try {
        const parsed = parseAnnotatedDocument(JSON.stringify(file.annotationDocument))
        const restored = restoreAnnotations(parsed)
        annotations = restored.annotations
        lastSavedDocument = parsed
        text = parsed.text
        if (restored.shifted || restored.orphaned) loadMessage = `Привязки восстановлены: сдвинуто ${restored.shifted}, без привязки ${restored.orphaned}`
      } catch (error) {
        loadMessage = error instanceof Error ? error.message : String(error)
      }
    }
    dirty = false
    selectedId = null
    if (editor) {
      suppressEditorUpdate = true
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } })
      syncRanges()
      suppressEditorUpdate = false
      editor.focus()
    }
    status = loadMessage
  }

  async function openFile(path?: string): Promise<void> {
    try {
      const result = path
        ? await invoke<OpenedFile>('fs:read', { path })
        : await invoke<OpenedFile | null>('dialog:openFile')
      if (!result) return
      switchToDocument(result)
    } catch (error) {
      status = `Не удалось открыть файл: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function openFolder(): Promise<void> {
    try {
      const result = await invoke<{ path: string; entries: FileEntry[] } | null>('dialog:openFolder')
      if (!result) return
      folder = result.path
      files = result.entries
      children = {}
      expanded = new Set()
      status = `Рабочая папка: ${result.path}`
    } catch (error) {
      status = `Не удалось открыть папку: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function toggleDirectory(entry: FileEntry): Promise<void> {
    const next = new Set(expanded)
    if (next.has(entry.path)) {
      next.delete(entry.path)
      expanded = next
      return
    }
    try {
      children[entry.path] = await invoke<FileEntry[]>('fs:list', { path: entry.path })
      next.add(entry.path)
      expanded = next
    } catch (error) {
      status = `Не удалось прочитать папку: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function newFile(): Promise<void> {
    if (savingTabId) {
      status = 'Дождитесь завершения сохранения текущей вкладки.'
      return
    }
    captureActiveTab()
    focusMode = false
    editor?.dispatch({
      effects: [
        setFocusView.of(false),
        focusCompartment.reconfigure([]),
      ],
    })
    filePath = null
    annotationPath = null
    text = ''
    encoding = 'utf-8'
    eol = '\n'
    hasBom = false
    annotations = []
    lastSavedDocument = undefined
    revision += 1
    dirty = false
    selectedId = null
    if (editor) {
      suppressEditorUpdate = true
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '' } })
      syncRanges()
      suppressEditorUpdate = false
      editor.focus()
    }
    status = 'Новый документ'
    const tab = createCurrentTab()
    tabs = [...tabs, tab]
    activeTabId = tab.id
  }

  function removeTab(id: string): void {
    const index = tabs.findIndex((tab) => tab.id === id)
    if (index < 0) return
    const wasActive = id === activeTabId
    const remaining = tabs.filter((tab) => tab.id !== id)
    if (!remaining.length) {
      tabs = []
      activeTabId = ''
      void newFile()
      return
    }
    tabs = remaining
    if (wasActive) activateTab(remaining[Math.min(index, remaining.length - 1)]!.id)
    captureActiveTab()
  }

  function requestCloseTab(id = activeTabId): void {
    if (savingTabId) return
    const tab = tabs.find((item) => item.id === id)
    if (!tab) return
    if (tab.dirty) {
      closeTabId = id
      return
    }
    removeTab(id)
  }

  async function closeTabChoice(choice: 'save' | 'discard' | 'cancel'): Promise<void> {
    const id = closeTabId
    closeTabId = null
    if (!id || choice === 'cancel') return
    if (choice === 'save') {
      if (activeTabId !== id) activateTab(id)
      await save()
      captureActiveTab()
      if (dirty) return
    } else {
      const tab = tabs.find((item) => item.id === id)
      if (tab) {
        try {
          await invoke('recovery:delete', { path: tab.path })
        } catch (error) {
          status = `Не удалось удалить снимок восстановления: ${error instanceof Error ? error.message : String(error)}`
          return
        }
      }
    }
    removeTab(id)
  }

  async function documentForSave(): Promise<AnnotatedDocument | null> {
    if (!annotations.length && !lastSavedDocument) return null
    const source = filePath && annotationPath && filePath === annotationPath
      ? null
      : filePath?.split(/[\\/]/).at(-1) ?? null
    const sourceEol = eol === '\r\n' ? 'crlf' : eol === '\r' ? 'cr' : 'lf'
    return createAnnotatedDocument(text, annotations, source, lastSavedDocument, sourceEol)
  }

  async function save(saveAs = false): Promise<void> {
    if (savingTabId) return
    if (!dirty && !saveAs) return
    savingTabId = activeTabId
    try {
      const savedFromPath = filePath
      const savedRevision = revision
      const document = await documentForSave()
      const savedFile = await invoke<SavedFile | null>('fs:save', {
        path: saveAs ? null : filePath,
        annotationPath: saveAs ? null : annotationPath,
        text,
        encoding,
        eol,
        hasBom,
        document,
      })
      if (!savedFile) return
      filePath = savedFile.path
      annotationPath = savedFile.annotationPath
      lastSavedDocument = document ?? undefined
      dirty = revision !== savedRevision
      status = dirty ? 'Документ изменён во время сохранения' : 'Сохранено'
      if (!dirty) {
        lastRecoveryDigest = ''
        await invoke('recovery:delete', { path: savedFromPath })
        if (savedFromPath !== filePath) await invoke('recovery:delete', { path: filePath })
      }
      if (folder) files = await invoke<FileEntry[]>('fs:list', { path: folder })
      captureActiveTab()
    } catch (error) {
      status = `Ошибка сохранения: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      savingTabId = null
    }
  }

  function createAnnotation(): void {
    if (!editor) return
    const selection = editor.state.selection.main
    if (selection.empty) {
      status = 'Сначала выделите фрагмент текста'
      editor.focus()
      return
    }
    pendingSelection = { from: selection.from, to: selection.to }
    noteDraft = ''
    selectedId = null
    status = 'Введите заметку и нажмите «Добавить»'
  }

  function confirmAnnotation(): void {
    const view = editor
    if (!view) return
    const { from, to } = pendingSelection
    if (from === to) return
    const now = new Date().toISOString()
    const quote = view.state.doc.sliceString(from, to)
    let id: string
    do {
      id = `a${Math.random().toString(36).slice(2, 8)}`
    } while (annotations.some((annotation) => annotation.id === id))
    annotations = [...annotations, {
      id,
      type: noteType,
      text: noteDraft,
      start: from,
      end: to,
      quote,
      tags: [],
      resolved: false,
      color: null,
      created: now,
      modified: now,
    }]
    markDirty()
    syncRanges(true)
    noteDraft = ''
    pendingSelection = { from: 0, to: 0 }
    status = 'Аннотация добавлена'
  }

  function removeAnnotation(id: string): void {
    annotations = annotations.filter((annotation) => annotation.id !== id)
    if (selectedId === id) selectedId = null
    markDirty()
    syncRanges(true)
  }

  function rebindOrphan(id: string): void {
    if (!editor) return
    const selection = editor.state.selection.main
    if (selection.empty) {
      status = 'Выделите фрагмент текста, к которому нужно привязать заметку'
      editor.focus()
      return
    }
    const quote = editor.state.doc.sliceString(selection.from, selection.to)
    annotations = annotations.map((annotation) => annotation.id === id
      ? { ...annotation, start: selection.from, end: selection.to, quote, orphan: false, modified: new Date().toISOString() }
      : annotation)
    selectedId = id
    markDirty()
    syncRanges(true)
    status = 'Аннотация привязана к выделению'
  }

  function findOrphanAgain(annotation: Annotation): void {
    if (!editor || !annotation.quote) {
      status = 'Для повторного поиска нет сохранённой цитаты'
      return
    }
    const currentText = editor.state.doc.toString()
    const contextual = annotation.quote
    const candidates: number[] = []
    let next = currentText.indexOf(contextual)
    while (next >= 0) {
      candidates.push(next)
      next = currentText.indexOf(contextual, next + 1)
    }
    if (!candidates.length) {
      status = 'Сохранённая цитата не найдена в документе'
      return
    }
    const start = candidates.sort((left, right) => Math.abs(left - annotation.start) - Math.abs(right - annotation.start) || left - right)[0]!
    annotations = annotations.map((item) => item.id === annotation.id
      ? { ...item, start, end: start + contextual.length, orphan: false, modified: new Date().toISOString() }
      : item)
    selectedId = annotation.id
    markDirty()
    syncRanges(true)
    status = 'Привязка восстановлена по цитате'
  }

  function updateAnnotation(id: string, changes: Partial<Annotation>, undoable = false): void {
    annotations = annotations.map((annotation) => annotation.id === id
      ? { ...annotation, ...changes, modified: new Date().toISOString() }
      : annotation)
    syncRanges(undoable)
    markDirty()
  }

  function commitTags(id: string): void {
    const annotation = annotations.find((item) => item.id === id)
    if (!annotation) return
    const tags = parseTags(tagDrafts[id] ?? '', annotation.tags)
    updateAnnotation(id, { tags })
    tagDrafts = { ...tagDrafts, [id]: '' }
  }

  function handleAnnotationListKeydown(event: KeyboardEvent): void {
    if (event.target instanceof HTMLElement && event.target.closest('input, textarea, select, button')) return
    const annotation = annotations.find((item) => item.id === selectedId)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveAnnotation(event.key === 'ArrowDown' ? 1 : -1)
    } else if (event.key === 'Enter' && annotation) {
      event.preventDefault()
      editNoteId = annotation.id
    } else if (event.key === 'Delete' && annotation) {
      event.preventDefault()
      removeAnnotation(annotation.id)
    } else if (event.key === ' ' && annotation) {
      event.preventDefault()
      updateAnnotation(annotation.id, { resolved: !annotation.resolved }, true)
    }
  }

  function selectAnnotation(annotation: Annotation): void {
    selectedId = annotation.id
    const view = editor
    if (!view) return
    if (!annotation.orphan) {
      view.dispatch({ selection: { anchor: annotation.start, head: annotation.end }, scrollIntoView: true })
      view.focus()
    }
  }

  function moveAnnotation(direction: number): void {
    const ordered = visibleAnnotations.filter((annotation) => !annotation.orphan)
    if (!ordered.length) return
    const index = ordered.findIndex((annotation) => annotation.id === selectedId)
    const next = ordered[(index + direction + ordered.length) % ordered.length]
    selectAnnotation(next)
  }

  function focusNext(): void {
    const active = document.activeElement
    if (active && editorHost?.contains(active)) return
    editor?.focus()
  }

  function handleKeydown(event: KeyboardEvent): void {
    const code = event.code
    const mod = event.ctrlKey && !event.altKey && !event.metaKey
    const typing = (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement)
    if (mod && code === 'KeyW') {
      event.preventDefault()
      requestCloseTab()
    } else if (mod && code === 'Tab') {
      event.preventDefault()
      const index = tabs.findIndex((tab) => tab.id === activeTabId)
      const offset = event.shiftKey ? -1 : 1
      const next = tabs[(index + offset + tabs.length) % tabs.length]
      if (next) activateTab(next.id)
    } else if (mod && code === 'KeyS') {
      event.preventDefault()
      void save(event.shiftKey)
    } else if (mod && code === 'KeyN') {
      event.preventDefault()
      void newFile()
    } else if (mod && code === 'KeyO') {
      event.preventDefault()
      void openFile()
    } else if (mod && code === 'KeyF') {
      event.preventDefault()
      document.querySelector<HTMLInputElement>('.search-input')?.focus()
    } else if (mod && event.shiftKey && code === 'KeyA') {
      event.preventDefault()
      createAnnotation()
    } else if (!typing && event.altKey && code === 'ArrowDown') {
      event.preventDefault()
      moveAnnotation(1)
    } else if (!typing && event.altKey && code === 'ArrowUp') {
      event.preventDefault()
      moveAnnotation(-1)
    } else if (!typing && code === 'F9') {
      setFocusMode(!focusMode)
    } else if (mod && code === 'Digit1') {
      showExplorer = !showExplorer
    } else if (mod && code === 'Digit3') {
      showAnnotations = !showAnnotations
    } else if (event.key === 'Escape' && pendingSelection.from !== pendingSelection.to) {
      pendingSelection = { from: 0, to: 0 }
      noteDraft = ''
    }
  }

  function renderMarkdown(note: string): string {
    return DOMPurify.sanitize(markdownParser.render(note), { ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto):|[^a-z]|[a-z+.-]+(?:[^a-z+.-:]|$))/i })
  }

  function openNoteLink(event: MouseEvent | KeyboardEvent, annotation?: Annotation): void {
    const anchor = (event.target as HTMLElement).closest('a')
    if (anchor?.href) {
      event.preventDefault()
      void invoke('shell:openExternal', { url: anchor.href })
    } else if (annotation && event instanceof KeyboardEvent && event.key === 'Enter') {
      selectAnnotation(annotation)
    }
  }

  async function checkRecovery(): Promise<void> {
    try {
      const snapshots = await invoke<RecoverySnapshot[]>('recovery:list')
      if (!snapshots.length) return
      const snapshot = snapshots.sort((left, right) => right.modified.localeCompare(left.modified))[0]
      if (!snapshot) return
      if (!window.confirm(`Найдены несохранённые изменения${snapshot.path ? ` в файле «${snapshot.path.split(/[\\/]/).at(-1)}»` : ''}. Восстановить?`)) {
        await invoke('recovery:delete', { path: snapshot.path })
        return
      }
      revision += 1
      filePath = snapshot.path
      text = snapshot.text
      annotations = snapshot.annotations
      dirty = true
      if (editor) {
        suppressEditorUpdate = true
        editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } })
        syncRanges()
        suppressEditorUpdate = false
      }
      status = 'Восстановлен снимок. Сохраните документ, чтобы записать изменения.'
    } catch (error) {
      status = `Не удалось проверить восстановление: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  onMount(() => {
    const extensions = [
      history(),
      drawSelection(),
      highlightActiveLine(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      keymap.of([...historyKeymap, ...searchKeymap]),
      annotationField,
      focusViewField,
      focusDecorations,
      annotationHistory,
      focusCompartment.of([]),
      EditorView.lineWrapping,
      EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? ''),
      EditorView.updateListener.of((update) => {
        if (suppressEditorUpdate) return
        if (update.docChanged) {
          text = update.state.doc.toString()
          markDirty()
          rangeUpdate(update.state.field(annotationField))
          status = 'Изменения не сохранены'
        } else if (update.startState.field(annotationField) !== update.state.field(annotationField)) {
          annotations = update.state.field(annotationField)
          markDirty()
          status = 'Изменения не сохранены'
        }
      }),
      EditorView.domEventHandlers({
        copy(event, view) {
          if (!focusMode || !event.clipboardData) return false
          const selection = view.state.selection.main
          const visible = annotations
            .filter((annotation) => !annotation.orphan && annotation.start < selection.to && annotation.end > selection.from)
            .sort((left, right) => left.start - right.start || left.end - right.end)
          const ranges: Array<{ from: number; to: number }> = []
          for (const annotation of visible) {
            const from = Math.max(selection.from, annotation.start)
            const to = Math.min(selection.to, annotation.end)
            const previous = ranges.at(-1)
            if (previous && from <= previous.to) previous.to = Math.max(previous.to, to)
            else ranges.push({ from, to })
          }
          event.clipboardData.setData('text/plain', ranges.map((range) => view.state.doc.sliceString(range.from, range.to)).join('\n\n'))
          event.preventDefault()
          return true
        },
        click(event, view) {
          if (!focusMode) return false
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
          const annotation = position === null ? undefined : annotations.find((item) => !item.orphan && item.start <= position && position < item.end)
          if (annotation) selectedId = annotation.id
          return false
        },
        dblclick(event, view) {
          if (!focusMode) return false
          const position = view.posAtCoords({ x: event.clientX, y: event.clientY })
          setFocusMode(false)
          if (position !== null) view.dispatch({ selection: { anchor: position }, scrollIntoView: true })
          return true
        },
      }),
      EditorView.theme({
        '&': { height: '100%', color: 'var(--editor-fg)', backgroundColor: 'var(--editor-bg)', fontSize: '16px' },
        '.cm-content': { fontFamily: 'var(--editor-font-family)', fontSize: 'var(--editor-font-size)', lineHeight: 'var(--editor-line-height)', padding: '24px', caretColor: 'var(--editor-fg)' },
        '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--gutter-fg)', border: 'none' },
        '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--editor-fg) 4%, transparent)' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent' },
        '.cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
        '.cm-focus-gap': { display: 'inline-block', whiteSpace: 'pre-wrap', minWidth: '1px', height: '2.5em', verticalAlign: 'baseline' },
      }),
    ]
    editor = new EditorView({
      state: EditorState.create({ doc: text, extensions }),
      parent: editorHost,
    })
    const firstTab = createCurrentTab('untitled:initial')
    tabs = [firstTab]
    activeTabId = firstTab.id
    void loadSettings()
    void checkRecovery()
    window.addEventListener('keydown', handleKeydown)
    const unsubscribeOpen = window.annotator.onOpenFile(normalizeSource)
    const unsubscribeWorkspace = window.annotator.onWorkspaceRefresh(() => {
      if (folder) void invoke<FileEntry[]>('fs:list', { path: folder }).then((entries) => files = entries).catch((error: unknown) => {
        status = `Не удалось обновить дерево: ${error instanceof Error ? error.message : String(error)}`
      })
    })
    const unsubscribeFileChanged = window.annotator.onFileChanged(({ path: changedPath }) => {
      void handleExternalChange(changedPath)
    })
    const recoveryTimer = setInterval(() => {
      if (!dirty) return
      const snapshot = JSON.parse(JSON.stringify({
        path: filePath,
        text,
        annotations,
        modified: new Date().toISOString(),
      })) as RecoverySnapshot
      const signature = JSON.stringify(snapshot)
      if (signature === lastRecoveryDigest) return
      lastRecoveryDigest = signature
      void invoke('recovery:save', snapshot).catch((error: unknown) => {
        status = `Не удалось создать снимок восстановления: ${error instanceof Error ? error.message : String(error)}`
      })
    }, 5000)
    return () => {
      window.removeEventListener('keydown', handleKeydown)
      unsubscribeOpen()
      unsubscribeWorkspace()
      unsubscribeFileChanged()
      clearInterval(recoveryTimer)
      editor?.destroy()
      if (autosaveTimer) clearTimeout(autosaveTimer)
    }
  })

  $effect(() => {
    const shouldAutosave = dirty && annotations.length > 0 && Boolean(filePath)
    if (autosaveTimer) clearTimeout(autosaveTimer)
    if (shouldAutosave) {
      autosaveTimer = setTimeout(() => void save(), 1500)
    }
  })
</script>

<svelte:head>
  <title>{filePath?.split(/[\\/]/).at(-1) ?? 'Annotator'}{dirty ? ' •' : ''} — Annotator</title>
</svelte:head>

<div class:focus-mode={focusMode} class="app-shell">
  <header class="toolbar">
    <div class="brand"><span class="brand-mark">A</span><span>Annotator</span></div>
    <div class="toolbar-group">
      <button onclick={newFile} title="Новый документ (Ctrl+N)">Новый</button>
      <button onclick={() => void openFile()} title="Открыть файл (Ctrl+O)">Открыть</button>
      <button onclick={() => void openFolder()} title="Открыть рабочую папку">Папка</button>
    </div>
    <div class="toolbar-group editor-actions">
      <button class="accent-button" onclick={createAnnotation} title="Создать аннотацию (Ctrl+Shift+A)">＋ Аннотация</button>
      <button onclick={() => void save()} title="Сохранить (Ctrl+S)">Сохранить</button>
      <button onclick={() => void save(true)} title="Сохранить как (Ctrl+Shift+S)">Сохранить как…</button>
    </div>
    <div class="toolbar-spacer"></div>
    <button class:active={focusMode} onclick={() => setFocusMode(!focusMode)} title="Режим фокуса (F9)">Фокус</button>
    <button onclick={() => { void loadSettings(); showSettings = true }} title="Настройки приложения">⚙</button>
  </header>

  <div class="workspace">
    {#if showExplorer && !focusMode}
      <aside class="explorer pane">
        <div class="pane-heading"><span>ПРОВОДНИК</span><button class="icon-button" onclick={() => void openFolder()} title="Открыть папку">＋</button></div>
        {#if folder}
          <div class="root-label" title={folder}>▾ {folder.split(/[\\/]/).at(-1)}</div>
          <div class="file-tree" role="tree" aria-label="Файлы рабочей папки">
            {#each files as entry (entry.path)}
              {@render TreeEntry(entry, 0, expanded, children, toggleDirectory, openFile)}
            {/each}
          </div>
        {:else}
          <div class="file-tree empty-tree"><div class="empty-hint"><span class="empty-icon">⌂</span><p>Откройте папку с документами,<br />чтобы видеть файлы здесь.</p><button onclick={() => void openFolder()}>Открыть папку</button></div></div>
        {/if}

        {#if showSettings}
          <div class="modal-backdrop">
            <dialog open class="settings-dialog" aria-labelledby="settings-title">
              <h2 id="settings-title">Настройки Annotator</h2>
              <label class="settings-field">
                <span>Цветовая тема</span>
                <select bind:value={settings.theme} onchange={applyTheme}>
                  {#each Object.keys(themes) as themeId}<option value={themeId}>{themeId}</option>{/each}
                </select>
              </label>
              <label class="settings-field">
                <span>Шрифт редактора</span>
                <input bind:value={settings.editor.fontFamily} oninput={applyTheme} />
              </label>
              <label class="settings-field">
                <span>Размер текста: {settings.editor.fontSize}px</span>
                <input type="range" min="8" max="48" step="1" bind:value={settings.editor.fontSize} oninput={applyTheme} />
              </label>
              <p class="font-preview" style:font-family={settings.editor.fontFamily} style:font-size="{settings.editor.fontSize}px">
                Русский текст, English, 123 — «Кавычки», ёж и фрагмент.
              </p>
              <div class="settings-actions">
                <button onclick={() => { showSettings = false; void loadSettings() }}>Отмена</button>
                <button class="accent-button" onclick={() => void saveSettings()}>Сохранить настройки</button>
              </div>
            </dialog>
          </div>
        {/if}
        <div class="explorer-footer"><button onclick={() => void openFile()}>＋ Открыть отдельный файл</button></div>
        <section class:collapsed={!showOutline} class="outline-pane">
          <div class="outline-heading">
            <span>СТРУКТУРА</span>
            <span class="count-badge">{outlineRows.length}</span>
            <button class="icon-button" title={showOutline ? 'Свернуть навигатор' : 'Развернуть навигатор'} aria-expanded={showOutline} onclick={() => showOutline = !showOutline}>{showOutline ? '⌄' : '⌃'}</button>
          </div>
          {#if showOutline}
            <div
              class="outline-list"
              role="listbox"
              aria-label="Навигатор аннотаций"
              tabindex="0"
              bind:this={outlineListHost}
              bind:clientHeight={outlineHeight}
              onscroll={() => outlineScrollTop = outlineListHost?.scrollTop ?? 0}
              onkeydown={(event) => {
              if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
              event.preventDefault()
              const current = outlineRows.findIndex((row) => row.id === selectedId)
              const next = outlineRows[Math.max(0, Math.min(outlineRows.length - 1, current + (event.key === 'ArrowDown' ? 1 : -1)))]
              if (next) selectAnnotation(annotations.find((annotation) => annotation.id === next.id)!)
            }}
            >
              {#if !outlineRows.length}
                <div class="outline-empty">Аннотации появятся здесь</div>
              {:else}
                <div class="outline-spacer" style:height="{outlineStart * outlineRowHeight}px"></div>
              {/if}
              {#each visibleOutlineRows as row (row.id)}
                <button class:chosen={selectedId === row.id} class="outline-row annot-card-{row.type}" onclick={() => {
                  const annotation = annotations.find((item) => item.id === row.id)
                  if (annotation) selectAnnotation(annotation)
                }}>
                  <span class="outline-type-dot"></span>
                  <span class="outline-row-content">
                    <span class="outline-quote">{row.quote || 'Без цитаты'}</span>
                    {#if row.note}<span class="outline-note">{row.note}</span>{/if}
                  </span>
                  <span class="outline-line">{row.line}</span>
                </button>
              {/each}
              {#if outlineRows.length}
                <div class="outline-spacer" style:height="{Math.max(0, (outlineRows.length - outlineEnd) * outlineRowHeight)}px"></div>
              {/if}
            </div>
          {/if}
        </section>
      </aside>
    {/if}

    <main class="editor-column">
      <div class="document-tabs">
        <div class="tab-strip" role="tablist" aria-label="Документы">
          {#each tabs as tab (tab.id)}
            <div
              class:active-tab={tab.id === activeTabId}
              class="document-tab"
              role="tab"
              aria-selected={tab.id === activeTabId}
              title={tab.path ?? 'Новый документ'}
              tabindex={tab.id === activeTabId ? 0 : -1}
              onclick={() => activateTab(tab.id)}
              onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); activateTab(tab.id) } }}
              onmousedown={(event) => { if (event.button === 1) { event.preventDefault(); requestCloseTab(tab.id) } }}
            >
              {#if tab.annotations.length}<span class="file-glyph" title="Есть аннотации">✳</span>{:else}<span class="file-glyph">≡</span>{/if}
              <span class="tab-label">{tab.path?.split(/[\\/]/).at(-1) ?? 'Новый документ'}</span>
              {#if tab.dirty}<span class="dirty-dot" title="Не сохранено"></span>{/if}
              <button class="tab-close" title="Закрыть вкладку (Ctrl+W)" aria-label="Закрыть {tab.path?.split(/[\\/]/).at(-1) ?? 'Новый документ'}" onclick={(event) => { event.stopPropagation(); requestCloseTab(tab.id) }}>×</button>
            </div>
          {/each}
        </div>
        <span class="tab-spacer"></span>
        <button class="icon-button" title="Переключить проводник" onclick={() => showExplorer = !showExplorer}>◧</button>
        <button class="icon-button" title="Переключить аннотации" onclick={() => showAnnotations = !showAnnotations}>▤</button>
      </div>
      <div class="editor-surface" bind:this={editorHost}></div>
      <footer class="statusbar">
        <span>{dirty ? '● Не сохранено' : '✓ Сохранено'}</span>
        <span>{encoding.toUpperCase()}</span>
        <span>{eol === '\r\n' ? 'CRLF' : eol === '\r' ? 'CR' : 'LF'}</span>
        <span>{annotations.length} {annotations.length === 1 ? 'аннотация' : 'аннотаций'}</span>
        <span class="status-message">{status}</span>
      </footer>
    </main>

    {#if showAnnotations && !focusMode}
      <aside class="annotations pane">
        <div class="pane-heading"><span>АННОТАЦИИ</span><span class="count-badge">{annotations.length}</span></div>
        <input class="search-input" bind:value={query} placeholder="Поиск по заметкам и тегам" aria-label="Поиск по аннотациям" />
        <div class="annotation-filters">
          <select bind:value={filterType} aria-label="Фильтр по типу аннотации">
            <option value="all">Все типы</option>
            {#each annotationTypes as type}<option value={type.id}>{type.label}</option>{/each}
          </select>
          <label><input type="checkbox" bind:checked={hideResolved} /> Скрыть решённые</label>
        </div>
        {#if pendingSelection.from !== pendingSelection.to}
          <section class="note-composer">
            <div class="composer-title">Новая аннотация</div>
            <div class="quote-preview">“{editor?.state.doc.sliceString(pendingSelection.from, pendingSelection.to).slice(0, 120)}”</div>
            <select bind:value={noteType} aria-label="Тип аннотации">
              {#each annotationTypes as type}<option value={type.id}>{type.label}</option>{/each}
            </select>
            <textarea bind:value={noteDraft} rows="4" placeholder="Текст заметки в Markdown…"></textarea>
            <div class="composer-actions"><button onclick={() => { pendingSelection = { from: 0, to: 0 }; noteDraft = '' }}>Отмена</button><button class="accent-button" onclick={confirmAnnotation}>Добавить</button></div>
          </section>
        {/if}
        {#if annotations.some((annotation) => annotation.orphan)}
          <section class="orphan-group">
            <button class="orphan-heading" aria-expanded={showOrphans} onclick={() => showOrphans = !showOrphans}>
              <span>{showOrphans ? '⌄' : '›'} БЕЗ ПРИВЯЗКИ</span>
              <span class="count-badge">{annotations.filter((annotation) => annotation.orphan).length}</span>
            </button>
            {#if showOrphans}
              {#each visibleOrphanAnnotations as annotation (annotation.id)}
                <article class:chosen={selectedId === annotation.id} class="orphan-card">
                  <div class="annotation-quote">“{annotation.quote.slice(0, 120)}”</div>
                  <div class="annotation-rendered">{@html renderMarkdown(annotation.text || '*Пустая заметка*')}</div>
                  <div class="orphan-actions">
                    <button disabled={!editor || editor.state.selection.main.empty} title="Привязать к текущему выделению" onclick={() => rebindOrphan(annotation.id)}>Привязать к выделению</button>
                    <button title="Найти цитату в документе" onclick={() => findOrphanAgain(annotation)}>Найти заново</button>
                    <button class="delete-button" title="Удалить аннотацию" onclick={() => removeAnnotation(annotation.id)}>×</button>
                  </div>
                </article>
              {/each}
            {/if}
          </section>
        {/if}
        <div class="annotation-list" role="listbox" aria-label="Список аннотаций" tabindex="0" onkeydown={handleAnnotationListKeydown}>
          {#if visibleLinkedAnnotations.length === 0}
            <div class="empty-hint annotation-empty"><span class="empty-icon">✳</span><p>{annotations.length ? 'Совпадений не найдено.' : 'Выделите фрагмент текста и нажмите «＋ Аннотация», чтобы добавить заметку.'}</p></div>
          {/if}
          {#each visibleLinkedAnnotations as annotation (annotation.id)}
            <article class:chosen={selectedId === annotation.id} class:orphan={annotation.orphan} class="annotation-card annot-card-{annotation.type}">
              <div class="card-heading">
                <span class="type-dot"></span>
                <select aria-label="Тип аннотации" value={annotation.type} onclick={(event) => event.stopPropagation()} onchange={(event) => updateAnnotation(annotation.id, { type: event.currentTarget.value }, true)}>
                  {#each annotationTypes as type}<option value={type.id}>{type.label}</option>{/each}
                </select>
                <button class="resolve-button" class:resolved={annotation.resolved} title={annotation.resolved ? 'Снова открыть' : 'Отметить решённой'} onclick={(event) => { event.stopPropagation(); updateAnnotation(annotation.id, { resolved: !annotation.resolved }, true) }}>{annotation.resolved ? '✓' : '○'}</button>
                <button class="delete-button" title="Удалить аннотацию" onclick={(event) => { event.stopPropagation(); removeAnnotation(annotation.id) }}>×</button>
              </div>
              <button class="card-main" aria-pressed={selectedId === annotation.id} onclick={() => selectAnnotation(annotation)} ondblclick={() => editNoteId = annotation.id}>
                <div class="annotation-quote">{annotation.orphan ? 'Без привязки' : `“${annotation.quote.slice(0, 120)}”`}</div>
              </button>
              <div class="annotation-rendered" role="button" aria-label="Текст заметки" tabindex="0" onclick={(event) => openNoteLink(event, annotation)} onkeydown={(event) => openNoteLink(event, annotation)}>{@html renderMarkdown(annotation.text || '*Двойной щелчок, чтобы добавить заметку…*')}</div>
              {#if editNoteId === annotation.id}
                <textarea class="annotation-body" aria-label="Текст заметки" rows="3" value={annotation.text} oninput={(event) => updateAnnotation(annotation.id, { text: event.currentTarget.value })} onkeydown={(event) => { if (event.key === 'Escape') editNoteId = null }} onblur={() => editNoteId = null} placeholder="Текст заметки в Markdown…"></textarea>
              {/if}
              {#if annotation.tags.length}<div class="tag-row">{#each annotation.tags as tag}<span>#{tag}</span>{/each}</div>{/if}
              <div class="tag-editor">
                <input
                  aria-label="Добавить тег к аннотации"
                  placeholder="Добавить тег…"
                  value={tagDrafts[annotation.id] ?? ''}
                  oninput={(event) => tagDrafts = { ...tagDrafts, [annotation.id]: event.currentTarget.value }}
                  onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitTags(annotation.id) } }}
                  onblur={() => { if (tagDrafts[annotation.id]?.trim()) commitTags(annotation.id) }}
                />
              </div>
            </article>
          {/each}
        </div>
      </aside>
    {/if}
  </div>
</div>

{#if closeTabId}
  {@const closingTab = tabs.find((tab) => tab.id === closeTabId)}
  <div class="modal-backdrop">
    <dialog open class="close-dialog" aria-labelledby="close-dialog-title">
      <h2 id="close-dialog-title">Сохранить изменения?</h2>
      <p>Документ «{closingTab?.path?.split(/[\\/]/).at(-1) ?? 'Новый документ'}» содержит несохранённые изменения.</p>
      <div class="close-dialog-actions">
        <button class="accent-button" onclick={() => void closeTabChoice('save')}>Сохранить</button>
        <button onclick={() => void closeTabChoice('discard')}>Не сохранять</button>
        <button onclick={() => void closeTabChoice('cancel')}>Отмена</button>
      </div>
    </dialog>
  </div>
{/if}

{#snippet TreeEntry(entry: FileEntry, depth: number, expanded: Set<string>, children: Record<string, FileEntry[]>, toggleDirectory: (entry: FileEntry) => void, openFile: (path: string) => void)}
  <div class={`tree-row depth-${Math.min(depth, 6)}`} role="treeitem" aria-selected="false" aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined} tabindex="0" onclick={() => entry.kind === 'directory' ? toggleDirectory(entry) : openFile(entry.path)} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); entry.kind === 'directory' ? toggleDirectory(entry) : openFile(entry.path) } }}>
    <span class="tree-chevron">{entry.kind === 'directory' ? expanded.has(entry.path) ? '▾' : '▸' : ''}</span>
    <span class="tree-icon">{entry.kind === 'directory' ? expanded.has(entry.path) ? '▾' : '▸' : entry.name.toLowerCase().endsWith('.md') ? '¶' : '≡'}</span>
    <span class="tree-name">{entry.name.replace(/\.annot\.(json|md)$/i, '')}</span>
    {#if entry.annotated}<span class="tree-annotated" title="Есть аннотации">✳</span>{/if}
  </div>
  {#if entry.kind === 'directory' && expanded.has(entry.path)}
    {#each children[entry.path] ?? [] as child (child.path)}
      {@render TreeEntry(child, depth + 1, expanded, children, toggleDirectory, openFile)}
    {/each}
  {/if}
{/snippet}
