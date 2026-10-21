<script lang="ts">
  import { onMount, tick } from 'svelte'
  import { Compartment, EditorState, Transaction } from '@codemirror/state'
  import { history, historyKeymap } from '@codemirror/commands'
  import { defaultHighlightStyle, indentOnInput, syntaxHighlighting } from '@codemirror/language'
  import { markdown } from '@codemirror/lang-markdown'
  import { searchKeymap } from '@codemirror/search'
  import { EditorView, drawSelection, highlightActiveLine, keymap, lineNumbers } from '@codemirror/view'
  import MarkdownIt from 'markdown-it'
  import DOMPurify from 'dompurify'
  import type { Annotation, AnnotatedDocument, FileEntry, OpenedFile, RecoverySnapshot, SavedFile } from '../shared/model'
  import type { AppState } from '../shared/app-state'
  import { getVirtualRange } from '../shared/virtual-list'
  import { annotationField, annotationHistory, focusDecorations, focusViewField, setAnnotationRanges, setFocusView } from './editor/annotation-field'
  import { createLineStarts, createOutlineRows } from './editor/outline'
  import { parseTags } from './editor/annotation-tags'
  import { createAnnotatedDocument, parseAnnotatedDocument, restoreAnnotations, toPlainAnnotatedDocument } from './format/json-format'
  import { getAnnotationMarkerColor, parseShortcut, resolveTheme, settingsSchema, themes, type AppSettings, type UserTheme } from '../shared/settings'

  interface DocumentTab {
    id: string
    path: string | null
    annotationPath: string | null
    text: string
    encoding: string
    eol: '\n' | '\r\n' | '\r'
    hasBom: boolean
    originalText: string | null
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

  async function restoreAppState(): Promise<void> {
    try {
      const result = await invoke<{ state: AppState; error: string | null }>('state:get')
      const state = result.state
      folders = state.folders
      lastWorkspaceFile = state.lastWorkspace
      explorerWidth = state.layout.explorerWidth
      annotationWidth = state.layout.annotationsWidth
      showExplorer = state.layout.showExplorer
      showAnnotations = state.layout.showAnnotations
      showOutline = state.layout.showOutline
      if (folders.length) await refreshWorkspace()
      const restoredTabs = new Map<number, string>()
      for (const [index, tabPath] of state.openTabs.entries()) {
        try {
          const opened = await invoke<OpenedFile>('fs:read', { path: tabPath })
          switchToDocument(opened)
          restoredTabs.set(index, tabPath)
        } catch (error) {
          status = `Не удалось восстановить вкладку «${tabPath.split(/[\\/]/).at(-1)}»: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      const activePath = restoredTabs.get(state.activeTab)
      if (activePath) {
        const active = tabs.find((tab) => tab.path === activePath)
        if (active) activateTab(active.id)
      }
      if (result.error) status = `Состояние не загружено: ${result.error}`
    } catch (error) {
      status = `Не удалось восстановить состояние: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      appStateLoaded = true
    }
  }

  interface TreeEdit {
    action: 'create-file' | 'create-folder' | 'rename'
    parentPath: string
    sourcePath: string | null
    name: string
  }

  let editorHost: HTMLDivElement
  let noteInput = $state<HTMLTextAreaElement>()
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
  let originalText = $state<string | null>(null)
  let annotations = $state<Annotation[]>([])
  let selectedId = $state<string | null>(null)
  let folders = $state<string[]>([])
  let folderNames = $state<Record<string, string>>({})
  let rootEntries = $state<Record<string, FileEntry[]>>({})
  let rootErrors = $state<Record<string, string>>({})
  let lastWorkspaceFile = $state<string | null>(null)
  let expanded = $state(new Set<string>())
  let children = $state<Record<string, FileEntry[]>>({})
  let selectedEntryPath = $state<string | null>(null)
  let selectedEntryPaths = $state<string[]>([])
  let selectionAnchorPath: string | null = null
  let draggedEntryPaths: string[] = []
  let dropDestination = $state<string | null>(null)
  let dropTargetPath = $state<string | null>(null)
  let dropTargetInto = $state(false)
  let dragHoverTimer: ReturnType<typeof setTimeout> | undefined
  let treeMenu = $state(false)
  let treeEdit = $state<TreeEdit | null>(null)
  let treeNameInput = $state<HTMLInputElement>()
  let availableUserThemes = $state<UserTheme[]>([])
  let fontSuggestions = $state<string[]>(['Segoe UI', 'Calibri', 'Cambria', 'Georgia', 'Consolas', 'Cascadia Mono', 'Arial', 'Times New Roman', 'Verdana', 'Tahoma'])
  let themeErrors = $state<Array<{ file: string; message: string }>>([])
  let systemUsesDarkColors = $state(true)
  let commandPaletteOpen = $state(false)
  let commandPaletteQuery = $state('')
  let commandPaletteInput = $state<HTMLInputElement>()
  let themePickerOpen = $state(false)
  let pendingShortcut = ''
  let pendingShortcutTimer: ReturnType<typeof setTimeout> | undefined
  let settingsSaveTimer: ReturnType<typeof setTimeout> | undefined
  let dirty = $state(false)
  let status = $state('Готово')
  let cursorPosition = $state({ line: 1, column: 1 })
  let noteDraft = $state('')
  let noteType = $state('comment')
  let query = $state('')
  let filterType = $state('all')
  let hideResolved = $state(false)
  let tagDrafts = $state<Record<string, string>>({})
  let showOrphans = $state(true)
  let focusMode = $state(false)
  const focusCompartment = new Compartment()
  const editorLayoutCompartment = new Compartment()
  let showExplorer = $state(true)
  let explorerWidth = $state(250)
  let annotationWidth = $state(340)
  let explorerRenderedWidth = $state(250)
  let annotationsRenderedWidth = $state(340)
  let paneResize: { side: 'explorer' | 'annotations'; startX: number; startWidth: number } | null = null
  let showOutline = $state(true)
  let outlineListHost = $state<HTMLDivElement>()
  let outlineScrollTop = $state(0)
  let outlineHeight = $state(200)
  let annotationScrollHost = $state<HTMLDivElement>()
  let annotationScrollTop = $state(0)
  let annotationViewportHeight = $state(500)
  let orphanScrollHost = $state<HTMLDivElement>()
  let orphanScrollTop = $state(0)
  let orphanViewportHeight = $state(200)
  let annotationHeights = $state<Record<string, number>>({})
  let showAnnotations = $state(true)
  let showSettings = $state(false)
  let settings = $state<AppSettings>(settingsSchema.parse({}))
  let lastSavedDocument: AnnotatedDocument | undefined
  let suppressEditorUpdate = false
  let autosaveTimer: ReturnType<typeof setTimeout> | undefined
  let autosaveStartedAt = 0
  let appStateTimer: ReturnType<typeof setTimeout> | undefined
  let appStateLoaded = false
  let pendingSelection = $state({ from: 0, to: 0 })
  let selectionTrigger = $state<{ from: number; to: number; left: number; top: number } | null>(null)
  let suppressSelectionTrigger = false
  let editNoteId = $state<string | null>(null)
  let revision = $state(0)
  let lastRecoveryDigest = ''

  function startPaneResize(side: 'explorer' | 'annotations', event: PointerEvent): void {
    if (event.button !== 0) return
    paneResize = { side, startX: event.clientX, startWidth: side === 'explorer' ? explorerWidth : annotationWidth }
    ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
    event.preventDefault()
  }

  function movePaneResize(event: PointerEvent): void {
    if (!paneResize) return
    const delta = event.clientX - paneResize.startX
    if (paneResize.side === 'explorer') explorerWidth = Math.max(190, Math.min(380, paneResize.startWidth + delta))
    else annotationWidth = Math.max(270, Math.min(460, paneResize.startWidth - delta))
  }

  function finishPaneResize(): void { paneResize = null }

  function resizePaneWithKeyboard(side: 'explorer' | 'annotations', event: KeyboardEvent): void {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
    event.preventDefault()
    const delta = event.key === 'ArrowRight' ? 16 : -16
    if (side === 'explorer') explorerWidth = Math.max(190, Math.min(380, explorerWidth + delta))
    else annotationWidth = Math.max(270, Math.min(460, annotationWidth - delta))
  }

  function resizablePane(node: HTMLElement, side: 'explorer' | 'annotations') {
    const pointerDown = (event: PointerEvent) => startPaneResize(side, event)
    const pointerMove = (event: PointerEvent) => movePaneResize(event)
    const pointerUp = () => finishPaneResize()
    const keyDown = (event: KeyboardEvent) => resizePaneWithKeyboard(side, event)
    node.addEventListener('pointerdown', pointerDown)
    node.addEventListener('pointermove', pointerMove)
    node.addEventListener('pointerup', pointerUp)
    node.addEventListener('pointercancel', pointerUp)
    node.addEventListener('keydown', keyDown)
    return {
      destroy() {
        node.removeEventListener('pointerdown', pointerDown)
        node.removeEventListener('pointermove', pointerMove)
        node.removeEventListener('pointerup', pointerUp)
        node.removeEventListener('pointercancel', pointerUp)
        node.removeEventListener('keydown', keyDown)
      },
    }
  }

  function measurePaneWidth(node: HTMLElement, side: 'explorer' | 'annotations') {
    const update = () => {
      const width = Math.round(node.getBoundingClientRect().width)
      if (width > 0) {
        if (side === 'explorer') explorerRenderedWidth = width
        else annotationsRenderedWidth = width
      }
    }
    const observer = new ResizeObserver(update)
    observer.observe(node)
    update()
    return { destroy: () => observer.disconnect() }
  }

  function modalDialog(node: HTMLDialogElement) {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    const focusable = () => [...node.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    )].filter((element) => element.getClientRects().length > 0)
    const firstFrame = requestAnimationFrame(() => (focusable()[0] ?? node).focus())
    const onKeydown = (event: KeyboardEvent) => {
      if (event.key !== 'Tab') return
      const items = focusable()
      if (!items.length) {
        event.preventDefault()
        node.focus()
        return
      }
      const first = items[0]!
      const last = items.at(-1)!
      if (event.shiftKey && (document.activeElement === first || !node.contains(document.activeElement))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (document.activeElement === last || !node.contains(document.activeElement))) {
        event.preventDefault()
        first.focus()
      }
    }
    node.addEventListener('keydown', onKeydown)
    return {
      destroy() {
        cancelAnimationFrame(firstFrame)
        node.removeEventListener('keydown', onKeydown)
        if (previousFocus?.isConnected) previousFocus.focus()
      },
    }
  }

  const annotationTypes = [
    { id: 'comment', label: 'Комментарий' },
    { id: 'note', label: 'Заметка' },
    { id: 'question', label: 'Вопрос' },
    { id: 'idea', label: 'Идея' },
    { id: 'todo', label: 'Задача' },
    { id: 'important', label: 'Важно' },
  ]
  const annotationPluralRules = new Intl.PluralRules('ru')
  const markdownParser = new MarkdownIt({ html: false, linkify: true, breaks: true })
  const builtinFonts = ['Segoe UI', 'Calibri', 'Cambria', 'Georgia', 'Consolas', 'Cascadia Mono', 'Arial', 'Times New Roman', 'Verdana', 'Tahoma']
  const supportedEncodings = ['utf-8', 'windows-1251', 'utf-16le', 'utf-16be', 'koi8-r', 'iso-8859-1']
  const commandDefinitions = [
    { id: 'annotation.create', label: 'Создать аннотацию из выделения', shortcut: 'Ctrl+Shift+A' },
    { id: 'annotation.confirm', label: 'Подтвердить аннотацию', shortcut: 'Ctrl+Enter' },
    { id: 'ui.cancel', label: 'Отменить ввод / закрыть диалог', shortcut: 'Escape' },
    { id: 'annotation.next', label: 'Следующая аннотация', shortcut: 'Alt+ArrowDown' },
    { id: 'annotation.prev', label: 'Предыдущая аннотация', shortcut: 'Alt+ArrowUp' },
    { id: 'view.focusMode', label: 'Переключить режим фокуса', shortcut: 'F9' },
    { id: 'file.save', label: 'Сохранить', shortcut: 'Ctrl+S' },
    { id: 'file.saveAs', label: 'Сохранить как…', shortcut: 'Ctrl+Shift+S' },
    { id: 'workspace.openFolder', label: 'Открыть папку', shortcut: 'Ctrl+K Ctrl+O' },
    { id: 'file.new', label: 'Новый документ', shortcut: 'Ctrl+N' },
    { id: 'tab.close', label: 'Закрыть вкладку', shortcut: 'Ctrl+W' },
    { id: 'tab.next', label: 'Следующая вкладка', shortcut: 'Ctrl+Tab' },
    { id: 'tab.prev', label: 'Предыдущая вкладка', shortcut: 'Ctrl+Shift+Tab' },
    { id: 'theme.pick', label: 'Сменить тему', shortcut: 'Ctrl+K Ctrl+T' },
    { id: 'settings.open', label: 'Открыть настройки', shortcut: 'Ctrl+,' },
    { id: 'palette.open', label: 'Панель команд', shortcut: 'Ctrl+Shift+P' },
    { id: 'editor.find', label: 'Поиск по аннотациям', shortcut: 'Ctrl+F' },
    { id: 'zoom.in', label: 'Увеличить размер текста', shortcut: null },
    { id: 'zoom.out', label: 'Уменьшить размер текста', shortcut: null },
    { id: 'zoom.reset', label: 'Сбросить размер текста', shortcut: 'Ctrl+0' },
    { id: 'focus.explorer', label: 'Фокус на проводник', shortcut: 'Ctrl+1' },
    { id: 'focus.editor', label: 'Фокус на текст', shortcut: 'Ctrl+2' },
    { id: 'focus.annotations', label: 'Фокус на аннотации', shortcut: 'Ctrl+3' },
    { id: 'layout.explorer', label: 'Показать / скрыть проводник', shortcut: 'Ctrl+B' },
    { id: 'layout.annotations', label: 'Показать / скрыть аннотации', shortcut: 'Ctrl+Shift+B' },
    { id: 'explorer.rename', label: 'Переименовать в проводнике', shortcut: 'F2' },
    { id: 'explorer.delete', label: 'Переместить в корзину', shortcut: 'Delete' },
    { id: 'edit.undo', label: 'Отменить файловую операцию', shortcut: 'Ctrl+Z' },
  ] as const
  const visibleCommands = $derived(commandDefinitions.filter((command) =>
    `${command.label} ${command.id}`.toLocaleLowerCase('ru').includes(commandPaletteQuery.toLocaleLowerCase('ru'))))
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
      .sort((left, right) => Number(Boolean(left.orphan)) - Number(Boolean(right.orphan)) || (
        settings.annotationsPanel.sort === 'created'
          ? left.created.localeCompare(right.created)
          : settings.annotationsPanel.sort === 'modified'
            ? left.modified.localeCompare(right.modified)
            : left.start - right.start || right.end - left.end
      )),
  )
  const visibleLinkedAnnotations = $derived(visibleAnnotations.filter((annotation) => !annotation.orphan))
  const visibleOrphanAnnotations = $derived(visibleAnnotations.filter((annotation) => annotation.orphan))
  const linkedWindow = $derived(getVirtualRange(
    visibleLinkedAnnotations.map((annotation) => annotation.id),
    annotationHeights,
    annotationScrollTop,
    annotationViewportHeight,
    190,
    4,
  ))
  const orphanWindow = $derived(getVirtualRange(
    visibleOrphanAnnotations.map((annotation) => annotation.id),
    annotationHeights,
    orphanScrollTop,
    orphanViewportHeight,
    120,
    3,
  ))
  const virtualLinkedAnnotations = $derived(visibleLinkedAnnotations.slice(linkedWindow.start, linkedWindow.end))
  const virtualOrphanAnnotations = $derived(visibleOrphanAnnotations.slice(orphanWindow.start, orphanWindow.end))

  function measureAnnotation(node: HTMLElement, id: string) {
    const updateHeight = () => {
      const margin = Number.parseFloat(getComputedStyle(node).marginBottom) || 0
      const height = Math.ceil(node.getBoundingClientRect().height + margin)
      if (height > 0 && Math.abs((annotationHeights[id] ?? 0) - height) > 1) {
        annotationHeights = { ...annotationHeights, [id]: height }
      }
    }
    const observer = new ResizeObserver(updateHeight)
    observer.observe(node)
    updateHeight()
    return {
      destroy() {
        observer.disconnect()
      },
    }
  }

  function invoke<T>(channel: Parameters<typeof window.annotator.invoke>[0], payload?: unknown): Promise<T> {
    return window.annotator.invoke(channel, payload) as Promise<T>
  }

  function applyTheme(): void {
    const themeId = settings.themeFollowSystem.enabled
      ? systemUsesDarkColors ? settings.themeFollowSystem.dark : settings.themeFollowSystem.light
      : settings.theme
    const palette = resolveTheme(themeId, settings.colorOverrides, availableUserThemes)
    const root = document.documentElement
    const variableNames: Record<string, string> = {
      'ui.bg': '--ui-bg',
      'ui.bgAlt': '--ui-bg-alt',
      'ui.fg': '--ui-fg',
      'ui.fgMuted': '--fg-muted',
      'ui.border': '--border',
      'ui.accent': '--accent',
      'ui.accentFg': '--accent-fg',
      'ui.hover': '--hover',
      'ui.selectedRow': '--selected-row',
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
      const typeId = key.startsWith('annot.') ? key.slice('annot.'.length) : null
      const configuredTypeColor = typeId
        ? settings.annotations.types.find((type) => type.id === typeId)?.color
        : null
      const color = typeId && typeId !== 'default'
        ? settings.annotations.colorByType
          ? configuredTypeColor ?? palette.colors[key]!
          : settings.annotations.highlightColor ?? palette.colors['annot.default']!
        : palette.colors[key]!
      root.style.setProperty(variable, color)
      if (typeId && typeId !== 'default') {
        const markerPalette = {
          ...palette,
          colors: { ...palette.colors, [key]: color },
        }
        root.style.setProperty(`--annot-dot-${typeId}`, getAnnotationMarkerColor(markerPalette, typeId))
      }
    }
    root.style.setProperty('--annot-alpha', `${settings.annotations.highlightAlpha * 100}%`)
    root.style.setProperty('--editor-font-family', settings.editor.fontFamily)
    root.style.setProperty('--editor-font-size', `${settings.editor.fontSize}px`)
    root.style.setProperty('--editor-font-weight', String(settings.editor.fontWeight))
    root.style.setProperty('--editor-line-height', String(settings.editor.lineHeight))
    root.style.setProperty('--editor-max-width', `${settings.editor.maxLineWidthCh}ch`)
    root.style.setProperty('--editor-ligatures', settings.editor.ligatures ? 'normal' : 'none')
    root.style.setProperty('--card-bg', palette.colors['ui.bgAlt']!)
    root.style.setProperty('--ui-font-family', settings.ui.fontFamily)
    root.style.setProperty('--ui-font-size', `${settings.ui.fontSize}px`)
    root.style.setProperty('--annotations-font-family', settings.annotationsPanel.fontFamily)
    root.style.setProperty('--annotations-font-size', `${settings.annotationsPanel.fontSize}px`)
    root.style.setProperty('--annotations-line-height', String(settings.annotationsPanel.lineHeight))
    root.style.setProperty('--ui-zoom', String(settings.ui.zoom))
    root.style.colorScheme = palette.kind
    editor?.dispatch({ effects: editorLayoutCompartment.reconfigure(editorLayoutExtensions()) })
  }

  function editorLayoutExtensions() {
    return [
      ...(settings.editor.wrap ? [EditorView.lineWrapping] : []),
      ...(settings.editor.lineNumbers ? [lineNumbers()] : []),
      EditorState.readOnly.of(settings.editor.readOnly),
    ]
  }

  async function loadSettings(): Promise<void> {
    try {
      const [result, userThemeResult] = await Promise.all([
        invoke<{ settings: AppSettings; error: string | null }>('settings:get'),
        invoke<{ themes: UserTheme[]; errors: Array<{ file: string; message: string }>; systemUsesDarkColors: boolean }>('themes:list'),
      ])
      settings = settingsSchema.parse(result.settings)
      noteType = settings.annotations.defaultType
      availableUserThemes = userThemeResult.themes
      themeErrors = userThemeResult.errors
      systemUsesDarkColors = userThemeResult.systemUsesDarkColors
      applyTheme()
      if (result.error) status = `Настройки не загружены: ${result.error}`
    } catch (error) {
      status = `Не удалось загрузить настройки: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function saveSettings(close = true): Promise<void> {
    try {
      const validated = settingsSchema.parse(settings)
      const plainSettings = JSON.parse(JSON.stringify(validated)) as AppSettings
      const result = await invoke<{ settings: AppSettings; error: null }>('settings:save', plainSettings)
      settings = settingsSchema.parse(result.settings)
      applyTheme()
      if (close) showSettings = false
      status = 'Настройки сохранены'
    } catch (error) {
      status = `Не удалось сохранить настройки: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function importTheme(event: Event): Promise<void> {
      const input = event.currentTarget
      if (!(input instanceof HTMLInputElement) || !input.files?.[0]) return
      try {
        const parsed: unknown = JSON.parse(await input.files[0].text())
        const theme = await invoke<UserTheme>('themes:save', parsed)
        availableUserThemes = [...availableUserThemes.filter((item) => item.id !== theme.id), theme]
        settings.theme = theme.id
        applyTheme()
        status = `Тема «${theme.name}» добавлена`
      } catch (error) {
        status = `Не удалось импортировать тему: ${error instanceof Error ? error.message : String(error)}`
      } finally {
        input.value = ''
      }
    }

  async function deleteUserTheme(theme: UserTheme): Promise<void> {
      try {
        await invoke('themes:delete', { id: theme.id })
        availableUserThemes = availableUserThemes.filter((item) => item.id !== theme.id)
        if (settings.theme === theme.id) settings.theme = 'dracula'
        if (settings.themeFollowSystem.light === theme.id) settings.themeFollowSystem.light = 'github-light'
        if (settings.themeFollowSystem.dark === theme.id) settings.themeFollowSystem.dark = 'github-dark'
        applyTheme()
        await saveSettings(false)
        status = `Тема «${theme.name}» удалена`
      } catch (error) {
        status = `Не удалось удалить тему: ${error instanceof Error ? error.message : String(error)}`
      }
    }

  function scheduleSettingsSave(): void {
      if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
      settingsSaveTimer = setTimeout(() => void saveSettings(false), 500)
    }

  function adjustEditorFontSize(delta: number): void {
      settings.editor.fontSize = Math.max(8, Math.min(48, settings.editor.fontSize + delta))
      applyTheme()
      scheduleSettingsSave()
  }

  async function openCommandPalette(): Promise<void> {
    commandPaletteOpen = true
    commandPaletteQuery = ''
    await tick()
    commandPaletteInput?.focus()
  }

  async function executeCommand(id: string): Promise<void> {
    commandPaletteOpen = false
    switch (id) {
      case 'annotation.create': await createAnnotation(); break
      case 'annotation.confirm': confirmAnnotation(); break
      case 'ui.cancel':
        if (showSettings) { showSettings = false; void loadSettings() }
        else if (closeTabId) closeTabId = null
        else if (treeEdit) treeEdit = null
        else if (treeMenu) treeMenu = false
        else if (themePickerOpen) themePickerOpen = false
        else if (pendingSelection.from !== pendingSelection.to) {
          pendingSelection = { from: 0, to: 0 }
          noteDraft = ''
        }
        break
      case 'annotation.next': moveAnnotation(1); break
      case 'annotation.prev': moveAnnotation(-1); break
      case 'view.focusMode': setFocusMode(!focusMode); break
      case 'file.save': await save(); break
      case 'file.saveAs': await save(true); break
      case 'workspace.openFolder': await openFolder(); break
      case 'file.new': await newFile(); break
      case 'tab.close': requestCloseTab(); break
      case 'tab.next':
      case 'tab.prev': {
        const index = tabs.findIndex((tab) => tab.id === activeTabId)
        const offset = id === 'tab.prev' ? -1 : 1
        const next = tabs[(index + offset + tabs.length) % tabs.length]
        if (next) activateTab(next.id)
        break
      }
      case 'theme.pick': themePickerOpen = true; break
      case 'settings.open':
        await loadSettings()
        showSettings = true
        break
      case 'palette.open': await openCommandPalette(); break
      case 'editor.find': document.querySelector<HTMLInputElement>('.search-input')?.focus(); break
      case 'zoom.in': adjustEditorFontSize(1); break
      case 'zoom.out': adjustEditorFontSize(-1); break
      case 'zoom.reset':
        settings.editor.fontSize = 16
        applyTheme()
        scheduleSettingsSave()
        break
      case 'focus.explorer': document.querySelector<HTMLElement>('[role="tree"]')?.focus(); break
      case 'focus.editor': editor?.focus(); break
      case 'focus.annotations': document.querySelector<HTMLElement>('.annotations .search-input')?.focus(); break
      case 'layout.explorer': showExplorer = !showExplorer; break
      case 'layout.annotations': showAnnotations = !showAnnotations; break
      case 'explorer.rename': beginTreeEdit('rename'); break
      case 'explorer.delete': await deleteTreeEntry(); break
      case 'edit.undo':
        if (document.activeElement instanceof HTMLElement && document.activeElement.closest('[role="tree"]')) {
          await invoke('fs:undo')
          selectedEntryPaths = []
          selectedEntryPath = null
          await refreshWorkspace()
          status = 'Последняя файловая операция отменена'
        }
        break
    }
  }

  function eventStroke(event: KeyboardEvent): string {
    const modifiers = [
      ...(event.ctrlKey || event.metaKey ? ['Ctrl'] : []),
      ...(event.shiftKey ? ['Shift'] : []),
      ...(event.altKey ? ['Alt'] : []),
    ]
    const key = event.code.startsWith('Key') ? event.code.slice(3)
      : event.code.startsWith('Digit') ? event.code.slice(5)
        : event.code === 'Comma' ? ','
          : event.code === 'Escape' ? 'Escape'
            : event.code === 'Space' ? 'Space'
              : event.code.startsWith('Arrow') ? event.code
                : event.code
    return [...modifiers, key].join('+')
  }

  function bindingFor(command: (typeof commandDefinitions)[number]): string | null {
    return Object.hasOwn(settings.keybindings, command.id)
      ? settings.keybindings[command.id] ?? null
      : command.shortcut
  }

  function themeColor(key: string): string {
    const themeId = settings.themeFollowSystem.enabled
      ? systemUsesDarkColors ? settings.themeFollowSystem.dark : settings.themeFollowSystem.light
      : settings.theme
    return resolveTheme(themeId, {}, availableUserThemes).colors[key] ?? '#000000'
  }

  function setThemeColor(key: string, color: string): void {
    settings.colorOverrides = { ...settings.colorOverrides, [key]: color }
    applyTheme()
  }

  function setAnnotationTypeColor(id: string, color: string | null): void {
    const existing = settings.annotations.types.find((type) => type.id === id)
    const label = annotationTypes.find((type) => type.id === id)?.label ?? id
    settings.annotations.types = [
      ...settings.annotations.types.filter((type) => type.id !== id),
      { id, label: existing?.label ?? label, color },
    ]
    applyTheme()
  }

  function conflictingCommandIds(): Set<string> {
    const bindings = commandDefinitions.flatMap((command) => {
      const shortcut = bindingFor(command)
      if (!shortcut) return []
      try {
        return [{ command, shortcut, steps: parseShortcut(shortcut) }]
      } catch {
        return []
      }
    })
    const conflicts = new Set<string>()
    for (let left = 0; left < bindings.length; left += 1) {
      for (let right = left + 1; right < bindings.length; right += 1) {
        const first = bindings[left]!
        const second = bindings[right]!
        const length = Math.min(first.steps.length, second.steps.length)
        if (!first.steps.slice(0, length).every((step, index) => step === second.steps[index])) continue
        conflicts.add(first.command.id)
        conflicts.add(second.command.id)
      }
    }
    return conflicts
  }

  function shortcutConflicts(): string[] {
    const bindings = commandDefinitions.flatMap((command) => {
      const shortcut = bindingFor(command)
      if (!shortcut) return []
      try {
        return [{ command, shortcut, steps: parseShortcut(shortcut) }]
      } catch {
        return []
      }
    })
    const conflicts: string[] = []
    for (let left = 0; left < bindings.length; left += 1) {
      for (let right = left + 1; right < bindings.length; right += 1) {
        const first = bindings[left]!
        const second = bindings[right]!
        const length = Math.min(first.steps.length, second.steps.length)
        if (first.steps.slice(0, length).every((step, index) => step === second.steps[index])) {
          conflicts.push(`${first.shortcut} / ${second.shortcut}: ${first.command.id}, ${second.command.id}`)
        }
      }
    }
    return conflicts
  }

  function handleCommandShortcut(event: KeyboardEvent, typing: boolean, inTree: boolean): boolean {
    if (event.target instanceof HTMLElement && event.target.closest('.shortcut-setting')) return false
    const stroke = eventStroke(event)
    const conflicts = conflictingCommandIds()
    if (pendingShortcut) {
      const matched = commandDefinitions.find((command) => {
        if (conflicts.has(command.id)) return false
        const binding = bindingFor(command)
        if (!binding) return false
        try {
          const steps = parseShortcut(binding)
          return steps.length === 2 && steps[0] === pendingShortcut && steps[1] === stroke
        } catch {
          return false
        }
      })
      if (pendingShortcutTimer) clearTimeout(pendingShortcutTimer)
      pendingShortcut = ''
      status = 'Готово'
      if (matched) {
        event.preventDefault()
        void executeCommand(matched.id).catch((error: unknown) => {
          status = `Команда не выполнена: ${error instanceof Error ? error.message : String(error)}`
        })
        return true
      }
    }
    if (typing && ['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A'].includes(stroke)) return false
    for (const command of commandDefinitions) {
      if (conflicts.has(command.id)) continue
      const binding = bindingFor(command)
      if (!binding) continue
      let steps: string[]
      try {
        steps = parseShortcut(binding)
      } catch {
        continue
      }
      if (steps[0] !== stroke) continue
      if (steps.length === 2) {
        event.preventDefault()
        pendingShortcut = stroke
        status = 'Ожидание следующей клавиши…'
        pendingShortcutTimer = setTimeout(() => {
          pendingShortcut = ''
          status = 'Готово'
        }, 1500)
        return true
      }
      if ((command.id.startsWith('explorer.') || command.id === 'edit.undo') && !inTree) continue
      if (command.id === 'annotation.confirm' && !(event.target instanceof HTMLTextAreaElement)) continue
      if (command.id === 'ui.cancel' && !commandPaletteOpen && !themePickerOpen && !showSettings && !closeTabId && !treeMenu && !treeEdit && pendingSelection.from === pendingSelection.to) continue
      event.preventDefault()
      void executeCommand(command.id).catch((error: unknown) => {
        status = `Команда не выполнена: ${error instanceof Error ? error.message : String(error)}`
      })
      return true
    }
    return false
  }

  function syncRanges(undoable = false): void {
    if (!editor) return
    editor.dispatch({
      effects: setAnnotationRanges.of(annotations),
      annotations: Transaction.addToHistory.of(undoable),
    })
  }

  function updateCursorPosition(state: EditorState): void {
    const cursor = state.doc.lineAt(state.selection.main.head)
    cursorPosition = { line: cursor.number, column: state.selection.main.head - cursor.from + 1 }
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
      originalText,
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
      originalText,
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
    originalText = tab.originalText
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
        setFocusView.of(focusViewOptions(tab.focusMode)),
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
    if (editor) updateCursorPosition(editor.state)
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
    const sourceChanged = affected.some((tab) =>
      tab.annotationPath &&
      tab.path &&
      tab.path.toLocaleLowerCase('ru') === resolved &&
      tab.annotationPath.toLocaleLowerCase('ru') !== resolved)
    if (sourceChanged) {
      try {
        const sourceTab = affected.find((tab) => tab.id === activeTabId) ?? affected[0]
        const latestOriginal = await invoke<string>('fs:readSource', {
          path: changedPath,
          ...(sourceTab ? { encoding: sourceTab.encoding } : {}),
        })
        tabs = tabs.map((tab) => affected.some((item) => item.id === tab.id)
          ? { ...tab, originalText: latestOriginal, status: 'Исходный файл изменён вне приложения' }
          : tab)
        if (affected.some((tab) => tab.id === activeTabId)) {
          originalText = latestOriginal
          status = 'Исходный файл изменён вне приложения'
          captureActiveTab()
        }
      } catch (error) {
        status = `Не удалось проверить внешний исходник: ${error instanceof Error ? error.message : String(error)}`
      }
      return
    }
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
        setFocusView.of(focusViewOptions(enabled)),
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

  function focusViewOptions(enabled: boolean) {
    return {
      enabled,
      contextChars: settings.focusView.contextChars,
      separator: settings.focusView.separator,
    }
  }

  function normalizeSource(file: OpenedFile): void {
    revision += 1
    focusMode = false
    editor?.dispatch({
      effects: [
        setFocusView.of(focusViewOptions(false)),
        focusCompartment.reconfigure([]),
      ],
    })
    filePath = file.path
    annotationPath = file.annotationPath ?? null
    text = file.text
    encoding = file.encoding
    eol = file.eol
    hasBom = file.hasBom
    originalText = file.originalText ?? null
    annotations = []
    cursorPosition = { line: 1, column: 1 }
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
    if (file.mixedEol) loadMessage += ' · файл содержал смешанные переводы строк; при сохранении используется преобладающий стиль'
    dirty = false
    selectedId = null
    if (editor) {
      suppressEditorUpdate = true
      editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text } })
      syncRanges()
      updateCursorPosition(editor.state)
      suppressEditorUpdate = false
      editor.focus()
    }
    status = loadMessage
  }

  async function openFile(path?: string, encodingOverride?: string): Promise<void> {
    try {
      const result = path
        ? await invoke<OpenedFile | null>('fs:read', { path, ...(encodingOverride ? { encoding: encodingOverride } : {}) })
        : await invoke<OpenedFile | null>('dialog:openFile')
      if (!result) return
      lastWorkspaceFile = result.path
      switchToDocument(result)
    } catch (error) {
      status = `Не удалось открыть файл: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function reopenWithEncoding(): Promise<void> {
    if (!filePath) return
    if (dirty && !window.confirm('Переоткрытие может отбросить несохранённые изменения. Продолжить?')) return
    try {
      const selected = await invoke<string | null>('dialog:chooseEncoding', { current: encoding })
      if (selected) await openFile(filePath, selected)
    } catch (error) {
      status = `Не удалось выбрать кодировку: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function openFolder(add = false): Promise<void> {
    try {
      const result = await invoke<{ folders: Array<{ path: string; entries: FileEntry[] }> } | null>('dialog:openFolder', { add })
      if (!result) return
      if (!add) {
        folders = []
        lastWorkspaceFile = null
        folderNames = {}
        rootEntries = {}
        rootErrors = {}
        children = {}
        expanded = new Set()
      }
      const nextRoots = [...folders]
      const nextEntries = { ...rootEntries }
      for (const root of result.folders) {
        if (!nextRoots.includes(root.path)) nextRoots.push(root.path)
        nextEntries[root.path] = root.entries
      }
      folders = nextRoots
      rootEntries = nextEntries
      status = `Рабочая область: ${folders.length} корней`
    } catch (error) {
      status = `Не удалось открыть папку: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function openWorkspace(): Promise<void> {
    try {
      const result = await invoke<{
        path: string
        folders: Array<{ path: string; name?: string; entries: FileEntry[]; error: string | null }>
        openTabs: string[]
        activeTab: number
        settings?: Record<string, unknown>
      } | null>('dialog:openWorkspace')
      if (!result) return
      folders = result.folders.map((root) => root.path)
      folderNames = Object.fromEntries(result.folders.flatMap((root) => root.name ? [[root.path, root.name]] : []))
      rootEntries = Object.fromEntries(result.folders.map((root) => [root.path, root.entries]))
      rootErrors = Object.fromEntries(result.folders.flatMap((root) => root.error ? [[root.path, root.error]] : []))
      children = {}
      expanded = new Set()
      if (result.settings) {
        const editorOverrides = result.settings.editor && typeof result.settings.editor === 'object' && !Array.isArray(result.settings.editor)
          ? result.settings.editor
          : {}
        settings = settingsSchema.parse({
          ...settings,
          ...result.settings,
          editor: { ...settings.editor, ...editorOverrides },
        })
        applyTheme()
      }
      const restoredTabs = new Map<number, string>()
      let restoreErrors = 0
      for (const [index, tabPath] of result.openTabs.entries()) {
        try {
          const opened = await invoke<OpenedFile>('fs:read', { path: tabPath })
          switchToDocument(opened)
          restoredTabs.set(index, tabPath)
        } catch (error) {
          restoreErrors += 1
          status = `Не удалось восстановить вкладку «${tabPath.split(/[\\/]/).at(-1)}»: ${error instanceof Error ? error.message : String(error)}`
        }
      }
      const activePath = restoredTabs.get(result.activeTab)
      if (activePath) {
        const active = tabs.find((tab) => tab.path === activePath)
        if (active) activateTab(active.id)
      }
      status = restoreErrors
        ? `Workspace открыт; не удалось восстановить вкладок: ${restoreErrors}`
        : `Workspace открыт: ${result.path}`
    } catch (error) {
      status = `Не удалось открыть workspace: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function saveWorkspace(): Promise<void> {
    if (!folders.length) {
      status = 'Сначала добавьте папку в рабочую область.'
      return
    }
    const openTabs = tabs.flatMap((tab) => tab.path ? [tab.path] : [])
    const activeTab = filePath ? openTabs.indexOf(filePath) : 0
    try {
      const result = await invoke<string | null>('dialog:saveWorkspace', {
        folders,
        openTabs,
        activeTab: Math.max(0, activeTab),
        settings: { theme: settings.theme, editor: settings.editor },
      })
      if (result) {
        lastWorkspaceFile = result
        status = `Workspace сохранён: ${result}`
      }
    } catch (error) {
      status = `Не удалось сохранить workspace: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function toggleDirectory(entry: FileEntry): Promise<void> {
    selectedEntryPath = entry.path
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

  function flattenedTreeEntries(): FileEntry[] {
    const result: FileEntry[] = []
    function append(entries: FileEntry[]): void {
      for (const entry of entries) {
        result.push(entry)
        if (entry.kind === 'directory' && expanded.has(entry.path)) append(children[entry.path] ?? [])
      }
    }
    for (const root of folders) append(rootEntries[root] ?? [])
    return result
  }

  function selectTreeEntry(event: MouseEvent, entry: FileEntry): void {
    const paths = flattenedTreeEntries().map((item) => item.path)
    if (event.shiftKey && selectionAnchorPath) {
      const start = paths.indexOf(selectionAnchorPath)
      const end = paths.indexOf(entry.path)
      selectedEntryPaths = start < 0 || end < 0
        ? [entry.path]
        : paths.slice(Math.min(start, end), Math.max(start, end) + 1)
    } else if (event.ctrlKey || event.metaKey) {
      selectedEntryPaths = selectedEntryPaths.includes(entry.path)
        ? selectedEntryPaths.filter((item) => item !== entry.path)
        : [...selectedEntryPaths, entry.path]
      selectionAnchorPath = entry.path
    } else {
      selectedEntryPaths = [entry.path]
      selectionAnchorPath = entry.path
    }
    selectedEntryPath = entry.path
    if (!event.shiftKey && !event.ctrlKey && !event.metaKey) {
      if (entry.kind === 'directory') void toggleDirectory(entry)
      else void openFile(entry.path)
    }
  }

  function clearDropTarget(): void {
    dropDestination = null
    dropTargetPath = null
    if (dragHoverTimer) clearTimeout(dragHoverTimer)
    dragHoverTimer = undefined
  }

  function dragOverEntry(event: DragEvent, entry: FileEntry): void {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? 'copy' : 'move'
    const bounds = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null
    const into = entry.kind === 'directory' && Boolean(bounds && event.clientY > bounds.top + bounds.height * 0.25 && event.clientY < bounds.bottom - bounds.height * 0.25)
    dropTargetPath = entry.path
    dropTargetInto = into
    dropDestination = into ? entry.path : pathParent(entry.path)
    if (dragHoverTimer) clearTimeout(dragHoverTimer)
    if (into && !expanded.has(entry.path)) {
      dragHoverTimer = setTimeout(async () => {
        try {
          children[entry.path] = await invoke<FileEntry[]>('fs:list', { path: entry.path })
          expanded = new Set([...expanded, entry.path])
        } catch (error) {
          status = `Не удалось раскрыть папку: ${error instanceof Error ? error.message : String(error)}`
        }
      }, 600)
    }
  }

  function dragOverRoot(event: DragEvent, root: string): void {
    event.preventDefault()
    event.stopPropagation()
    if (event.dataTransfer) event.dataTransfer.dropEffect = event.ctrlKey || event.metaKey ? 'copy' : 'move'
    dropTargetPath = root
    dropTargetInto = true
    dropDestination = root
  }

  async function dropOnTree(event: DragEvent, destination?: string): Promise<void> {
    event.preventDefault()
    event.stopPropagation()
    const target = destination ?? dropDestination ?? folders[0]
    const paths = [...draggedEntryPaths]
    const copy = event.ctrlKey || event.metaKey
    clearDropTarget()
    draggedEntryPaths = []
    if (!target || !paths.length) return
    try {
      const result = await invoke<Array<{ source: string; target: string }>>('fs:transfer', {
        paths,
        destination: target,
        copy,
      })
      const movedPaths = result.filter((pair) => !pair.source.toLowerCase().endsWith('.annot.json') && !pair.source.toLowerCase().endsWith('.annot.md'))
      selectedEntryPaths = movedPaths.map((pair) => pair.target)
      selectedEntryPath = selectedEntryPaths.at(-1) ?? null
      await refreshWorkspace()
      status = `${copy ? 'Скопировано' : 'Перемещено'} элементов: ${movedPaths.length}`
    } catch (error) {
      status = `Не удалось выполнить перенос: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function refreshWorkspace(): Promise<void> {
    if (!folders.length) return
    const roots = await Promise.all(folders.map(async (root) => {
      try {
        return { root, entries: await invoke<FileEntry[]>('fs:list', { path: root }), error: null }
      } catch (error) {
        return { root, entries: [] as FileEntry[], error: error instanceof Error ? error.message : String(error) }
      }
    }))
    const refreshedChildren: Record<string, FileEntry[]> = {}
    await Promise.all([...expanded].map(async (directory) => {
      try {
        refreshedChildren[directory] = await invoke<FileEntry[]>('fs:list', { path: directory })
      } catch (error) {
        if (!(error instanceof Error) || !/ENOENT|не существует|не найдена/i.test(error.message)) {
          status = `Не удалось обновить папку дерева: ${error instanceof Error ? error.message : String(error)}`
        }
      }
    }))
    rootEntries = Object.fromEntries(roots.map(({ root, entries }) => [root, entries]))
    rootErrors = Object.fromEntries(roots.flatMap(({ root, error }) => error ? [[root, error]] : []))
    children = refreshedChildren
    const availablePaths = new Set([...Object.values(rootEntries).flat(), ...Object.values(children).flat()].map((entry) => entry.path))
    selectedEntryPaths = selectedEntryPaths.filter((item) => availablePaths.has(item))
    if (selectedEntryPath && !availablePaths.has(selectedEntryPath)) selectedEntryPath = selectedEntryPaths.at(-1) ?? null
  }

  async function retryRoot(root: string): Promise<void> {
    try {
      rootEntries = { ...rootEntries, [root]: await invoke<FileEntry[]>('fs:list', { path: root }) }
      const remainingErrors = { ...rootErrors }
      delete remainingErrors[root]
      rootErrors = remainingErrors
    } catch (error) {
      rootErrors = { ...rootErrors, [root]: error instanceof Error ? error.message : String(error) }
    }
  }

  function openTreeMenu(event: MouseEvent, entry?: FileEntry): void {
    event.preventDefault()
    if (entry) {
      if (!selectedEntryPaths.includes(entry.path)) selectedEntryPaths = [entry.path]
      selectedEntryPath = entry.path
      selectionAnchorPath = entry.path
    }
    treeMenu = true
  }

  function toggleTreeMenu(): void {
    treeMenu = !treeMenu
  }

  function beginTreeEdit(action: TreeEdit['action']): void {
    const selected = [...Object.values(rootEntries).flat(), ...Object.values(children).flat()].find((entry) => entry.path === selectedEntryPath)
    const parentPath = action === 'rename'
      ? selected ? pathParent(selected.path) : folders[0]
      : selected?.kind === 'directory' ? selected.path : selected ? pathParent(selected.path) : folders[0]
    if (!parentPath || (action === 'rename' && !selected)) {
      status = 'Сначала выберите элемент дерева.'
      treeMenu = false
      return
    }
    treeEdit = {
      action,
      parentPath,
      sourcePath: action === 'rename' && selected ? selected.path : null,
      name: action === 'rename' && selected ? selected.name : '',
    }
    treeMenu = false
  }

  async function commitTreeEdit(): Promise<void> {
    if (!treeEdit) return
    const edit = treeEdit
    try {
      if (edit.action === 'rename' && edit.sourcePath) {
        const result = await invoke<{ path: string; annotationPath: string | null }>('fs:rename', {
          path: edit.sourcePath,
          name: edit.name,
        })
        selectedEntryPath = result.path
        selectedEntryPaths = [result.path]
      } else {
        const kind = edit.action === 'create-folder' ? 'directory' : 'file'
        selectedEntryPath = await invoke<string>('fs:create', {
          parentPath: edit.parentPath,
          name: edit.name,
          kind,
        })
        selectedEntryPaths = [selectedEntryPath]
        const nextExpanded = new Set(expanded)
        nextExpanded.add(edit.parentPath)
        expanded = nextExpanded
      }
      treeEdit = null
      await refreshWorkspace()
      status = edit.action === 'rename' ? 'Элемент переименован' : 'Элемент создан'
    } catch (error) {
      status = `Не удалось выполнить файловую операцию: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function deleteTreeEntry(): Promise<void> {
    const selected = flattenedTreeEntries().filter((entry) => selectedEntryPaths.includes(entry.path))
    if (!selected.length) {
      status = 'Сначала выберите элемент дерева.'
      treeMenu = false
      return
    }
    treeMenu = false
    if (!window.confirm(`Переместить выбранные элементы (${selected.length}) в корзину?`)) return
    try {
      for (const entry of selected) {
        const includeSidecars = entry.kind === 'file' && entry.annotated
          ? window.confirm(`Также переместить связанные файлы аннотаций для «${entry.name}» в корзину?`)
          : false
        await invoke('fs:delete', { path: entry.path, includeSidecars })
      }
      selectedEntryPath = null
      selectedEntryPaths = []
      await refreshWorkspace()
      status = 'Элемент перемещён в корзину'
    } catch (error) {
      status = `Не удалось удалить элемент: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  function pathParent(filePath: string): string {
    return filePath.slice(0, Math.max(filePath.lastIndexOf('\\'), filePath.lastIndexOf('/')))
  }

  function remapWorkspacePath(candidate: string | null, mappings: Map<string, string>): string | null {
    if (!candidate) return candidate
    for (const [source, target] of [...mappings].sort(([left], [right]) => right.length - left.length)) {
      const normalizedSource = source.replace(/[\\/]+$/, '')
      if (candidate.toLocaleLowerCase() === normalizedSource.toLocaleLowerCase()) return target
      const remainder = candidate.slice(normalizedSource.length)
      if (
        remainder.length > 0 &&
        /^[\\/]/.test(remainder) &&
        candidate.toLocaleLowerCase().startsWith(normalizedSource.toLocaleLowerCase())
      ) {
        return `${target}${remainder}`
      }
    }
    return candidate
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
        setFocusView.of(focusViewOptions(false)),
        focusCompartment.reconfigure([]),
      ],
    })
    filePath = null
    annotationPath = null
    text = ''
    encoding = settings.files.encoding
    eol = settings.files.defaultEol === 'crlf' ? '\r\n' : '\n'
    hasBom = false
    originalText = null
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
      const ipcDocument = document ? toPlainAnnotatedDocument(document) : null
      const savedFile = await invoke<SavedFile | null>('fs:save', {
        path: saveAs ? null : filePath,
        annotationPath: saveAs ? null : annotationPath,
        text,
        encoding,
        eol,
        hasBom,
        document: ipcDocument,
        backupIntervalMin: settings.files.backupIntervalMin,
        saveFormat: settings.files.saveFormat,
      })
      if (!savedFile) return
      filePath = savedFile.path
      annotationPath = savedFile.annotationPath
      if (savedFromPath !== savedFile.path && document) originalText = text
      lastSavedDocument = document ?? undefined
      dirty = revision !== savedRevision
      status = dirty ? 'Документ изменён во время сохранения' : 'Сохранено'
      if (!dirty) {
        lastRecoveryDigest = ''
        await invoke('recovery:delete', { path: savedFromPath })
        if (savedFromPath !== filePath) await invoke('recovery:delete', { path: filePath })
      }
      if (folders.length) await refreshWorkspace()
      captureActiveTab()
    } catch (error) {
      status = `Ошибка сохранения: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      savingTabId = null
    }
  }

  async function applyTextToSource(): Promise<void> {
    if (!filePath || !annotationPath || filePath === annotationPath) return
    if (!window.confirm('Заменить исходный файл текущим текстом? Перед записью будет создана резервная копия .bak.')) return
    try {
      await invoke('fs:applyText', {
        path: filePath,
        text,
        encoding,
        eol,
        hasBom,
      })
      originalText = text
      status = 'Текст применён к исходному файлу; резервная копия создана'
      captureActiveTab()
    } catch (error) {
      status = `Не удалось обновить исходный файл: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function createAnnotation(): Promise<void> {
    if (!editor) return
    const selection = editor.state.selection.main
    const quote = editor.state.doc.sliceString(selection.from, selection.to)
    selectionTrigger = null
    if (selection.empty || !quote.trim()) {
      status = 'Выделите непустой фрагмент текста'
      editor.focus()
      return
    }
    pendingSelection = { from: selection.from, to: selection.to }
    noteDraft = ''
    noteType = settings.annotations.defaultType
    selectedId = null
    status = 'Введите заметку и нажмите «Добавить»'
    await tick()
    noteInput?.focus()
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

  async function handleAnnotationListKeydown(event: KeyboardEvent): Promise<void> {
    if (event.target instanceof HTMLElement) {
      if (event.target.closest('input, textarea, select')) return
      if (event.target.closest('button') && !event.target.closest('.card-main')) return
    }
    const annotation = annotations.find((item) => item.id === selectedId)
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      moveAnnotation(event.key === 'ArrowDown' ? 1 : -1, false)
      await tick()
      const selected = annotationScrollHost?.querySelector<HTMLButtonElement>(`[data-annotation-id="${CSS.escape(selectedId ?? '')}"] .card-main`)
      selected?.focus()
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

  function selectAnnotation(annotation: Annotation, focusEditor = true): void {
    selectedId = annotation.id
    if (!settings.annotationsPanel.linkScroll) return
    const view = editor
    if (!view) return
    if (!annotation.orphan) {
      suppressSelectionTrigger = true
      view.dispatch({ selection: { anchor: annotation.start, head: annotation.end }, scrollIntoView: true })
      if (focusEditor) view.focus()
      suppressSelectionTrigger = false
    }
  }

  function moveAnnotation(direction: number, focusEditor = true): void {
    const ordered = visibleAnnotations.filter((annotation) => !annotation.orphan)
    if (!ordered.length) return
    const index = ordered.findIndex((annotation) => annotation.id === selectedId)
    const nextIndex = index < 0
      ? direction > 0 ? 0 : ordered.length - 1
      : (index + direction + ordered.length) % ordered.length
    const next = ordered[nextIndex]
    selectAnnotation(next, focusEditor)
    if (!focusEditor && next) {
      const rowIndex = visibleLinkedAnnotations.findIndex((annotation) => annotation.id === next.id)
      const rowTop = visibleLinkedAnnotations
        .slice(0, rowIndex)
        .reduce((height, annotation) => height + (annotationHeights[annotation.id] ?? 190), 0)
      annotationScrollHost?.scrollTo({ top: rowTop, behavior: 'auto' })
    }
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
    const inTree = document.activeElement instanceof HTMLElement && Boolean(document.activeElement.closest('[role="tree"]'))
    if (event.key === 'Escape' && treeEdit) {
      treeEdit = null
      return
    }
    if (event.key === 'Escape' && treeMenu) {
      treeMenu = false
      return
    }
    if (handleCommandShortcut(event, typing, inTree)) return
    if (mod && code === 'KeyO') {
      event.preventDefault()
      void openFile()
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
      editorLayoutCompartment.of(editorLayoutExtensions()),
      EditorView.cspNonce.of(document.querySelector<HTMLMetaElement>('meta[name="csp-nonce"]')?.content ?? ''),
      EditorView.updateListener.of((update) => {
        if (suppressEditorUpdate) return
        if (update.selectionSet || update.docChanged) updateCursorPosition(update.state)
        if (update.docChanged) {
          selectionTrigger = null
        } else if (update.selectionSet) {
          const selection = update.state.selection.main
          const selectedText = update.state.doc.sliceString(selection.from, selection.to)
          if (selection.empty || !selectedText.trim() || update.view.composing || focusMode || suppressSelectionTrigger) {
            selectionTrigger = null
          } else {
            const coords = update.view.coordsAtPos(selection.to)
            selectionTrigger = coords
              ? {
                  from: selection.from,
                  to: selection.to,
                  left: Math.max(8, Math.min(window.innerWidth - 150, coords.right)),
                  top: Math.max(8, coords.top - 36),
                }
              : null
          }
        }
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
        '.cm-content': { fontFamily: 'var(--editor-font-family)', fontSize: 'var(--editor-font-size)', fontWeight: 'var(--editor-font-weight)', fontVariantLigatures: 'var(--editor-ligatures)', lineHeight: 'var(--editor-line-height)', maxWidth: 'var(--editor-max-width)', margin: '0 auto', padding: '24px', caretColor: 'var(--editor-fg)' },
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
    void restoreAppState().then(() => checkRecovery())
    window.addEventListener('keydown', handleKeydown)
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey || !(event.target instanceof Node) || !editorHost.contains(event.target)) return
      event.preventDefault()
      adjustEditorFontSize(event.deltaY < 0 ? 1 : -1)
    }
    window.addEventListener('wheel', handleWheel, { passive: false })
    const unsubscribeSystemTheme = window.annotator.onSystemThemeChanged((dark) => {
      systemUsesDarkColors = dark
      if (settings.themeFollowSystem.enabled) applyTheme()
    })
    const unsubscribeOpen = window.annotator.onOpenFile(normalizeSource)
    const unsubscribeWorkspace = window.annotator.onWorkspaceRefresh(() => {
      void refreshWorkspace()
    })
    const unsubscribeEntryRenamed = window.annotator.onEntryRenamed((change) => {
      const renamedPaths = new Map([[change.oldPath, change.newPath], ...change.sidecars.map((sidecar) => [sidecar.oldPath, sidecar.newPath] as [string, string])])
      const remap = (candidate: string | null) => remapWorkspacePath(candidate, renamedPaths)
      tabs = tabs.map((tab) => ({
        ...tab,
        path: remap(tab.path),
        annotationPath: remap(tab.annotationPath),
        externalChangePaths: tab.externalChangePaths.map((changedPath) => remap(changedPath)!),
      }))
      expanded = new Set([...expanded].map((item) => remap(item)!))
      children = Object.fromEntries(Object.entries(children).map(([directory, entries]) => [
        remap(directory)!,
        entries.map((entry) => ({ ...entry, path: remap(entry.path)! })),
      ]))
      filePath = remap(filePath)
      annotationPath = remap(annotationPath)
      if (selectedEntryPath) selectedEntryPath = remap(selectedEntryPath)
      selectedEntryPaths = selectedEntryPaths.map((item) => remap(item)!)
      if (selectionAnchorPath) selectionAnchorPath = remap(selectionAnchorPath)
      captureActiveTab()
    })
    const unsubscribeEntriesTransferred = window.annotator.onEntriesTransferred((change) => {
      if (change.copy) return
      const movedPaths = new Map(change.pairs.map(({ source, target }) => [source, target]))
      const remap = (candidate: string | null) => remapWorkspacePath(candidate, movedPaths)
      tabs = tabs.map((tab) => ({
        ...tab,
        path: remap(tab.path),
        annotationPath: remap(tab.annotationPath),
        externalChangePaths: tab.externalChangePaths.map((item) => remap(item)!),
      }))
      expanded = new Set([...expanded].map((item) => remap(item)!))
      children = Object.fromEntries(Object.entries(children).map(([directory, entries]) => [
        remap(directory)!,
        entries.map((entry) => ({ ...entry, path: remap(entry.path)! })),
      ]))
      filePath = remap(filePath)
      annotationPath = remap(annotationPath)
      if (selectedEntryPath) selectedEntryPath = remap(selectedEntryPath)
      selectedEntryPaths = selectedEntryPaths.map((item) => remap(item)!)
      if (selectionAnchorPath) selectionAnchorPath = remap(selectionAnchorPath)
      captureActiveTab()
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
      window.removeEventListener('wheel', handleWheel)
      unsubscribeSystemTheme()
      unsubscribeOpen()
      unsubscribeWorkspace()
      unsubscribeEntryRenamed()
      unsubscribeEntriesTransferred()
      unsubscribeFileChanged()
      if (dragHoverTimer) clearTimeout(dragHoverTimer)
      clearInterval(recoveryTimer)
      editor?.destroy()
      if (autosaveTimer) clearTimeout(autosaveTimer)
      if (appStateTimer) clearTimeout(appStateTimer)
      if (settingsSaveTimer) clearTimeout(settingsSaveTimer)
      if (pendingShortcutTimer) clearTimeout(pendingShortcutTimer)
    }
  })

  $effect(() => {
    const currentRevision = revision
    const shouldAutosave = settings.files.autosave
      && dirty
      && Boolean(filePath)
      && (annotations.length > 0 || settings.files.autosavePlain)
    if (autosaveTimer) clearTimeout(autosaveTimer)
    if (!shouldAutosave) {
      autosaveStartedAt = 0
      return
    }
    if (!autosaveStartedAt) autosaveStartedAt = Date.now()
    const wait = Math.min(
      settings.files.autosaveDelayMs,
      Math.max(0, settings.files.autosaveMaxWaitMs - (Date.now() - autosaveStartedAt)),
    )
    if (shouldAutosave) {
      autosaveTimer = setTimeout(() => {
        autosaveStartedAt = 0
        if (revision === currentRevision) void save()
      }, wait)
    }
  })

  $effect(() => {
    if (treeEdit) void tick().then(() => treeNameInput?.focus())
  })

  $effect(() => {
    if (!appStateLoaded) return
    const openDocumentTabs = tabs.filter((tab) => tab.path)
    const activeTab = Math.max(0, openDocumentTabs.findIndex((tab) => tab.id === activeTabId))
    const state: AppState = {
      version: 1,
      folders: [...folders],
      openTabs: openDocumentTabs.flatMap((tab) => tab.path ? [tab.path] : []),
      activeTab,
      lastWorkspace: lastWorkspaceFile,
      layout: { explorerWidth, annotationsWidth: annotationWidth, showExplorer, showAnnotations, showOutline },
    }
    if (appStateTimer) clearTimeout(appStateTimer)
    appStateTimer = setTimeout(() => {
      void invoke('state:save', state).catch((error: unknown) => {
        status = `Не удалось сохранить состояние приложения: ${error instanceof Error ? error.message : String(error)}`
      })
    }, 500)
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
      <button onclick={() => void openWorkspace()} title="Открыть файл workspace">Workspace…</button>
      <button onclick={() => void openCommandPalette()} title="Панель команд (Ctrl+Shift+P)">Команды</button>
    </div>
    <div class="toolbar-group editor-actions">
      <button class="accent-button" onclick={createAnnotation} title="Создать аннотацию (Ctrl+Shift+A)">＋ Аннотация</button>
      <button onclick={() => void save()} title="Сохранить (Ctrl+S)">Сохранить</button>
      <button onclick={() => void save(true)} title="Сохранить как (Ctrl+Shift+S)">Сохранить как…</button>
    </div>
    <div class="toolbar-spacer"></div>
    <button class:active={focusMode} onclick={() => setFocusMode(!focusMode)} title="Режим фокуса (F9)">Фокус</button>
    <button aria-label="Настройки приложения" onclick={() => { void loadSettings(); showSettings = true }} title="Настройки приложения">⚙</button>
  </header>

  <div class="workspace">
    {#if showExplorer && !focusMode}
      <aside class="explorer pane" style:width="{explorerWidth}px" style:flex-basis="{explorerWidth}px" use:measurePaneWidth={'explorer'}>
        <div class="pane-heading"><span>ПРОВОДНИК</span><div class="explorer-actions"><button class="icon-button" aria-expanded={treeMenu} onclick={toggleTreeMenu} title="Операции с файлами">⋯</button><button class="icon-button" onclick={() => void openFolder(true)} title="Добавить папку">＋</button></div></div>
        {#if treeMenu && folders.length}
          <div class="tree-context-menu" role="menu" aria-label="Операции с файлами">
            <button role="menuitem" onclick={() => { treeMenu = false; void saveWorkspace() }}>Сохранить workspace как…</button>
            <button role="menuitem" onclick={() => beginTreeEdit('create-file')}>Новый текстовый файл</button>
            <button role="menuitem" onclick={() => beginTreeEdit('create-folder')}>Новая папка</button>
            {#if selectedEntryPath}
              <button role="menuitem" onclick={() => beginTreeEdit('rename')}>Переименовать… <span>F2</span></button>
              <button role="menuitem" onclick={() => void deleteTreeEntry()}>Переместить в корзину <span>Delete</span></button>
              <button role="menuitem" onclick={() => { treeMenu = false; void invoke('shell:copyPath', { path: selectedEntryPath }).then(() => status = 'Путь скопирован').catch((error: unknown) => status = `Не удалось скопировать путь: ${error instanceof Error ? error.message : String(error)}`) }}>Копировать путь</button>
              <button role="menuitem" onclick={() => { treeMenu = false; void invoke('shell:showItemInFolder', { path: selectedEntryPath }).catch((error: unknown) => status = `Не удалось открыть расположение: ${error instanceof Error ? error.message : String(error)}`) }}>Показать в Проводнике</button>
            {/if}
          </div>
        {/if}
        {#if folders.length}
          <div class:tree-root-drop={dropDestination === folders[0] && dropTargetPath === null} class="file-tree" role="tree" aria-label="Файлы рабочей папки" tabindex="0" oncontextmenu={(event) => { if (event.target === event.currentTarget) openTreeMenu(event) }} ondragover={(event) => { if (draggedEntryPaths.length) { event.preventDefault(); dropDestination = folders[0]; dropTargetPath = null } }} ondragleave={(event) => { if (event.target === event.currentTarget) clearDropTarget() }} ondrop={(event) => void dropOnTree(event, folders[0])}>
            {#each folders as root (root)}
              <div class:drop-root={dropTargetPath === root} class="root-label" title={root} role="treeitem" aria-selected="false" tabindex="0" ondragover={(event) => dragOverRoot(event, root)} ondragleave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) clearDropTarget() }} ondrop={(event) => void dropOnTree(event, root)}>{rootErrors[root] ? '⚠' : '▾'} {folderNames[root] ?? root.split(/[\\/]/).at(-1)}</div>
              {#if rootErrors[root]}
                <div class="root-error"><span>{rootErrors[root]}</span><button onclick={() => void retryRoot(root)}>Повторить</button></div>
              {:else}
                {#each rootEntries[root] ?? [] as entry (entry.path)}
                  {@render TreeEntry(entry, 0, expanded, children, toggleDirectory, openFile)}
                {/each}
              {/if}
            {/each}
          </div>
        {:else}
          <div class="file-tree empty-tree"><div class="empty-hint"><span class="empty-icon">⌂</span><p>Откройте папку с документами,<br />чтобы видеть файлы здесь.</p><button onclick={() => void openFolder()}>Открыть папку</button></div></div>
        {/if}

        {#if showSettings}
          <div class="modal-backdrop">
            <dialog open class="settings-dialog" aria-modal="true" aria-labelledby="settings-title" use:modalDialog>
              <div class="settings-title-row">
                <h2 id="settings-title">Настройки Annotator</h2>
                <button aria-label="Закрыть настройки" onclick={() => { showSettings = false; void loadSettings() }}>×</button>
              </div>
              <div class="settings-scroll">
                <nav class="settings-nav" aria-label="Разделы настроек">
                  <button onclick={() => document.getElementById('settings-appearance')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>Внешний вид</button>
                  <button onclick={() => document.getElementById('settings-typography')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>Шрифты</button>
                  <button onclick={() => document.getElementById('settings-editor')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>Отображение</button>
                  <button onclick={() => document.getElementById('settings-annotations')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>Аннотации</button>
                  <button onclick={() => document.getElementById('settings-colors')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>Цвета</button>
                  <button onclick={() => document.getElementById('settings-files')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>Файлы</button>
                  <button onclick={() => document.getElementById('settings-shortcuts')?.scrollIntoView({ block: 'start', behavior: 'smooth' })}>Сочетания клавиш</button>
                </nav>
                <section id="settings-appearance" class="settings-section">
                  <h3>Цветовая тема</h3>
                  <label class="settings-field">
                    <span>Тема</span>
                    <select bind:value={settings.theme} onchange={applyTheme}>
                      {#each Object.keys(themes) as themeId}<option value={themeId}>{themeId}</option>{/each}
                      {#each availableUserThemes as theme (theme.id)}<option value={theme.id}>{theme.name} (пользовательская)</option>{/each}
                    </select>
                  </label>
                  <label class="settings-check"><input type="checkbox" bind:checked={settings.themeFollowSystem.enabled} onchange={applyTheme} /> Следовать системной светлой/тёмной теме</label>
                  {#if settings.themeFollowSystem.enabled}
                    <label class="settings-field"><span>Светлая тема</span><select bind:value={settings.themeFollowSystem.light} onchange={applyTheme}>{#each Object.keys(themes) as themeId}{#if resolveTheme(themeId).kind === 'light'}<option value={themeId}>{themeId}</option>{/if}{/each}{#each availableUserThemes as theme (theme.id)}{#if theme.type === 'light'}<option value={theme.id}>{theme.name}</option>{/if}{/each}</select></label>
                    <label class="settings-field"><span>Тёмная тема</span><select bind:value={settings.themeFollowSystem.dark} onchange={applyTheme}>{#each Object.keys(themes) as themeId}{#if resolveTheme(themeId).kind === 'dark'}<option value={themeId}>{themeId}</option>{/if}{/each}{#each availableUserThemes as theme (theme.id)}{#if theme.type === 'dark'}<option value={theme.id}>{theme.name}</option>{/if}{/each}</select></label>
                    <p class="settings-hint">Сейчас система использует {systemUsesDarkColors ? 'тёмную' : 'светлую'} схему.</p>
                  {/if}
                  <div class="settings-actions settings-import">
                    <label class="button-like">Импортировать тему JSON<input class="visually-hidden" type="file" accept=".json,application/json" onchange={(event) => void importTheme(event)} /></label>
                    {#each availableUserThemes as theme (theme.id)}<button title={`Удалить тему ${theme.name}`} onclick={() => void deleteUserTheme(theme)}>Удалить «{theme.name}»</button>{/each}
                  </div>
                  {#each themeErrors as error (error.file)}<p class="settings-error">{error.file}: {error.message}</p>{/each}
                </section>
                <section id="settings-typography" class="settings-section">
                  <h3>Шрифты и масштаб</h3>
                  <label class="settings-field">
                    <span>Шрифт интерфейса</span>
                    <input list="available-fonts" bind:value={settings.ui.fontFamily} oninput={applyTheme} />
                  </label>
                  <label class="settings-field">
                    <span>Размер интерфейса: {settings.ui.fontSize}px</span>
                    <input type="range" min="8" max="24" step="1" bind:value={settings.ui.fontSize} oninput={applyTheme} />
                  </label>
                  <label class="settings-field">
                    <span>Шрифт редактора</span>
                    <input list="available-fonts" bind:value={settings.editor.fontFamily} oninput={applyTheme} />
                  </label>
                  <label class="settings-field">
                    <span>Размер текста: {settings.editor.fontSize}px</span>
                    <input type="range" min="8" max="48" step="1" bind:value={settings.editor.fontSize} oninput={applyTheme} />
                  </label>
                  <label class="settings-field">
                    <span>Шрифт аннотаций</span>
                    <input list="available-fonts" bind:value={settings.annotationsPanel.fontFamily} oninput={applyTheme} />
                  </label>
                  <label class="settings-field">
                    <span>Размер аннотаций: {settings.annotationsPanel.fontSize}px</span>
                    <input type="range" min="8" max="32" step="1" bind:value={settings.annotationsPanel.fontSize} oninput={applyTheme} />
                  </label>
                  <button onclick={async () => {
                    try {
                      const fontApi = window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> }
                      const fonts = fontApi.queryLocalFonts ? await fontApi.queryLocalFonts() : []
                      fontSuggestions = [...new Set([...builtinFonts, ...fonts.map((font) => font.family)])].sort((a, b) => a.localeCompare(b, 'ru'))
                      status = fonts.length ? `Найдено системных шрифтов: ${fonts.length}` : 'Список системных шрифтов недоступен; доступен встроенный список и ручной ввод'
                    } catch (error) {
                      fontSuggestions = builtinFonts
                      status = `Не удалось прочитать системные шрифты: ${error instanceof Error ? error.message : String(error)}`
                    }
                  }}>Загрузить список системных шрифтов</button>
                  <datalist id="available-fonts">{#each fontSuggestions as font}<option value={font}></option>{/each}</datalist>
                  <label class="settings-check"><input type="checkbox" bind:checked={settings.editor.ligatures} /> Лигатуры</label>
                  <label class="settings-field"><span>Высота строки: {settings.editor.lineHeight}</span><input type="range" min="1" max="3" step="0.1" bind:value={settings.editor.lineHeight} oninput={applyTheme} /></label>
                  <p class="font-preview" style:font-family={settings.editor.fontFamily} style:font-size="{settings.editor.fontSize}px">
                    Русский текст, English, 123 — «Кавычки», ёж и фрагмент.
                  </p>
                  <p class="settings-hint">Ctrl+колесо меняет размер текста, Ctrl+0 сбрасывает его. Семейство шрифта можно ввести вручную.</p>
                </section>
                <section id="settings-editor" class="settings-section">
                  <h3>Отображение</h3>
                  <label class="settings-field"><span>Масштаб интерфейса: {Math.round(settings.ui.zoom * 100)}%</span><input type="range" min="0.75" max="1.5" step="0.05" bind:value={settings.ui.zoom} oninput={applyTheme} /></label>
                  <label class="settings-field"><span>Контекст режима фокуса (символы)</span><input type="number" min="0" max="500" bind:value={settings.focusView.contextChars} onchange={() => setFocusMode(focusMode)} /></label>
                  <label class="settings-field"><span>Разделитель Focus view</span><select bind:value={settings.focusView.separator} onchange={() => setFocusMode(focusMode)}><option value="blank1">Одна пустая строка</option><option value="blank2">Две пустые строки</option><option value="ellipsis">Многоточие</option></select></label>
                  <label class="settings-check"><input type="checkbox" bind:checked={settings.editor.lineNumbers} onchange={applyTheme} /> Номера строк</label>
                  <label class="settings-check"><input type="checkbox" bind:checked={settings.editor.readOnly} onchange={applyTheme} /> Редактор только для чтения</label>
                  <label class="settings-check"><input type="checkbox" bind:checked={settings.editor.wrap} onchange={applyTheme} /> Переносить длинные строки</label>
                  <label class="settings-field"><span>Толщина шрифта редактора</span><select bind:value={settings.editor.fontWeight} onchange={applyTheme}>{#each [300, 400, 500, 600, 700] as weight}<option value={weight}>{weight}</option>{/each}</select></label>
                  <label class="settings-field"><span>Максимальная ширина строки (ch)</span><input type="number" min="40" max="240" bind:value={settings.editor.maxLineWidthCh} oninput={applyTheme} /></label>
                </section>
                <section id="settings-annotations" class="settings-section">
                  <h3>Аннотации и отображение</h3>
                  <label class="settings-check"><input type="checkbox" bind:checked={settings.annotationsPanel.showQuote} /> Показывать цитату в карточке</label>
                  <label class="settings-check"><input type="checkbox" bind:checked={settings.annotationsPanel.linkScroll} /> Связывать прокрутку текста и аннотаций</label>
                  <label class="settings-field"><span>Тип новой аннотации</span><select bind:value={settings.annotations.defaultType}>{#each annotationTypes as type}<option value={type.id}>{type.label}</option>{/each}</select></label>
                  <label class="settings-field"><span>Интенсивность подсветки</span><input type="range" min="0.05" max="0.6" step="0.01" bind:value={settings.annotations.highlightAlpha} oninput={applyTheme} /></label>
                  <label class="settings-check"><input type="checkbox" bind:checked={settings.annotations.colorByType} onchange={applyTheme} /> Различать цвета аннотаций по типу</label>
                  <h3>Цвета типов аннотаций</h3>
                  <label class="settings-field"><span>Единый цвет подсветки</span><input type="color" disabled={settings.annotations.colorByType} value={settings.annotations.highlightColor ?? themeColor('annot.default')} oninput={(event) => { settings.annotations.highlightColor = event.currentTarget.value; applyTheme() }} /></label>
                  {#each annotationTypes as type (type.id)}
                    <label class="color-setting">
                      <span>Цвет: {type.label}</span>
                      <input type="color" disabled={!settings.annotations.colorByType} value={settings.annotations.types.find((item) => item.id === type.id)?.color ?? themeColor(`annot.${type.id}`)} aria-label={`Цвет типа ${type.label}`} oninput={(event) => setAnnotationTypeColor(type.id, event.currentTarget.value)} />
                      <button disabled={!settings.annotations.types.find((item) => item.id === type.id)?.color} onclick={() => setAnnotationTypeColor(type.id, null)}>Сбросить</button>
                    </label>
                  {/each}
                </section>
                <section id="settings-colors" class="settings-section">
                  <h3>Переопределение цветов</h3>
                  {#each ['ui.bg', 'ui.fg', 'ui.fgMuted', 'ui.accent', 'ui.border', 'editor.bg', 'editor.fg', 'editor.selection', 'annot.default', 'annot.comment', 'annot.note', 'annot.question', 'annot.idea', 'annot.todo', 'annot.important'] as colorKey (colorKey)}
                    <label class="color-setting">
                      <span>{colorKey}</span>
                      <input type="color" value={settings.colorOverrides[colorKey] ?? themeColor(colorKey)} aria-label={`Цвет ${colorKey}`} oninput={(event) => setThemeColor(colorKey, event.currentTarget.value)} />
                      <button onclick={() => {
                        const overrides = { ...settings.colorOverrides }
                        delete overrides[colorKey]
                        settings.colorOverrides = overrides
                        applyTheme()
                      }}>Сбросить</button>
                    </label>
                  {/each}
                </section>
                <section id="settings-files" class="settings-section">
                  <h3>Файлы и сглаживание</h3>
                  <label class="settings-field"><span>Автосохранение аннотаций</span><input type="checkbox" bind:checked={settings.files.autosave} /></label>
                  <label class="settings-field"><span>Задержка автосохранения (мс)</span><input type="number" min="250" max="10000" step="250" bind:value={settings.files.autosaveDelayMs} /></label>
                  <label class="settings-field"><span>Максимум до автосохранения (мс)</span><input type="number" min="1000" max="120000" step="1000" bind:value={settings.files.autosaveMaxWaitMs} /></label>
                  <label class="settings-check"><input type="checkbox" bind:checked={settings.files.autosavePlain} /> Автосохранение обычных текстовых файлов</label>
                  <label class="settings-field"><span>Интервал резервирования (мин)</span><input type="number" min="1" max="1440" bind:value={settings.files.backupIntervalMin} /></label>
                  <label class="settings-field"><span>Формат новых sidecar</span><select bind:value={settings.files.saveFormat}><option value="json">JSON</option><option value="md">Markdown</option></select></label>
                  <label class="settings-field"><span>Кодировка новых документов</span><select bind:value={settings.files.encoding}>{#each supportedEncodings as supportedEncoding}<option value={supportedEncoding}>{supportedEncoding.toUpperCase()}</option>{/each}</select></label>
                  <label class="settings-field"><span>Перевод строки новых документов</span><select bind:value={settings.files.defaultEol}><option value="lf">LF</option><option value="crlf">CRLF</option></select></label>
                  <label class="settings-field"><span>Сглаживание текста</span><select bind:value={settings.rendering.smoothing}><option value="system">Системное (по умолчанию)</option><option value="grayscale">Оттенки серого</option></select></label>
                  <p class="settings-hint">Изменение сглаживания требует перезапуска.</p>
                  <div class="settings-actions">
                    <button onclick={() => void invoke('settings:openFile').catch((error: unknown) => status = `Не удалось открыть settings.json: ${error instanceof Error ? error.message : String(error)}`)}>Открыть settings.json</button>
                    <button onclick={() => void invoke('app:relaunch').catch((error: unknown) => status = `Не удалось перезапустить: ${error instanceof Error ? error.message : String(error)}`)}>Перезапустить</button>
                  </div>
                </section>
                <section id="settings-shortcuts" class="settings-section">
                  <h3>Команды и сочетания клавиш</h3>
                  {#each shortcutConflicts() as conflict}<p class="settings-error">Конфликт сочетания: {conflict}</p>{/each}
                  {#each commandDefinitions as command (command.id)}
                    <label class="shortcut-setting">
                      <span title={command.id}>{command.label}</span>
                      <input
                        aria-label={`Сочетание: ${command.label}`}
                        value={settings.keybindings[command.id] ?? ''}
                        placeholder={command.shortcut ?? 'нет'}
                        oninput={(event) => settings.keybindings = { ...settings.keybindings, [command.id]: event.currentTarget.value || null }}
                      />
                      <button aria-label={`Сбросить сочетание: ${command.label}`} onclick={() => {
                        const bindings = { ...settings.keybindings }
                        delete bindings[command.id]
                        settings.keybindings = bindings
                      }}>Сбросить</button>
                    </label>
                  {/each}
                </section>
              </div>
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
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="pane-resizer" role="separator" aria-orientation="vertical" aria-label="Ширина проводника" aria-valuemin="190" aria-valuemax="380" aria-valuenow={explorerRenderedWidth} tabindex="0" use:resizablePane={'explorer'}></div>
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
        <button class="icon-button" class:active={showExplorer} aria-label="Показать или скрыть проводник" aria-pressed={showExplorer} title="Проводник (Ctrl+B)" onclick={() => showExplorer = !showExplorer}>◧</button>
        <button class="icon-button" class:active={showAnnotations} aria-label="Показать или скрыть аннотации" aria-pressed={showAnnotations} title="Аннотации (Ctrl+Shift+B)" onclick={() => showAnnotations = !showAnnotations}>▤</button>
      </div>
      <div class="editor-surface">
        <div class="editor-host" bind:this={editorHost}></div>
        {#if tabs.length === 0}
          <section class="welcome-screen" aria-labelledby="welcome-title">
            <div class="welcome-content">
              <span class="welcome-mark" aria-hidden="true">A</span>
              <h1 id="welcome-title">Начните работу с текстом</h1>
              <p>Откройте документ или папку, чтобы читать текст и добавлять к нему аннотации.</p>
              <div class="welcome-actions">
                <button class="accent-button" onclick={() => void openFile()}>Открыть документ</button>
                <button onclick={() => void openFolder()}>Открыть папку</button>
                <button onclick={newFile}>Создать документ</button>
              </div>
              <p class="welcome-shortcut">Открыть документ <kbd>Ctrl+O</kbd><span aria-hidden="true"> · </span>Новый документ <kbd>Ctrl+N</kbd></p>
            </div>
          </section>
        {/if}
      </div>
      <footer class="statusbar">
        <span>{dirty ? '● Не сохранено' : '✓ Сохранено'}</span>
        {#if annotationPath && filePath !== annotationPath && originalText !== null && originalText !== text}
          <button class="source-diff" onclick={() => void applyTextToSource()} title="Создать резервную копию .bak и применить текст к исходному файлу">
            Текст отличается от исходника · Применить
          </button>
        {/if}
        <button class="status-action" disabled={!filePath} title="Переоткрыть с другой кодировкой" onclick={() => void reopenWithEncoding()}>{encoding.toUpperCase()}</button>
        <span>{eol === '\r\n' ? 'CRLF' : eol === '\r' ? 'CR' : 'LF'}</span>
        <span>Стр. {cursorPosition.line}, стлб. {cursorPosition.column}</span>
        <span>{annotations.length} {annotationPluralRules.select(annotations.length) === 'one' ? 'аннотация' : annotationPluralRules.select(annotations.length) === 'few' ? 'аннотации' : 'аннотаций'}</span>
        <span class="status-message" role="status" aria-live="polite">{status}</span>
      </footer>
    </main>

    {#if showAnnotations && !focusMode}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="pane-resizer" role="separator" aria-orientation="vertical" aria-label="Ширина панели аннотаций" aria-valuemin="270" aria-valuemax="460" aria-valuenow={annotationsRenderedWidth} tabindex="0" use:resizablePane={'annotations'}></div>
      <aside class="annotations pane" style:width="{annotationWidth}px" style:flex-basis="{annotationWidth}px" use:measurePaneWidth={'annotations'}>
        <div class="pane-heading"><span>АННОТАЦИИ</span><span class="count-badge">{annotations.length}</span></div>
        <input class="search-input" bind:value={query} oninput={() => { annotationScrollTop = 0; if (annotationScrollHost) annotationScrollHost.scrollTop = 0 }} placeholder="Поиск по заметкам и тегам" aria-label="Поиск по аннотациям" />
        <div class="annotation-filters">
          <select bind:value={filterType} onchange={() => { annotationScrollTop = 0; if (annotationScrollHost) annotationScrollHost.scrollTop = 0 }} aria-label="Фильтр по типу аннотации">
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
            <textarea bind:this={noteInput} bind:value={noteDraft} rows="4" placeholder="Текст заметки в Markdown…" onkeydown={(event) => {
              if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Enter') {
                event.preventDefault()
                confirmAnnotation()
              }
            }}></textarea>
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
              <div
                class="orphan-list"
                role="list"
                aria-label="Аннотации без привязки"
                bind:this={orphanScrollHost}
                bind:clientHeight={orphanViewportHeight}
                onscroll={() => orphanScrollTop = orphanScrollHost?.scrollTop ?? 0}
              >
              {#if orphanWindow.top > 0}<div class="virtual-spacer" aria-hidden="true" style:height="{orphanWindow.top}px"></div>{/if}
              {#each virtualOrphanAnnotations as annotation, index (annotation.id)}
                <article use:measureAnnotation={annotation.id} role="listitem" aria-posinset={orphanWindow.start + index + 1} aria-setsize={visibleOrphanAnnotations.length} class:chosen={selectedId === annotation.id} class="orphan-card">
                  {#if settings.annotationsPanel.showQuote}<div class="annotation-quote">“{annotation.quote.slice(0, 120)}”</div>{/if}
                  <div class="annotation-rendered">{@html renderMarkdown(annotation.text || '*Пустая заметка*')}</div>
                  <div class="orphan-actions">
                    <button disabled={!editor || editor.state.selection.main.empty} title="Привязать к текущему выделению" onclick={() => rebindOrphan(annotation.id)}>Привязать к выделению</button>
                    <button title="Найти цитату в документе" onclick={() => findOrphanAgain(annotation)}>Найти заново</button>
                    <button class="delete-button" title="Удалить аннотацию" onclick={() => removeAnnotation(annotation.id)}>×</button>
                  </div>
                </article>
              {/each}
              {#if orphanWindow.bottom > 0}<div class="virtual-spacer" aria-hidden="true" style:height="{orphanWindow.bottom}px"></div>{/if}
              </div>
            {/if}
          </section>
        {/if}
        <div
          class="annotation-list"
          role="toolbar"
          aria-orientation="vertical"
          aria-label="Список аннотаций"
          tabindex="0"
          bind:this={annotationScrollHost}
          bind:clientHeight={annotationViewportHeight}
          onscroll={() => annotationScrollTop = annotationScrollHost?.scrollTop ?? 0}
          onkeydown={handleAnnotationListKeydown}
        >
          {#if visibleLinkedAnnotations.length === 0}
            <div class="empty-hint annotation-empty"><span class="empty-icon">✳</span><p>{annotations.length ? 'Совпадений не найдено.' : 'Выделите фрагмент текста и нажмите «＋ Аннотация», чтобы добавить заметку.'}</p></div>
          {/if}
          {#if linkedWindow.top > 0}<div class="virtual-spacer" aria-hidden="true" style:height="{linkedWindow.top}px"></div>{/if}
          {#each virtualLinkedAnnotations as annotation (annotation.id)}
            <article use:measureAnnotation={annotation.id} data-annotation-id={annotation.id} role="group" aria-label={`${annotation.type}: ${annotation.quote.slice(0, 80)}`} class:chosen={selectedId === annotation.id} class:orphan={annotation.orphan} class="annotation-card annot-card-{annotation.type}">
              <div class="card-heading">
                <span class="type-dot"></span>
                <select aria-label="Тип аннотации" value={annotation.type} onclick={(event) => event.stopPropagation()} onchange={(event) => updateAnnotation(annotation.id, { type: event.currentTarget.value }, true)}>
                  {#each annotationTypes as type}<option value={type.id}>{type.label}</option>{/each}
                </select>
                <button class="resolve-button" class:resolved={annotation.resolved} title={annotation.resolved ? 'Снова открыть' : 'Отметить решённой'} onclick={(event) => { event.stopPropagation(); updateAnnotation(annotation.id, { resolved: !annotation.resolved }, true) }}>{annotation.resolved ? '✓' : '○'}</button>
                <button class="delete-button" title="Удалить аннотацию" onclick={(event) => { event.stopPropagation(); removeAnnotation(annotation.id) }}>×</button>
              </div>
              <button class="card-main" aria-pressed={selectedId === annotation.id} onclick={() => selectAnnotation(annotation)} ondblclick={() => editNoteId = annotation.id}>
                {#if settings.annotationsPanel.showQuote}<div class="annotation-quote">{annotation.orphan ? 'Без привязки' : `“${annotation.quote.slice(0, 120)}”`}</div>{/if}
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
          {#if linkedWindow.bottom > 0}<div class="virtual-spacer" aria-hidden="true" style:height="{linkedWindow.bottom}px"></div>{/if}
        </div>
      </aside>
    {/if}
    {#if selectionTrigger && selectionTrigger.from !== selectionTrigger.to && pendingSelection.from === pendingSelection.to && !focusMode}
      <button
        class="selection-trigger"
        style:left="{selectionTrigger.left}px"
        style:top="{selectionTrigger.top}px"
        onmousedown={(event) => event.preventDefault()}
        onclick={() => void createAnnotation()}
      >＋ Аннотация</button>
    {/if}
  </div>
</div>

{#if commandPaletteOpen}
  <div class="modal-backdrop command-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) commandPaletteOpen = false }}>
    <dialog open class="command-palette" aria-label="Панель команд" aria-modal="true" use:modalDialog>
      <input
        bind:this={commandPaletteInput}
        bind:value={commandPaletteQuery}
        aria-label="Поиск команд"
        placeholder="Введите название команды…"
        onkeydown={(event) => {
          if (event.key === 'Enter' && visibleCommands[0]) {
            event.preventDefault()
            void executeCommand(visibleCommands[0].id)
          }
        }}
      />
      <div class="command-results" role="listbox">
        {#each visibleCommands as command (command.id)}
          <button role="option" aria-selected="false" onclick={() => void executeCommand(command.id)}>
            <span>{command.label}<small>{command.id}</small></span>
            <kbd>{bindingFor(command) ?? '—'}</kbd>
          </button>
        {:else}
          <p class="settings-hint">Команды не найдены.</p>
        {/each}
      </div>
    </dialog>
  </div>
{/if}

{#if themePickerOpen}
  <div class="modal-backdrop">
    <dialog open class="command-palette" aria-label="Выбор темы" aria-modal="true" use:modalDialog>
      <h2>Сменить тему</h2>
      <div class="command-results" role="listbox">
        {#each [...Object.keys(themes), ...availableUserThemes.map((theme) => theme.id)] as themeId (themeId)}
          {@const userTheme = availableUserThemes.find((theme) => theme.id === themeId)}
          <button role="option" aria-selected={settings.theme === themeId} onclick={() => {
            settings.theme = themeId
            themePickerOpen = false
            applyTheme()
            void saveSettings(false)
          }}>
            <span>{userTheme?.name ?? themeId}</span>
            <kbd>{settings.theme === themeId ? 'Выбрана' : userTheme ? 'Пользовательская' : 'Встроенная'}</kbd>
          </button>
        {/each}
      </div>
      <button onclick={() => themePickerOpen = false}>Закрыть</button>
    </dialog>
  </div>
{/if}

{#if treeEdit}
<div class="modal-backdrop">
  <dialog open class="close-dialog tree-edit-dialog" aria-modal="true" aria-labelledby="tree-edit-title" use:modalDialog>
    <h2 id="tree-edit-title">{treeEdit.action === 'rename' ? 'Переименовать' : treeEdit.action === 'create-folder' ? 'Создать папку' : 'Создать текстовый файл'}</h2>
    <form onsubmit={(event) => { event.preventDefault(); void commitTreeEdit() }}>
      <label class="tree-edit-field">
        <span>Имя</span>
        <input bind:this={treeNameInput} bind:value={treeEdit.name} maxlength="259" required aria-label="Имя файла или папки" />
      </label>
      <div class="close-dialog-actions">
        <button type="button" onclick={() => treeEdit = null}>Отмена</button>
        <button class="accent-button" type="submit">{treeEdit.action === 'rename' ? 'Переименовать' : 'Создать'}</button>
      </div>
    </form>
  </dialog>
</div>
{/if}

{#if closeTabId}
  {@const closingTab = tabs.find((tab) => tab.id === closeTabId)}
  <div class="modal-backdrop">
    <dialog open class="close-dialog" aria-modal="true" aria-labelledby="close-dialog-title" use:modalDialog>
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
  <div
    class:tree-selected={selectedEntryPaths.includes(entry.path) || selectedEntryPath === entry.path}
    class:drop-into={dropTargetPath === entry.path && dropTargetInto}
    class:drop-edge={dropTargetPath === entry.path && !dropTargetInto}
    class={`tree-row depth-${Math.min(depth, 6)}`}
    role="treeitem"
    aria-selected={selectedEntryPaths.includes(entry.path) || selectedEntryPath === entry.path}
    aria-expanded={entry.kind === 'directory' ? expanded.has(entry.path) : undefined}
    tabindex="0"
    draggable="true"
    onclick={(event) => selectTreeEntry(event, entry)}
    oncontextmenu={(event) => openTreeMenu(event, entry)}
    onkeydown={(event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        selectedEntryPath = entry.path
        selectedEntryPaths = [entry.path]
        entry.kind === 'directory' ? toggleDirectory(entry) : openFile(entry.path)
      }
    }}
    ondragstart={(event) => {
      if (!selectedEntryPaths.includes(entry.path)) {
        selectedEntryPaths = [entry.path]
        selectedEntryPath = entry.path
      }
      draggedEntryPaths = [...selectedEntryPaths]
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = 'copyMove'
        event.dataTransfer.setData('text/plain', draggedEntryPaths.join('\n'))
      }
    }}
    ondragover={(event) => { if (draggedEntryPaths.length) dragOverEntry(event, entry) }}
    ondragleave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) clearDropTarget() }}
    ondrop={(event) => void dropOnTree(event)}
    ondragend={() => { draggedEntryPaths = []; clearDropTarget() }}
  >
    <span class="tree-chevron">{entry.kind === 'directory' ? expanded.has(entry.path) ? '▾' : '▸' : ''}</span>
    <span class="tree-icon">{entry.kind === 'directory' ? expanded.has(entry.path) ? '▾' : '▸' : entry.name.toLowerCase().endsWith('.md') ? '¶' : '≡'}</span>
    <span class="tree-name">{entry.name.replace(/\.annot\.(json|md)$/i, '')}</span>
    {#if entry.annotationConflict}<span class="tree-conflict" title="Найдены оба формата sidecar-аннотаций">⚠</span>
    {:else if entry.annotated}<span class="tree-annotated" title="Есть аннотации">✳</span>{/if}
  </div>
  {#if entry.kind === 'directory' && expanded.has(entry.path)}
    {#each children[entry.path] ?? [] as child (child.path)}
      {@render TreeEntry(child, depth + 1, expanded, children, toggleDirectory, openFile)}
    {/each}
  {/if}
{/snippet}
