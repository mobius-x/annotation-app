import chardet from 'chardet'
import iconv from 'iconv-lite'

export interface DecodedText {
  text: string
  encoding: string
  hasBom: boolean
}

function iconvEncoding(encoding: string): string {
  return encoding.toLowerCase().replace(/[^a-z0-9]/g, '') === 'utf16be' ? 'utf16-be' : encoding
}

export function decodeTextBuffer(buffer: Buffer, forcedEncoding?: string): DecodedText {
  if (forcedEncoding) {
    const decoderEncoding = iconvEncoding(forcedEncoding)
    if (!iconv.encodingExists(decoderEncoding)) throw new Error(`Неизвестная кодировка: ${forcedEncoding}`)
    let contents = buffer
    let bomEncoding: string | null = null
    if (contents.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
      contents = contents.subarray(3)
      bomEncoding = 'utf-8'
    } else if (contents.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))
      || contents.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
      bomEncoding = contents[0] === 0xff ? 'utf-16le' : 'utf-16be'
      contents = contents.subarray(2)
    }
    const canonical = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '')
    const hasBom = bomEncoding !== null && canonical(bomEncoding) === canonical(forcedEncoding)
    return { text: iconv.decode(contents, decoderEncoding), encoding: forcedEncoding, hasBom }
  }
  if (buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]))) {
    return { text: buffer.subarray(3).toString('utf8'), encoding: 'utf-8', hasBom: true }
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xff, 0xfe]))) {
    return { text: buffer.subarray(2).toString('utf16le'), encoding: 'utf-16le', hasBom: true }
  }
  if (buffer.subarray(0, 2).equals(Buffer.from([0xfe, 0xff]))) {
    return { text: iconv.decode(buffer.subarray(2), 'utf16-be'), encoding: 'utf-16be', hasBom: true }
  }
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(buffer), encoding: 'utf-8', hasBom: false }
  } catch {
    const detected = chardet.detect(buffer)?.toLowerCase()
    const encoding = detected && iconv.encodingExists(detected) ? detected : 'windows-1251'
    return { text: iconv.decode(buffer, encoding), encoding, hasBom: false }
  }
}

export function encodeTextBuffer(
  text: string,
  encoding: string,
  eol: '\n' | '\r\n' | '\r',
  hasBom: boolean,
): Buffer {
  const encoderEncoding = iconvEncoding(encoding)
  if (!iconv.encodingExists(encoderEncoding)) throw new Error(`Неизвестная кодировка: ${encoding}`)
  const normalized = text.replace(/\r\n?|\n/g, '\n').replace(/\n/g, eol)
  let contents = iconv.encode(normalized, encoderEncoding)
  if (iconv.decode(contents, encoderEncoding) !== normalized) {
    throw new Error('Текст нельзя записать в исходной кодировке. Сохраните исходник в UTF-8.')
  }
  if (hasBom) {
    const canonical = encoding.toLowerCase().replace(/[^a-z0-9]/g, '')
    const bom = canonical === 'utf8'
      ? Buffer.from([0xef, 0xbb, 0xbf])
      : canonical === 'utf16le'
        ? Buffer.from([0xff, 0xfe])
        : canonical === 'utf16be'
          ? Buffer.from([0xfe, 0xff])
          : Buffer.alloc(0)
    contents = Buffer.concat([bom, contents])
  }
  return contents
}
