import { StateEffect, StateField, Transaction } from '@codemirror/state'
import { Decoration, EditorView } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'
import type { Annotation } from '../../shared/model'

export const setAnnotationRanges = StateEffect.define<Annotation[]>()
export const annotationHistory = invertedEffects.of((transaction) => {
  if (transaction.annotation(Transaction.addToHistory) === false) return []
  return transaction.effects.some((effect) => effect.is(setAnnotationRanges))
    ? [setAnnotationRanges.of(transaction.startState.field(annotationField))]
    : []
})

export const annotationField = StateField.define<Annotation[]>({
  create: () => [],
  update(ranges, transaction) {
    const mapped = transaction.docChanged
      ? ranges.map((range) => {
          if (range.orphan) return range
          const start = transaction.changes.mapPos(range.start, 1)
          const end = transaction.changes.mapPos(range.end, -1)
          return end <= start
            ? { ...range, start, end: start, orphan: true }
            : { ...range, start, end }
        })
      : ranges
    for (const effect of transaction.effects) {
      if (effect.is(setAnnotationRanges)) return effect.value
    }
    return mapped
  },
  provide: (field) => EditorView.decorations.from(field, (ranges) => Decoration.set(
    ranges
      .filter((annotation) => !annotation.orphan && annotation.start < annotation.end)
      .map((annotation) => Decoration.mark({ class: `annot-mark annot-${annotation.type.replace(/[^a-z0-9_-]/gi, '')}` }).range(annotation.start, annotation.end)),
    true,
  )),
})
