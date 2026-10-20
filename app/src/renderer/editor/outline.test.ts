import { describe, expect, it } from 'vitest'
import type { Annotation } from '../../shared/model'
import { createLineStarts, createOutlineRows, lineNumberAt } from './outline'

const note: Annotation = {
  id: 'one',
  type: 'question',
  text: 'Проверить источник',
  start: 4,
  end: 12,
  quote: 'важный фрагмент',
  tags: [],
  resolved: false,
  color: null,
  created: '',
  modified: '',
}

describe('annotation outline', () => {
  it('maps offsets to one-based lines including empty and final lines', () => {
    const starts = createLineStarts('Первая\n\nПоследняя\n')
    expect(starts).toEqual([0, 7, 8, 18])
    expect(lineNumberAt(starts, 6)).toBe(1)
    expect(lineNumberAt(starts, 7)).toBe(2)
    expect(lineNumberAt(starts, 8)).toBe(3)
    expect(lineNumberAt(starts, 18)).toBe(4)
  })

  it('orders linked annotations by position and excludes orphans', () => {
    const rows = createOutlineRows([
      { ...note, id: 'later', start: 14 },
      { ...note, id: 'orphan', orphan: true, start: 0 },
      note,
    ], [0, 10, 20])
    expect(rows.map((row) => [row.id, row.line])).toEqual([['one', 1], ['later', 2]])
  })
})
