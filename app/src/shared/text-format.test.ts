import { describe, expect, it } from 'vitest'
import { detectLineEnding } from './text-format'

describe('detectLineEnding', () => {
  it('recognizes uniform LF, CRLF, and CR input', () => {
    expect(detectLineEnding('one\ntwo\n')).toEqual({ eol: '\n', mixed: false })
    expect(detectLineEnding('one\r\ntwo\r\n')).toEqual({ eol: '\r\n', mixed: false })
    expect(detectLineEnding('one\rtwo\r')).toEqual({ eol: '\r', mixed: false })
  })

  it('chooses the most frequent ending and identifies mixed input', () => {
    expect(detectLineEnding('a\nb\r\nc\n')).toEqual({ eol: '\n', mixed: true })
    expect(detectLineEnding('a\rb\r\nc\r')).toEqual({ eol: '\r', mixed: true })
  })

  it('uses the first ending to break ties and LF for text without line endings', () => {
    expect(detectLineEnding('a\r\nb\n')).toEqual({ eol: '\r\n', mixed: true })
    expect(detectLineEnding('no newline')).toEqual({ eol: '\n', mixed: false })
  })
})
