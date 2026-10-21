import { describe, expect, it } from 'vitest'
import { appStateSchema } from './app-state'

describe('application state', () => {
  it('fills defaults for a new state and preserves persisted workspace state', () => {
    expect(appStateSchema.parse({})).toEqual({
      version: 1,
      folders: [],
      openTabs: [],
      activeTab: 0,
      lastWorkspace: null,
      layout: {
        explorerWidth: 250,
        annotationsWidth: 340,
        showExplorer: true,
        showAnnotations: true,
        showOutline: true,
      },
    })
    expect(appStateSchema.parse({
      folders: ['C:\\texts'],
      openTabs: ['C:\\texts\\chapter.txt'],
      activeTab: 0,
      lastWorkspace: 'C:\\texts\\library.annotator-workspace',
    })).toMatchObject({ folders: ['C:\\texts'], activeTab: 0 })
  })

  it('restores valid panel layout and repairs invalid layout without losing workspace state', () => {
    expect(appStateSchema.parse({
      folders: ['C:\\texts'],
      layout: {
        explorerWidth: 320,
        annotationsWidth: 400,
        showExplorer: false,
        showAnnotations: true,
        showOutline: false,
      },
    })).toMatchObject({
      folders: ['C:\\texts'],
      layout: { explorerWidth: 320, annotationsWidth: 400, showExplorer: false, showAnnotations: true, showOutline: false },
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
