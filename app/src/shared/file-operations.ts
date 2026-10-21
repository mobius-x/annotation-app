import path from 'node:path'

export type FileEntryKind = 'file' | 'directory'

export function isPathWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate))
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

export function resolveDropDestination(
  targetPath: string,
  targetKind: FileEntryKind,
  intoDirectory: boolean,
): string {
  if (intoDirectory && targetKind === 'directory') return path.resolve(targetPath)
  return path.dirname(path.resolve(targetPath))
}

export function uniqueTransferName(name: string, destination: string, exists: (target: string) => boolean): string {
  if (!exists(path.join(destination, name))) return name
  const extension = path.extname(name)
  const stem = extension ? name.slice(0, -extension.length) : name
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${stem} (${suffix})${extension}`
    if (!exists(path.join(destination, candidate))) return candidate
  }
}

export function validateFileEntryName(name: string, parentPath: string, kind: FileEntryKind): string {
  const trimmed = name.trim()
  if (!trimmed) throw new Error('Имя не может быть пустым.')
  if (trimmed !== name) throw new Error('Имя не должно начинаться или заканчиваться пробелом.')
  if (/[<>:"/\\|?*\u0000-\u001f]/.test(trimmed)) {
    throw new Error('Имя содержит запрещённые символы: < > : " / \\ | ? *')
  }
  if (/[. ]$/.test(trimmed)) throw new Error('Имя не может заканчиваться точкой или пробелом.')
  const deviceName = trimmed.split('.')[0]!
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(deviceName)) {
    throw new Error('Это имя зарезервировано Windows.')
  }
  if (kind === 'file' && !path.extname(trimmed)) return validateFileEntryName(`${trimmed}.txt`, parentPath, kind)
  if (kind === 'file' && !/\.(txt|md)$/i.test(trimmed)) {
    throw new Error('Поддерживаются только файлы .txt и .md.')
  }
  if (path.join(parentPath, trimmed).length > 259) {
    throw new Error('Полный путь превышает ограничение Windows в 259 символов.')
  }
  return trimmed
}
