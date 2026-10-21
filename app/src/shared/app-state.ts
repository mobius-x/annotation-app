import { z } from 'zod'

export const appStateSchema = z.object({
  version: z.literal(1).default(1),
  folders: z.array(z.string()).default([]),
  openTabs: z.array(z.string()).default([]),
  activeTab: z.number().int().nonnegative().default(0),
  lastWorkspace: z.string().nullable().default(null),
})

export type AppState = z.infer<typeof appStateSchema>
