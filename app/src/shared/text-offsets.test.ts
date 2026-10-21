import { describe, expect, it } from 'vitest'
import { quoteContext, restoreQuoteAnchor, textOffsetsAt } from './text-offsets'

describe('text offset adapters and quote anchors', () => {
  it('keeps UTF-16 offsets and computes UTF-8 and grapheme coordinates for Unicode', () => {
    const text = 'A😀e\u0301Б'
    expect(textOffsetsAt(text, 3)).toEqual({ utf16: 3, utf8: 5, grapheme: 2 })
    expect(textOffsetsAt(text, 5)).toEqual({ utf16: 5, utf8: 8, grapheme: 3 })
  })

  it('captures 32 characters of context and restores a shifted quote', () => {
    const source = `${'до'.repeat(20)} ЦИТАТА ${'после'.repeat(10)}`
    const start = source.indexOf('ЦИТАТА')
    const quote = quoteContext(source, start, start + 6)
    const changed = `вставка ${source}`
    expect(quote.prefix.length).toBe(32)
    expect(restoreQuoteAnchor(changed, quote, start)).toMatchObject({ start: start + 8, end: start + 14, ambiguous: false })
  })

  it('marks repeated anchors ambiguous when quote context and old position cannot distinguish them', () => {
    const text = 'одинаково одинаково'
    expect(restoreQuoteAnchor(text, { exact: 'одинаково' }, 5)?.ambiguous).toBe(true)
  })

  it('returns no anchor when the quote was removed', () => {
    expect(restoreQuoteAnchor('другой текст', { exact: 'цитата' }, 0)).toBeNull()
  })
})
