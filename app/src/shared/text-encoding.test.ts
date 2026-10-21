import iconv from 'iconv-lite'
import { describe, expect, it } from 'vitest'
import { decodeTextBuffer, encodeTextBuffer } from './text-encoding'

describe('text encoding detection and overrides', () => {
  it('detects UTF-8 with and without a byte-order mark', () => {
    expect(decodeTextBuffer(Buffer.from('Текст', 'utf8'))).toEqual({
      text: 'Текст',
      encoding: 'utf-8',
      hasBom: false,
    })
    expect(decodeTextBuffer(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('Текст', 'utf8')]))).toEqual({
      text: 'Текст',
      encoding: 'utf-8',
      hasBom: true,
    })
  })

  it('decodes Windows-1251 automatically and accepts an explicit encoding', () => {
    const source = iconv.encode('Привет, мир!', 'windows-1251')
    expect(decodeTextBuffer(source).text).toBe('Привет, мир!')
    expect(decodeTextBuffer(source, 'windows-1251')).toEqual({
      text: 'Привет, мир!',
      encoding: 'windows-1251',
      hasBom: false,
    })
  })

  it('supports UTF-16 byte order marks and rejects unknown explicit encodings', () => {
    const utf16 = Buffer.from([0xff, 0xfe, 0x41, 0x00])
    expect(decodeTextBuffer(utf16)).toEqual({
      text: 'A',
      encoding: 'utf-16le',
      hasBom: true,
    })
    expect(decodeTextBuffer(utf16, 'windows-1251').hasBom).toBe(false)
    expect(() => decodeTextBuffer(Buffer.from('x'), 'unknown-encoding')).toThrow('Неизвестная кодировка')
  })

  it('round-trips text, line endings, and BOMs, and rejects unrepresentable text', () => {
    const contents = encodeTextBuffer('Текст\nстрока', 'utf-16be', '\r\n', true)
    expect(contents.subarray(0, 2)).toEqual(Buffer.from([0xfe, 0xff]))
    expect(decodeTextBuffer(contents)).toEqual({
      text: 'Текст\r\nстрока',
      encoding: 'utf-16be',
      hasBom: true,
    })
    expect(() => encodeTextBuffer('Смайл 😀', 'windows-1251', '\n', false)).toThrow('Сохраните исходник в UTF-8')
  })
})
