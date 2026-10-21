import { z } from 'zod'

export const channelSchemas = {
  'dialog:openFile': z.void(),
  'dialog:openFolder': z.void(),
  'fs:list': z.object({ path: z.string().min(1) }),
  'fs:read': z.object({ path: z.string().min(1) }),
  'fs:watchAck': z.object({ path: z.string().min(1) }),
  'fs:save': z.object({
    path: z.string().nullable(),
    annotationPath: z.string().nullable(),
    text: z.string(),
    encoding: z.string(),
    eol: z.string(),
    hasBom: z.boolean(),
    document: z.record(z.string(), z.unknown()).nullable(),
  }),
  'settings:get': z.void(),
  'settings:save': z.record(z.string(), z.unknown()),
  'recovery:save': z.object({
    path: z.string().nullable(),
    text: z.string(),
    annotations: z.array(z.unknown()),
    modified: z.string(),
  }),
  'recovery:list': z.void(),
  'recovery:delete': z.object({ path: z.string().nullable() }),
  'shell:openExternal': z.object({ url: z.string().url() }),
} as const

export type Channel = keyof typeof channelSchemas

export const channelNames = Object.keys(channelSchemas) as Channel[]
