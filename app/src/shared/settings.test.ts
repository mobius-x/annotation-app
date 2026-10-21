import { describe, expect, it } from 'vitest'
import { contrastRatio, defaultSettings, getAnnotationMarkerColor, parseShortcut, resolveTheme, settingsSchema, themeSchema, themes } from './settings'

function blend(foreground: string, background: string, alpha: number): string {
  const channels = [1, 3, 5].map((offset) => {
    const fg = Number.parseInt(foreground.slice(offset, offset + 2), 16)
    const bg = Number.parseInt(background.slice(offset, offset + 2), 16)
    return Math.round(fg * alpha + bg * (1 - alpha)).toString(16).padStart(2, '0')
  })
  return `#${channels.join('')}`
}

describe('application settings', () => {
  it('fills defaults while preserving unknown extension keys', () => {
    const parsed = settingsSchema.parse({ customSection: { keep: true }, editor: { fontSize: 18, customEditorKey: 'keep too' } })
    expect(parsed.theme).toBe('dracula')
    expect(parsed.editor.fontSize).toBe(18)
    expect(parsed.editor.customEditorKey).toBe('keep too')
    expect(parsed.rendering.smoothing).toBe('system')
    expect(parsed.files.autosaveDelayMs).toBe(1500)
    expect(parsed.customSection).toEqual({ keep: true })
    expect(defaultSettings.focusView.contextChars).toBe(0)
  })

  it('rejects invalid font sizes and malformed color overrides', () => {
    expect(() => settingsSchema.parse({ editor: { fontSize: 100 } })).toThrow()
    expect(() => settingsSchema.parse({ colorOverrides: { 'annot.note': 'red' } })).toThrow()
    expect(() => settingsSchema.parse({ keybindings: { 'file.save': 'Ctrl+Alt+Q' } })).toThrow()
    expect(() => settingsSchema.parse({ keybindings: { 'file.save': 'Ctrl+C' } })).toThrow()
  })

  it('resolves each built-in palette and applies user overrides last', () => {
    for (const [id, theme] of Object.entries(themes)) {
      expect(resolveTheme(id).colors['editor.bg']).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.kind).toMatch(/^(dark|light)$/)
    }
    expect(resolveTheme('dracula', { 'annot.note': '#123456' }).colors['annot.note']).toBe('#123456')
    for (const id of Object.keys(themes)) {
      const theme = resolveTheme(id)
      expect(contrastRatio(theme.colors['editor.fg']!, theme.colors['editor.bg']!), `${id}: editor contrast`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(theme.colors['ui.fg']!, theme.colors['ui.bg']!), `${id}: UI contrast`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(theme.colors['ui.fgMuted']!, theme.colors['ui.bg']!), `${id}: muted UI contrast`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(theme.colors['ui.fgMuted']!, theme.colors['editor.bg']!), `${id}: muted editor contrast`).toBeGreaterThanOrEqual(4.5)
      expect(contrastRatio(theme.colors['ui.accentFg']!, theme.colors['ui.accent']!), `${id}: accent contrast`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('resolves fallback theme colors and parses physical-key shortcut chains', () => {
    expect(Object.keys(themes)).toHaveLength(12)
    expect(resolveTheme('solarized-light').colors['ui.fgMuted']).toBe('#52666d')
    expect(parseShortcut('Ctrl+K Ctrl+T')).toEqual(['Ctrl+K', 'Ctrl+T'])
    expect(parseShortcut('Ctrl+,')).toEqual(['Ctrl+,'])
    expect(() => parseShortcut('Ctrl+Alt+Q')).toThrow('AltGr')
    expect(() => parseShortcut('Ctrl+K Ctrl+T Ctrl+P')).toThrow('двух шагов')
  })

  it('validates custom theme data and inherits missing colors from built-ins', () => {
    const userTheme = themeSchema.parse({
      id: 'custom-dark',
      name: 'Custom Dark',
      type: 'dark',
      extends: 'dracula',
      colors: { 'ui.accent': '#123456' },
    })
    const resolved = resolveTheme(userTheme.id, {}, [userTheme])
    expect(resolved.colors['ui.accent']).toBe('#123456')
    expect(resolved.colors['editor.bg']).toBe(themes.dracula!.colors['editor.bg'])
    expect(() => themeSchema.parse({ ...userTheme, id: '../escape' })).toThrow()
  })

  it('keeps annotation text readable on default and active highlights', () => {
    const ids = ['comment', 'note', 'question', 'idea', 'todo', 'important']
    const alpha = defaultSettings.annotations.highlightAlpha
    const activeAlpha = Math.max(alpha, Math.min(alpha + 0.12, 0.35))
    const violations: string[] = []
    for (const [themeId, palette] of Object.entries(themes)) {
      for (const id of ids) {
        const highlight = palette.colors[`annot.${id}`]!
        const normalBackground = blend(highlight, palette.colors['editor.bg']!, alpha)
        const activeBackground = blend(highlight, palette.colors['editor.bg']!, activeAlpha)
        const normalContrast = contrastRatio(palette.colors['editor.fg']!, normalBackground)
        const activeContrast = contrastRatio(palette.colors['editor.fg']!, activeBackground)
        if (normalContrast < 4.5) violations.push(`${themeId}/${id} default ${normalContrast.toFixed(2)}:1`)
        if (activeContrast < 3) violations.push(`${themeId}/${id} active ${activeContrast.toFixed(2)}:1`)
      }
    }
    expect(violations).toEqual([])
  })

  it('keeps annotation type markers and resolved indicators distinct from card backgrounds', () => {
    const ids = ['comment', 'note', 'question', 'idea', 'todo', 'important']
    const violations: string[] = []
    for (const themeId of Object.keys(themes)) {
      const palette = resolveTheme(themeId)
      const backgrounds = {
        card: palette.colors['ui.bgAlt']!,
        hover: palette.colors['ui.hover']!,
        selected: palette.colors['ui.selectedRow']!,
      }
      for (const id of ids) {
        const markerColor = getAnnotationMarkerColor(palette, id)
        for (const [state, background] of Object.entries(backgrounds)) {
          const contrast = contrastRatio(markerColor, background)
          if (contrast < 3) violations.push(`${themeId}/${id} ${state} ${contrast.toFixed(2)}:1`)
        }
      }
      expect(
        contrastRatio(palette.colors['editor.fg']!, palette.colors['ui.bgAlt']!),
        `${themeId}: resolved indicator contrast`,
      ).toBeGreaterThanOrEqual(4.5)
    }
    expect(violations).toEqual([])
  })
})
