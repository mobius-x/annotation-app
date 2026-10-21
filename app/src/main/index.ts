import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeTheme, net, protocol, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import chokidar from 'chokidar'
import iconv from 'iconv-lite'
import { channelNames, channelSchemas, type Channel } from '../shared/ipc-contract'
import { defaultSettings, settingsSchema, themeSchema, themes, type UserTheme } from '../shared/settings'
import { parseMarkdownDocument, serializeMarkdownDocument } from '../shared/markdown-format'
import { parseAnnotatedDocument } from '../renderer/format/json-format'
import { detectLineEnding } from '../shared/text-format'
import { isPathWithin, uniqueTransferName, validateFileEntryName } from '../shared/file-operations'
import { parseWorkspaceFile, serializeWorkspaceFile, workspacePathFromFile } from '../shared/workspace-format'
import { appStateSchema, type AppState } from '../shared/app-state'
import { decodeTextBuffer as decodeBuffer, encodeTextBuffer } from '../shared/text-encoding'
import type { AnnotatedDocument, ApplyTextRequest, FileEntry, OpenedFile, RecoverySnapshot, SaveRequest, SavedFile } from '../shared/model'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
const allowedRoots = new Set<string>()
const backupTimes = new Map<string, number>()
const watchedFiles = new Map<string, ReturnType<typeof chokidar.watch>>()
const folderWatchers = new Map<string, ReturnType<typeof chokidar.watch>>()
const fileDigests = new Map<string, string | null>()
type UndoAction =
  | { kind: 'create'; entries: Array<{ path: string; digest: string | null; directory: boolean }> }
  | {
      kind: 'transfer' | 'rename'
      copy: boolean
      pairs: Array<{ source: string; target: string }>
      sidecarOriginals?: Array<{ path: string; contents: Buffer }>
      replacements?: Array<{ original: string; backup: string }>
      targetDigests?: Record<string, string>
    }
const undoHistory: UndoAction[] = []
let mainWindow: BrowserWindow | null = null

function recordUndo(action: UndoAction): void {
  undoHistory.push(action)
  if (undoHistory.length > 20) {
    const expired = undoHistory.shift()
    for (const replacement of expired?.kind === 'transfer' ? expired.replacements ?? [] : []) {
      void fs.rm(replacement.backup, { recursive: true, force: true }).catch((error) => {
        console.error(`Не удалось удалить резервную копию ${replacement.backup}.`, error)
      })
    }
  }
}

app.setName('Annotator')
if (process.env.ANNOTATOR_USERDATA) {
  app.setPath('userData', process.env.ANNOTATOR_USERDATA)
} else if (app.isPackaged) {
  const executableDir = path.dirname(process.execPath)
  const portableData = path.join(executableDir, 'data')
  if (existsSync(portableData) || existsSync(path.join(executableDir, 'portable.flag'))) {
    app.setPath('userData', portableData)
  }
}

async function assertNoLinkedPathComponents(target: string, includeTarget: boolean): Promise<void> {
  const resolved = path.resolve(target)
  const root = [...allowedRoots].find((candidate) => {
    const relative = path.relative(candidate, resolved)
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  })
  if (!root) throw new Error('Путь находится вне разрешённой рабочей области.')
  let current = includeTarget ? resolved : path.dirname(resolved)
  while (path.relative(root, current) !== '') {
    if ((await fs.lstat(current)).isSymbolicLink()) {
      throw new Error('Операции через символические ссылки и junction запрещены.')
    }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

let startupSmoothing = process.env.ANNOTATOR_SMOOTHING
try {
  const saved = JSON.parse(readFileSync(settingsPath(), 'utf8')) as unknown
  const parsed = settingsSchema.safeParse(saved)
  if (parsed.success) startupSmoothing = parsed.data.rendering.smoothing
  else console.error('Не удалось применить настройку сглаживания: settings.json содержит недопустимые значения.', parsed.error)
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
    console.error('Не удалось прочитать настройку сглаживания при запуске.', error)
  }
}
if (startupSmoothing === 'grayscale') app.commandLine.appendSwitch('disable-lcd-text')

protocol.registerSchemesAsPrivileged([
  { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: false } },
])

function isAllowedPath(target: string): boolean {
  const resolved = path.resolve(target)
  for (const root of allowedRoots) {
    const relative = path.relative(root, resolved)
    if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
      return true
    }
  }
  return false
}

function remapPathWithin(candidate: string, source: string, target: string): string | null {
  if (!isPathWithin(source, candidate)) return null
  const relative = path.relative(source, candidate)
  return relative ? path.join(target, relative) : target
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent): void {
  const url = event.senderFrame?.url ?? ''
  if (!(url.startsWith('app://') || (isDev && /^https?:\/\/(localhost|127\.0\.0\.1):/.test(url)))) {
    throw new Error('Запрос отклонён: неизвестный источник.')
  }
}

async function chooseDocument(): Promise<OpenedFile | null> {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Текстовые файлы', extensions: ['txt', 'md', 'json'] }, { name: 'Все файлы', extensions: ['*'] }],
  })
  if (result.canceled || !result.filePaths[0]) return null
  const filePath = path.resolve(result.filePaths[0])
  allowedRoots.add(path.dirname(filePath))
  return openDocumentAndWatch(filePath)
}

function digest(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex')
}

async function currentDigest(filePath: string): Promise<string | null> {
  try {
    return digest(await fs.readFile(filePath))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

async function treeDigest(target: string): Promise<string> {
  const stat = await fs.lstat(target)
  if (stat.isSymbolicLink()) throw new Error(`Нельзя проверить символическую ссылку: ${target}`)
  if (stat.isFile()) return digest(await fs.readFile(target))
  if (!stat.isDirectory()) throw new Error(`Тип элемента не поддерживается: ${target}`)
  const entries = (await fs.readdir(target)).sort()
  const contents = await Promise.all(entries.map(async (name) => [
    name,
    await treeDigest(path.join(target, name)),
  ]))
  return digest(Buffer.from(JSON.stringify(contents), 'utf8'))
}

async function watchFile(filePath: string): Promise<void> {
  const resolved = path.resolve(filePath)
  if (!isAllowedPath(resolved) || watchedFiles.has(resolved)) return
  fileDigests.set(resolved, await currentDigest(resolved))
  const watcher = chokidar.watch(resolved, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 250, pollInterval: 100 },
  })
  watcher.on('all', async (event, changedPath) => {
    if (!['add', 'change', 'unlink'].includes(event)) return
    try {
      const target = path.resolve(changedPath)
      const nextDigest = await currentDigest(target)
      if (fileDigests.get(target) === nextDigest) return
      fileDigests.set(target, nextDigest)
      mainWindow?.webContents.send('file:changed', { path: target })
    } catch (error) {
      console.error(`Не удалось проверить внешнее изменение файла ${changedPath}.`, error)
    }
  })
  watcher.on('error', (error) => console.error(`Ошибка наблюдения за файлом ${resolved}.`, error))
  watchedFiles.set(resolved, watcher)
}

async function openDocumentAndWatch(filePath: string, encoding?: string): Promise<OpenedFile | null> {
  const resolvedPath = path.resolve(filePath)
  let annotationChoice: string | undefined
  if (!/\.annot\.(json|md)$/i.test(resolvedPath)) {
    const jsonPath = annotatedPath(resolvedPath)
    const markdownPath = annotatedPath(resolvedPath, 'md')
    const [hasJson, hasMarkdown] = await Promise.all([exists(jsonPath), exists(markdownPath)])
    if (hasJson && hasMarkdown) {
      if (!mainWindow) return null
      const choice = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Конфликт форматов аннотаций',
        message: `Для «${path.basename(resolvedPath)}» найдены оба формата аннотаций.`,
        detail: 'Выберите sidecar, который нужно открыть. Второй файл останется без изменений.',
        buttons: ['Открыть JSON', 'Открыть Markdown', 'Отмена'],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
      })
      if (choice.response === 2) return null
      annotationChoice = choice.response === 0 ? jsonPath : markdownPath
    }
  }
  const opened = await readDocument(resolvedPath, annotationChoice, encoding)
  const paths = new Set([opened.path, opened.annotationPath].filter((item): item is string => Boolean(item)))
  await Promise.all([...paths].map((item) => watchFile(item)))
  return opened
}

async function readDocument(filePath: string, annotationChoice?: string, encoding?: string): Promise<OpenedFile> {
  if (!isAllowedPath(filePath)) throw new Error('Файл находится вне разрешённой папки.')
  if (/\.(annot\.json|annot\.md)$/i.test(filePath)) {
    const isMarkdown = /\.annot\.md$/i.test(filePath)
    const annotationDocument = isMarkdown
      ? parseMarkdownDocument(await fs.readFile(filePath, 'utf8'))
      : JSON.parse(await fs.readFile(filePath, 'utf8')) as AnnotatedDocument
    const source = annotationDocument.document?.source
    const basePath = source ? path.resolve(path.dirname(filePath), source) : filePath.replace(/\.annot\.(?:json|md)$/i, '.txt')
    if (typeof annotationDocument.text !== 'string') throw new Error('В файле аннотаций отсутствует текст.')
    const sourceExists = Boolean(source && await exists(basePath))
    const sourceBytes = sourceExists ? await fs.readFile(basePath) : null
    const sourceDecoded = sourceBytes ? decodeBuffer(sourceBytes, encoding) : null
    const sourceLineEndings = sourceDecoded ? detectLineEnding(sourceDecoded.text) : null
    const sourceEol = sourceLineEndings?.eol
      ?? (annotationDocument.document?.eol === 'crlf' ? '\r\n' : annotationDocument.document?.eol === 'cr' ? '\r' : '\n')
    return {
      path: source ? basePath : filePath,
      text: annotationDocument.text,
      encoding: sourceDecoded?.encoding ?? 'utf-8',
      eol: sourceEol,
      hasBom: sourceDecoded?.hasBom ?? false,
      originalText: sourceDecoded ? sourceDecoded.text.replace(/\r\n?|\n/g, '\n') : null,
      mixedEol: sourceLineEndings?.mixed ?? false,
      annotationDocument,
      annotationPath: filePath,
    }
  }
  const bytes = await fs.readFile(filePath)
  const decoded = decodeBuffer(bytes, encoding)
  const lineEndings = detectLineEnding(decoded.text)
  const eol = lineEndings.eol
  const text = decoded.text.replace(/\r\n?|\n/g, '\n')
  const jsonPath = annotatedPath(filePath)
  const markdownPath = annotatedPath(filePath, 'md')
  const [hasJson, hasMarkdown] = await Promise.all([exists(jsonPath), exists(markdownPath)])
  const annotationPath = annotationChoice ?? (hasMarkdown ? markdownPath : hasJson ? jsonPath : null)
  const annotationDocument = annotationPath
    ? /\.annot\.md$/i.test(annotationPath)
      ? parseMarkdownDocument(await fs.readFile(annotationPath, 'utf8'))
      : JSON.parse(await fs.readFile(annotationPath, 'utf8'))
    : undefined
  if (annotationDocument && typeof annotationDocument === 'object' && 'text' in annotationDocument && typeof annotationDocument.text === 'string') {
    return {
      path: filePath,
      ...decoded,
      eol,
      text: annotationDocument.text,
      originalText: text,
      mixedEol: lineEndings.mixed,
      annotationDocument,
      annotationPath,
    }
  }
  return { path: filePath, ...decoded, eol, text, originalText: text, mixedEol: lineEndings.mixed, annotationPath }
}

async function readSourceText(filePath: string, encoding?: string): Promise<string> {
  const target = path.resolve(filePath)
  if (!isAllowedPath(target)) throw new Error('Файл находится вне разрешённой папки.')
  return decodeBuffer(await fs.readFile(target), encoding).text.replace(/\r\n?|\n/g, '\n')
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

function annotatedPath(filePath: string, format: 'json' | 'md' = 'json'): string {
  const extension = path.extname(filePath)
  return `${filePath.slice(0, -extension.length)}.annot.${format}`
}

async function listDirectory(directory: string): Promise<FileEntry[]> {
  if (!isAllowedPath(directory)) throw new Error('Папка находится вне разрешённой рабочей области.')
  const entries = await fs.readdir(directory, { withFileTypes: true })
  const names = new Set(entries.map((entry) => entry.name.toLocaleLowerCase('ru')))
  const collator = new Intl.Collator('ru', { numeric: true, sensitivity: 'base' })
  const items = entries
    .filter((entry) => !entry.isSymbolicLink() && !['.git', 'node_modules', '.tools', '.cache', '.userdata'].includes(entry.name.toLowerCase()))
    .filter((entry) => !entry.name.endsWith('.bak') && !entry.name.endsWith('.tmp') && !entry.name.startsWith('.~'))
    .filter((entry) => entry.isDirectory() || /\.(txt|md)$/i.test(entry.name) || /\.annot\.(json|md)$/i.test(entry.name))
    .filter((entry) => {
      if (!/\.annot\.(json|md)$/i.test(entry.name)) return true
      const stem = entry.name.replace(/\.annot\.(json|md)$/i, '')
      return !['.txt', '.md'].some((extension) => names.has(`${stem}${extension}`.toLocaleLowerCase('ru')))
    })
    .map((entry) => ({
      name: entry.name,
      path: path.join(directory, entry.name),
      kind: entry.isDirectory() ? 'directory' as const : 'file' as const,
      annotated: entry.isFile() && /\.(txt|md)$/i.test(entry.name) && (
        names.has(path.basename(annotatedPath(path.join(directory, entry.name))).toLocaleLowerCase('ru')) ||
        names.has(path.basename(annotatedPath(path.join(directory, entry.name), 'md')).toLocaleLowerCase('ru'))
      ),
      annotationConflict: entry.isFile() && /\.(txt|md)$/i.test(entry.name) &&
        names.has(path.basename(annotatedPath(path.join(directory, entry.name))).toLocaleLowerCase('ru')) &&
        names.has(path.basename(annotatedPath(path.join(directory, entry.name), 'md')).toLocaleLowerCase('ru')),
    }))
  items.sort((left, right) => Number(right.kind === 'directory') - Number(left.kind === 'directory') || collator.compare(left.name, right.name))
  return items
}

async function assertOrdinaryEntry(target: string): Promise<void> {
  if (!isAllowedPath(target)) throw new Error('Путь находится вне разрешённой рабочей области.')
  await assertNoLinkedPathComponents(target, true)
  const stat = await fs.lstat(target)
  if (stat.isSymbolicLink()) throw new Error('Операции с символическими ссылками запрещены.')
}

async function createEntry(parentPath: string, requestedName: string, kind: 'file' | 'directory'): Promise<string> {
  const parent = path.resolve(parentPath)
  if (!isAllowedPath(parent)) throw new Error('Папка находится вне разрешённой рабочей области.')
  await assertNoLinkedPathComponents(parent, true)
  const parentStat = await fs.stat(parent)
  if (!parentStat.isDirectory()) throw new Error('Родительский путь не является папкой.')
  const name = validateFileEntryName(requestedName, parent, kind)
  const target = path.join(parent, name)
  if (kind === 'directory') await fs.mkdir(target)
  else await fs.writeFile(target, '', { flag: 'wx' })
  recordUndo({
    kind: 'create',
    entries: [{ path: target, digest: await currentDigest(target), directory: kind === 'directory' }],
  })
  return target
}

async function renameEntry(sourcePath: string, requestedName: string): Promise<{ path: string; annotationPath: string | null }> {
  const source = path.resolve(sourcePath)
  await assertOrdinaryEntry(source)
  const sourceStat = await fs.lstat(source)
  const kind = sourceStat.isDirectory() ? 'directory' : 'file'
  const parent = path.dirname(source)
  const name = validateFileEntryName(requestedName, parent, kind)
  const target = path.join(parent, name)
  if (source === target) return { path: target, annotationPath: null }
  if (await exists(target)) throw new Error(`Элемент «${name}» уже существует.`)

  const isSourceDocument = kind === 'file' && /\.(txt|md)$/i.test(source)
  const sidecarPaths: string[] = []
  for (const sidecar of isSourceDocument ? [annotatedPath(source), annotatedPath(source, 'md')] : []) {
    if (await exists(sidecar)) {
      await assertOrdinaryEntry(sidecar)
      sidecarPaths.push(sidecar)
    }
  }
  const destinationSidecars = sidecarPaths.map((sidecar) => ({
    oldPath: sidecar,
    newPath: annotatedPath(target, /\.annot\.md$/i.test(sidecar) ? 'md' : 'json'),
    contents: null as Buffer | null,
    originalContents: null as Buffer | null,
  }))
  for (const sidecar of destinationSidecars) {
    if (await exists(sidecar.newPath)) throw new Error(`Файл аннотаций «${path.basename(sidecar.newPath)}» уже существует.`)
    const raw = await fs.readFile(sidecar.oldPath)
    sidecar.originalContents = raw
    if (/\.annot\.md$/i.test(sidecar.oldPath)) {
      const document = parseMarkdownDocument(raw.toString('utf8'))
      document.document.source = name
      const lineEnding = detectLineEnding(raw.toString('utf8')).eol
      sidecar.contents = Buffer.from(serializeMarkdownDocument(document, lineEnding), 'utf8')
    } else {
      const document = parseAnnotatedDocument(raw.toString('utf8'))
      document.document.source = name
      sidecar.contents = Buffer.from(JSON.stringify(document, null, 2), 'utf8')
    }
  }

  const moved: Array<{ oldPath: string; newPath: string }> = []
  const watcherPaths = [...watchedFiles.keys()].filter((watchedPath) =>
    watchedPath === source || sidecarPaths.includes(watchedPath) || (sourceStat.isDirectory() && isPathWithin(source, watchedPath)))
  for (const watchedPath of watcherPaths) {
    const watcher = watchedFiles.get(watchedPath)
    if (watcher) {
      await watcher.close()
      watchedFiles.delete(watchedPath)
      fileDigests.delete(watchedPath)
    }
  }
  try {
    await fs.rename(source, target)
    moved.push({ oldPath: source, newPath: target })
    for (const sidecar of destinationSidecars) {
      await fs.rename(sidecar.oldPath, sidecar.newPath)
      moved.push({ oldPath: sidecar.oldPath, newPath: sidecar.newPath })
    }
    for (const sidecar of destinationSidecars) {
      if (!sidecar.contents) throw new Error('Не удалось подготовить файл аннотаций.')
      await atomicWrite(sidecar.newPath, sidecar.contents)
    }
  } catch (error) {
    const rollbackErrors: unknown[] = []
    for (const sidecar of destinationSidecars) {
      if (moved.some((item) => item.newPath === sidecar.newPath) && sidecar.originalContents) {
        try {
          await atomicWrite(sidecar.newPath, sidecar.originalContents)
        } catch (rollbackError) {
          rollbackErrors.push(rollbackError)
        }
      }
    }
    for (const item of moved.reverse()) {
      try {
        await fs.rename(item.newPath, item.oldPath)
      } catch (rollbackError) {
        rollbackErrors.push(rollbackError)
      }
    }
    if (rollbackErrors.length) {
      throw new AggregateError([error, ...rollbackErrors], 'Переименование не завершено, и автоматический откат также завершился с ошибкой.')
    }
    await Promise.all(watcherPaths.map((watchedPath) => watchFile(watchedPath)))
    throw error
  }

  const movedWatchPaths = watcherPaths.flatMap((watchedPath) => {
    const direct = moved.find((item) => item.oldPath === watchedPath)
    const newPath = direct?.newPath ?? (sourceStat.isDirectory() ? remapPathWithin(watchedPath, source, target) : null)
    if (!newPath) return []
    return [{ oldPath: watchedPath, newPath }]
  })
  for (const item of movedWatchPaths) {
    fileDigests.delete(item.oldPath)
    fileDigests.set(item.newPath, await currentDigest(item.newPath))
  }
  recordUndo({
    kind: 'rename',
    copy: false,
    pairs: moved.map(({ oldPath, newPath }) => ({ source: oldPath, target: newPath })),
    sidecarOriginals: destinationSidecars.flatMap(({ newPath, originalContents }) => originalContents ? [{ path: newPath, contents: originalContents }] : []),
  })
  await Promise.all(movedWatchPaths.map((item) => watchFile(item.newPath)))
  mainWindow?.webContents.send('workspace:refresh')
  mainWindow?.webContents.send('workspace:entryRenamed', {
    oldPath: source,
    newPath: target,
    sidecars: destinationSidecars.map(({ oldPath, newPath }) => ({ oldPath, newPath })),
  })
  return { path: target, annotationPath: destinationSidecars[0]?.newPath ?? null }
}

async function deleteEntry(targetPath: string, includeSidecars: boolean): Promise<void> {
  const target = path.resolve(targetPath)
  await assertOrdinaryEntry(target)
  const stat = await fs.lstat(target)
  const sidecars = !stat.isDirectory() && /\.(txt|md)$/i.test(target) && includeSidecars
    ? [annotatedPath(target), annotatedPath(target, 'md')]
    : []
  const existingSidecars: string[] = []
  for (const sidecar of sidecars) {
    if (await exists(sidecar)) {
      await assertOrdinaryEntry(sidecar)
      existingSidecars.push(sidecar)
    }
  }
  const watchedTargets = [target, ...existingSidecars]
  const closedWatchers: string[] = []
  for (const watchedTarget of watchedTargets) {
    const watcher = watchedFiles.get(watchedTarget)
    if (watcher) {
      await watcher.close()
      watchedFiles.delete(watchedTarget)
      fileDigests.delete(watchedTarget)
      closedWatchers.push(watchedTarget)
    }
  }
  try {
    await shell.trashItem(target)
    for (const sidecar of existingSidecars) await shell.trashItem(sidecar)
  } finally {
    await Promise.all(closedWatchers.filter((watchedTarget) => existsSync(watchedTarget)).map((watchedTarget) => watchFile(watchedTarget)))
    mainWindow?.webContents.send('workspace:refresh')
  }
}

async function copyTreeVerified(source: string, target: string): Promise<void> {
  let created = false
  try {
    const sourceStat = await fs.lstat(source)
    if (sourceStat.isSymbolicLink()) throw new Error(`Перенос символической ссылки запрещён: ${source}`)
    if (sourceStat.isDirectory()) {
      await fs.mkdir(target)
      created = true
      for (const entry of await fs.readdir(source)) {
        await copyTreeVerified(path.join(source, entry), path.join(target, entry))
      }
    } else if (sourceStat.isFile()) {
      await fs.copyFile(source, target, 1)
      created = true
      const [sourceDigest, targetDigest] = await Promise.all([currentDigest(source), currentDigest(target)])
      if (!sourceDigest || sourceDigest !== targetDigest) throw new Error(`Не удалось проверить копию «${source}».`)
    } else {
      throw new Error(`Тип элемента не поддерживается: ${source}`)
    }
  } catch (error) {
    if (created) {
      try {
        await fs.rm(target, { recursive: true, force: true })
      } catch (cleanupError) {
        console.error(`Не удалось удалить частичную копию ${target}.`, cleanupError)
      }
    }
    throw error
  }
}

async function verifyCopiedTree(source: string, target: string): Promise<void> {
  const [sourceStat, targetStat] = await Promise.all([fs.lstat(source), fs.lstat(target)])
  if (sourceStat.isSymbolicLink() || targetStat.isSymbolicLink()) throw new Error(`Копия содержит символическую ссылку: ${source}`)
  if (sourceStat.isDirectory() && targetStat.isDirectory()) {
    const [sourceNames, targetNames] = await Promise.all([fs.readdir(source), fs.readdir(target)])
    sourceNames.sort()
    targetNames.sort()
    if (sourceNames.length !== targetNames.length || sourceNames.some((name, index) => name !== targetNames[index])) {
      throw new Error(`Содержимое папки изменилось во время копирования: ${source}`)
    }
    for (const name of sourceNames) await verifyCopiedTree(path.join(source, name), path.join(target, name))
  } else if (sourceStat.isFile() && targetStat.isFile()) {
    const [sourceDigest, targetDigest] = await Promise.all([currentDigest(source), currentDigest(target)])
    if (!sourceDigest || sourceDigest !== targetDigest) throw new Error(`Не удалось проверить копию «${source}».`)
  } else {
    throw new Error(`Тип элемента изменился во время копирования: ${source}`)
  }
}

async function transferOne(
  sourcePath: string,
  destinationDirectory: string,
  copy: boolean,
  conflictMode: { choice: 'replace' | 'suffix' | null; applyToAll: boolean },
  replacementBackups: Array<{ original: string; backup: string }>,
): Promise<Array<{ source: string; target: string }>> {
    const source = path.resolve(sourcePath)
    const destination = path.resolve(destinationDirectory)
    await assertOrdinaryEntry(source)
    await assertOrdinaryEntry(destination)
    const sourceStat = await fs.lstat(source)
    if (!(await fs.stat(destination)).isDirectory()) throw new Error('Целевой путь должен быть папкой.')
    if (!sourceStat.isFile() && !sourceStat.isDirectory()) throw new Error('Можно переносить только обычные файлы и папки.')
    if (sourceStat.isDirectory() && isPathWithin(source, destination)) {
      throw new Error('Нельзя переносить папку внутрь себя или её дочерней папки.')
    }
    if (!copy && path.dirname(source) === destination) throw new Error('Элемент уже находится в этой папке.')

    const sidecars: string[] = []
    if (sourceStat.isFile() && /\.(txt|md)$/i.test(source)) {
      for (const sidecar of [annotatedPath(source), annotatedPath(source, 'md')]) {
        if (await exists(sidecar)) {
          await assertOrdinaryEntry(sidecar)
          sidecars.push(sidecar)
        }
      }
    }

    const sidecarTarget = (target: string, sidecar: string) => annotatedPath(target, /\.annot\.md$/i.test(sidecar) ? 'md' : 'json')
    const occupied = (target: string) => existsSync(target) || sidecars.some((sidecar) => existsSync(sidecarTarget(target, sidecar)))
    let name = path.basename(source)
    const conflict = occupied(path.join(destination, name))
    let replace = false
    if (conflict) {
      if (conflictMode.choice === null) {
        if (!mainWindow) throw new Error(`Элемент «${name}» уже существует.`)
        const answer = await dialog.showMessageBox(mainWindow, {
          type: 'warning',
          title: 'Конфликт имён',
          message: `В целевой папке уже есть «${name}».`,
          detail: 'Выберите замену, сохранение обоих элементов с суффиксом или отмену.',
          buttons: ['Заменить', 'Оставить оба', 'Отмена'],
          defaultId: 1,
          cancelId: 2,
          noLink: true,
          checkboxLabel: 'Применить этот выбор ко всем конфликтам',
          checkboxChecked: false,
        })
        if (answer.response === 2) throw new Error('Операция переноса отменена.')
        conflictMode.choice = answer.response === 0 ? 'replace' : 'suffix'
        conflictMode.applyToAll = answer.checkboxChecked
        replace = answer.response === 0
      } else {
        replace = conflictMode.choice === 'replace'
      }
      if (!replace) {
        name = uniqueTransferName(name, destination, (candidate) => occupied(candidate))
      }
    }

    const target = path.join(destination, name)
    const pairs = [{ source, target }, ...sidecars.map((item) => ({ source: item, target: sidecarTarget(target, item) }))]
    const backups: Array<{ original: string; backup: string }> = []
    const originalSidecarBytes = new Map<string, Buffer>()
    const updatedSidecarBytes = new Map<string, Buffer>()
    for (const pair of pairs.slice(1)) {
      const raw = await fs.readFile(pair.source)
      originalSidecarBytes.set(pair.source, raw)
      if (/\.annot\.md$/i.test(pair.source)) {
        const document = parseMarkdownDocument(raw.toString('utf8'))
        document.document.source = name
        updatedSidecarBytes.set(pair.source, Buffer.from(serializeMarkdownDocument(document, detectLineEnding(raw.toString('utf8')).eol), 'utf8'))
      } else {
        const document = parseAnnotatedDocument(raw.toString('utf8'))
        document.document.source = name
        updatedSidecarBytes.set(pair.source, Buffer.from(JSON.stringify(document, null, 2), 'utf8'))
      }
    }

    const closedWatchers: string[] = []
    if (!copy) {
      const sourceWatchers = [...watchedFiles.keys()].filter((watchedPath) =>
        pairs.some((pair) => pair.source === watchedPath) || isPathWithin(source, watchedPath))
      for (const watchedPath of sourceWatchers) {
        const watcher = watchedFiles.get(watchedPath)
        if (watcher) {
          await watcher.close()
          watchedFiles.delete(watchedPath)
          fileDigests.delete(watchedPath)
          closedWatchers.push(watchedPath)
        }
      }
    }

    const completed: Array<{ source: string; target: string }> = []
    const removedSources: string[] = []
    const destinationStat = await fs.stat(destination)
    const sameDevice = sourceStat.dev === destinationStat.dev
    try {
      if (replace) {
        for (const pair of pairs) {
          if (await exists(pair.target)) {
            const backup = path.join(destination, `.annotator-backup-${randomBytes(8).toString('hex')}`)
            await fs.rename(pair.target, backup)
            backups.push({ original: pair.target, backup })
          }
        }
      }

      const copyAndRemove = async (removeSources: boolean): Promise<void> => {
        for (const pair of pairs) {
          await copyTreeVerified(pair.source, pair.target)
          completed.push(pair)
          const bytes = updatedSidecarBytes.get(pair.source)
          if (bytes) await atomicWrite(pair.target, bytes)
        }
        for (const pair of pairs) {
          const bytes = updatedSidecarBytes.get(pair.source)
          if (bytes) {
            if (digest(await fs.readFile(pair.target)) !== digest(bytes)) throw new Error(`Не удалось проверить sidecar «${pair.target}».`)
          } else {
            await verifyCopiedTree(pair.source, pair.target)
          }
        }
        if (removeSources) {
          for (const pair of pairs) {
            await fs.rm(pair.source, { recursive: true })
            removedSources.push(pair.source)
          }
        }
      }

      if (!copy && sameDevice) {
        let fallbackUsed = false
        try {
          for (const pair of pairs) {
            await fs.rename(pair.source, pair.target)
            completed.push(pair)
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
          for (const pair of [...completed].reverse()) await fs.rename(pair.target, pair.source)
          completed.length = 0
          fallbackUsed = true
          await copyAndRemove(true)
        }
        if (!fallbackUsed) {
          for (const pair of pairs.slice(1)) {
            const bytes = updatedSidecarBytes.get(pair.source)
            if (bytes) await atomicWrite(pair.target, bytes)
          }
        }
      } else {
        await copyAndRemove(!copy)
      }
      replacementBackups.push(...backups)
    } catch (error) {
      for (const sourcePath of removedSources.reverse()) {
        const pair = pairs.find((item) => item.source === sourcePath)
        if (pair) {
          try {
            await copyTreeVerified(pair.target, pair.source)
            const original = originalSidecarBytes.get(pair.source)
            if (original) await atomicWrite(pair.source, original)
          } catch (rollbackError) {
            console.error(`Не удалось восстановить исходный файл ${pair.source}.`, rollbackError)
          }
        }
      }
      for (const pair of [...completed].reverse()) {
        try {
          if (!copy && sameDevice && await exists(pair.target)) await fs.rename(pair.target, pair.source)
          else if (await exists(pair.target)) await fs.rm(pair.target, { recursive: true })
        } catch (rollbackError) {
          console.error(`Не удалось откатить перенос ${pair.target} → ${pair.source}.`, rollbackError)
        }
      }
      for (const [sidecar, bytes] of originalSidecarBytes) {
        try {
          if (await exists(sidecar)) await atomicWrite(sidecar, bytes)
        } catch (rollbackError) {
          console.error(`Не удалось восстановить sidecar ${sidecar}.`, rollbackError)
        }
      }
      for (const backup of backups.reverse()) {
        try {
          if (await exists(backup.backup)) await fs.rename(backup.backup, backup.original)
        } catch (rollbackError) {
          console.error(`Не удалось восстановить заменённый элемент ${backup.original}.`, rollbackError)
        }
      }
      await Promise.all(closedWatchers.map((watchedPath) => watchFile(watchedPath)))
      throw error
    }

    const newWatchPaths: string[] = []
    if (!copy) {
      for (const watchedPath of closedWatchers) {
        const newPath = remapPathWithin(watchedPath, source, target)
        if (newPath) {
          fileDigests.delete(watchedPath)
          fileDigests.set(newPath, await currentDigest(newPath))
          newWatchPaths.push(newPath)
        }
      }
    } else {
      for (const watchedPath of closedWatchers) await watchFile(watchedPath)
    }
    for (const pair of pairs) {
      if ((await fs.lstat(pair.target)).isFile()) {
        fileDigests.set(pair.target, await currentDigest(pair.target))
        newWatchPaths.push(pair.target)
      }
    }
    await Promise.all([...new Set(newWatchPaths)].map((item) => watchFile(item)))
    return pairs
  }

async function transferEntries(paths: string[], destination: string, copy: boolean): Promise<Array<{ source: string; target: string }>> {
    const targetDirectory = path.resolve(destination)
    await assertOrdinaryEntry(targetDirectory)
    const requestedSources = [...new Set(paths.map((item) => path.resolve(item)))]
    const directorySources = new Set<string>()
    for (const source of requestedSources) {
      await assertOrdinaryEntry(source)
      if ((await fs.lstat(source)).isDirectory()) directorySources.add(source)
    }
    const uniqueSources = requestedSources.filter((source) =>
      !requestedSources.some((parent) => parent !== source && directorySources.has(parent) && isPathWithin(parent, source)))
    const pairs: Array<{ source: string; target: string }> = []
    const sidecarOriginals: Array<{ path: string; contents: Buffer }> = []
    const replacementBackups: Array<{ original: string; backup: string }> = []
    const conflictMode: { choice: 'replace' | 'suffix' | null; applyToAll: boolean } = { choice: null, applyToAll: false }
    const targetDigests: Record<string, string> = {}
    const captureTargetDigests = async (): Promise<void> => {
      for (const pair of pairs) targetDigests[pair.target] = await treeDigest(pair.target)
    }
    for (const source of uniqueSources) {
      try {
        if (!copy && /\.(txt|md)$/i.test(source)) {
          for (const sidecar of [annotatedPath(source), annotatedPath(source, 'md')]) {
            if (await exists(sidecar)) sidecarOriginals.push({ path: sidecar, contents: await fs.readFile(sidecar) })
          }
        }
        pairs.push(...await transferOne(source, targetDirectory, copy, conflictMode, replacementBackups))
        if (!conflictMode.applyToAll) conflictMode.choice = null
      } catch (error) {
        if (pairs.length) {
          await captureTargetDigests()
          recordUndo({ kind: 'transfer', copy, pairs, sidecarOriginals, replacements: replacementBackups, targetDigests })
          mainWindow?.webContents.send('workspace:entriesTransferred', { pairs, copy })
          mainWindow?.webContents.send('workspace:refresh')
          throw new Error(`Выполнено частично: завершённые элементы доступны одной операцией отмены. ${error instanceof Error ? error.message : String(error)}`)
        }
        throw error
      }
    }
    await captureTargetDigests()
    recordUndo({ kind: 'transfer', copy, pairs, sidecarOriginals, replacements: replacementBackups, targetDigests })
    mainWindow?.webContents.send('workspace:entriesTransferred', { pairs, copy })
    mainWindow?.webContents.send('workspace:refresh')
    return pairs
  }

async function undoFileOperation(): Promise<void> {
    const action = undoHistory.at(-1)
    if (!action) throw new Error('Нет файловых операций для отмены.')
    const watcherPaths = new Set(action.kind === 'create'
      ? action.entries.map(({ path: entryPath }) => entryPath)
      : action.pairs.flatMap(({ source, target }) => [source, target]))
    if (action.kind !== 'create') {
      for (const pair of action.pairs) {
        for (const watchedPath of watchedFiles.keys()) {
          const fromTarget = remapPathWithin(watchedPath, pair.target, pair.source)
          const fromSource = remapPathWithin(watchedPath, pair.source, pair.target)
          if (fromTarget) watcherPaths.add(fromTarget)
          if (fromSource) watcherPaths.add(fromSource)
        }
      }
    }
    const transferAction = action.kind === 'create' ? null : action
    for (const watchedPath of watcherPaths) {
      const watcher = watchedFiles.get(watchedPath)
      if (watcher) {
        await watcher.close()
        watchedFiles.delete(watchedPath)
        fileDigests.delete(watchedPath)
      }
    }
    let undone = false
    try {
    if (action.kind === 'create') {
      for (const entry of [...action.entries].reverse()) {
        await fs.lstat(entry.path)
        if (entry.directory) {
          if ((await fs.readdir(entry.path)).length) throw new Error(`Нельзя отменить создание непустой папки «${entry.path}».`)
        } else if (await currentDigest(entry.path) !== entry.digest) {
          throw new Error(`Файл изменён после создания; отмена остановлена, чтобы не потерять данные: ${entry.path}`)
        }
        await fs.rm(entry.path, { recursive: entry.directory, force: false })
      }
    } else {
      const reversed = action.pairs.map(({ source, target }) => ({ source: target, target: source }))
      if (action.copy) {
        for (const pair of reversed) {
          if (await treeDigest(pair.source) !== action.targetDigests?.[pair.source]) {
            throw new Error(`Элемент копии изменён; отмена остановлена, чтобы не потерять данные: ${pair.source}`)
          }
        }
        for (const pair of reversed) await fs.rm(pair.source, { recursive: true })
      } else {
        const completed: Array<{ source: string; target: string }> = []
        try {
          for (const pair of reversed) {
            if (await exists(pair.target)) throw new Error(`Нельзя отменить операцию: «${pair.target}» уже существует.`)
            try {
              await fs.rename(pair.source, pair.target)
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error
              await copyTreeVerified(pair.source, pair.target)
              await fs.rm(pair.source, { recursive: true })
            }
            completed.push(pair)
          }
        } catch (error) {
          for (const pair of completed.reverse()) {
            try {
              try {
                await fs.rename(pair.target, pair.source)
              } catch (rollbackError) {
                if ((rollbackError as NodeJS.ErrnoException).code !== 'EXDEV') throw rollbackError
                await copyTreeVerified(pair.target, pair.source)
                await fs.rm(pair.target, { recursive: true })
              }
            } catch (rollbackError) {
              console.error(`Не удалось восстановить файл при откате undo ${pair.target}.`, rollbackError)
            }
          }
          throw error
        }
      }
      for (const original of action.sidecarOriginals ?? []) {
        const restorePath = action.kind === 'rename'
          ? action.pairs.find(({ target }) => target === original.path)?.source ?? original.path
          : original.path
        if (await exists(restorePath)) await atomicWrite(restorePath, original.contents)
      }
      for (const replacement of [...(action.replacements ?? [])].reverse()) {
        if (await exists(replacement.backup)) await fs.rename(replacement.backup, replacement.original)
      }
    }
    undoHistory.pop()
    undone = true
    if (transferAction && !transferAction.copy && transferAction.kind === 'rename') {
      mainWindow?.webContents.send('workspace:entryRenamed', {
        oldPath: transferAction.pairs[0].target,
        newPath: transferAction.pairs[0].source,
        sidecars: transferAction.pairs.slice(1).map(({ source, target }) => ({ oldPath: target, newPath: source })),
      })
    } else if (transferAction && !transferAction.copy) {
      mainWindow?.webContents.send('workspace:entriesTransferred', {
        pairs: transferAction.pairs.map(({ source, target }) => ({ source: target, target: source })),
        copy: false,
      })
    }
    mainWindow?.webContents.send('workspace:refresh')
    } finally {
      for (const watchedPath of watcherPaths) {
        if (await exists(watchedPath) && (await fs.lstat(watchedPath)).isFile()) await watchFile(watchedPath)
      }
      if (undone && transferAction) {
        for (const original of transferAction.sidecarOriginals ?? []) {
          const restorePath = transferAction.kind === 'rename'
            ? transferAction.pairs.find(({ target }) => target === original.path)?.source ?? original.path
            : original.path
          if (await exists(restorePath)) fileDigests.set(restorePath, await currentDigest(restorePath))
        }
      }
    }
  }
function watchFolderRoot(directory: string): void {
  if (folderWatchers.has(directory)) return
  const watcher = chokidar.watch(directory, {
    depth: 0,
    ignoreInitial: true,
    ignored: /(^|[\\/])(\.git|node_modules|\.tools|\.cache|\.userdata)([\\/]|$)|(^|[\\/])\.~|\.bak$|\.tmp$/,
    awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
  })
  watcher.on('all', () => mainWindow?.webContents.send('workspace:refresh'))
  watcher.on('error', (error) => console.error(`Ошибка наблюдения за рабочей папкой ${directory}.`, error))
  folderWatchers.set(directory, watcher)
}

async function openWorkspaceFile(): Promise<{
  path: string
  folders: Array<{ path: string; name?: string; entries: FileEntry[]; error: string | null }>
  openTabs: string[]
  activeTab: number
} | null> {
  if (!mainWindow) return null
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [{ name: 'Workspace Annotator', extensions: ['annotator-workspace'] }],
  })
  if (result.canceled || !result.filePaths[0]) return null
  const workspaceFile = path.resolve(result.filePaths[0])
  allowedRoots.add(path.dirname(workspaceFile))
  const workspace = parseWorkspaceFile(await fs.readFile(workspaceFile, 'utf8'))
  await Promise.all([...folderWatchers.values()].map((watcher) => watcher.close()))
  folderWatchers.clear()
  const folders = await Promise.all(workspace.folders.map(async (folder) => {
    const directory = workspacePathFromFile(workspaceFile, folder.path)
    allowedRoots.add(directory)
    try {
      const stat = await fs.stat(directory)
      if (!stat.isDirectory()) throw new Error('Путь не является папкой.')
      watchFolderRoot(directory)
      return { path: directory, name: folder.name, entries: await listDirectory(directory), error: null }
    } catch (error) {
      return {
        path: directory,
        name: folder.name,
        entries: [] as FileEntry[],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }))
  const state = workspace.state
  return {
    path: workspaceFile,
    folders,
    openTabs: state?.openTabs.map((item) => workspacePathFromFile(workspaceFile, item)) ?? [],
    activeTab: state?.activeTab ?? 0,
  }
}

async function saveWorkspaceFile(
  folders: string[],
  openTabs: string[],
  activeTab: number,
  settings?: Record<string, unknown>,
): Promise<string | null> {
  if (!mainWindow) return null
  for (const target of [...folders, ...openTabs]) {
    if (!isAllowedPath(target)) throw new Error(`Нельзя добавить путь вне разрешённой рабочей области: ${target}`)
  }
  const result = await dialog.showSaveDialog(mainWindow, {
    defaultPath: 'workspace.annotator-workspace',
    filters: [{ name: 'Workspace Annotator', extensions: ['annotator-workspace'] }],
  })
  if (result.canceled || !result.filePath) return null
  const target = result.filePath.toLowerCase().endsWith('.annotator-workspace')
    ? result.filePath
    : `${result.filePath}.annotator-workspace`
  allowedRoots.add(path.dirname(target))
  await atomicWrite(target, Buffer.from(serializeWorkspaceFile(target, folders, openTabs, activeTab, settings), 'utf8'))
  return target
}

async function atomicWrite(target: string, contents: Buffer): Promise<void> {
  const tempPath = path.join(path.dirname(target), `.~${path.basename(target)}.${randomBytes(3).toString('hex')}.tmp`)
  try {
    const handle = await fs.open(tempPath, 'wx')
    try {
      await handle.writeFile(contents)
      await handle.sync()
    } finally {
      await handle.close()
    }
    for (let attempt = 0; ; attempt += 1) {
      try {
        await fs.rename(tempPath, target)
        return
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code
        if (!['EPERM', 'EBUSY', 'EACCES'].includes(code ?? '') || attempt >= 4) throw error
        await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)))
      }
    }
  } catch (error) {
    await fs.rm(tempPath, { force: true })
    throw error
  }
}

async function backupBeforeWrite(target: string, intervalMin: number): Promise<void> {
  const previousBackup = backupTimes.get(target) ?? 0
  if (Date.now() - previousBackup < intervalMin * 60 * 1000) return
  try {
    await fs.copyFile(target, `${target}.bak`)
    backupTimes.set(target, Date.now())
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
}

function recoveryPath(documentPath: string | null): string {
  const key = createHash('sha256').update(documentPath ?? 'untitled', 'utf8').digest('hex')
  return path.join(app.getPath('userData'), 'recovery', `${key}.json`)
}

function settingsPath(): string {
  return path.join(app.getPath('userData'), 'settings.json')
}

function userThemesPath(): string {
  return path.join(app.getPath('userData'), 'themes')
}

async function readUserThemes(): Promise<{ themes: UserTheme[]; errors: Array<{ file: string; message: string }> }> {
  const directory = userThemesPath()
  try {
    await fs.mkdir(directory, { recursive: true })
    const files = (await fs.readdir(directory)).filter((file) => file.toLowerCase().endsWith('.json'))
    const userThemes: UserTheme[] = []
    const errors: Array<{ file: string; message: string }> = []
    for (const file of files) {
      try {
        const parsed: unknown = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))
        const result = themeSchema.parse(parsed)
        if (result.extends && !(result.extends in themes)) {
          throw new Error(`Неизвестная базовая тема «${result.extends}».`)
        }
        const required = ['ui.bg', 'ui.fg', 'ui.accent', 'editor.bg', 'editor.fg', 'editor.selection', 'annot.default']
        if (!result.extends && required.some((key) => !(key in result.colors))) {
          throw new Error('Тема без базовой темы должна определить обязательные цвета интерфейса и редактора.')
        }
        userThemes.push(result)
      } catch (error) {
        errors.push({ file, message: error instanceof Error ? error.message : String(error) })
      }
    }
    return { themes: userThemes, errors }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { themes: [], errors: [] }
    throw error
  }
}

async function isKnownTheme(themeId: string): Promise<boolean> {
  if (themeId in themes) return true
  return (await readUserThemes()).themes.some((theme) => theme.id === themeId)
}

function appStatePath(): string {
  return path.join(app.getPath('userData'), 'state.json')
}

async function readAppState(): Promise<{ state: AppState; error: string | null }> {
  try {
    const raw = await fs.readFile(appStatePath(), 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { state: appStateSchema.parse({}), error: `state.json: ${error instanceof Error ? error.message : String(error)}` }
    }
    const result = appStateSchema.safeParse(parsed)
    if (!result.success) {
      const issue = result.error.issues[0]
      return { state: appStateSchema.parse({}), error: `state.json (${issue.path.join('.') || 'корень'}): ${issue.message}` }
    }
    return { state: result.data, error: null }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { state: appStateSchema.parse({}), error: null }
    throw error
  }
}

async function writeAppState(raw: unknown): Promise<void> {
  const state = appStateSchema.parse(raw)
  for (const target of [...state.folders, ...state.openTabs]) {
    if (!isAllowedPath(target)) throw new Error(`Состояние содержит путь вне разрешённой рабочей области: ${target}`)
  }
  await fs.mkdir(path.dirname(appStatePath()), { recursive: true })
  await atomicWrite(appStatePath(), Buffer.from(`${JSON.stringify(state, null, 2)}\n`, 'utf8'))
}

async function readSettings(): Promise<{ settings: unknown; error: string | null }> {
  try {
    const raw = await fs.readFile(settingsPath(), 'utf8')
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch (error) {
      return { settings: defaultSettings, error: `settings.json: ${error instanceof Error ? error.message : String(error)}` }
    }
    const result = settingsSchema.safeParse(parsed)
    if (!result.success) {
      const issue = result.error.issues[0]
      return { settings: defaultSettings, error: `settings.json (${issue.path.join('.') || 'корень'}): ${issue.message}` }
    }
    if (!(await isKnownTheme(result.data.theme))) {
      return { settings: defaultSettings, error: `settings.json (theme): неизвестная тема «${result.data.theme}»` }
    }
    return { settings: result.data, error: null }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { settings: defaultSettings, error: null }
    throw error
  }
}

async function writeSettings(raw: Record<string, unknown>): Promise<{ settings: unknown; error: null }> {
  const parsed = settingsSchema.parse(raw)
  if (!(await isKnownTheme(parsed.theme))) throw new Error(`Неизвестная тема «${parsed.theme}».`)
  const target = settingsPath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  await atomicWrite(target, Buffer.from(`${JSON.stringify(parsed, null, 2)}\n`, 'utf8'))
  return { settings: parsed, error: null }
}

async function applyTextToSource(request: ApplyTextRequest): Promise<void> {
  const target = path.resolve(request.path)
  if (!isAllowedPath(target)) throw new Error('Обновление исходника вне разрешённой рабочей области запрещено.')
  if (!/\.(txt|md)$/i.test(target) || /\.annot\.(json|md)$/i.test(target)) {
    throw new Error('Применить текст можно только к исходному файлу .txt или .md.')
  }
  const contents = encodeTextBuffer(request.text, request.encoding, request.eol, request.hasBom)
  await fs.copyFile(target, `${target}.bak`)
  await atomicWrite(target, contents)
  fileDigests.set(target, digest(contents))
}

async function saveDocument(request: SaveRequest): Promise<SavedFile | null> {
  let target = request.path ? path.resolve(request.path) : null
  if (target && !isAllowedPath(target)) throw new Error('Сохранение вне разрешённой рабочей области запрещено.')
  if (target && request.annotationPath) {
    const annotationTarget = path.resolve(request.annotationPath)
    const validSidecars = [target, annotatedPath(target), annotatedPath(target, 'md')]
    if (!isAllowedPath(annotationTarget) || !validSidecars.includes(annotationTarget)) {
      throw new Error('Файл аннотаций должен находиться рядом с исходным документом.')
    }

  }
  const isNewSource = !target
  if (!target) {
    if (!mainWindow) return null
    const result = await dialog.showSaveDialog(mainWindow, {
      defaultPath: 'Новый документ.txt',
      filters: [{ name: 'Текст', extensions: ['txt'] }, { name: 'Markdown', extensions: ['md'] }],
    })
    if (result.canceled || !result.filePath) return null
    target = path.resolve(result.filePath)
    allowedRoots.add(path.dirname(target))
  }
  let contents: Buffer
  let savedAnnotationPath: string | null = null
  if (request.document) {
    const document = request.document as unknown as AnnotatedDocument
    savedAnnotationPath = isNewSource
      ? annotatedPath(target, request.saveFormat)
      : request.annotationPath ?? annotatedPath(target, request.saveFormat)
    if (isNewSource) {
      const sourceBytes = encodeTextBuffer(request.text, request.encoding, request.eol, request.hasBom)
      await atomicWrite(target, sourceBytes)
      fileDigests.set(target, digest(sourceBytes))
      await watchFile(target)
    }
    await backupBeforeWrite(savedAnnotationPath, request.backupIntervalMin)
    const bytes = /\.annot\.md$/i.test(savedAnnotationPath)
      ? Buffer.from(serializeMarkdownDocument(document, request.eol as '\n' | '\r\n' | '\r'), 'utf8')
      : Buffer.from(JSON.stringify(document, null, 2), 'utf8')
    await atomicWrite(savedAnnotationPath, bytes)
    fileDigests.set(savedAnnotationPath, digest(bytes))
    await watchFile(savedAnnotationPath)
  } else {
    contents = encodeTextBuffer(request.text, request.encoding, request.eol, request.hasBom)
    await atomicWrite(target, contents)
    fileDigests.set(target, digest(contents))
  }
  return { path: target, annotationPath: savedAnnotationPath }
}

function installHandler<K extends Channel>(channel: K, handler: (payload: ReturnType<(typeof channelSchemas)[K]['parse']>) => unknown | Promise<unknown>): void {
  ipcMain.handle(channel, async (event, rawPayload) => {
    assertTrustedSender(event)
    const payload = channelSchemas[channel].parse(rawPayload) as ReturnType<(typeof channelSchemas)[K]['parse']>
    return handler(payload)
  })
}

function registerIpc(): void {
  for (const channel of channelNames) ipcMain.removeHandler(channel)
  installHandler('dialog:openFile', () => chooseDocument())
  installHandler('dialog:openFolder', async ({ add }) => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory', 'multiSelections'] })
    if (result.canceled || !result.filePaths.length) return null
    if (!add) {
      await Promise.all([...folderWatchers.values()].map((watcher) => watcher.close()))
      folderWatchers.clear()
      allowedRoots.clear()
      for (const filePath of watchedFiles.keys()) allowedRoots.add(path.dirname(filePath))
    }
    const selectedFolders = result.filePaths.map((directory) => path.resolve(directory))
    const folders = [...new Set([...(add ? [...folderWatchers.keys()] : []), ...selectedFolders])]
    for (const directory of selectedFolders) {
      allowedRoots.add(directory)
      watchFolderRoot(directory)
    }
    return {
      folders: await Promise.all(folders.map(async (directory) => ({ path: directory, entries: await listDirectory(directory) }))),
    }
  })
  installHandler('dialog:openWorkspace', () => openWorkspaceFile())
  installHandler('state:get', async () => {
    const result = await readAppState()
    for (const directory of result.state.folders) {
      const resolved = path.resolve(directory)
      allowedRoots.add(resolved)
      if (await exists(resolved)) watchFolderRoot(resolved)
    }
    for (const filePath of result.state.openTabs) allowedRoots.add(path.dirname(path.resolve(filePath)))
    return result
  })
  installHandler('state:save', (state) => writeAppState(state))
  installHandler('dialog:chooseEncoding', async ({ current }) => {
    if (!mainWindow) return null
    const encodings = [...new Set([current, 'utf-8', 'windows-1251', 'utf-16le', 'utf-16be', 'koi8-r', 'iso-8859-1'])]
      .filter((encoding) => iconv.encodingExists(encoding === 'utf-16be' ? 'utf16-be' : encoding))
    const result = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: 'Переоткрыть с кодировкой',
      message: 'Выберите кодировку для повторного чтения файла.',
      buttons: [...encodings, 'Отмена'],
      defaultId: Math.max(0, encodings.indexOf(current)),
      cancelId: encodings.length,
      noLink: true,
    })
    return result.response < encodings.length ? encodings[result.response] ?? null : null
  })
  installHandler('dialog:saveWorkspace', ({ folders, openTabs, activeTab, settings }) => saveWorkspaceFile(folders, openTabs, activeTab, settings))
  installHandler('fs:list', ({ path: directory }) => listDirectory(directory))
  installHandler('fs:create', ({ parentPath, name, kind }) => createEntry(parentPath, name, kind))
  installHandler('fs:rename', ({ path: entryPath, name }) => renameEntry(entryPath, name))
  installHandler('fs:transfer', ({ paths, destination, copy }) => transferEntries(paths, destination, copy))
  installHandler('fs:undo', () => undoFileOperation())
  installHandler('fs:delete', ({ path: entryPath, includeSidecars }) => deleteEntry(entryPath, includeSidecars))
  installHandler('fs:read', ({ path: filePath, encoding }) => openDocumentAndWatch(path.resolve(filePath), encoding))
  installHandler('fs:readSource', ({ path: filePath, encoding }) => readSourceText(filePath, encoding))
  installHandler('fs:watchAck', async ({ path: filePath }) => {
    const target = path.resolve(filePath)
    if (!isAllowedPath(target)) throw new Error('Путь вне разрешённой рабочей области.')
    fileDigests.set(target, await currentDigest(target))
  })
  installHandler('fs:applyText', (request) => applyTextToSource(request as ApplyTextRequest))
  installHandler('fs:save', (payload) => saveDocument(payload as SaveRequest))
  installHandler('settings:get', () => readSettings())
  installHandler('settings:save', (settings) => writeSettings(settings))
  installHandler('settings:openFile', async () => {
    await fs.mkdir(path.dirname(settingsPath()), { recursive: true })
    if (!(await exists(settingsPath()))) await atomicWrite(settingsPath(), Buffer.from(`${JSON.stringify(defaultSettings, null, 2)}\n`, 'utf8'))
    const error = await shell.openPath(settingsPath())
    if (error) throw new Error(`Не удалось открыть settings.json: ${error}`)
  })
  installHandler('themes:list', async () => ({ ...(await readUserThemes()), systemUsesDarkColors: nativeTheme.shouldUseDarkColors }))
  installHandler('themes:save', async (raw) => {
    const theme = themeSchema.parse(raw)
    if (theme.id in themes) throw new Error('Нельзя заменить встроенную тему.')
    if (theme.extends && !(theme.extends in themes)) throw new Error(`Неизвестная базовая тема «${theme.extends}».`)
    const required = ['ui.bg', 'ui.fg', 'ui.accent', 'editor.bg', 'editor.fg', 'editor.selection', 'annot.default']
    if (!theme.extends && required.some((key) => !(key in theme.colors))) {
      throw new Error('Тема без базовой темы должна определить обязательные цвета интерфейса и редактора.')
    }
    await fs.mkdir(userThemesPath(), { recursive: true })
    await atomicWrite(path.join(userThemesPath(), `${theme.id}.json`), Buffer.from(`${JSON.stringify(theme, null, 2)}\n`, 'utf8'))
    return theme
  })
  installHandler('themes:delete', async ({ id }) => {
    if (id in themes) throw new Error('Нельзя удалить встроенную тему.')
    await fs.rm(path.join(userThemesPath(), `${id}.json`))
  })
  installHandler('app:relaunch', () => {
    setTimeout(() => {
      app.relaunch()
      app.exit(0)
    }, 100)
  })
  installHandler('recovery:save', async (snapshot) => {
    const target = recoveryPath(snapshot.path)
    await fs.mkdir(path.dirname(target), { recursive: true })
    await atomicWrite(target, Buffer.from(JSON.stringify(snapshot), 'utf8'))
  })
  installHandler('recovery:list', async () => {
    const directory = path.join(app.getPath('userData'), 'recovery')
    try {
      const files = await fs.readdir(directory)
      const snapshots: RecoverySnapshot[] = []
      for (const file of files.filter((name) => /^[a-f0-9]{64}\.json$/.test(name))) {
        try {
          const parsed: unknown = JSON.parse(await fs.readFile(path.join(directory, file), 'utf8'))
          if (parsed && typeof parsed === 'object' && 'text' in parsed && typeof parsed.text === 'string') snapshots.push(parsed as RecoverySnapshot)
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error
        }
      }
      return snapshots
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
  })
  installHandler('recovery:delete', async ({ path: documentPath }) => {
    await fs.rm(recoveryPath(documentPath), { force: true })
  })
  installHandler('shell:openExternal', async ({ url }) => {
    const parsed = new URL(url)
    if (!['http:', 'https:', 'mailto:'].includes(parsed.protocol)) throw new Error('Эта схема ссылки запрещена.')
    await shell.openExternal(parsed.href)
  })
  installHandler('shell:showItemInFolder', async ({ path: itemPath }) => {
    const target = path.resolve(itemPath)
    await assertOrdinaryEntry(target)
    shell.showItemInFolder(target)
  })
  installHandler('shell:copyPath', async ({ path: itemPath }) => {
    const target = path.resolve(itemPath)
    await assertOrdinaryEntry(target)
    clipboard.writeText(target)
  })
}

async function registerAppProtocol(): Promise<void> {
  if (isDev) return
  const rendererRoot = path.resolve(currentDir, '../renderer')
  await protocol.handle('app', async (request) => {
    const pathname = new URL(request.url).pathname
    const target = path.resolve(rendererRoot, `.${decodeURIComponent(pathname === '/' ? '/index.html' : pathname)}`)
    if (!target.startsWith(rendererRoot + path.sep) && target !== path.join(rendererRoot, 'index.html')) {
      console.error(`Запрос к ресурсу вне каталога приложения: ${target}`)
      return new Response('Not found', { status: 404 })
    }
    try {
      const response = await net.fetch(pathToFileURL(target).toString())
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const nonce = randomBytes(16).toString('base64')
      if (target.endsWith('.html')) {
        const headers = new Headers(response.headers)
        headers.set('Content-Security-Policy', `default-src 'self'; script-src 'self'; style-src 'self' 'nonce-${nonce}'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'`)
        return new Response((await response.text()).replace('</head>', `<meta name="csp-nonce" content="${nonce}"></head>`), { headers })
      }
      return response
    } catch (error) {
      console.error(`Не удалось загрузить ресурс приложения: ${target}`, error)
      return new Response('Не удалось загрузить ресурс приложения.', { status: 500 })
    }
  })
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 820,
    minHeight: 520,
    show: false,
    backgroundColor: '#282a36',
    webPreferences: {
      preload: path.join(currentDir, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  })
  mainWindow.once('ready-to-show', () => mainWindow?.show())
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev ? /^https?:\/\/(localhost|127\.0\.0\.1):/.test(url) : url.startsWith('app://')
    if (!allowed) event.preventDefault()
  })
  if (isDev && process.env.ELECTRON_RENDERER_URL) {
    await mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    await mainWindow.loadURL('app://renderer/index.html')
  }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', (_event, argv) => {
    const documentPath = argv.find((argument) => /\.(txt|md)$/i.test(argument))
    if (documentPath && isAllowedPath(path.resolve(documentPath))) {
      allowedRoots.add(path.dirname(path.resolve(documentPath)))
      void openDocumentAndWatch(path.resolve(documentPath)).then((document) => {
        if (document) mainWindow?.webContents.send('file:open', document)
      }).catch((error: unknown) => console.error('Не удалось открыть документ из второго экземпляра.', error))
    }
    mainWindow?.show()
    mainWindow?.focus()
  })
  void app.whenReady().then(async () => {
    Menu.setApplicationMenu(null)
    const currentSession = mainWindow?.webContents.session ?? (await import('electron')).session.defaultSession
    currentSession.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
    currentSession.setPermissionCheckHandler(() => false)
    registerIpc()
    nativeTheme.on('updated', () => mainWindow?.webContents.send('theme:systemChanged', nativeTheme.shouldUseDarkColors))
    await registerAppProtocol()
    await createWindow()
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) void createWindow()
    })
  }).catch((error: unknown) => {
    console.error('Не удалось запустить Annotator.', error)
    dialog.showErrorBox('Annotator', `Не удалось запустить приложение: ${error instanceof Error ? error.message : String(error)}`)
    app.quit()
  })
}

app.on('window-all-closed', () => {
  for (const watcher of watchedFiles.values()) void watcher.close()
  for (const watcher of folderWatchers.values()) void watcher.close()
  watchedFiles.clear()
  folderWatchers.clear()
  if (process.platform !== 'darwin') app.quit()
})
