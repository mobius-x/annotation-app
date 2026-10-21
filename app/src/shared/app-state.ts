import { z } from 'zod'

export const appLayoutSchema = z.object({
  explorerWidth: z.number().int().min(190).max(380).default(250),
  annotationsWidth: z.number().int().min(270).max(460).default(340),
  showExplorer: z.boolean().default(true),
  showAnnotations: z.boolean().default(true),
  showOutline: z.boolean().default(true),
}).catch({
  explorerWidth: 250,
  annotationsWidth: 340,
  showExplorer: true,
  showAnnotations: true,
  showOutline: true,
})

export const appStateSchema = z.object({
  version: z.literal(1).default(1),
  folders: z.array(z.string()).default([]),
  openTabs: z.array(z.string()).default([]),
  activeTab: z.number().int().nonnegative().default(0),
  lastWorkspace: z.string().nullable().default(null),
  layout: appLayoutSchema.default({
    explorerWidth: 250,
    annotationsWidth: 340,
    showExplorer: true,
    showAnnotations: true,
    showOutline: true,
  }),
})

export type AppState = z.infer<typeof appStateSchema>
