/** One remembered fact, episode, or user profile. */
export type MemoryKind = 'profile' | 'fact' | 'episode'

export interface MemoryEntry {
  id: string
  /** The character card that owns this memory. `undefined` means every card reads it. */
  persona?: string
  kind: MemoryKind
  description: string
  body: string
  importance: number
  pinned: boolean
  source?: string
  sourceSessionId?: string
  createdAt: number
  updatedAt: number
  lastUsedAt?: number
  useCount: number
  supersededBy?: string
  deletedAt?: number
}

export interface MemoryWriteInput {
  id?: string
  persona?: string
  kind?: MemoryKind
  description: string
  body: string
  importance?: number
  pinned?: boolean
  source?: string
  sourceSessionId?: string
}

export interface MemoryPatch {
  persona?: string | null
  kind?: MemoryKind
  description?: string
  body?: string
  importance?: number
  pinned?: boolean
  supersededBy?: string | null
  deletedAt?: number | null
}

export interface MemoryListFilter {
  persona?: string
  includeGeneral?: boolean
  kind?: MemoryKind
  limit?: number
  offset?: number
}
