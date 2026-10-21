import { z } from 'zod'

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  theme: z.string().default('dracula'),
  themeFollowSystem: z.object({
    enabled: z.boolean().default(false),
    light: z.string().default('github-light'),
    dark: z.string().default('github-dark'),
  }).passthrough().default({ enabled: false, light: 'github-light', dark: 'github-dark' }),
  colorOverrides: z.record(z.string(), colorSchema).default({}),
  ui: z.object({
    fontFamily: z.string().min(1).default('Segoe UI'),
    fontSize: z.number().int().min(8).max(48).default(13),
    zoom: z.number().min(0.75).max(1.5).default(1),
  }).passthrough().default({ fontFamily: 'Segoe UI', fontSize: 13, zoom: 1 }),
  explorer: z.object({
    showAnnotFiles: z.boolean().default(false),
    showAllFiles: z.boolean().default(false),
  }).passthrough().default({ showAnnotFiles: false, showAllFiles: false }),
  editor: z.object({
    fontFamily: z.string().min(1).default('Cascadia Mono, Consolas, monospace'),
    fontSize: z.number().int().min(8).max(48).default(16),
    fontWeight: z.number().int().min(100).max(900).default(400),
    lineHeight: z.number().min(1).max(3).default(1.6),
    ligatures: z.boolean().default(false),
    wrap: z.boolean().default(true),
    maxLineWidthCh: z.number().int().min(40).max(240).default(100),
    lineNumbers: z.boolean().default(false),
    readOnly: z.boolean().default(false),
  }).passthrough().default({
    fontFamily: 'Cascadia Mono, Consolas, monospace',
    fontSize: 16,
    fontWeight: 400,
    lineHeight: 1.6,
    ligatures: false,
    wrap: true,
    maxLineWidthCh: 100,
    lineNumbers: false,
    readOnly: false,
  }),
  annotationsPanel: z.object({
    fontFamily: z.string().min(1).default('Segoe UI'),
    fontSize: z.number().int().min(8).max(48).default(14),
    lineHeight: z.number().min(1).max(3).default(1.5),
    showQuote: z.boolean().default(true),
    linkScroll: z.boolean().default(true),
    sort: z.enum(['position', 'created', 'modified']).default('position'),
  }).passthrough().default({
    fontFamily: 'Segoe UI',
    fontSize: 14,
    lineHeight: 1.5,
    showQuote: true,
    linkScroll: true,
    sort: 'position',
  }),
  annotations: z.object({
    highlightAlpha: z.number().min(0.05).max(0.6).default(0.18),
    highlightColor: colorSchema.nullable().default(null),
    colorByType: z.boolean().default(true),
    types: z.array(z.object({
      id: z.string().min(1),
      label: z.string().min(1),
      color: colorSchema.nullable().default(null),
    }).passthrough()).default([
      { id: 'comment', label: 'Комментарий', color: null },
      { id: 'note', label: 'Заметка', color: null },
      { id: 'question', label: 'Вопрос', color: null },
      { id: 'idea', label: 'Идея', color: null },
      { id: 'todo', label: 'Задача', color: null },
      { id: 'important', label: 'Важно', color: null },
    ]),
    defaultType: z.string().default('comment'),
  }).passthrough().default({
    highlightAlpha: 0.18,
    highlightColor: null,
    colorByType: true,
    types: [
      { id: 'comment', label: 'Комментарий', color: null },
      { id: 'note', label: 'Заметка', color: null },
      { id: 'question', label: 'Вопрос', color: null },
      { id: 'idea', label: 'Идея', color: null },
      { id: 'todo', label: 'Задача', color: null },
      { id: 'important', label: 'Важно', color: null },
    ],
    defaultType: 'comment',
  }),
  focusView: z.object({
    contextChars: z.number().int().min(0).max(500).default(0),
    separator: z.enum(['blank1', 'blank2', 'ellipsis']).default('blank2'),
  }).passthrough().default({ contextChars: 0, separator: 'blank2' }),
  rendering: z.object({
    smoothing: z.enum(['system', 'grayscale']).default('system'),
  }).passthrough().default({ smoothing: 'system' }),
  files: z.object({
    saveFormat: z.enum(['json', 'md']).default('json'),
    autosave: z.boolean().default(true),
    autosaveDelayMs: z.number().int().min(250).max(10000).default(1500),
    autosaveMaxWaitMs: z.number().int().min(1000).max(120000).default(30000),
    autosavePlain: z.boolean().default(false),
    backupIntervalMin: z.number().int().min(1).max(1440).default(10),
    defaultEol: z.enum(['lf', 'crlf']).default('lf'),
    encoding: z.enum(['utf-8', 'windows-1251', 'utf-16le', 'utf-16be', 'koi8-r', 'iso-8859-1']).default('utf-8'),
  }).passthrough().default({
    saveFormat: 'json',
    autosave: true,
    autosaveDelayMs: 1500,
    autosaveMaxWaitMs: 30000,
    autosavePlain: false,
    backupIntervalMin: 10,
    defaultEol: 'lf',
    encoding: 'utf-8',
  }),
  keybindings: z.record(z.string(), z.string().nullable().refine((shortcut) => {
    if (!shortcut) return true
    try {
      const strokes = parseShortcut(shortcut)
      return !strokes.some((stroke) => ['Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+A'].includes(stroke))
    } catch {
      return false
    }
  }, 'Некорректное или зарезервированное сочетание клавиш.')).default({}),
}).passthrough()

export type AppSettings = z.infer<typeof settingsSchema>

export const defaultSettings: AppSettings = settingsSchema.parse({})

export interface ThemePalette {
  kind: 'dark' | 'light'
  colors: Record<string, string>
}

const annotationTypeIds = ['comment', 'note', 'question', 'idea', 'todo', 'important'] as const

export const themes: Record<string, ThemePalette> = {
  dracula: {
    kind: 'dark',
    colors: {
      'ui.bg': '#21222c', 'ui.fg': '#f8f8f2', 'ui.fgMuted': '#a5abc4', 'ui.border': '#3a3c4a',
      'ui.accent': '#bd93f9', 'ui.accentFg': '#282a36', 'ui.hover': '#343644', 'ui.danger': '#ff6b76',
      'editor.bg': '#282a36', 'editor.fg': '#f8f8f2', 'editor.selection': '#44475a', 'editor.gutterFg': '#a5abc4',
      'annot.default': '#f1fa8c', 'annot.comment': '#f1fa8c', 'annot.note': '#8be9fd',
      'annot.question': '#ffb86c', 'annot.idea': '#50fa7b', 'annot.todo': '#ff5555', 'annot.important': '#ff79c6',
    },
  },
  'github-light': {
    kind: 'light',
    colors: {
      'ui.bg': '#f6f8fa', 'ui.fg': '#1f2328', 'ui.fgMuted': '#59636e', 'ui.border': '#d0d7de',
      'ui.accent': '#0969da', 'ui.accentFg': '#ffffff', 'ui.hover': '#eaeef2', 'ui.danger': '#cf222e',
      'editor.bg': '#ffffff', 'editor.fg': '#1f2328', 'editor.selection': '#b6e3ff', 'editor.gutterFg': '#59636e',
      'annot.default': '#bf8700', 'annot.comment': '#bf8700', 'annot.note': '#0969da',
      'annot.question': '#bc4c00', 'annot.idea': '#1a7f37', 'annot.todo': '#cf222e', 'annot.important': '#8250df',
    },
  },
  'github-dark': {
    kind: 'dark',
    colors: {
      'ui.bg': '#161b22', 'ui.fg': '#e6edf3', 'ui.fgMuted': '#8b949e', 'ui.border': '#30363d',
      'ui.accent': '#58a6ff', 'ui.accentFg': '#0d1117', 'ui.hover': '#21262d', 'ui.danger': '#ff7b72',
      'editor.bg': '#0d1117', 'editor.fg': '#e6edf3', 'editor.selection': '#264f78', 'editor.gutterFg': '#8b949e',
      'annot.default': '#d29922', 'annot.comment': '#d29922', 'annot.note': '#58a6ff',
      'annot.question': '#db6d28', 'annot.idea': '#3fb950', 'annot.todo': '#f85149', 'annot.important': '#bc8cff',
    },
  },
  nord: {
    kind: 'dark',
    colors: {
      'ui.bg': '#272c36', 'ui.fg': '#d8dee9', 'ui.fgMuted': '#aab4c5', 'ui.border': '#434c5e',
      'ui.accent': '#88c0d0', 'ui.accentFg': '#2e3440', 'ui.hover': '#343c49', 'ui.danger': '#bf616a',
      'editor.bg': '#2e3440', 'editor.fg': '#d8dee9', 'editor.selection': '#434c5e', 'editor.gutterFg': '#aab4c5',
      'annot.default': '#ebcb8b', 'annot.comment': '#ebcb8b', 'annot.note': '#88c0d0',
      'annot.question': '#d08770', 'annot.idea': '#a3be8c', 'annot.todo': '#bf616a', 'annot.important': '#b48ead',
    },
  },
}

function palette(kind: ThemePalette['kind'], editorBg: string, editorFg: string, uiBg: string, accent: string, selection: string, annot: string[]): ThemePalette {
  const annotationIds = ['default', 'comment', 'note', 'question', 'idea', 'todo', 'important']
  return {
    kind,
    colors: {
      'ui.bg': uiBg,
      'ui.fg': editorFg,
      'ui.fgMuted': editorFg,
      'ui.border': selection,
      'ui.accent': accent,
      'ui.hover': selection,
      'ui.danger': annot[4]!,
      'editor.bg': editorBg,
      'editor.fg': editorFg,
      'editor.selection': selection,
      'editor.gutterFg': editorFg,
      ...Object.fromEntries(annotationIds.map((id, index) => [`annot.${id}`, annot[index] ?? annot[0]!])),
    },
  }
}

Object.assign(themes, {
  'solarized-dark': palette('dark', '#002b36', '#839496', '#00212b', '#268bd2', '#073642', ['#b58900', '#cb4b16', '#2aa198', '#6c71c4', '#859900', '#dc322f', '#d33682']),
  'solarized-light': palette('light', '#fdf6e3', '#586e75', '#eee8d5', '#268bd2', '#eee8d5', ['#b58900', '#cb4b16', '#2aa198', '#6c71c4', '#859900', '#dc322f', '#d33682']),
  monokai: palette('dark', '#272822', '#f8f8f2', '#1e1f1c', '#a6e22e', '#49483e', ['#e6db74', '#f92672', '#66d9ef', '#ae81ff', '#a6e22e', '#fd971f', '#f92672']),
  cobalt2: palette('dark', '#193549', '#ffffff', '#15232d', '#ffc600', '#0d3a58', ['#ffc600', '#ff628c', '#0088ff', '#ae81ff', '#3ad900', '#ff9d00', '#ff628c']),
  'one-dark': palette('dark', '#282c34', '#abb2bf', '#21252b', '#61afef', '#3e4451', ['#e5c07b', '#e06c75', '#56b6c2', '#c678dd', '#98c379', '#e06c75', '#c678dd']),
  'gruvbox-dark': palette('dark', '#282828', '#ebdbb2', '#1d2021', '#fabd2f', '#504945', ['#fabd2f', '#fb4934', '#83a598', '#d3869b', '#b8bb26', '#fb4934', '#d3869b']),
  'tokyo-night': palette('dark', '#1a1b26', '#c0caf5', '#16161e', '#7aa2f7', '#283457', ['#e0af68', '#f7768e', '#7dcfff', '#bb9af7', '#9ece6a', '#f7768e', '#bb9af7']),
  'paper-light': palette('light', '#faf8f3', '#2b2b2b', '#efece4', '#8a5a00', '#e8dfc8', ['#8a5a00', '#9a6700', '#0969da', '#bc4c00', '#1a7f37', '#cf222e', '#8250df']),
})
themes['solarized-light']!.colors['ui.fg'] = '#52666d'
themes['solarized-light']!.colors['ui.fgMuted'] = '#52666d'

for (const theme of Object.values(themes)) {
  const background = theme.colors['editor.bg']!
  const text = theme.colors['editor.fg']!
  const alpha = defaultSettings.annotations.highlightAlpha
  const activeAlpha = Math.max(alpha, Math.min(alpha + 0.12, 0.35))
  for (const id of annotationTypeIds) {
    const key = `annot.${id}`
    const original = theme.colors[key]!
    for (let step = 0; step <= 100; step += 1) {
      const candidate = interpolateColor(original, background, step / 100)
      if (contrastRatio(text, blendColor(candidate, background, alpha)) >= 4.5
        && contrastRatio(text, blendColor(candidate, background, activeAlpha)) >= 3) {
        theme.colors[key] = candidate
        break
      }
    }
  }
}

export const themeSchema = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/),
  name: z.string().min(1).max(80),
  type: z.enum(['dark', 'light']),
  extends: z.string().nullable().default(null),
  colors: z.record(z.string(), z.string().regex(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/)),
})

export type UserTheme = z.infer<typeof themeSchema>

export function contrastRatio(left: string, right: string): number {
  const luminance = (color: string) => {
    const normalized = color.length === 4
      ? `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`
      : color.slice(0, 7)
    const channels = [1, 3, 5].map((offset) => {
      const value = Number.parseInt(normalized.slice(offset, offset + 2), 16) / 255
      return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    })
    return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722
  }
  const a = luminance(left)
  const b = luminance(right)
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
}

function blendColor(foreground: string, background: string, alpha: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const fg = Number.parseInt(foreground.slice(offset, offset + 2), 16)
    const bg = Number.parseInt(background.slice(offset, offset + 2), 16)
    return Math.round(fg * alpha + bg * (1 - alpha)).toString(16).padStart(2, '0')
  })
  return `#${channels.join('')}`
}

function interpolateColor(from: string, to: string, fraction: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const start = Number.parseInt(from.slice(offset, offset + 2), 16)
    const end = Number.parseInt(to.slice(offset, offset + 2), 16)
    return Math.round(start * (1 - fraction) + end * fraction).toString(16).padStart(2, '0')
  })
  return `#${channels.join('')}`
}

export function resolveTheme(themeId: string, overrides: Record<string, string> = {}, userThemes: UserTheme[] = []): ThemePalette {
  const userTheme = userThemes.find((theme) => theme.id === themeId)
  const parent = userTheme?.extends ? themes[userTheme.extends] : undefined
  const theme = userTheme
    ? { kind: userTheme.type, colors: { ...parent?.colors, ...userTheme.colors } }
    : themes[themeId] ?? themes.dracula!
  const colors = { ...theme.colors }
  const required = ['ui.bg', 'ui.fg', 'ui.accent', 'editor.bg', 'editor.fg', 'editor.selection', 'annot.default']
  if (required.some((key) => !colors[key])) throw new Error(`В теме «${themeId}» отсутствует обязательный цвет.`)
  colors['ui.bgAlt'] ??= colors['editor.bg']!
  colors['ui.fgMuted'] ??= colors['ui.fg']!
  colors['ui.hover'] ??= colors['editor.selection']!
  colors['ui.selectedRow'] ??= colors['editor.selection']!
  colors['ui.border'] ??= colors['editor.selection']!
  colors['ui.danger'] ??= theme.kind === 'dark' ? '#ff6b76' : '#cf222e'
  if (!colors['ui.accentFg'] || overrides['ui.accent'] && !overrides['ui.accentFg']) {
    colors['ui.accentFg'] = contrastRatio(colors['ui.accent']!, '#000000') >= contrastRatio(colors['ui.accent']!, '#ffffff')
      ? '#000000'
      : '#ffffff'
  }

  colors['editor.caret'] ??= colors['editor.fg']!
  colors['editor.lineHighlight'] ??= colors['editor.selection']!
  colors['editor.gutterFg'] ??= colors['ui.fgMuted']!
  for (const key of ['comment', 'note', 'question', 'idea', 'todo', 'important']) {
    colors[`annot.${key}`] ??= colors['annot.default']!
  }
  colors['annot.cardBg'] ??= colors['ui.bg']!
  colors['annot.cardBorder'] ??= colors['ui.border']!
  return {
    kind: theme.kind,
    colors: { ...colors, ...overrides },
  }
}

export function getAnnotationMarkerColor(palette: ThemePalette, typeId: string): string {
  const color = palette.colors[`annot.${typeId}`] ?? palette.colors['annot.default']!
  const markerBackgrounds = [
    palette.colors['ui.bgAlt'] ?? palette.colors['editor.bg']!,
    palette.colors['ui.hover'] ?? palette.colors['editor.selection']!,
    palette.colors['ui.selectedRow'] ?? palette.colors['editor.selection']!,
  ]
  const minContrast = (candidate: string) => Math.min(
    ...markerBackgrounds.map((background) => contrastRatio(candidate, background)),
  )
  if (minContrast(color) >= 3) return color
  const blackContrast = minContrast('#000000')
  const whiteContrast = minContrast('#ffffff')
  const endpoint = blackContrast > whiteContrast ? '#000000' : '#ffffff'
  for (let step = 1; step <= 100; step += 1) {
    const candidate = interpolateColor(color, endpoint, step / 100)
    if (minContrast(candidate) >= 3) return candidate
  }
  return endpoint
}

export function parseShortcut(shortcut: string): string[] {
  if (!shortcut.trim()) throw new Error('Сочетание клавиш не может быть пустым.')
  const strokes = shortcut.trim().split(/\s+/)
  if (strokes.length > 2) throw new Error('Поддерживаются сочетания максимум из двух шагов.')
  return strokes.map((stroke) => {
    const parts = stroke.split('+')
    const key = parts.pop()
    if (!key || parts.some((part) => !['Ctrl', 'Shift', 'Alt'].includes(part))) {
      throw new Error(`Некорректное сочетание клавиш: ${stroke}`)
    }
    if (parts.includes('Ctrl') && parts.includes('Alt')) {
      throw new Error('Сочетания Ctrl+Alt не поддерживаются из-за конфликта с AltGr.')
    }
    const orderedModifiers = ['Ctrl', 'Shift', 'Alt'].filter((modifier) => parts.includes(modifier))
    if (new Set(parts).size !== parts.length) throw new Error(`Повтор модификатора в сочетании ${stroke}`)
    if (!orderedModifiers.length && /^[A-Z0-9,]$/i.test(key) && !/^F\d{1,2}$/i.test(key)) {
      throw new Error('Для букв и цифр требуется модификатор Ctrl, Shift или Alt.')
    }
    return orderedModifiers.concat(key).join('+')
  })
}
