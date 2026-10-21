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
  import { createLineStarts, createOutlineRows, lineNumberAt } from './editor/outline'
  import { parseTags } from './editor/annotation-tags'
  import { createAnnotatedDocument, parseAnnotatedDocument, restoreAnnotations, toPlainAnnotatedDocument } from './format/json-format'
  import { parseExternalDocument } from './format/import-format'
  import { exportFormats, serializeExchange, type ExchangeFormat } from '../shared/interchange'
  import { getAnnotationMarkerColor, parseShortcut, resolveTheme, settingsSchema, themes, type AppSettings, type ThemePalette, type UserTheme } from '../shared/settings'
  import Icon from './Icon.svelte'
  import FontPicker from './FontPicker.svelte'

  type SettingsSection = 'appearance' | 'typography' | 'editor' | 'annotations' | 'colors' | 'files' | 'shortcuts'
  type ConfirmChoice = 'confirm' | 'cancel' | 'tertiary'
  interface ConfirmRequest {
    title: string
    message: string
    confirmLabel: string
    cancelLabel?: string
    tertiaryLabel?: string
    danger?: boolean
    resolve: (choice: ConfirmChoice) => void
  }
  interface ThemeOption {
    id: string
    name: string
    kind: 'dark' | 'light'
    colors: Record<string, string>
    user: boolean
  }

  const exampleDemoText = `Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива по-своему.\n\nВ доме Облонских все смешалось. Жена узнала, что муж был в связи с бывшею в их доме француженкою-гувернанткой, и объявила мужу, что не может жить с ним в одном доме.\n\nПоложение это продолжалось уже третий день и мучительно чувствовалось и самими супругами, и всеми членами семьи, и домочадцами.\n\nВыделите любой фрагмент текста, чтобы создать аннотацию. Этот демо-текст можно использовать для знакомства с редактором.`

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
      explorerWidth = state.layout.explorerWidth
      annotationWidth = state.layout.annotationsWidth
      showExplorer = state.layout.showExplorer
      showAnnotations = state.layout.showAnnotations
      showOutline = state.layout.showOutline
      outlinePaneHeight = state.layout.outlineHeight
      if (folders.length) await refreshFileTree()
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
  let savingTabId = $state<string | null>(null)
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
  let commandPaletteIndex = $state(0)
  let commandPaletteInput = $state<HTMLInputElement>()
  let commandPaletteResults = $state<HTMLDivElement>()
  let themePickerOpen = $state(false)
  let settingsSection = $state<SettingsSection>('appearance')
  let confirmRequest = $state<ConfirmRequest | null>(null)
  let pendingShortcut = ''
  let pendingShortcutTimer: ReturnType<typeof setTimeout> | undefined
  let settingsSaveTimer: ReturnType<typeof setTimeout> | undefined
  let dirty = $state(false)
  let welcomeDismissed = $state(false)
  let status = $state('Готово')
  let cursorPosition = $state({ line: 1, column: 1 })
  let noteDraft = $state('')
  let noteType = $state('comment')
  let query = $state('')
  let filterType = $state('all')
  let filterStatus = $state('all')
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
  let outlinePaneHeight = $state(230)
  let outlineResize: { startY: number; startHeight: number; maxHeight: number } | null = null
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
  let showExportPicker = $state(false)
  let showPasteDialog = $state(false)
  let pasteDraft = $state('')
  let pasteInput = $state<HTMLTextAreaElement>()
  let selectedExportFormat = $state<ExchangeFormat>('markdown')
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

  function resizeOutline(event: PointerEvent): void {
    if (!outlineResize) return
    const delta = outlineResize.startY - event.clientY
    outlinePaneHeight = Math.max(130, Math.min(outlineResize.maxHeight, outlineResize.startHeight + delta))
  }

  function resizableOutline(node: HTMLElement) {
    const pointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return
      const paneHeight = node.parentElement?.clientHeight ?? 600
      outlineResize = {
        startY: event.clientY,
        startHeight: outlinePaneHeight,
        maxHeight: Math.max(130, paneHeight - 190),
      }
      node.setPointerCapture(event.pointerId)
      event.preventDefault()
    }
    const pointerMove = (event: PointerEvent) => resizeOutline(event)
    const finish = () => { outlineResize = null }
    const keyDown = (event: KeyboardEvent) => {
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
      event.preventDefault()
      const maxHeight = Math.max(130, (node.parentElement?.clientHeight ?? 600) - 190)
      const delta = event.key === 'ArrowUp' ? 16 : -16
      outlinePaneHeight = Math.max(130, Math.min(maxHeight, outlinePaneHeight + delta))
    }
    node.addEventListener('pointerdown', pointerDown)
    node.addEventListener('pointermove', pointerMove)
    node.addEventListener('pointerup', finish)
    node.addEventListener('pointercancel', finish)
    node.addEventListener('keydown', keyDown)
    return {
      destroy() {
        node.removeEventListener('pointerdown', pointerDown)
        node.removeEventListener('pointermove', pointerMove)
        node.removeEventListener('pointerup', finish)
        node.removeEventListener('pointercancel', finish)
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
    { id: 'highlight', label: 'Подсветка' },
    { id: 'question', label: 'Вопрос' },
    { id: 'idea', label: 'Идея' },
    { id: 'todo', label: 'Задача' },
    { id: 'important', label: 'Важно' },
    { id: 'critic_add', label: 'CriticMarkup: добавление' },
    { id: 'critic_del', label: 'CriticMarkup: удаление' },
    { id: 'critic_sub', label: 'CriticMarkup: замена' },
    { id: 'critic_comment', label: 'CriticMarkup: комментарий' },
    { id: 'critic_highlight', label: 'CriticMarkup: подсветка' },
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
    { id: 'file.import', label: 'Импортировать аннотированный файл', shortcut: null },
    { id: 'file.export', label: 'Экспортировать документ', shortcut: null },
    { id: 'file.demo', label: 'Открыть демо-текст', shortcut: null },
    { id: 'file.paste', label: 'Создать документ из вставленного текста', shortcut: null },
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
  const shortcutGroups = [
    { title: 'Аннотации', ids: ['annotation.create', 'annotation.confirm', 'annotation.next', 'annotation.prev', 'editor.find'] },
    { title: 'Файлы и вкладки', ids: ['file.new', 'file.save', 'file.saveAs', 'tab.close', 'tab.next', 'tab.prev', 'workspace.openFolder'] },
    { title: 'Вид и панели', ids: ['view.focusMode', 'layout.explorer', 'layout.annotations', 'focus.explorer', 'focus.editor', 'focus.annotations', 'zoom.in', 'zoom.out', 'zoom.reset', 'theme.pick'] },
    { title: 'Навигация и команды', ids: ['palette.open', 'settings.open', 'ui.cancel'] },
    { title: 'Проводник', ids: ['explorer.rename', 'explorer.delete', 'edit.undo'] },
  ]
  const colorLabels: Record<string, string> = {
    'ui.bg': 'Фон панелей',
    'ui.fg': 'Текст интерфейса',
    'ui.fgMuted': 'Приглушённый текст',
    'ui.accent': 'Акцент',
    'ui.border': 'Границы и разделители',
    'editor.bg': 'Фон редактора',
    'editor.fg': 'Текст редактора',
    'editor.selection': 'Выделение',
    'annot.default': 'Аннотация по умолчанию',
    'annot.comment': 'Комментарий',
    'annot.note': 'Заметка',
    'annot.question': 'Вопрос',
    'annot.idea': 'Идея',
    'annot.todo': 'Задача',
    'annot.important': 'Важно',
    'annot.highlight': 'Подсветка',
    'annot.critic_add': 'CriticMarkup: добавление',
    'annot.critic_del': 'CriticMarkup: удаление',
    'annot.critic_sub': 'CriticMarkup: замена',
    'annot.critic_comment': 'CriticMarkup: комментарий',
    'annot.critic_highlight': 'CriticMarkup: подсветка',
  }
  const visibleCommands = $derived(commandDefinitions.filter((command) =>
    `${command.label} ${command.id}`.toLocaleLowerCase('ru').includes(commandPaletteQuery.toLocaleLowerCase('ru'))))
  const activeCommand = $derived(visibleCommands[commandPaletteIndex])
  const lineStarts = $derived(createLineStarts(text))
  const outlineRows = $derived(createOutlineRows(annotations, lineStarts))
  const outlineRowHeight = 44
  const fileName = $derived(filePath?.split(/[\\/]/).at(-1) ?? 'Новый документ')
  const annotationFormat = $derived(
    annotationPath?.toLocaleLowerCase('ru').endsWith('.md') ? 'Markdown'
      : annotationPath?.toLocaleLowerCase('ru').endsWith('.json') ? 'JSON'
        : settings.files.saveFormat === 'md' ? 'Markdown' : 'JSON',
  )
  const showWelcome = $derived(!welcomeDismissed && !focusMode && !filePath && !text && !dirty && !annotations.length)
  const annotationDateFormat = new Intl.DateTimeFormat('ru', { day: 'numeric', month: 'short' })
  const annotationDateFullFormat = new Intl.DateTimeFormat('ru', { dateStyle: 'medium', timeStyle: 'short' })
  const themeLabels: Record<string, string> = {
    dracula: 'Dracula',
    'github-light': 'GitHub Light',
    'github-dark': 'GitHub Dark',
    nord: 'Nord',
    'solarized-dark': 'Solarized Dark',
    'solarized-light': 'Solarized Light',
    monokai: 'Monokai',
    cobalt2: 'Cobalt 2',
    'one-dark': 'One Dark',
    'gruvbox-dark': 'Gruvbox Dark',
    'tokyo-night': 'Tokyo Night',
    'paper-light': 'Paper Light',
  }
  const themeSwatchKeys = ['editor.bg', 'ui.bg', 'ui.accent', 'annot.comment', 'annot.important']

  function safeResolveTheme(themeId: string): ThemePalette {
    try {
      return resolveTheme(themeId, {}, availableUserThemes)
    } catch {
      return resolveTheme('dracula')
    }
  }

  const themeOptions = $derived.by((): ThemeOption[] => {
    const options: ThemeOption[] = Object.keys(themes).map((id) => {
      const palette = safeResolveTheme(id)
      return { id, name: themeLabels[id] ?? id, kind: palette.kind, colors: palette.colors, user: false }
    })
    for (const theme of availableUserThemes) {
      const palette = safeResolveTheme(theme.id)
      const option: ThemeOption = { id: theme.id, name: theme.name, kind: palette.kind, colors: palette.colors, user: true }
      const existing = options.findIndex((item) => item.id === theme.id)
      if (existing >= 0) options[existing] = option
      else options.push(option)
    }
    return options
  })
  const lightThemeOptions = $derived(themeOptions.filter((option) => option.kind === 'light'))
  const darkThemeOptions = $derived(themeOptions.filter((option) => option.kind === 'dark'))
  const settingsSections = [
    { id: 'appearance', label: 'Оформление', icon: 'palette', title: 'Оформление', description: 'Тема, цвета интерфейса и внешний вид рабочего пространства.' },
    { id: 'typography', label: 'Шрифты', icon: 'type', title: 'Шрифты и масштаб', description: 'Типографика текста, заметок и элементов интерфейса.' },
    { id: 'editor', label: 'Редактор', icon: 'layout', title: 'Редактор', description: 'Полотно текста, перенос строк и режим фокуса.' },
    { id: 'annotations', label: 'Аннотации', icon: 'message-plus', title: 'Аннотации', description: 'Поведение панели заметок и подсветка фрагментов.' },
    { id: 'colors', label: 'Цвета', icon: 'droplet', title: 'Переопределение цветов', description: 'Точная настройка палитры поверх выбранной темы.' },
    { id: 'files', label: 'Файлы', icon: 'folder', title: 'Файлы и автосохранение', description: 'Форматы, кодировки, резервные копии и сглаживание.' },
    { id: 'shortcuts', label: 'Клавиши', icon: 'keyboard', title: 'Сочетания клавиш', description: 'Команды приложения и переназначение горячих клавиш.' },
  ] as const
  const activeSettingsSection = $derived(settingsSections.find((section) => section.id === settingsSection) ?? settingsSections[0]!)

  function annotationCountLabel(count: number): string {
    const form = annotationPluralRules.select(count)
    return `${count} ${form === 'one' ? 'аннотация' : form === 'few' ? 'аннотации' : 'аннотаций'}`
  }

  function formatAnnotationDate(value: string): string {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : annotationDateFormat.format(date)
  }

  function formatAnnotationDateFull(value: string): string {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? '' : annotationDateFullFormat.format(date)
  }

  function askConfirm(options: Omit<ConfirmRequest, 'resolve'>): Promise<ConfirmChoice> {
    return new Promise((resolve) => {
      confirmRequest = { ...options, resolve }
    })
  }

  function answerConfirm(choice: ConfirmChoice): void {
    const request = confirmRequest
    confirmRequest = null
    request?.resolve(choice)
  }

  function selectTheme(themeId: string): void {
    settings.theme = themeId
    applyTheme()
    if (themePickerOpen) {
      themePickerOpen = false
      void saveSettings(false)
    }
  }

  function openSettings(section: SettingsSection = 'appearance'): void {
    settingsSection = section
    void loadSettings()
    showSettings = true
  }

  function closeSettings(): void {
    showSettings = false
    void loadSettings()
  }
  const outlineStart = $derived(Math.max(0, Math.floor(outlineScrollTop / outlineRowHeight) - 4))
  const outlineEnd = $derived(Math.min(outlineRows.length, Math.ceil((outlineScrollTop + outlineHeight) / outlineRowHeight) + 4))
  const visibleOutlineRows = $derived(outlineRows.slice(outlineStart, outlineEnd))

  const visibleAnnotations = $derived(
    [...annotations]
      .filter((annotation) => filterType === 'all' || annotation.type === filterType)
      .filter((annotation) => filterStatus === 'all' || (annotation.status ?? (annotation.resolved ? 'resolved' : 'open')) === filterStatus)
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
    commandPaletteIndex = 0
    await tick()
    commandPaletteInput?.focus()
  }

  function setCommandPaletteQuery(value: string): void {
    commandPaletteQuery = value
    commandPaletteIndex = 0
  }

  async function moveCommandPaletteSelection(delta: number): Promise<void> {
    if (!visibleCommands.length) return
    commandPaletteIndex = Math.max(0, Math.min(visibleCommands.length - 1, commandPaletteIndex + delta))
    await tick()
    commandPaletteResults?.querySelector<HTMLElement>(`[data-command-index="${commandPaletteIndex}"]`)?.scrollIntoView({ block: 'nearest' })
  }

  async function executeCommand(id: string): Promise<void> {
    const paletteWasOpen = commandPaletteOpen
    commandPaletteOpen = false
    switch (id) {
      case 'annotation.create': await createAnnotation(); break
      case 'annotation.confirm': confirmAnnotation(); break
      case 'ui.cancel':
        if (paletteWasOpen) break
        if (confirmRequest) answerConfirm('cancel')
        else if (closeTabId) closeTabId = null
        else if (treeEdit) treeEdit = null
        else if (treeMenu) treeMenu = false
        else if (themePickerOpen) themePickerOpen = false
        else if (showSettings) closeSettings()
        else if (focusMode) setFocusMode(false)
        else if (pendingSelection.from !== pendingSelection.to) {
          pendingSelection = { from: 0, to: 0 }
          noteDraft = ''
          status = 'Готово'
        }
        break
      case 'annotation.next': moveAnnotation(1); break
      case 'annotation.prev': moveAnnotation(-1); break
      case 'view.focusMode': setFocusMode(!focusMode); break
      case 'file.save': await save(); break
      case 'file.saveAs': await save(true); break
      case 'file.import': await importInterchange(); break
      case 'file.export': showExportPicker = true; break
      case 'file.demo': await openDemoDocument(); break
      case 'file.paste': showPasteDialog = true; pasteDraft = ''; await tick(); pasteInput?.focus(); break
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
      case 'settings.open': openSettings(); break
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
          await refreshFileTree()
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

  function hasOpenModal(): boolean {
    return commandPaletteOpen || showSettings || themePickerOpen || Boolean(closeTabId) || Boolean(treeMenu) || Boolean(treeEdit) || Boolean(confirmRequest)
  }

  function handleCommandShortcut(event: KeyboardEvent, typing: boolean, inTree: boolean): boolean {
    if (event.target instanceof HTMLElement && event.target.closest('.shortcut-setting')) return false
    const stroke = eventStroke(event)
    if (hasOpenModal()) {
      if (stroke !== 'Escape') return false
      if (pendingShortcut) {
        if (pendingShortcutTimer) clearTimeout(pendingShortcutTimer)
        pendingShortcut = ''
        return true
      }
    }
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
      if (command.id === 'ui.cancel' && !commandPaletteOpen && !themePickerOpen && !showSettings && !closeTabId && !treeMenu && !treeEdit && !confirmRequest && !focusMode && pendingSelection.from === pendingSelection.to) continue
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
    const reload = await askConfirm({
      title: 'Файл изменён вне приложения',
      message: `Файл «${sourceName}» изменён другой программой. Перезагрузить документ? Несохранённые изменения будут потеряны.`,
      confirmLabel: 'Перезагрузить',
      cancelLabel: 'Оставить текущую',
      danger: true,
    })
    if (reload !== 'confirm') {
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
      switchToDocument(result)
    } catch (error) {
      status = `Не удалось открыть файл: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function reopenWithEncoding(): Promise<void> {
    if (!filePath) return
    if (dirty) {
      const proceed = await askConfirm({
        title: 'Переоткрыть документ?',
        message: 'Файл будет прочитан заново с выбранной кодировкой. Несохранённые изменения будут отброшены.',
        confirmLabel: 'Переоткрыть',
        danger: true,
      })
      if (proceed !== 'confirm') return
    }
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
      await refreshFileTree()
      status = `${copy ? 'Скопировано' : 'Перемещено'} элементов: ${movedPaths.length}`
    } catch (error) {
      status = `Не удалось выполнить перенос: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function refreshFileTree(): Promise<void> {
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
      await refreshFileTree()
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
    const proceed = await askConfirm({
      title: selected.length === 1 ? 'Переместить в корзину?' : 'Переместить элементы в корзину?',
      message: `${selected.length === 1 ? `Элемент «${selected[0]!.name}»` : `Выбранные элементы (${selected.length})`} можно будет восстановить из корзины Windows.`,
      confirmLabel: 'Переместить в корзину',
      danger: true,
    })
    if (proceed !== 'confirm') return
    try {
      for (const entry of selected) {
        const includeSidecars = entry.kind === 'file' && entry.annotated
          ? (await askConfirm({
              title: 'Связанные аннотации',
              message: `Переместить в корзину файлы аннотаций для «${entry.name}» вместе с исходником?`,
              confirmLabel: 'Переместить вместе',
              cancelLabel: 'Оставить аннотации',
            })) === 'confirm'
          : false
        await invoke('fs:delete', { path: entry.path, includeSidecars })
      }
      selectedEntryPath = null
      selectedEntryPaths = []
      await refreshFileTree()
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
    welcomeDismissed = true
    captureActiveTab()
    const reuseBlankTab = tabs.some((tab) => tab.id === activeTabId && !tab.path && !tab.dirty && !tab.text && !tab.annotations.length)
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
    const tab = createCurrentTab(reuseBlankTab ? activeTabId : undefined)
    tabs = reuseBlankTab ? tabs.map((item) => item.id === tab.id ? tab : item) : [...tabs, tab]
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

  async function exportCurrentDocument(format: ExchangeFormat): Promise<void> {
    try {
      const document = await createAnnotatedDocument(text, annotations, filePath?.split(/[\\/]/).at(-1) ?? null, lastSavedDocument, eol === '\r\n' ? 'crlf' : eol === '\r' ? 'cr' : 'lf')
      const content = await serializeExchange(document, format)
      const result = await invoke<string | null>('dialog:saveExport', { format, content })
      if (result) status = `Экспорт сохранён: ${result.split(/[\\/]/).at(-1)}`
      showExportPicker = false
    } catch (error) {
      status = `Не удалось экспортировать документ: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function importInterchange(): Promise<void> {
    try {
      const selected = await invoke<{ name: string; path: string; content: string | Uint8Array } | null>('dialog:importInterchange')
      if (!selected) return
      const document = await parseExternalDocument(selected.name, typeof selected.content === 'string' ? selected.content : new TextDecoder().decode(selected.content), typeof selected.content === 'string' ? undefined : selected.content)
      const restored = restoreAnnotations(document)
      captureActiveTab()
      activeTabId = `import:${crypto.randomUUID()}`
      filePath = null
      annotationPath = null
      text = document.text
      originalText = document.text
      encoding = 'utf-8'
      eol = '\n'
      hasBom = false
      annotations = restored.annotations
      selectedId = null
      dirty = true
      lastSavedDocument = document
      revision += 1
      focusMode = false
      suppressEditorUpdate = true
      editor?.dispatch({
        changes: { from: 0, to: editor.state.doc.length, insert: text },
        effects: [setAnnotationRanges.of(annotations), setFocusView.of(focusViewOptions(false)), focusCompartment.reconfigure([])],
      })
      suppressEditorUpdate = false
      tabs = [...tabs, createCurrentTab(activeTabId)]
      const warnings = restored.orphaned ? `; ${restored.orphaned} без привязки` : restored.shifted ? `; сдвинуто ${restored.shifted}` : ''
      status = `Импортирован новый документ «${selected.name}»${warnings}`
    } catch (error) {
      status = `Не удалось импортировать файл: ${error instanceof Error ? error.message : String(error)}`
    }
  }

  async function openDemoDocument(): Promise<void> {
    if (dirty) {
      const proceed = await askConfirm({
        title: 'Открыть демо-текст?',
        message: 'Текущий документ останется открытым в своей вкладке. Будет создана новая вкладка с примером.',
        confirmLabel: 'Открыть пример',
      })
      if (proceed !== 'confirm') return
    }
    captureActiveTab()
    filePath = null
    annotationPath = null
    text = exampleDemoText
    originalText = exampleDemoText
    annotations = []
    selectedId = null
    dirty = false
    lastSavedDocument = undefined
    revision += 1
    activeTabId = `demo:${crypto.randomUUID()}`
    suppressEditorUpdate = true
    editor?.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, effects: [setAnnotationRanges.of([])] })
    suppressEditorUpdate = false
    tabs = [...tabs, createCurrentTab(activeTabId)]
    status = 'Демо-текст открыт в новой вкладке'
  }

  async function createDocumentFromPaste(): Promise<void> {
    if (!pasteDraft.trim()) return
    await newFile()
    if (!activeTabId) return
    text = pasteDraft
    originalText = null
    dirty = true
    revision += 1
    suppressEditorUpdate = true
    editor?.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: text }, effects: [setAnnotationRanges.of([])] })
    suppressEditorUpdate = false
    tabs = tabs.map((tab) => tab.id === activeTabId ? createCurrentTab(activeTabId) : tab)
    status = 'Создан новый документ из вставленного текста'
    showPasteDialog = false
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
      if (folders.length) await refreshFileTree()
      captureActiveTab()
    } catch (error) {
      status = `Ошибка сохранения: ${error instanceof Error ? error.message : String(error)}`
    } finally {
      savingTabId = null
    }
  }

  async function applyTextToSource(): Promise<void> {
    if (!filePath || !annotationPath || filePath === annotationPath) return
    const proceed = await askConfirm({
      title: 'Применить текст к исходнику?',
      message: 'Исходный файл будет заменён текущим текстом аннотированного документа. Перед записью рядом будет создана резервная копия .bak.',
      confirmLabel: 'Применить',
    })
    if (proceed !== 'confirm') return
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
    const normalizedChanges = changes.resolved === undefined || changes.status !== undefined
      ? changes
      : { ...changes, status: changes.resolved ? 'resolved' as const : 'open' as const }
    annotations = annotations.map((annotation) => annotation.id === id
      ? { ...annotation, ...normalizedChanges, modified: new Date().toISOString() }
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
    if (document.querySelector('select:open')) return
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
    if (!hasOpenModal() && mod && code === 'KeyO') {
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
      const choice = await askConfirm({
        title: 'Восстановить изменения?',
        message: `Найдены несохранённые изменения${snapshot.path ? ` в файле «${snapshot.path.split(/[\\/]/).at(-1)}»` : ''}. Восстановить их или отбросить?`,
        confirmLabel: 'Восстановить',
        cancelLabel: 'Отбросить',
        tertiaryLabel: 'Позже',
      })
      if (choice === 'cancel') {
        await invoke('recovery:delete', { path: snapshot.path })
        return
      }
      if (choice !== 'confirm') return
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
        '.cm-content': { fontFamily: 'var(--editor-font-family)', fontSize: 'var(--editor-font-size)', fontWeight: 'var(--editor-font-weight)', fontVariantLigatures: 'var(--editor-ligatures)', lineHeight: 'var(--editor-line-height)', maxWidth: 'var(--editor-max-width)', margin: '0 auto', padding: '40px 32px 120px', caretColor: 'var(--editor-fg)' },
        '.cm-gutters': { backgroundColor: 'var(--editor-bg)', color: 'var(--gutter-fg)', border: 'none' },
        '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--editor-fg) 4%, transparent)' },
        '.cm-activeLineGutter': { backgroundColor: 'transparent' },
        '.cm-selectionBackground': { backgroundColor: 'var(--selection) !important' },
        '.cm-focus-gap': { display: 'inline-block', userSelect: 'none' },
        '.cm-focus-gap-blank1': { display: 'block', height: 'calc(var(--editor-line-height, 1.6) * 1em)' },
        '.cm-focus-gap-blank2': { display: 'block', height: 'calc(var(--editor-line-height, 1.6) * 2em)' },
        '.cm-focus-gap-ellipsis': { minWidth: '2em', height: 'auto', color: 'var(--fg-muted)', textAlign: 'center' },
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
    const unsubscribeTree = window.annotator.onTreeRefresh(() => {
      void refreshFileTree()
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
      unsubscribeTree()
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
    const id = editNoteId
    if (!id) return
    void tick().then(() => {
      const input = annotationScrollHost?.querySelector<HTMLTextAreaElement>(`[data-annotation-id="${CSS.escape(id)}"] .annotation-body`)
      if (!input) return
      input.focus()
      input.setSelectionRange(input.value.length, input.value.length)
    })
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
      layout: { explorerWidth, annotationsWidth: annotationWidth, showExplorer, showAnnotations, showOutline, outlineHeight: outlinePaneHeight },
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
  <header class="app-bar">
    <div class="brand" aria-label="Annotator">
      <span class="brand-mark" aria-hidden="true">
        <svg viewBox="0 0 20 20" fill="none">
          <path d="M4.5 5.5h7M4.5 10h11M4.5 14.5h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
          <circle cx="15.5" cy="5.5" r="1.5" fill="currentColor" />
        </svg>
      </span>
      <span class="brand-name">Annotator</span>
    </div>

    <div class="bar-group" role="group" aria-label="Документ">
      <button class="bar-button" onclick={() => void newFile()} title="Новый документ (Ctrl+N)" aria-label="Новый документ">
        <Icon name="file-plus" size={17} /><span class="bar-label">Новый</span>
      </button>
      <button class="bar-button" onclick={() => void openFile()} title="Открыть файл (Ctrl+O)" aria-label="Открыть файл">
        <Icon name="file-text" size={17} /><span class="bar-label">Открыть</span>
      </button>
      <button class="bar-button" onclick={() => void openFolder()} title="Открыть рабочую папку" aria-label="Открыть рабочую папку">
        <Icon name="folder-open" size={17} /><span class="bar-label">Папка</span>
      </button>
      <button class="bar-button" onclick={() => void importInterchange()} title="Импортировать файл с аннотациями" aria-label="Импортировать файл с аннотациями">
        <Icon name="file-text" size={17} /><span class="bar-label">Импорт</span>
      </button>
    </div>

    <span class="bar-divider" aria-hidden="true"></span>

    <button class="bar-button" onclick={() => void openCommandPalette()} title="Панель команд (Ctrl+Shift+P)" aria-label="Панель команд">
      <Icon name="command" size={17} /><span class="bar-label">Команды</span>
    </button>

    <span class="bar-spacer"></span>

    <button class="primary-action" onclick={() => void createAnnotation()} title="Создать аннотацию из выделения (Ctrl+Shift+A)" aria-label="Создать аннотацию из выделения">
      <Icon name="message-plus" size={17} /><span class="action-label">Аннотация</span>
    </button>
    <button class="bar-button" onclick={() => showExportPicker = true} title="Экспортировать документ" aria-label="Экспортировать документ">
      <Icon name="save-as" size={17} /><span class="bar-label">Экспорт</span>
    </button>

    <div class="bar-group bar-end" role="group" aria-label="Сохранение и вид">
      <button class="icon-button" onclick={() => void save()} title="Сохранить (Ctrl+S)" aria-label="Сохранить">
        <Icon name="save" size={17} />
      </button>
      <button class="icon-button" onclick={() => void save(true)} title="Сохранить как… (Ctrl+Shift+S)" aria-label="Сохранить как">
        <Icon name="save-as" size={17} />
      </button>
      <button class="icon-button" class:active={focusMode} aria-pressed={focusMode} onclick={() => setFocusMode(!focusMode)} title="Режим фокуса (F9)" aria-label="Режим фокуса">
        <Icon name="focus" size={17} />
      </button>
      <button class="icon-button" onclick={() => openSettings()} title="Настройки (Ctrl+,)" aria-label="Настройки">
        <Icon name="settings" size={17} />
      </button>
    </div>
  </header>

  {#if focusMode}
    <div class="focus-hud">
      <span class="focus-hud-mark" aria-hidden="true"><Icon name="book-open" size={16} /></span>
      <span class="focus-hud-copy">
        <span class="focus-hud-title">Режим фокуса</span>
        <span class="focus-hud-subtitle">{fileName}<span class="focus-hud-count">{annotationCountLabel(annotations.length)}</span></span>
      </span>
      <button class="hud-exit" onclick={() => setFocusMode(false)} title="Выйти из режима фокуса (F9)">
        <span>Выйти</span><kbd>F9</kbd>
      </button>
    </div>
  {/if}

  <div class="workspace">
    {#if showExplorer && !focusMode}
      <aside class="explorer pane" style:width="{explorerWidth}px" style:flex-basis="{explorerWidth}px" use:measurePaneWidth={'explorer'} aria-label="Проводник">
        <div class="pane-header">
          <div class="pane-title"><Icon name="folder" size={15} /><span>Проводник</span></div>
          <div class="pane-actions">
            <button class="icon-button compact" onclick={() => void openFolder(true)} title="Добавить папку" aria-label="Добавить папку">
              <Icon name="folder-plus" size={15} />
            </button>
            <button class="icon-button compact" aria-expanded={treeMenu} onclick={toggleTreeMenu} title="Операции с файлами" aria-label="Операции с файлами">
              <Icon name="dots" size={16} />
            </button>
          </div>
        </div>

        {#if treeMenu && folders.length}
          <div class="tree-context-menu menu-surface" role="menu" aria-label="Операции с файлами">
            <button role="menuitem" onclick={() => beginTreeEdit('create-file')}>
              <Icon name="file-plus" size={14} /><span>Новый текстовый файл</span>
            </button>
            <button role="menuitem" onclick={() => beginTreeEdit('create-folder')}>
              <Icon name="folder-plus" size={14} /><span>Новая папка</span>
            </button>
            {#if selectedEntryPath}
              <span class="menu-separator" role="separator"></span>
              <button role="menuitem" onclick={() => beginTreeEdit('rename')}>
                <Icon name="pencil" size={14} /><span>Переименовать</span><kbd>F2</kbd>
              </button>
              <button role="menuitem" onclick={() => void deleteTreeEntry()}>
                <Icon name="trash" size={14} /><span>Переместить в корзину</span><kbd>Del</kbd>
              </button>
              <button role="menuitem" onclick={() => { treeMenu = false; void invoke('shell:copyPath', { path: selectedEntryPath }).then(() => status = 'Путь скопирован').catch((error: unknown) => status = `Не удалось скопировать путь: ${error instanceof Error ? error.message : String(error)}`) }}>
                <Icon name="layers" size={14} /><span>Копировать путь</span>
              </button>
              <button role="menuitem" onclick={() => { treeMenu = false; void invoke('shell:showItemInFolder', { path: selectedEntryPath }).catch((error: unknown) => status = `Не удалось открыть расположение: ${error instanceof Error ? error.message : String(error)}`) }}>
                <Icon name="folder-open" size={14} /><span>Показать в Проводнике</span>
              </button>
            {/if}
          </div>
        {/if}

        {#if folders.length}
          <div
            class:tree-root-drop={dropDestination === folders[0] && dropTargetPath === null}
            class="file-tree"
            role="tree"
            aria-label="Файлы рабочей папки"
            tabindex="0"
            oncontextmenu={(event) => { if (event.target === event.currentTarget) openTreeMenu(event) }}
            ondragover={(event) => { if (draggedEntryPaths.length) { event.preventDefault(); dropDestination = folders[0]; dropTargetPath = null } }}
            ondragleave={(event) => { if (event.target === event.currentTarget) clearDropTarget() }}
            ondrop={(event) => void dropOnTree(event, folders[0])}
          >
            {#each folders as root (root)}
              <div
                class:drop-root={dropTargetPath === root}
                class="root-label"
                title={root}
                role="treeitem"
                aria-selected="false"
                tabindex="0"
                ondragover={(event) => dragOverRoot(event, root)}
                ondragleave={(event) => { if (!(event.relatedTarget instanceof Node) || !event.currentTarget.contains(event.relatedTarget)) clearDropTarget() }}
                ondrop={(event) => void dropOnTree(event, root)}
              >
                <Icon name={rootErrors[root] ? 'alert' : 'folder-open'} size={15} />
                <span class="root-name">{folderNames[root] ?? root.split(/[\\/]/).at(-1)}</span>
              </div>
              {#if rootErrors[root]}
                <div class="root-error" role="alert">
                  <span>{rootErrors[root]}</span>
                  <button class="mini-button" onclick={() => void retryRoot(root)}>Повторить</button>
                </div>
              {:else}
                {#each rootEntries[root] ?? [] as entry (entry.path)}
                  {@render TreeEntry(entry, 0, expanded, children, toggleDirectory, openFile)}
                {/each}
              {/if}
            {/each}
          </div>
          <div class="explorer-footer">
            <button class="mini-button" onclick={() => void openFile()} title="Открыть отдельный файл">
              <Icon name="file-plus" size={14} /><span>Открыть файл</span>
            </button>
          </div>
        {:else}
          <div class="explorer-empty">
            <span class="empty-visual" aria-hidden="true">
              <span class="empty-page"></span>
              <span class="empty-note"></span>
            </span>
            <p class="empty-title">Документы под рукой</p>
            <p class="empty-copy">Откройте папку — файлы появятся здесь с отметками аннотированных глав.</p>
            <button class="accent-button" onclick={() => void openFolder()}>Открыть папку</button>
          </div>
        {/if}

        {#if showOutline}
          <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
          <div
            class="outline-resizer"
            role="separator"
            aria-orientation="horizontal"
            aria-label="Высота панели структуры"
            aria-valuemin="130"
            aria-valuemax={Math.max(130, (outlineListHost?.closest('.explorer')?.clientHeight ?? 600) - 190)}
            aria-valuenow={outlinePaneHeight}
            aria-valuetext={`${outlinePaneHeight} пикселей`}
            tabindex="0"
            use:resizableOutline
          ></div>
        {/if}
        <section class:collapsed={!showOutline} class="outline-pane" style:flex-basis="{outlinePaneHeight}px" aria-label="Структура аннотаций">
          <div class="outline-heading">
            <button class="outline-toggle" aria-expanded={showOutline} title={showOutline ? 'Свернуть навигатор' : 'Развернуть навигатор'} onclick={() => showOutline = !showOutline}>
              <Icon name={showOutline ? 'chevron-down' : 'chevron-right'} size={14} />
              <span>Структура</span>
            </button>
            <span class="count-badge">{outlineRows.length}</span>
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
                <div class="outline-empty">
                  <Icon name="book-open" size={18} />
                  <span>Здесь появятся заметки на полях</span>
                </div>
              {:else}
                <div class="outline-spacer" style:height="{outlineStart * outlineRowHeight}px"></div>
              {/if}
              {#each visibleOutlineRows as row (row.id)}
                <button
                  class:chosen={selectedId === row.id}
                  class="outline-row annot-card-{row.type}"
                  role="option"
                  aria-selected={selectedId === row.id}
                  onclick={() => {
                    const annotation = annotations.find((item) => item.id === row.id)
                    if (annotation) selectAnnotation(annotation)
                  }}
                >
                  <span class="outline-type-dot type-dot annot-dot-{row.type}"></span>
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
              <span class="tab-icon" aria-hidden="true"><Icon name="file-text" size={14} /></span>
              <span class="tab-label">{tab.path?.split(/[\\/]/).at(-1) ?? 'Новый документ'}</span>
              {#if tab.annotations.length}<span class="tab-annotated" title="Есть аннотации"></span>{/if}
              {#if tab.dirty}<span class="dirty-dot" title="Не сохранено"></span>{/if}
              <button class="tab-close" title="Закрыть вкладку (Ctrl+W)" aria-label="Закрыть {tab.path?.split(/[\\/]/).at(-1) ?? 'Новый документ'}" onclick={(event) => { event.stopPropagation(); requestCloseTab(tab.id) }}>
                <Icon name="x" size={12} />
              </button>
            </div>
          {/each}
        </div>
        <button class="tab-add" onclick={() => void newFile()} title="Новый документ (Ctrl+N)" aria-label="Новый документ">
          <Icon name="plus" size={15} />
        </button>
        <span class="tab-spacer"></span>
        <div class="layout-actions" role="group" aria-label="Панели">
          <button class="icon-button compact" class:active={showExplorer} aria-label="Показать или скрыть проводник" aria-pressed={showExplorer} title="Проводник (Ctrl+B)" onclick={() => showExplorer = !showExplorer}>
            <Icon name="panel-left" size={16} />
          </button>
          <button class="icon-button compact" class:active={showAnnotations} aria-label="Показать или скрыть аннотации" aria-pressed={showAnnotations} title="Аннотации (Ctrl+Shift+B)" onclick={() => showAnnotations = !showAnnotations}>
            <Icon name="panel-right" size={16} />
          </button>
        </div>
      </div>

      <div class="editor-surface">
        <div class="editor-host" bind:this={editorHost}></div>
        {#if showWelcome}
          <section class="welcome-screen" aria-labelledby="welcome-title">
            <div class="welcome-inner">
              <div class="welcome-copy">
                <h1 id="welcome-title">Читайте внимательно.<br />Записывайте рядом.</h1>
                <p>Annotator держит текст и мысли на полях в одном спокойном пространстве. Откройте документ или папку, чтобы начать.</p>
                <div class="welcome-actions">
                  <button class="accent-button" onclick={() => void openFile()}>
                    <Icon name="file-text" size={15} /><span>Открыть документ</span>
                  </button>
                  <button class="button" onclick={() => void openFolder()}>
                    <Icon name="folder" size={15} /><span>Открыть папку</span>
                  </button>
                  <button class="ghost-button" onclick={() => void newFile()}>Создать документ</button>
                </div>
                <div class="welcome-hints">
                  <span>Открыть документ <kbd>Ctrl</kbd><kbd>O</kbd></span>
                  <span>Все команды <kbd>Ctrl</kbd><kbd>Shift</kbd><kbd>P</kbd></span>
                </div>
              </div>
              <div class="welcome-visual" aria-hidden="true">
                <span class="visual-sheet">
                  <span class="visual-line line-a"></span>
                  <span class="visual-line line-b"></span>
                  <span class="visual-line line-c"></span>
                  <span class="visual-line line-d"></span>
                  <span class="visual-line line-e"></span>
                  <span class="visual-margin"></span>
                  <span class="visual-marker marker-comment"></span>
                  <span class="visual-marker marker-idea"></span>
                </span>
                <span class="visual-note note-one"><span class="visual-note-dot dot-comment"></span><span class="visual-note-lines"></span></span>
                <span class="visual-note note-two"><span class="visual-note-dot dot-important"></span><span class="visual-note-lines"></span></span>
              </div>
            </div>
          </section>
        {/if}
      </div>

      <footer class="statusbar">
        <div class="status-left">
          <span class:is-dirty={dirty} class:is-saving={Boolean(savingTabId)} class="status-save">
            <span class="status-dot"></span>
            {savingTabId ? 'Сохранение…' : dirty ? 'Не сохранено' : 'Сохранено'}
          </span>
          <span class="status-item status-file" title={filePath ?? 'Новый документ'}>
            <Icon name="file-text" size={13} /><span>{fileName}</span>
          </span>
          <span class="status-item status-format" title="Формат файла аннотаций">{annotationFormat}</span>
          {#if annotationPath && filePath !== annotationPath && originalText !== null && originalText !== text}
            <button class="status-diff" onclick={() => void applyTextToSource()} title="Создать резервную копию .bak и применить текст к исходному файлу">
              <Icon name="alert" size={12} />
              <span>Текст отличается от исходника</span>
              <span class="status-diff-action">Применить</span>
            </button>
          {/if}
        </div>
        <span class="status-message" role="status" aria-live="polite">{status}</span>
        <div class="status-right">
          <span class="status-item">{annotationCountLabel(annotations.length)}</span>
          <button class="status-item status-action" disabled={!filePath} title="Переоткрыть с другой кодировкой" onclick={() => void reopenWithEncoding()}>{encoding.toUpperCase()}</button>
          <span class="status-item">{eol === '\r\n' ? 'CRLF' : eol === '\r' ? 'CR' : 'LF'}</span>
          <span class="status-item">Стр. {cursorPosition.line}, стлб. {cursorPosition.column}</span>
        </div>
      </footer>
    </main>

    {#if showAnnotations && !focusMode}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
      <div class="pane-resizer" role="separator" aria-orientation="vertical" aria-label="Ширина панели аннотаций" aria-valuemin="270" aria-valuemax="460" aria-valuenow={annotationsRenderedWidth} tabindex="0" use:resizablePane={'annotations'}></div>
      <aside class="annotations pane" style:width="{annotationWidth}px" style:flex-basis="{annotationWidth}px" use:measurePaneWidth={'annotations'} aria-label="Аннотации">
        <div class="pane-header">
          <div class="pane-title"><Icon name="message-plus" size={15} /><span>Аннотации</span><span class="count-badge">{annotations.length}</span></div>
          <div class="pane-actions">
            <button class="icon-button compact" onclick={() => void createAnnotation()} title="Новая аннотация из выделения" aria-label="Новая аннотация из выделения">
              <Icon name="plus" size={15} />
            </button>
          </div>
        </div>

        <div class="annotations-toolbar">
          <div class="search-field">
            <Icon name="search" size={15} />
            <input
              class="search-input"
              bind:value={query}
              oninput={() => { annotationScrollTop = 0; if (annotationScrollHost) annotationScrollHost.scrollTop = 0 }}
              placeholder="Поиск по заметкам и тегам"
              aria-label="Поиск по аннотациям"
            />
            {#if query}
              <button class="search-clear" aria-label="Очистить поиск" onclick={() => { query = ''; annotationScrollTop = 0; if (annotationScrollHost) annotationScrollHost.scrollTop = 0; annotationScrollHost?.focus() }}>
                <Icon name="x" size={13} />
              </button>
            {/if}
          </div>
          <div class="filter-controls">
            <div class="filter-control-row">
              <Icon name="filter" size={14} />
              <label class="select-wrap compact filter-dropdown" title="Фильтр по типу">
                <select bind:value={filterType} onchange={() => { annotationScrollTop = 0; if (annotationScrollHost) annotationScrollHost.scrollTop = 0 }} aria-label="Фильтр по типу аннотации">
                  <option value="all">Все типы</option>
                  {#each annotationTypes as type}<option value={type.id}>{type.label}</option>{/each}
                </select>
                <Icon name="chevron-down" size={12} />
              </label>
            </div>
            <div class="filter-control-row">
              <Icon name="circle" size={14} />
              <label class="select-wrap compact filter-dropdown" title="Фильтр по статусу">
                <select bind:value={filterStatus} onchange={() => { annotationScrollTop = 0; if (annotationScrollHost) annotationScrollHost.scrollTop = 0 }} aria-label="Фильтр по статусу">
                  <option value="all">Все статусы</option><option value="open">Открытые</option><option value="resolved">Решённые</option><option value="archived">Архив</option>
                </select>
                <Icon name="chevron-down" size={12} />
              </label>
            </div>
            <div class="filter-control-row">
              <Icon name="sort" size={14} />
              <label class="select-wrap compact filter-dropdown" title="Порядок аннотаций">
                <select bind:value={settings.annotationsPanel.sort} onchange={() => { annotationScrollTop = 0; if (annotationScrollHost) annotationScrollHost.scrollTop = 0; scheduleSettingsSave() }} aria-label="Порядок аннотаций">
                  <option value="position">По тексту</option>
                  <option value="created">По созданию</option>
                  <option value="modified">По изменению</option>
                </select>
                <Icon name="chevron-down" size={12} />
              </label>
            </div>
            <div class="filter-control-row">
              <Icon name="check-circle" size={14} />
              <button class="filter-dropdown filter-toggle" class:active={hideResolved} aria-pressed={hideResolved} onclick={() => { hideResolved = !hideResolved; annotationScrollTop = 0; if (annotationScrollHost) annotationScrollHost.scrollTop = 0 }}>
                Без решённых
              </button>
            </div>
          </div>
        </div>

        {#if pendingSelection.from !== pendingSelection.to}
          <section class="note-composer" aria-label="Новая аннотация">
            <div class="composer-heading">
              <span class="composer-label"><span class="composer-pip"></span>Новая аннотация</span>
            </div>
            <div class="quote-preview">“{editor?.state.doc.sliceString(pendingSelection.from, pendingSelection.to).slice(0, 160)}”</div>
            <div class="type-chips" role="radiogroup" aria-label="Тип аннотации">
              {#each annotationTypes as type (type.id)}
                <button class="type-chip" class:active={noteType === type.id} role="radio" aria-checked={noteType === type.id} onclick={() => noteType = type.id}>
                  <span class="type-dot annot-dot-{type.id}"></span>{type.label}
                </button>
              {/each}
            </div>
            <textarea
              bind:this={noteInput}
              bind:value={noteDraft}
              rows="3"
              placeholder="Что важно в этом фрагменте?"
              aria-label="Текст аннотации"
              onkeydown={(event) => {
                if (event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Enter') {
                  event.preventDefault()
                  confirmAnnotation()
                }
              }}
            ></textarea>
            <div class="composer-footer">
              <span class="composer-hint">Ctrl+Enter</span>
              <div class="composer-actions">
                <button class="ghost-button" onclick={() => { pendingSelection = { from: 0, to: 0 }; noteDraft = '' }}>Отмена</button>
                <button class="accent-button" onclick={confirmAnnotation}>Добавить</button>
              </div>
            </div>
          </section>
        {/if}

        {#if annotations.some((annotation) => annotation.orphan)}
          <section class="orphan-group">
            <button class="orphan-heading" aria-expanded={showOrphans} onclick={() => showOrphans = !showOrphans}>
              <span class="orphan-heading-label">
                <Icon name={showOrphans ? 'chevron-down' : 'chevron-right'} size={13} />
                <Icon name="alert" size={13} />
                <span>Без привязки</span>
              </span>
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
                      <button class="mini-button" disabled={!editor || editor.state.selection.main.empty} title="Привязать к текущему выделению" onclick={() => rebindOrphan(annotation.id)}>Привязать к выделению</button>
                      <button class="mini-button" title="Найти цитату в документе" onclick={() => findOrphanAgain(annotation)}>Найти заново</button>
                      <button class="icon-button compact delete-button" title="Удалить аннотацию" aria-label="Удалить аннотацию" onclick={() => removeAnnotation(annotation.id)}>
                        <Icon name="trash" size={14} />
                      </button>
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
            <div class="pane-empty annotation-empty">
              <span class="pane-empty-icon"><Icon name="message-plus" size={22} /></span>
              <p>{annotations.length ? 'Ничего не найдено. Измените запрос или фильтры.' : 'Выделите фрагмент текста и создайте первую заметку.'}</p>
              {#if !annotations.length}
                <p class="pane-empty-hint"><kbd>Ctrl</kbd><span>+</span><kbd>Shift</kbd><span>+</span><kbd>A</kbd></p>
              {/if}
            </div>
          {/if}
          {#if linkedWindow.top > 0}<div class="virtual-spacer" aria-hidden="true" style:height="{linkedWindow.top}px"></div>{/if}
          {#each virtualLinkedAnnotations as annotation (annotation.id)}
            <article
              use:measureAnnotation={annotation.id}
              data-annotation-id={annotation.id}
              role="group"
              aria-label={`${annotation.type}: ${annotation.quote.slice(0, 80)}`}
              class:chosen={selectedId === annotation.id}
              class:is-resolved={annotation.resolved}
              class="annotation-card annot-card-{annotation.type}"
            >
              <header class="card-heading">
                <span class="type-dot annot-dot-{annotation.type}"></span>
                <label class="select-wrap type-select-wrap">
                  <span class="visually-hidden">Тип аннотации</span>
                  <select aria-label="Тип аннотации" value={annotation.type} onclick={(event) => event.stopPropagation()} onchange={(event) => updateAnnotation(annotation.id, { type: event.currentTarget.value }, true)}>
                    {#each annotationTypes as type}<option value={type.id}>{type.label}</option>{/each}
                  </select>
                  <Icon name="chevron-down" size={11} />
                </label>
                <label class="select-wrap type-select-wrap">
                  <span class="visually-hidden">Статус аннотации</span>
                  <select aria-label="Статус аннотации" value={annotation.status ?? (annotation.resolved ? 'resolved' : 'open')} onclick={(event) => event.stopPropagation()} onchange={(event) => updateAnnotation(annotation.id, { status: event.currentTarget.value as 'open' | 'resolved' | 'archived', resolved: event.currentTarget.value === 'resolved' }, true)}>
                    <option value="open">Открыта</option><option value="resolved">Решена</option><option value="archived">Архив</option>
                  </select>
                  <Icon name="chevron-down" size={11} />
                </label>
                {#if annotation.orphan}
                  <span class="line-badge is-orphan">Без привязки</span>
                {:else}
                  <button class="line-badge" title="Перейти к фрагменту" onclick={(event) => { event.stopPropagation(); selectAnnotation(annotation) }}>Стр. {lineNumberAt(lineStarts, annotation.start)}</button>
                {/if}
                <span class="card-spacer"></span>
                <button class="icon-button compact resolve-button" class:resolved={annotation.resolved} aria-pressed={annotation.resolved} aria-label={annotation.resolved ? 'Снова открыть' : 'Отметить решённой'} title={annotation.resolved ? 'Снова открыть' : 'Отметить решённой'} onclick={(event) => { event.stopPropagation(); updateAnnotation(annotation.id, { resolved: !annotation.resolved }, true) }}>
                  <Icon name={annotation.resolved ? 'check-circle' : 'circle'} size={15} />
                </button>
                <button class="icon-button compact delete-button" aria-label="Удалить аннотацию" title="Удалить аннотацию" onclick={(event) => { event.stopPropagation(); removeAnnotation(annotation.id) }}>
                  <Icon name="trash" size={14} />
                </button>
              </header>
              <button
                class="card-main"
                aria-pressed={selectedId === annotation.id}
                onclick={() => selectAnnotation(annotation)}
                ondblclick={() => editNoteId = annotation.id}
                title="Перейти к фрагменту. Двойной щелчок — изменить заметку"
              >
                {#if settings.annotationsPanel.showQuote}
                  <span class="annotation-quote">{annotation.orphan ? 'Фрагмент не найден в тексте' : `“${annotation.quote.slice(0, 160)}”`}</span>
                {/if}
              </button>
              {#if editNoteId === annotation.id}
                <textarea
                  class="annotation-body"
                  aria-label="Текст заметки"
                  rows="3"
                  value={annotation.text}
                  placeholder="Текст заметки в Markdown…"
                  oninput={(event) => updateAnnotation(annotation.id, { text: event.currentTarget.value })}
                  onkeydown={(event) => { if (event.key === 'Escape') editNoteId = null }}
                  onblur={() => editNoteId = null}
                ></textarea>
              {:else}
                <div
                  class="annotation-rendered"
                  role="button"
                  aria-label="Текст заметки"
                  tabindex="0"
                  onclick={(event) => openNoteLink(event, annotation)}
                  onkeydown={(event) => openNoteLink(event, annotation)}
                  ondblclick={(event) => { event.stopPropagation(); editNoteId = annotation.id }}
                >{@html renderMarkdown(annotation.text || '*Двойной щелчок, чтобы добавить заметку…*')}</div>
              {/if}
              {#if annotation.tags.length}
                <div class="tag-row">
                  {#each annotation.tags as tag}<span class="tag-pill">#{tag}</span>{/each}
                </div>
              {/if}
              <div class="tag-editor">
                <Icon name="tag" size={12} />
                <input
                  aria-label="Добавить тег к аннотации"
                  placeholder="Добавить тег…"
                  value={tagDrafts[annotation.id] ?? ''}
                  oninput={(event) => tagDrafts = { ...tagDrafts, [annotation.id]: event.currentTarget.value }}
                  onkeydown={(event) => { if (event.key === 'Enter') { event.preventDefault(); commitTags(annotation.id) } }}
                  onblur={() => { if (tagDrafts[annotation.id]?.trim()) commitTags(annotation.id) }}
                />
              </div>
              <footer class="card-footer">
                <span class="card-date" title={formatAnnotationDateFull(annotation.modified)}>{formatAnnotationDate(annotation.modified)}</span>
                {#if annotation.resolved}
                  <span class="resolved-pill"><Icon name="check" size={11} />Решено</span>
                {/if}
              </footer>
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
      ><Icon name="message-plus" size={14} /><span>Аннотация</span></button>
    {/if}
  </div>
</div>

{#if showPasteDialog}
  <div class="modal-backdrop">
    <dialog open class="dialog export-dialog" aria-modal="true" aria-labelledby="paste-title" use:modalDialog>
      <div class="dialog-header"><div class="dialog-heading"><h2 id="paste-title">Новый документ из текста</h2><p>Текущая вкладка останется открытой.</p></div>
        <button class="icon-button" aria-label="Закрыть" onclick={() => showPasteDialog = false}><Icon name="x" size={16} /></button></div>
      <label class="settings-field"><span>Текст</span><textarea bind:this={pasteInput} bind:value={pasteDraft} rows="12" placeholder="Вставьте или напишите текст…"></textarea></label>
      <footer class="dialog-footer"><button class="button" onclick={() => showPasteDialog = false}>Отмена</button><button class="button primary" disabled={!pasteDraft.trim()} onclick={() => void createDocumentFromPaste()}>Создать вкладку</button></footer>
    </dialog>
  </div>
{/if}

{#if showExportPicker}
  <div class="modal-backdrop">
    <dialog open class="dialog export-dialog" aria-modal="true" aria-labelledby="export-title" use:modalDialog>
      <div class="dialog-header">
        <div class="dialog-heading">
          <h2 id="export-title">Экспортировать документ</h2>
          <p>Текст и аннотации будут сохранены в выбранном формате.</p>
        </div>
        <button class="icon-button" aria-label="Закрыть экспорт" onclick={() => showExportPicker = false}><Icon name="x" size={16} /></button>
      </div>
      <label class="settings-field">
        <span>Формат</span>
        <select bind:value={selectedExportFormat} aria-label="Формат экспорта">
          {#each exportFormats as format (format.id)}<option value={format.id}>{format.label} .{format.extension}</option>{/each}
        </select>
      </label>
      <footer class="dialog-footer">
        <button class="button" onclick={() => showExportPicker = false}>Отмена</button>
        <button class="button primary" onclick={() => void exportCurrentDocument(selectedExportFormat)}>Экспортировать</button>
      </footer>
    </dialog>
  </div>
{/if}

{#if showSettings}
  <div class="modal-backdrop">
    <dialog open class="settings-dialog" aria-modal="true" aria-labelledby="settings-title" use:modalDialog>
      <aside class="settings-sidebar">
        <div class="settings-brand">
          <span class="brand-mark small" aria-hidden="true">
            <svg viewBox="0 0 20 20" fill="none">
              <path d="M4.5 5.5h7M4.5 10h11M4.5 14.5h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
              <circle cx="15.5" cy="5.5" r="1.5" fill="currentColor" />
            </svg>
          </span>
          <span class="settings-brand-copy"><strong>Настройки</strong><span>Annotator</span></span>
        </div>
        <nav class="settings-nav" aria-label="Разделы настроек">
          {#each settingsSections as section (section.id)}
            <button class:active={settingsSection === section.id} onclick={() => settingsSection = section.id}>
              <Icon name={section.icon} size={16} /><span>{section.label}</span>
            </button>
          {/each}
        </nav>
      </aside>

      <div class="settings-main">
        <header class="settings-header">
          <div class="settings-heading">
            <h2 id="settings-title">{activeSettingsSection.title}</h2>
            <p>{activeSettingsSection.description}</p>
          </div>
          <button class="icon-button" aria-label="Закрыть настройки" title="Закрыть" onclick={closeSettings}>
            <Icon name="x" size={16} />
          </button>
        </header>

        <div class="settings-body">
          {#if settingsSection === 'appearance'}
            <section class="setting-group">
              <div class="group-heading">
                <h3>Тема</h3>
                <p>Выберите палитру для чтения и работы.</p>
              </div>
              <label class="setting-row switch-row">
                <span class="setting-copy">
                  <span class="setting-title">Следовать теме Windows</span>
                  <span class="setting-hint">Переключаться между светлой и тёмной темой вместе с системой.</span>
                </span>
                <input type="checkbox" role="switch" class="switch-input" aria-label="Следовать теме Windows" bind:checked={settings.themeFollowSystem.enabled} onchange={applyTheme} />
              </label>
              {#if settings.themeFollowSystem.enabled}
                <label class="setting-row">
                  <span class="setting-copy"><span class="setting-title">Светлая тема</span><span class="setting-hint">Используется, когда Windows в светлом режиме.</span></span>
                  <span class="select-wrap">
                    <select bind:value={settings.themeFollowSystem.light} onchange={applyTheme} aria-label="Светлая тема">
                      {#each lightThemeOptions as option (option.id)}<option value={option.id}>{option.name}</option>{/each}
                    </select>
                    <Icon name="chevron-down" size={12} />
                  </span>
                </label>
                <label class="setting-row">
                  <span class="setting-copy"><span class="setting-title">Тёмная тема</span><span class="setting-hint">Используется, когда Windows в тёмном режиме.</span></span>
                  <span class="select-wrap">
                    <select bind:value={settings.themeFollowSystem.dark} onchange={applyTheme} aria-label="Тёмная тема">
                      {#each darkThemeOptions as option (option.id)}<option value={option.id}>{option.name}</option>{/each}
                    </select>
                    <Icon name="chevron-down" size={12} />
                  </span>
                </label>
                <p class="inline-note"><Icon name="info" size={13} />Сейчас Windows использует {systemUsesDarkColors ? 'тёмное' : 'светлое'} оформление.</p>
              {:else}
                {@render ThemeGallery()}
              {/if}
            </section>
            <section class="setting-group">
              <div class="group-heading">
                <h3>Свои темы</h3>
                <p>Импортируйте палитру в формате JSON — она появится в списке тем.</p>
              </div>
              <div class="inline-actions">
                <label class="button file-button">
                  <Icon name="plus" size={15} /><span>Импортировать тему</span>
                  <input class="visually-hidden" type="file" accept=".json,application/json" onchange={(event) => void importTheme(event)} />
                </label>
              </div>
              {#each availableUserThemes as theme (theme.id)}
                <div class="user-theme-row">
                  <span class="user-theme-name">{theme.name}<span class="user-theme-kind">{theme.type === 'dark' ? 'Тёмная' : 'Светлая'}</span></span>
                  <button class="mini-button danger-text" title={`Удалить тему ${theme.name}`} onclick={() => void deleteUserTheme(theme)}>
                    <Icon name="trash" size={14} /><span>Удалить</span>
                  </button>
                </div>
              {:else}
                <p class="inline-note">Пользовательских тем пока нет.</p>
              {/each}
              {#each themeErrors as error (error.file)}<p class="settings-error">{error.file}: {error.message}</p>{/each}
            </section>
          {/if}

          {#if settingsSection === 'typography'}
            <section class="setting-group">
              <div class="group-heading"><h3>Интерфейс</h3><p>Панели, меню и подписи.</p></div>
              <div class="setting-block">
                <span class="setting-title">Шрифт интерфейса</span>
                <FontPicker bind:value={settings.ui.fontFamily} suggestions={fontSuggestions} label="Шрифт интерфейса" onValueChange={applyTheme} />
              </div>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Размер интерфейса</span><span class="setting-hint">Влияет на панели и элементы управления.</span></span>
                <span class="range-control">
                  <input type="range" min="8" max="24" step="1" bind:value={settings.ui.fontSize} oninput={applyTheme} aria-label="Размер шрифта интерфейса" />
                  <output>{settings.ui.fontSize} px</output>
                </span>
              </label>
            </section>
            <section class="setting-group">
              <div class="group-heading"><h3>Текст документа</h3><p>Основной шрифт для чтения и правки.</p></div>
              <div class="setting-block">
                <span class="setting-title">Шрифт редактора</span>
                <FontPicker bind:value={settings.editor.fontFamily} suggestions={fontSuggestions} label="Шрифт редактора" onValueChange={applyTheme} />
              </div>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Размер текста</span><span class="setting-hint">Ctrl+колесо также меняет размер.</span></span>
                <span class="range-control">
                  <input type="range" min="8" max="48" step="1" bind:value={settings.editor.fontSize} oninput={applyTheme} aria-label="Размер шрифта редактора" />
                  <output>{settings.editor.fontSize} px</output>
                </span>
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Высота строки</span></span>
                <span class="range-control">
                  <input type="range" min="1" max="3" step="0.1" bind:value={settings.editor.lineHeight} oninput={applyTheme} aria-label="Высота строки" />
                  <output>{settings.editor.lineHeight}</output>
                </span>
              </label>
              <label class="setting-row switch-row">
                <span class="setting-copy"><span class="setting-title">Лигатуры</span><span class="setting-hint">Показывать связанные символы в шрифтах, которые их поддерживают.</span></span>
                <input type="checkbox" role="switch" class="switch-input" aria-label="Лигатуры" bind:checked={settings.editor.ligatures} onchange={applyTheme} />
              </label>
              <p class="font-preview" style:font-family={settings.editor.fontFamily} style:font-size="{settings.editor.fontSize}px" style:line-height={settings.editor.lineHeight}>
                Русский текст, English, 123 — «Кавычки», ёж и фрагмент.
              </p>
            </section>
            <section class="setting-group">
              <div class="group-heading"><h3>Заметки на полях</h3><p>Шрифт карточек и композера аннотаций.</p></div>
              <div class="setting-block">
                <span class="setting-title">Шрифт аннотаций</span>
                <FontPicker bind:value={settings.annotationsPanel.fontFamily} suggestions={fontSuggestions} label="Шрифт аннотаций" onValueChange={applyTheme} />
              </div>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Размер аннотаций</span></span>
                <span class="range-control">
                  <input type="range" min="8" max="32" step="1" bind:value={settings.annotationsPanel.fontSize} oninput={applyTheme} aria-label="Размер шрифта аннотаций" />
                  <output>{settings.annotationsPanel.fontSize} px</output>
                </span>
              </label>
              <div class="inline-actions">
                <button class="button" onclick={async () => {
                  try {
                    const fontApi = window as Window & { queryLocalFonts?: () => Promise<Array<{ family: string }>> }
                    const fonts = fontApi.queryLocalFonts ? await fontApi.queryLocalFonts() : []
                    fontSuggestions = [...new Set([...builtinFonts, ...fonts.map((font) => font.family)])].sort((a, b) => a.localeCompare(b, 'ru'))
                    status = fonts.length ? `Найдено системных шрифтов: ${fonts.length}` : 'Список системных шрифтов недоступен; доступен встроенный список и ручной ввод'
                  } catch (error) {
                    fontSuggestions = builtinFonts
                    status = `Не удалось прочитать системные шрифты: ${error instanceof Error ? error.message : String(error)}`
                  }
                }}>
                  <Icon name="type" size={15} /><span>Загрузить системные шрифты</span>
                </button>
              </div>
              <p class="inline-note">Семейство шрифта можно ввести вручную, даже если его нет в списке.</p>
            </section>
          {/if}

          {#if settingsSection === 'editor'}
            <section class="setting-group">
              <div class="group-heading"><h3>Полотно текста</h3><p>Как документ выглядит во время чтения.</p></div>
              <label class="setting-row switch-row">
                <span class="setting-copy"><span class="setting-title">Номера строк</span><span class="setting-hint">Показывать нумерацию вдоль левого края.</span></span>
                <input type="checkbox" role="switch" class="switch-input" aria-label="Номера строк" bind:checked={settings.editor.lineNumbers} onchange={applyTheme} />
              </label>
              <label class="setting-row switch-row">
                <span class="setting-copy"><span class="setting-title">Переносить длинные строки</span><span class="setting-hint">Текст остаётся в пределах удобной ширины страницы.</span></span>
                <input type="checkbox" role="switch" class="switch-input" aria-label="Переносить длинные строки" bind:checked={settings.editor.wrap} onchange={applyTheme} />
              </label>
              <label class="setting-row switch-row">
                <span class="setting-copy"><span class="setting-title">Редактор только для чтения</span><span class="setting-hint">Защитить текст от случайных правок.</span></span>
                <input type="checkbox" role="switch" class="switch-input" aria-label="Редактор только для чтения" bind:checked={settings.editor.readOnly} onchange={applyTheme} />
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Максимальная ширина строки</span><span class="setting-hint">В символах. Меньше — спокойнее чтение.</span></span>
                <span class="number-wrap"><input type="number" min="40" max="240" bind:value={settings.editor.maxLineWidthCh} oninput={applyTheme} aria-label="Максимальная ширина строки" /><span>ch</span></span>
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Толщина шрифта</span></span>
                <span class="select-wrap">
                  <select bind:value={settings.editor.fontWeight} onchange={applyTheme} aria-label="Толщина шрифта редактора">
                    {#each [300, 400, 500, 600, 700] as weight}<option value={weight}>{weight}</option>{/each}
                  </select>
                  <Icon name="chevron-down" size={12} />
                </span>
              </label>
            </section>
            <section class="setting-group">
              <div class="group-heading"><h3>Масштаб и фокус</h3><p>Плотность интерфейса и режим чтения только заметок.</p></div>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Масштаб интерфейса</span><span class="setting-hint">Увеличивает все панели сразу.</span></span>
                <span class="range-control">
                  <input type="range" min="0.75" max="1.5" step="0.05" bind:value={settings.ui.zoom} oninput={applyTheme} aria-label="Масштаб интерфейса" />
                  <output>{Math.round(settings.ui.zoom * 100)}%</output>
                </span>
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Контекст режима фокуса</span><span class="setting-hint">Сколько символов вокруг заметки показывать при F9.</span></span>
                <span class="number-wrap"><input type="number" min="0" max="500" bind:value={settings.focusView.contextChars} onchange={() => setFocusMode(focusMode)} aria-label="Контекст режима фокуса" /><span>симв.</span></span>
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Разделитель фрагментов</span></span>
                <span class="select-wrap">
                  <select bind:value={settings.focusView.separator} onchange={() => setFocusMode(focusMode)} aria-label="Разделитель фрагментов">
                    <option value="blank1">Одна пустая строка</option>
                    <option value="blank2">Две пустые строки</option>
                    <option value="ellipsis">Многоточие</option>
                  </select>
                  <Icon name="chevron-down" size={12} />
                </span>
              </label>
              <p class="inline-note"><Icon name="focus" size={13} />F9 скрывает панели и оставляет только фрагменты с аннотациями. Выйти можно клавишей F9 или Escape.</p>
            </section>
          {/if}

          {#if settingsSection === 'annotations'}
            <section class="setting-group">
              <div class="group-heading"><h3>Панель заметок</h3><p>Что показывать в карточках и как связывать их с текстом.</p></div>
              <label class="setting-row switch-row">
                <span class="setting-copy"><span class="setting-title">Показывать цитату</span><span class="setting-hint">Фрагмент текста в верхней части карточки.</span></span>
                <input type="checkbox" role="switch" class="switch-input" aria-label="Показывать цитату" bind:checked={settings.annotationsPanel.showQuote} />
              </label>
              <label class="setting-row switch-row">
                <span class="setting-copy"><span class="setting-title">Связывать прокрутку</span><span class="setting-hint">Выбор заметки прокручивает текст к фрагменту.</span></span>
                <input type="checkbox" role="switch" class="switch-input" aria-label="Связывать прокрутку" bind:checked={settings.annotationsPanel.linkScroll} />
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Тип новой аннотации</span></span>
                <span class="select-wrap">
                  <select bind:value={settings.annotations.defaultType} aria-label="Тип новой аннотации">
                    {#each annotationTypes as type}<option value={type.id}>{type.label}</option>{/each}
                  </select>
                  <Icon name="chevron-down" size={12} />
                </span>
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Порядок по умолчанию</span></span>
                <span class="select-wrap">
                  <select bind:value={settings.annotationsPanel.sort} aria-label="Порядок аннотаций по умолчанию">
                    <option value="position">По тексту</option>
                    <option value="created">По созданию</option>
                    <option value="modified">По изменению</option>
                  </select>
                  <Icon name="chevron-down" size={12} />
                </span>
              </label>
            </section>
            <section class="setting-group">
              <div class="group-heading"><h3>Подсветка</h3><p>Настройте интенсивность и цвета фрагментов.</p></div>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Интенсивность подсветки</span></span>
                <span class="range-control">
                  <input type="range" min="0.05" max="0.6" step="0.01" bind:value={settings.annotations.highlightAlpha} oninput={applyTheme} aria-label="Интенсивность подсветки" />
                  <output>{Math.round(settings.annotations.highlightAlpha * 100)}%</output>
                </span>
              </label>
              <label class="setting-row switch-row">
                <span class="setting-copy"><span class="setting-title">Различать цвета по типу</span><span class="setting-hint">У каждого типа заметки будет свой маркер.</span></span>
                <input type="checkbox" role="switch" class="switch-input" aria-label="Различать цвета по типу" bind:checked={settings.annotations.colorByType} onchange={applyTheme} />
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Единый цвет подсветки</span><span class="setting-hint">Используется, когда различение по типу выключено.</span></span>
                <input class="color-input" type="color" disabled={settings.annotations.colorByType} value={settings.annotations.highlightColor ?? themeColor('annot.default')} aria-label="Единый цвет подсветки" oninput={(event) => { settings.annotations.highlightColor = event.currentTarget.value; applyTheme() }} />
              </label>
              <div class="color-list">
                {#each annotationTypes as type (type.id)}
                  <div class="color-row">
                    <span class="color-label"><span class="type-dot annot-dot-{type.id}"></span>{type.label}</span>
                    <span class="color-controls">
                      <input class="color-input" type="color" disabled={!settings.annotations.colorByType} value={settings.annotations.types.find((item) => item.id === type.id)?.color ?? themeColor(`annot.${type.id}`)} aria-label={`Цвет типа ${type.label}`} oninput={(event) => setAnnotationTypeColor(type.id, event.currentTarget.value)} />
                      <button class="mini-button" disabled={!settings.annotations.types.find((item) => item.id === type.id)?.color} onclick={() => setAnnotationTypeColor(type.id, null)}>Сбросить</button>
                    </span>
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if settingsSection === 'colors'}
            <section class="setting-group">
              <div class="group-heading">
                <h3>Палитра темы</h3>
                <p>Отдельные цвета можно переопределить поверх выбранной темы. Сброс возвращает исходное значение.</p>
              </div>
              <div class="color-list">
                {#each ['ui.bg', 'ui.fg', 'ui.fgMuted', 'ui.accent', 'ui.border', 'editor.bg', 'editor.fg', 'editor.selection', 'annot.default', 'annot.comment', 'annot.note', 'annot.highlight', 'annot.question', 'annot.idea', 'annot.todo', 'annot.important', 'annot.critic_add', 'annot.critic_del', 'annot.critic_sub', 'annot.critic_comment', 'annot.critic_highlight'] as colorKey (colorKey)}
                  <div class="color-row">
                    <span class="color-label">{colorLabels[colorKey] ?? colorKey}</span>
                    <span class="color-controls">
                      <input class="color-input" type="color" value={settings.colorOverrides[colorKey] ?? themeColor(colorKey)} aria-label={`Цвет ${colorKey}`} oninput={(event) => setThemeColor(colorKey, event.currentTarget.value)} />
                      <button class="mini-button" disabled={!settings.colorOverrides[colorKey]} onclick={() => {
                        const overrides = { ...settings.colorOverrides }
                        delete overrides[colorKey]
                        settings.colorOverrides = overrides
                        applyTheme()
                      }}>Сбросить</button>
                    </span>
                  </div>
                {/each}
              </div>
            </section>
          {/if}

          {#if settingsSection === 'files'}
            <section class="setting-group">
              <div class="group-heading"><h3>Автосохранение</h3><p>Заметки сохраняются вместе с документом.</p></div>
              <label class="setting-row switch-row">
                <span class="setting-copy"><span class="setting-title">Автосохранение аннотаций</span><span class="setting-hint">Сохранять аннотированные документы автоматически.</span></span>
                <input type="checkbox" role="switch" class="switch-input" aria-label="Автосохранение аннотаций" bind:checked={settings.files.autosave} />
              </label>
              <label class="setting-row switch-row">
                <span class="setting-copy"><span class="setting-title">Автосохранение обычных файлов</span><span class="setting-hint">Работает и для документов без заметок.</span></span>
                <input type="checkbox" role="switch" class="switch-input" aria-label="Автосохранение обычных файлов" bind:checked={settings.files.autosavePlain} />
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Задержка автосохранения</span></span>
                <span class="number-wrap"><input type="number" min="250" max="10000" step="250" bind:value={settings.files.autosaveDelayMs} aria-label="Задержка автосохранения" /><span>мс</span></span>
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Максимум до автосохранения</span></span>
                <span class="number-wrap"><input type="number" min="1000" max="120000" step="1000" bind:value={settings.files.autosaveMaxWaitMs} aria-label="Максимум до автосохранения" /><span>мс</span></span>
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Интервал резервирования</span></span>
                <span class="number-wrap"><input type="number" min="1" max="1440" bind:value={settings.files.backupIntervalMin} aria-label="Интервал резервирования" /><span>мин</span></span>
              </label>
            </section>
            <section class="setting-group">
              <div class="group-heading"><h3>Новые документы</h3><p>Формат заметок, кодировка и переводы строк.</p></div>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Формат новых sidecar</span></span>
                <span class="select-wrap">
                  <select bind:value={settings.files.saveFormat} aria-label="Формат новых sidecar">
                    <option value="json">JSON</option>
                    <option value="md">Markdown</option>
                  </select>
                  <Icon name="chevron-down" size={12} />
                </span>
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Кодировка</span></span>
                <span class="select-wrap">
                  <select bind:value={settings.files.encoding} aria-label="Кодировка новых документов">
                    {#each supportedEncodings as supportedEncoding}<option value={supportedEncoding}>{supportedEncoding.toUpperCase()}</option>{/each}
                  </select>
                  <Icon name="chevron-down" size={12} />
                </span>
              </label>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Перевод строки</span></span>
                <span class="select-wrap">
                  <select bind:value={settings.files.defaultEol} aria-label="Перевод строки новых документов">
                    <option value="lf">LF</option>
                    <option value="crlf">CRLF</option>
                  </select>
                  <Icon name="chevron-down" size={12} />
                </span>
              </label>
            </section>
            <section class="setting-group">
              <div class="group-heading"><h3>Сглаживание текста</h3><p>Изменение вступит в силу после перезапуска приложения.</p></div>
              <label class="setting-row">
                <span class="setting-copy"><span class="setting-title">Сглаживание</span><span class="setting-hint">Системное сохраняет привычную чёткость Windows.</span></span>
                <span class="select-wrap">
                  <select bind:value={settings.rendering.smoothing} aria-label="Сглаживание текста">
                    <option value="system">Системное</option>
                    <option value="grayscale">Оттенки серого</option>
                  </select>
                  <Icon name="chevron-down" size={12} />
                </span>
              </label>
              <div class="inline-actions">
                <button class="button" onclick={() => void invoke('settings:openFile').catch((error: unknown) => status = `Не удалось открыть settings.json: ${error instanceof Error ? error.message : String(error)}`)}>
                  <Icon name="file-text" size={15} /><span>Открыть settings.json</span>
                </button>
                <button class="button" onclick={() => void invoke('app:relaunch').catch((error: unknown) => status = `Не удалось перезапустить: ${error instanceof Error ? error.message : String(error)}`)}>
                  <Icon name="arrow-up-right" size={15} /><span>Перезапустить</span>
                </button>
              </div>
            </section>
          {/if}

          {#if settingsSection === 'shortcuts'}
            <section class="setting-group">
              <div class="group-heading">
                <h3>Команды</h3>
                <p>Введите сочетание в поле, например Ctrl+Shift+A. Пустое поле использует значение по умолчанию.</p>
              </div>
              {#each shortcutConflicts() as conflict}<p class="settings-error"><Icon name="alert" size={12} />{conflict}</p>{/each}
              {#each shortcutGroups as group (group.title)}
                <div class="shortcut-group">
                  <h4>{group.title}</h4>
                  {#each group.ids as id (id)}
                    {@const command = commandDefinitions.find((item) => item.id === id)}
                    {#if command}
                      <div class="shortcut-setting">
                        <span class="shortcut-label" title={command.id}>{command.label}</span>
                        <input
                          aria-label={`Сочетание: ${command.label}`}
                          value={settings.keybindings[command.id] ?? ''}
                          placeholder={command.shortcut ?? 'Нет'}
                          oninput={(event) => settings.keybindings = { ...settings.keybindings, [command.id]: event.currentTarget.value || null }}
                        />
                        <button class="icon-button compact" aria-label={`Сбросить сочетание: ${command.label}`} title="Сбросить" onclick={() => {
                          const bindings = { ...settings.keybindings }
                          delete bindings[command.id]
                          settings.keybindings = bindings
                        }}>
                          <Icon name="x" size={13} />
                        </button>
                      </div>
                    {/if}
                  {/each}
                </div>
              {/each}
            </section>
          {/if}
        </div>

        <footer class="settings-footer">
          <button class="button" onclick={closeSettings}>Отмена</button>
          <button class="button primary" onclick={() => void saveSettings()}>Сохранить настройки</button>
        </footer>
      </div>
    </dialog>
  </div>
{/if}

{#if commandPaletteOpen}
  <div class="modal-backdrop palette-backdrop" role="presentation" onclick={(event) => { if (event.target === event.currentTarget) commandPaletteOpen = false }}>
    <dialog open class="command-palette" aria-label="Панель команд" aria-modal="true" use:modalDialog>
      <div class="command-input-row">
        <Icon name="search" size={18} />
        <input
          bind:this={commandPaletteInput}
          bind:value={commandPaletteQuery}
          aria-label="Поиск команд"
          placeholder="Введите название команды…"
          role="combobox"
          aria-expanded="true"
          aria-controls="command-results"
          aria-autocomplete="list"
          aria-activedescendant={activeCommand ? `command-option-${activeCommand.id}` : undefined}
          oninput={(event) => setCommandPaletteQuery(event.currentTarget.value)}
          onkeydown={(event) => {
            if (event.key === 'ArrowDown') { event.preventDefault(); void moveCommandPaletteSelection(1) }
            else if (event.key === 'ArrowUp') { event.preventDefault(); void moveCommandPaletteSelection(-1) }
            else if (event.key === 'Enter') {
              event.preventDefault()
              if (activeCommand) void executeCommand(activeCommand.id)
            }
          }}
        />
        <kbd>Esc</kbd>
      </div>
      <div class="command-results" id="command-results" role="listbox" aria-label="Команды" bind:this={commandPaletteResults}>
        {#each visibleCommands as command, index (command.id)}
          <button
            id={`command-option-${command.id}`}
            class:active={index === commandPaletteIndex}
            role="option"
            aria-selected={index === commandPaletteIndex}
            data-command-index={index}
            onmouseenter={() => commandPaletteIndex = index}
            onclick={() => void executeCommand(command.id)}
          >
            <span class="command-copy">
              <span class="command-label">{command.label}</span>
              <span class="command-id">{command.id}</span>
            </span>
            <kbd>{bindingFor(command) ?? '—'}</kbd>
          </button>
        {:else}
          <div class="command-empty">
            <Icon name="search" size={22} />
            <p>Ничего не найдено</p>
            <span>Попробуйте другое название команды.</span>
          </div>
        {/each}
      </div>
      <footer class="command-footer">
        <span><kbd>↑</kbd><kbd>↓</kbd> выбор</span>
        <span><kbd>Enter</kbd> выполнить</span>
        <span><kbd>Esc</kbd> закрыть</span>
      </footer>
    </dialog>
  </div>
{/if}

{#if themePickerOpen}
  <div class="modal-backdrop palette-backdrop">
    <dialog open class="picker-dialog" aria-labelledby="theme-picker-title" aria-modal="true" use:modalDialog>
      <header class="dialog-header">
        <div class="dialog-heading">
          <h2 id="theme-picker-title">Выбрать тему</h2>
          <p>Оформление применяется сразу.</p>
        </div>
        <button class="icon-button" aria-label="Закрыть выбор темы" onclick={() => themePickerOpen = false}>
          <Icon name="x" size={16} />
        </button>
      </header>
      {@render ThemeGallery()}
      {#if settings.themeFollowSystem.enabled}
        <p class="inline-note"><Icon name="info" size={13} />Включено следование теме Windows. Выбор вступит в силу, если его отключить.</p>
      {/if}
      <footer class="dialog-footer">
        <button class="button" onclick={() => themePickerOpen = false}>Закрыть</button>
      </footer>
    </dialog>
  </div>
{/if}

{#if treeEdit}
  <div class="modal-backdrop">
    <dialog open class="dialog tree-edit-dialog" aria-modal="true" aria-labelledby="tree-edit-title" use:modalDialog>
      <div class="dialog-header">
        <div class="dialog-heading">
          <h2 id="tree-edit-title">{treeEdit.action === 'rename' ? 'Переименовать' : treeEdit.action === 'create-folder' ? 'Создать папку' : 'Создать текстовый файл'}</h2>
          <p>{treeEdit.action === 'rename' ? 'Введите новое имя элемента.' : 'Элемент появится внутри выбранной папки.'}</p>
        </div>
        <button class="icon-button" aria-label="Закрыть" onclick={() => treeEdit = null}>
          <Icon name="x" size={16} />
        </button>
      </div>
      <form onsubmit={(event) => { event.preventDefault(); void commitTreeEdit() }}>
        <label class="tree-edit-field">
          <span>Имя</span>
          <input bind:this={treeNameInput} bind:value={treeEdit.name} maxlength="259" required aria-label="Имя файла или папки" />
        </label>
        <footer class="dialog-footer">
          <button class="button" type="button" onclick={() => treeEdit = null}>Отмена</button>
          <button class="button primary" type="submit">{treeEdit.action === 'rename' ? 'Переименовать' : 'Создать'}</button>
        </footer>
      </form>
    </dialog>
  </div>
{/if}

{#if closeTabId}
  {@const closingTab = tabs.find((tab) => tab.id === closeTabId)}
  <div class="modal-backdrop">
    <dialog open class="dialog confirm-dialog" aria-modal="true" aria-labelledby="close-dialog-title" use:modalDialog>
      <div class="confirm-body">
        <span class="confirm-icon"><Icon name="save" size={18} /></span>
        <div class="dialog-heading">
          <h2 id="close-dialog-title">Сохранить изменения?</h2>
          <p>Документ «{closingTab?.path?.split(/[\\/]/).at(-1) ?? 'Новый документ'}» содержит несохранённые изменения.</p>
        </div>
      </div>
      <footer class="dialog-footer">
        <button class="button" onclick={() => void closeTabChoice('cancel')}>Отмена</button>
        <button class="button danger-ghost" onclick={() => void closeTabChoice('discard')}>Не сохранять</button>
        <button class="button primary" onclick={() => void closeTabChoice('save')}>Сохранить</button>
      </footer>
    </dialog>
  </div>
{/if}

{#if confirmRequest}
  <div class="modal-backdrop">
    <dialog open class="dialog confirm-dialog" aria-modal="true" aria-labelledby="confirm-title" aria-describedby="confirm-message" use:modalDialog>
      <div class="confirm-body">
        <span class:danger={confirmRequest.danger} class="confirm-icon"><Icon name={confirmRequest.danger ? 'alert' : 'info'} size={18} /></span>
        <div class="dialog-heading">
          <h2 id="confirm-title">{confirmRequest.title}</h2>
          <p id="confirm-message">{confirmRequest.message}</p>
        </div>
      </div>
      <footer class="dialog-footer">
        {#if confirmRequest.tertiaryLabel}
          <button class="button" onclick={() => answerConfirm('tertiary')}>{confirmRequest.tertiaryLabel}</button>
        {/if}
        <span class="dialog-spacer"></span>
        <button class="button" onclick={() => answerConfirm('cancel')}>{confirmRequest.cancelLabel ?? 'Отмена'}</button>
        <button class="button" class:danger={confirmRequest.danger} class:primary={!confirmRequest.danger} onclick={() => answerConfirm('confirm')}>{confirmRequest.confirmLabel}</button>
      </footer>
    </dialog>
  </div>
{/if}

{#snippet ThemeGallery()}
  <div class="theme-gallery">
    {#each themeOptions as option (option.id)}
      <button class="theme-card" class:active={settings.theme === option.id} aria-pressed={settings.theme === option.id} onclick={() => selectTheme(option.id)}>
        <span class="theme-preview" style="background: {option.colors['editor.bg']}">
          <span class="theme-preview-side" style="background: {option.colors['ui.bg']}"></span>
          <span class="theme-preview-page">
            <span class="theme-preview-line" style="background: color-mix(in srgb, {option.colors['editor.fg']} 62%, transparent); width: 62%"></span>
            <span class="theme-preview-line" style="background: color-mix(in srgb, {option.colors['editor.fg']} 34%, transparent); width: 82%"></span>
            <span class="theme-preview-line" style="background: color-mix(in srgb, {option.colors['editor.fg']} 34%, transparent); width: 70%"></span>
            <span class="theme-preview-highlight" style="background: {option.colors['annot.comment']}"></span>
            <span class="theme-preview-line" style="background: color-mix(in srgb, {option.colors['editor.fg']} 34%, transparent); width: 76%"></span>
          </span>
          <span class="theme-preview-swatches">
            {#each themeSwatchKeys as key}<span class="theme-swatch" style="background: {option.colors[key]}"></span>{/each}
          </span>
        </span>
        <span class="theme-meta">
          <span class="theme-name">{option.name}</span>
          <span class="theme-kind">{option.user ? 'Своя тема' : option.kind === 'dark' ? 'Тёмная' : 'Светлая'}</span>
        </span>
      </button>
    {/each}
  </div>
{/snippet}

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
    <span class="tree-chevron">
      {#if entry.kind === 'directory'}<Icon name={expanded.has(entry.path) ? 'chevron-down' : 'chevron-right'} size={13} />{/if}
    </span>
    <span class="tree-icon">
      {#if entry.kind === 'directory'}<Icon name={expanded.has(entry.path) ? 'folder-open' : 'folder'} size={15} />{:else}<Icon name="file-text" size={14} />{/if}
    </span>
    <span class="tree-name">{entry.name.replace(/\.annot\.(json|md)$/i, '')}</span>
    {#if entry.annotationConflict}
      <span class="tree-conflict" title="Найдены оба формата sidecar-аннотаций"><Icon name="alert" size={12} /></span>
    {:else if entry.annotated}
      <span class="tree-annotated" title="Есть аннотации"><Icon name="spark" size={12} /></span>
    {/if}
  </div>
  {#if entry.kind === 'directory' && expanded.has(entry.path)}
    {#each children[entry.path] ?? [] as child (child.path)}
      {@render TreeEntry(child, depth + 1, expanded, children, toggleDirectory, openFile)}
    {/each}
  {/if}
{/snippet}
