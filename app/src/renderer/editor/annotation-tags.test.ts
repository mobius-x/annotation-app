import { describe, expect, it } from 'vitest'
import { parseTags } from './annotation-tags'

describe('annotation tags', () => {
  it('normalizes hashes and whitespace and deduplicates without losing first casing', () => {
    expect(parseTags(' #Сюжет #важная_тема, #герой, важная тема ', ['герой', 'Улика'])).toEqual([
      'герой',
      'Улика',
      'Сюжет',
      'важная_тема',
    ])
  })

  it('returns no empty tags', () => {
    expect(parseTags('###   ,  ')).toEqual([])
  })
})
