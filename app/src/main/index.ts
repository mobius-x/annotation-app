import { app, BrowserWindow, dialog, ipcMain, Menu, net, protocol, shell } from 'electron'
import { createHash, randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import chokidar from 'chokidar'
import chardet from 'chardet'
import iconv from 'iconv-lite'
import { channelNames, channelSchemas, type Channel } from '../shared/ipc-contract'
import { parseMarkdownDocument, serializeMarkdownDocument } from '../shared/markdown-format'
import type { AnnotatedDocument, FileEntry, OpenedFile, RecoverySnapshot, SaveRequest, SavedFile } from '../shared/model'

const currentDir = path.dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged && Boolean(process.env.ELECTRON_RENDERER_URL)
const allowedRoots = new Set<string>()
const backupTimes = new Map<string, number>()
let mainWindow: BrowserWindow | null = null
let folderWatcher: ReturnType<typeof chokidar.watch> | null = null

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

if (process.env.ANNOTATOR_SMOOTHING === 'grayscale') {
  app.commandLine.appendSwitch('disable-lcd-text')
}

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
  return readDocument(filePath)
}

function decodeBuffer(buffer: Buffer): Pick<OpenedFile, 'text' | 'encoding' | 'hasBom'> {
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

async function readDocument(filePath: string): Promise<OpenedFile> {
  if (!isAllowedPath(filePath)) throw new Error('Файл находится вне разрешённой папки.')
  if (/\.(annot\.json|annot\.md)$/i.test(filePath)) {
    const isMarkdown = /\.annot\.md$/i.test(filePath)
    const annotationDocument = isMarkdown
      ? parseMarkdownDocument(await fs.readFile(filePath, 'utf8'))
      : JSON.parse(await fs.readFile(filePath, 'utf8')) as AnnotatedDocument
    const source = annotationDocument.document?.source
    const basePath = source ? path.resolve(path.dirname(filePath), source) : filePath.replace(/\.annot\.(?:json|md)$/i, '.txt')
    if (!isMarkdown && typeof annotationDocument.text !== 'string') throw new Error('В файле аннотаций отсутствует текст.')
    return {
      path: source ? basePath : filePath,
      text: annotationDocument.text,
      encoding: 'utf-8',
      eol: annotationDocument.document?.eol === 'crlf' ? '\r\n' : annotationDocument.document?.eol === 'cr' ? '\r' : '\n',
      hasBom: false,
      annotationDocument,
      annotationPath: filePath,
    }
  }
  const bytes = await fs.readFile(filePath)
  const decoded = decodeBuffer(bytes)
  const eol = decoded.text.includes('\r\n') ? '\r\n' : decoded.text.includes('\r') ? '\r' : '\n'
  const text = decoded.text.replace(/\r\n?|\n/g, '\n')
  const jsonPath = annotatedPath(filePath)
  const markdownPath = annotatedPath(filePath, 'md')
  const [hasJson, hasMarkdown] = await Promise.all([exists(jsonPath), exists(markdownPath)])
  if (hasJson && hasMarkdown) throw new Error('Рядом найдены оба формата аннотаций (.annot.json и .annot.md). Откройте нужный файл аннотаций отдельно.')
  const annotationPath = hasMarkdown ? markdownPath : hasJson ? jsonPath : null
  const annotationDocument = annotationPath
    ? hasMarkdown
      ? parseMarkdownDocument(await fs.readFile(annotationPath, 'utf8'))
      : JSON.parse(await fs.readFile(annotationPath, 'utf8'))
    : undefined
  if (annotationDocument && typeof annotationDocument === 'object' && 'text' in annotationDocument && typeof annotationDocument.text === 'string') {
    return { path: filePath, ...decoded, eol, text: annotationDocument.text, annotationDocument, annotationPath }
  }
  return { path: filePath, ...decoded, eol, text, annotationPath }
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
      annotated: entry.isFile() && /\.(txt|md)$/i.test(entry.name) && (names.has(path.basename(annotatedPath(path.join(directory, entry.name))).toLocaleLowerCase('ru'))),
    }))
  items.sort((left, right) => Number(right.kind === 'directory') - Number(left.kind === 'directory') || collator.compare(left.name, right.name))
  return items
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

async function backupBeforeWrite(target: string): Promise<void> {
  const previousBackup = backupTimes.get(target) ?? 0
  if (Date.now() - previousBackup < 10 * 60 * 1000) return
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
  const text = request.text.replace(/\n/g, request.eol)
  let contents: Buffer
  let savedAnnotationPath: string | null = null
  if (request.document) {
    const document = request.document as unknown as AnnotatedDocument
    savedAnnotationPath = isNewSource
      ? annotatedPath(target)
      : request.annotationPath ?? annotatedPath(target)
    if (isNewSource) await atomicWrite(target, Buffer.from(text, 'utf8'))
    await backupBeforeWrite(savedAnnotationPath)
    const bytes = /\.annot\.md$/i.test(savedAnnotationPath)
      ? Buffer.from(serializeMarkdownDocument(document, request.eol as '\n' | '\r\n' | '\r'), 'utf8')
      : Buffer.from(JSON.stringify(document, null, 2), 'utf8')
    await atomicWrite(savedAnnotationPath, bytes)
  } else {
    const encoding = request.encoding === 'utf-16be' ? 'utf16-be' : request.encoding
    if (!iconv.encodingExists(encoding)) throw new Error(`Неизвестная кодировка: ${request.encoding}`)
    contents = iconv.encode(text, encoding)
    if (iconv.decode(contents, encoding) !== text) {
      throw new Error('Текст нельзя записать в исходной кодировке. Сохраните его как UTF-8.')
    }
    if (request.hasBom) {
      const bom = encoding === 'utf-8' ? Buffer.from([0xef, 0xbb, 0xbf]) : encoding === 'utf-16le' ? Buffer.from([0xff, 0xfe]) : Buffer.from([0xfe, 0xff])
      contents = Buffer.concat([bom, contents])
    }
    await atomicWrite(target, contents)
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
  installHandler('dialog:openFolder', async () => {
    if (!mainWindow) return null
    const result = await dialog.showOpenDialog(mainWindow, { properties: ['openDirectory'] })
    if (result.canceled || !result.filePaths[0]) return null
    const directory = path.resolve(result.filePaths[0])
    allowedRoots.add(directory)
    folderWatcher?.close()
    folderWatcher = chokidar.watch(directory, {
      depth: 0,
      ignoreInitial: true,
      ignored: /(^|[\\/])(\.git|node_modules|\.tools|\.cache|\.userdata)([\\/]|$)|(^|[\\/])\.~|\.bak$|\.tmp$/,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 100 },
    })
    folderWatcher.on('all', () => mainWindow?.webContents.send('workspace:refresh'))
    return { path: directory, entries: await listDirectory(directory) }
  })
  installHandler('fs:list', ({ path: directory }) => listDirectory(directory))
  installHandler('fs:read', ({ path: filePath }) => readDocument(path.resolve(filePath)))
  installHandler('fs:save', (payload) => saveDocument(payload as SaveRequest))
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
      void readDocument(path.resolve(documentPath)).then((document) => mainWindow?.webContents.send('file:open', document))
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
  if (process.platform !== 'darwin') app.quit()
})
