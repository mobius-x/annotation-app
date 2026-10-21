import path from 'node:path'
import { z } from 'zod'

const workspaceFolderSchema = z.object({
  path: z.string().min(1),
  name: z.string().min(1).optional(),
}).passthrough()

export const workspaceSchema = z.object({
  version: z.literal(1),
  folders: z.array(workspaceFolderSchema).min(1),
  settings: z.record(z.string(), z.unknown()).optional(),
  state: z.object({
    openTabs: z.array(z.string()).default([]),
    activeTab: z.number().int().nonnegative().default(0),
  }).passthrough().optional(),
}).passthrough()

export type WorkspaceDocument = z.infer<typeof workspaceSchema>

export function parseWorkspaceFile(source: string): WorkspaceDocument {
  let parsed: unknown
  try {
    parsed = JSON.parse(source)
  } catch (error) {
    throw new Error(`Некорректный файл workspace: ${error instanceof Error ? error.message : String(error)}`)
  }
  const result = workspaceSchema.safeParse(parsed)
  if (!result.success) {
    const issue = result.error.issues[0]
    throw new Error(`Некорректный файл workspace (${issue.path.join('.') || 'корень'}): ${issue.message}`)
  }
  return result.data
}

export function workspacePathFromFile(workspaceFile: string, storedPath: string): string {
  return path.resolve(path.dirname(workspaceFile), storedPath)
}

export function serializeWorkspaceFile(
  workspaceFile: string,
  folders: string[],
  openTabs: string[],
  activeTab: number,
  settings?: Record<string, unknown>,
): string {
  const directory = path.dirname(path.resolve(workspaceFile))
  const storeRelative = (target: string) => {
    const resolved = path.resolve(target)
    const relative = path.relative(directory, resolved)
    return path.isAbsolute(relative) ? resolved : relative.replace(/\\/g, '/')
  }
  return `${JSON.stringify({
    version: 1,
    folders: folders.map((folder) => ({ path: storeRelative(folder) })),
    ...(settings ? { settings } : {}),
    state: {
      openTabs: openTabs.map(storeRelative),
      activeTab,
    },
  }, null, 2)}\n`
}
