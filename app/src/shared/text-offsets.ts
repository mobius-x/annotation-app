export interface TextOffsets {
  utf16: number
  utf8: number
  grapheme: number
}

/** Converts a UTF-16 offset (the editor's native coordinate system) to interchange offsets. */
export function textOffsetsAt(text: string, utf16Offset: number): TextOffsets {
  const bounded = Math.max(0, Math.min(text.length, Math.trunc(utf16Offset)))
  const prefix = text.slice(0, bounded)
  const utf8 = new TextEncoder().encode(prefix).length
  const segmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null
  const grapheme = segmenter
    ? [...segmenter.segment(prefix)].length
    : [...prefix].length
  return { utf16: bounded, utf8, grapheme }
}

/** Captures quote context used to restore anchors when a source file changes. */
export function quoteContext(text: string, start: number, end: number, contextLength = 32): { exact: string; prefix: string; suffix: string } {
  const boundedStart = Math.max(0, Math.min(text.length, start))
  const boundedEnd = Math.max(boundedStart, Math.min(text.length, end))
  return {
    exact: text.slice(boundedStart, boundedEnd),
    prefix: text.slice(Math.max(0, boundedStart - contextLength), boundedStart),
    suffix: text.slice(boundedEnd, boundedEnd + contextLength),
  }
}

export function findQuoteMatches(text: string, exact: string): number[] {
  if (!exact) return []
  const matches: number[] = []
  for (let index = text.indexOf(exact); index >= 0; index = text.indexOf(exact, index + 1)) matches.push(index)
  return matches
}

export function restoreQuoteAnchor(
  text: string,
  quote: { exact: string; prefix?: string; suffix?: string },
  previousStart: number,
): { start: number; end: number; ambiguous: boolean } | null {
  const candidates = findQuoteMatches(text, quote.exact)
  if (!candidates.length) return null
  const scored = candidates.map((start) => {
    const prefix = quote.prefix ?? ''
    const suffix = quote.suffix ?? ''
    const actualPrefix = text.slice(Math.max(0, start - prefix.length), start)
    const actualSuffix = text.slice(start + quote.exact.length, start + quote.exact.length + suffix.length)
    const prefixScore = suffixLength(prefix, actualPrefix)
    const suffixScore = prefixLength(suffix, actualSuffix)
    const contextScore = prefixScore + suffixScore
    const distance = Math.abs(start - previousStart)
    return { start, contextScore, distance }
  }).sort((a, b) => b.contextScore - a.contextScore || a.distance - b.distance || a.start - b.start)
  const best = scored[0]!
  const tied = scored.filter((candidate) => candidate.contextScore === best.contextScore && candidate.distance === best.distance)
  if (tied.length > 1) return { start: best.start, end: best.start + quote.exact.length, ambiguous: true }
  return { start: best.start, end: best.start + quote.exact.length, ambiguous: false }
}

function suffixLength(expected: string, actual: string): number {
  let length = 0
  while (length < expected.length && length < actual.length && expected[expected.length - 1 - length] === actual[actual.length - 1 - length]) length += 1
  return length
}

function prefixLength(expected: string, actual: string): number {
  let length = 0
  while (length < expected.length && length < actual.length && expected[length] === actual[length]) length += 1
  return length
}
