import { z } from 'zod'

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/)

export const settingsSchema = z.object({
  version: z.literal(1).default(1),
  theme: z.string().default('dracula'),
  colorOverrides: z.record(z.string(), colorSchema).default({}),
  editor: z.object({
    fontFamily: z.string().min(1).default('Cascadia Mono, Consolas, monospace'),
    fontSize: z.number().int().min(8).max(48).default(16),
    lineHeight: z.number().min(1).max(3).default(1.6),
    wrap: z.boolean().default(true),
  }).default({ fontFamily: 'Cascadia Mono, Consolas, monospace', fontSize: 16, lineHeight: 1.6, wrap: true }),
  focusView: z.object({
    contextChars: z.number().int().min(0).max(500).default(0),
  }).default({ contextChars: 0 }),
}).passthrough()

export type AppSettings = z.infer<typeof settingsSchema>

export const defaultSettings: AppSettings = settingsSchema.parse({})

interface ThemePalette {
  kind: 'dark' | 'light'
  colors: Record<string, string>
}

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

export function resolveTheme(themeId: string, overrides: Record<string, string> = {}): ThemePalette {
  const theme = themes[themeId] ?? themes.dracula!
  return {
    kind: theme.kind,
    colors: { ...theme.colors, ...overrides },
  }
}
