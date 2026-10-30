// Library sync status shown in Settings > Sync. Credentials and tokens never cross IPC.

export type SyncConflictChoice = 'thisDevice' | 'server' | 'keepBoth'

export interface SyncConflictSummary {
  id: string
  title: string
  remoteDeleted: boolean
  localDeleted: boolean
  isWriting: boolean
}

export interface SyncUnavailableAttachment {
  id: string
  paperTitle: string
  filename: string
  reason: 'missing' | 'unreadable' | 'outsideLibrary'
}

export interface SyncStatus {
  configuration?: { server: string; label: string; isEnabled: boolean }
  isSyncing: boolean
  /** An English catalog key, translated by the renderer. */
  statusKey: string
  /** Already translated. */
  errorMessage?: string
  lastSuccess?: string
  pendingCount: number
  progressCompleted: number
  progressTotal: number
  needsHistoryReview: boolean
  conflicts: SyncConflictSummary[]
  unavailableAttachments: SyncUnavailableAttachment[]
}

/** Papers and writings whose files sync replaced, so open readers and editors reload. */
export interface SyncAppliedChange {
  paperIds: string[]
  writingIds: string[]
}
