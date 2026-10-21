import { StateEffect, StateField, Transaction, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { invertedEffects } from '@codemirror/commands'
import type { Annotation } from '../../shared/model'

export const setAnnotationRanges = StateEffect.define<Annotation[]>()
export interface FocusViewOptions {
  enabled: boolean
  contextChars: number
  separator: 'blank1' | 'blank2' | 'ellipsis'
}

export const setFocusView = StateEffect.define<FocusViewOptions>()

export function getFocusRanges(annotations: Annotation[], length: number, contextChars = 0): Array<{ from: number; to: number }> {
  const sorted = annotations
    .filter((annotation) => !annotation.orphan && annotation.start < annotation.end)
    .map((annotation) => ({
      from: Math.max(0, annotation.start - contextChars),
      to: Math.min(length, annotation.end + contextChars),
    }))
    .sort((left, right) => left.from - right.from || left.to - right.to)
  const merged: Array<{ from: number; to: number }> = []
  for (const range of sorted) {
    const previous = merged.at(-1)
    if (previous && range.from <= previous.to) previous.to = Math.max(previous.to, range.to)
    else merged.push({ ...range })
  }
  return merged
}

class FocusGapWidget extends WidgetType {
  constructor(private readonly separator: FocusViewOptions['separator']) {
    super()
  }

  toDOM(): HTMLElement {
    const gap = document.createElement('span')
    gap.className = `cm-focus-gap cm-focus-gap-${this.separator}`
    gap.textContent = this.separator === 'ellipsis' ? '…' : ''
    return gap
  }
}

export const focusViewField = StateField.define<FocusViewOptions>({
  create: () => ({ enabled: false, contextChars: 0, separator: 'blank2' }),
  update(enabled, transaction) {
    for (const effect of transaction.effects) {
      if (effect.is(setFocusView)) enabled = effect.value
    }
    return enabled
  },
})

export const focusDecorations = StateField.define<DecorationSet>({
  create: (state) => buildFocusDecorations(state.doc.length, state.field(annotationField), state.field(focusViewField)),
  update(decorations, transaction) {
    if (!transaction.docChanged
      && !transaction.effects.some((effect) => effect.is(setAnnotationRanges) || effect.is(setFocusView))) return decorations
    const options = transaction.state.field(focusViewField)
    return buildFocusDecorations(
      transaction.newDoc.length,
      transaction.state.field(annotationField),
      options,
    )
  },
  provide: (field) => [
    EditorView.decorations.from(field),
    EditorView.atomicRanges.of((view) => view.state.field(field)),
  ],
})

function buildFocusDecorations(length: number, annotations: Annotation[], options: FocusViewOptions): DecorationSet {
  if (!options.enabled) return Decoration.none
  const visible = getFocusRanges(annotations, length, options.contextChars)
  const gaps: Range<Decoration>[] = []
  let position = 0
  for (const range of visible) {
    if (range.from > position) gaps.push(Decoration.replace({ widget: new FocusGapWidget(options.separator), inclusive: false }).range(position, range.from))
    position = range.to
  }
  if (position < length) gaps.push(Decoration.replace({ widget: new FocusGapWidget(options.separator), inclusive: false }).range(position, length))
  return Decoration.set(gaps, true)
}

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
