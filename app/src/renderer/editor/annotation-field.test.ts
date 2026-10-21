import { describe, expect, it } from 'vitest'
import { invertedEffects } from '@codemirror/commands'
import { EditorState, Transaction } from '@codemirror/state'
import type { Annotation } from '../../shared/model'
import { annotationField, annotationHistory, getFocusRanges, setAnnotationRanges } from './annotation-field'

const note: Annotation = {
  id: 'a123abc',
  type: 'note',
  text: 'Найти источник',
  start: 0,
  end: 4,
  quote: 'Текст',
  tags: [],
  resolved: false,
  color: null,
  created: '2026-10-21T00:00:00.000Z',
  modified: '2026-10-21T00:00:00.000Z',
}

describe('annotation history', () => {
  it('provides inverse effects for annotation edits to the editor history', () => {
    let state = EditorState.create({
      doc: 'Текст',
      extensions: [annotationField, annotationHistory],
    })

    const transaction = state.update({
      effects: setAnnotationRanges.of([note]),
      annotations: Transaction.addToHistory.of(true),
    })
    state = transaction.state
    expect(state.field(annotationField)).toHaveLength(1)

    const inverseEffects = state.facet(invertedEffects).flatMap((invert) => invert(transaction))
    state = state.update({ effects: inverseEffects }).state
    expect(state.field(annotationField)).toHaveLength(0)

    state = state.update({
      effects: setAnnotationRanges.of([note]),
      annotations: Transaction.addToHistory.of(true),
    }).state
    expect(state.field(annotationField)).toHaveLength(1)
  })
})

describe('focus view ranges', () => {
  it('merges touching and overlapping annotations and ignores orphans', () => {
    expect(getFocusRanges([
      { ...note, start: 2, end: 5 },
      { ...note, id: 'next', start: 5, end: 8 },
      { ...note, id: 'overlap', start: 7, end: 10 },
      { ...note, id: 'orphan', start: 12, end: 14, orphan: true },
    ], 20)).toEqual([{ from: 2, to: 10 }])
  })

  it('adds context and clips it to document bounds', () => {
    expect(getFocusRanges([{ ...note, start: 2, end: 4 }], 10, 5)).toEqual([{ from: 0, to: 9 }])
  })
})

describe('annotation ranges through editor changes', () => {
  it('maps edits before, inside, and at both boundaries using UTF-16 positions', () => {
    let state = EditorState.create({ doc: '0123456789', extensions: [annotationField] })
    state = state.update({ effects: setAnnotationRanges.of([{ ...note, start: 3, end: 7 }]) }).state
    state = state.update({ changes: { from: 0, insert: '😀' } }).state
    expect(state.field(annotationField)[0]).toMatchObject({ start: 5, end: 9 })
    state = state.update({ changes: { from: 7, insert: 'X' } }).state
    expect(state.field(annotationField)[0]).toMatchObject({ start: 5, end: 10 })
    state = state.update({ changes: { from: 5, insert: 'Y' } }).state
    expect(state.field(annotationField)[0]).toMatchObject({ start: 6, end: 11 })
  })

  it('orphans a collapsed annotation and retains overlapping annotations independently', () => {
    let state = EditorState.create({ doc: 'abcdefghij', extensions: [annotationField] })
    const overlapping = [{ ...note, start: 1, end: 5 }, { ...note, id: 'second', start: 3, end: 7 }]
    state = state.update({ effects: setAnnotationRanges.of(overlapping) }).state
    state = state.update({ changes: { from: 1, to: 5, insert: '' } }).state
    expect(state.field(annotationField)).toHaveLength(2)
    expect(state.field(annotationField)[0]).toMatchObject({ orphan: true })
    expect(state.field(annotationField)[1]).toMatchObject({ id: 'second', start: 1, end: 3 })
  })
})
