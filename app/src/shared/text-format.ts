export type LineEnding = '\n' | '\r\n' | '\r'

export interface LineEndingInfo {
  eol: LineEnding
  mixed: boolean
}

export function detectLineEnding(text: string): LineEndingInfo {
  const counts: Record<LineEnding, number> = { '\n': 0, '\r\n': 0, '\r': 0 }
  let first: LineEnding | undefined
  for (const match of text.matchAll(/\r\n|\r|\n/g)) {
    const ending = match[0] as LineEnding
    counts[ending] += 1
    first ??= ending
  }
  const eol = (Object.keys(counts) as LineEnding[]).reduce((selected, candidate) =>
    counts[candidate] > counts[selected] ? candidate : selected,
  first ?? '\n')
  return {
    eol,
    mixed: Object.values(counts).filter((count) => count > 0).length > 1,
  }
}
