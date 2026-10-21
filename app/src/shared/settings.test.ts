import { describe, expect, it } from 'vitest'
import { defaultSettings, resolveTheme, settingsSchema, themes } from './settings'

describe('application settings', () => {
  it('fills defaults while preserving unknown extension keys', () => {
    const parsed = settingsSchema.parse({ customSection: { keep: true } })
    expect(parsed.theme).toBe('dracula')
    expect(parsed.editor.fontSize).toBe(16)
    expect(parsed.customSection).toEqual({ keep: true })
    expect(defaultSettings.focusView.contextChars).toBe(0)
  })

  it('rejects invalid font sizes and malformed color overrides', () => {
    expect(() => settingsSchema.parse({ editor: { fontSize: 100 } })).toThrow()
    expect(() => settingsSchema.parse({ colorOverrides: { 'annot.note': 'red' } })).toThrow()
  })

  it('resolves each built-in palette and applies user overrides last', () => {
    for (const [id, theme] of Object.entries(themes)) {
      expect(resolveTheme(id).colors['editor.bg']).toMatch(/^#[0-9a-f]{6}$/i)
      expect(theme.kind).toMatch(/^(dark|light)$/)
    }
    expect(resolveTheme('dracula', { 'annot.note': '#123456' }).colors['annot.note']).toBe('#123456')
  })
})
