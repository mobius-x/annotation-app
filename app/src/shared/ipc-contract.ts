import { z } from 'zod'

export const channelSchemas = {
  'dialog:openFile': z.void(),
  'dialog:openFolder': z.object({ add: z.boolean().default(false) }),
  'dialog:openWorkspace': z.void(),
  'dialog:chooseEncoding': z.object({ current: z.string().min(1) }),
  'state:get': z.void(),
  'state:save': z.object({
    folders: z.array(z.string()),
    openTabs: z.array(z.string()),
    activeTab: z.number().int().nonnegative(),
    lastWorkspace: z.string().nullable(),
    layout: z.object({
      explorerWidth: z.number().int().min(190).max(380),
      annotationsWidth: z.number().int().min(270).max(460),
      showExplorer: z.boolean(),
      showAnnotations: z.boolean(),
      showOutline: z.boolean(),
    }).optional(),
  }),
  'dialog:saveWorkspace': z.object({
    folders: z.array(z.string().min(1)).min(1),
    openTabs: z.array(z.string()),
    activeTab: z.number().int().nonnegative(),
    settings: z.record(z.string(), z.unknown()).optional(),
  }),
  'fs:list': z.object({ path: z.string().min(1) }),
  'fs:create': z.object({
    parentPath: z.string().min(1),
    name: z.string().min(1),
    kind: z.enum(['file', 'directory']),
  }),
  'fs:rename': z.object({
    path: z.string().min(1),
    name: z.string().min(1),
  }),
  'fs:transfer': z.object({
    paths: z.array(z.string().min(1)).min(1),
    destination: z.string().min(1),
    copy: z.boolean(),
  }),
  'fs:undo': z.void(),
  'fs:delete': z.object({
    path: z.string().min(1),
    includeSidecars: z.boolean().default(false),
  }),
  'fs:read': z.object({ path: z.string().min(1), encoding: z.string().min(1).optional() }),
  'fs:readSource': z.object({ path: z.string().min(1), encoding: z.string().min(1).optional() }),
  'fs:watchAck': z.object({ path: z.string().min(1) }),
  'fs:applyText': z.object({
    path: z.string().min(1),
    text: z.string(),
    encoding: z.string(),
    eol: z.enum(['\n', '\r\n', '\r']),
    hasBom: z.boolean(),
  }),
  'fs:save': z.object({
    path: z.string().nullable(),
    annotationPath: z.string().nullable(),
    text: z.string(),
    encoding: z.string(),
    eol: z.enum(['\n', '\r\n', '\r']),
    hasBom: z.boolean(),
    document: z.record(z.string(), z.unknown()).nullable(),
    backupIntervalMin: z.number().int().min(1).max(1440).default(10),
    saveFormat: z.enum(['json', 'md']).default('json'),
  }),
  'settings:get': z.void(),
  'settings:save': z.record(z.string(), z.unknown()),
  'settings:openFile': z.void(),
  'themes:list': z.void(),
  'themes:save': z.record(z.string(), z.unknown()),
  'themes:delete': z.object({ id: z.string().min(1) }),
  'app:relaunch': z.void(),
  'recovery:save': z.object({
    path: z.string().nullable(),
    text: z.string(),
    annotations: z.array(z.unknown()),
    modified: z.string(),
  }),
  'recovery:list': z.void(),
  'recovery:delete': z.object({ path: z.string().nullable() }),
  'shell:openExternal': z.object({ url: z.string().url() }),
  'shell:showItemInFolder': z.object({ path: z.string().min(1) }),
  'shell:copyPath': z.object({ path: z.string().min(1) }),
} as const

export type Channel = keyof typeof channelSchemas

export const channelNames = Object.keys(channelSchemas) as Channel[]
