import { describe, expect, it } from 'vitest'
import { appStateSchema } from './app-state'

describe('application state', () => {
  it('fills defaults for a new state and preserves persisted folders and tabs', () => {
    expect(appStateSchema.parse({})).toEqual({
      version: 1,
      folders: [],
      openTabs: [],
      activeTab: 0,
      layout: {
        explorerWidth: 250,
        annotationsWidth: 340,
        showExplorer: true,
        showAnnotations: true,
        showOutline: true,
        outlineHeight: 230,
      },
    })
    expect(appStateSchema.parse({
      folders: ['C:\\texts'],
      openTabs: ['C:\\texts\\chapter.txt'],
      activeTab: 0,
    })).toMatchObject({ folders: ['C:\\texts'], activeTab: 0 })
  })

  it('restores valid panel layout and repairs invalid layout without losing folder state', () => {
    expect(appStateSchema.parse({
      folders: ['C:\\texts'],
      layout: {
        explorerWidth: 320,
        annotationsWidth: 400,
        showExplorer: false,
        showAnnotations: true,
        showOutline: false,
        outlineHeight: 320,
      },
    })).toMatchObject({
      folders: ['C:\\texts'],
      layout: { explorerWidth: 320, annotationsWidth: 400, showExplorer: false, showAnnotations: true, showOutline: false, outlineHeight: 320 },
    })

    expect(appStateSchema.parse({
      folders: ['C:\\texts'],
      layout: { explorerWidth: 900, annotationsWidth: -1, showExplorer: 'no' },
    })).toMatchObject({
      folders: ['C:\\texts'],
      layout: { explorerWidth: 250, annotationsWidth: 340, showExplorer: true, showAnnotations: true, showOutline: true },
    })
  })

  it('rejects unsupported state versions and invalid active tab indices', () => {
    expect(() => appStateSchema.parse({ version: 2 })).toThrow()
    expect(() => appStateSchema.parse({ activeTab: -1 })).toThrow()
  })
})
