import type { Annotation } from '../../shared/model'

export function createLineStarts(text: string): number[] {
  const starts = [0]
  for (let index = text.indexOf('\n'); index >= 0; index = text.indexOf('\n', index + 1)) {
    starts.push(index + 1)
  }
  return starts
}

export function lineNumberAt(lineStarts: number[], position: number): number {
  let low = 0
  let high = lineStarts.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (lineStarts[middle]! <= position) low = middle + 1
    else high = middle
  }
  return Math.max(1, low)
}

export function createOutlineRows(annotations: Annotation[], lineStarts: number[]) {
  return annotations
    .filter((annotation) => !annotation.orphan)
    .sort((left, right) => left.start - right.start || right.end - left.end)
    .map((annotation) => ({
      id: annotation.id,
      quote: annotation.quote.slice(0, 50),
      note: annotation.text.replace(/\s+/g, ' ').slice(0, 70),
      line: lineNumberAt(lineStarts, annotation.start),
      type: annotation.type,
    }))
}
