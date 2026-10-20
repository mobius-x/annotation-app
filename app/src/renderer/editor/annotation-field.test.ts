import { describe, expect, it } from 'vitest'
import { invertedEffects } from '@codemirror/commands'
import { EditorState, Transaction } from '@codemirror/state'
import type { Annotation } from '../../shared/model'
import { annotationField, annotationHistory, setAnnotationRanges } from './annotation-field'

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
