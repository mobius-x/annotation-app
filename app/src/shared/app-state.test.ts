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
    })
    expect(appStateSchema.parse({
      folders: ['C:\\texts'],
      openTabs: ['C:\\texts\\chapter.txt'],
      activeTab: 0,
      lastWorkspace: 'C:\\texts\\library.annotator-workspace',
    })).toMatchObject({ folders: ['C:\\texts'], activeTab: 0 })
  })

  it('rejects unsupported state versions and invalid active tab indices', () => {
    expect(() => appStateSchema.parse({ version: 2 })).toThrow()
    expect(() => appStateSchema.parse({ activeTab: -1 })).toThrow()
  })
})
