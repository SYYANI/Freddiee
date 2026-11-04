import type { LibrarySnapshot, LibrarySnapshotUpdate } from '../../shared/types'
import { reuseEqual } from '../../shared/reuseEqual'

/** Serializes refreshes so an older IPC response cannot overwrite a newer library. */
export class SnapshotLoader {
  private revision?: number
  private snapshot?: LibrarySnapshot
  private pending?: Promise<void>
  private requested = false

  constructor(private readonly read: (since?: number) => Promise<LibrarySnapshotUpdate>, private readonly publish: (snapshot: LibrarySnapshot) => void) {}

  reload = (): Promise<void> => {
    this.requested = true
    this.pending ??= this.drain().finally(() => { this.pending = undefined })
    return this.pending
  }

  private async drain(): Promise<void> {
    while (this.requested) {
      this.requested = false
      const update = await this.read(this.revision)
      if (!update.full && !this.snapshot) throw new Error('Initial library snapshot is incomplete')
      const next = reuseEqual(this.snapshot, update.full ? update.changes : { ...this.snapshot!, ...update.changes })
      this.revision = update.revision
      if (next !== this.snapshot) {
        this.snapshot = next
        this.publish(next)
      }
    }
  }
}
