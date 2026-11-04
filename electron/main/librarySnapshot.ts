import type { LibrarySnapshot, LibrarySnapshotUpdate } from '../../shared/types'
import { reuseEqual } from '../../shared/reuseEqual'

/** Shares snapshot work across windows and sends only sections changed since their last read. */
export class LibrarySnapshotCache {
  private pending?: Promise<void>
  private loadedVersion?: string
  private loadedAt = 0
  private revision = 0
  private readonly history = new Map<number, LibrarySnapshot>()

  constructor(private readonly load: () => Promise<LibrarySnapshot>, private readonly version: () => string) {}

  async read(since?: number): Promise<LibrarySnapshotUpdate> {
    // Recheck disk on a later read as well: writings can be edited by external tools.
    // At most two loads: the first may be one already in flight from before this read, the second
    // starts after it. Steady writes cannot hold the read open; each of them sends a later notification.
    for (let attempt = 0; attempt < 2 && this.stale(); attempt++) {
      this.pending ??= this.refresh().finally(() => { this.pending = undefined })
      await this.pending
    }
    const snapshot = this.history.get(this.revision)!
    const previous = since === undefined ? undefined : this.history.get(since)
    if (!previous) return { revision: this.revision, full: true, changes: snapshot }
    const changes: Partial<LibrarySnapshot> = {}
    for (const key of new Set([...Object.keys(previous), ...Object.keys(snapshot)]) as Set<keyof LibrarySnapshot>) {
      if (snapshot[key] !== previous[key]) Object.assign(changes, { [key]: snapshot[key] })
    }
    return { revision: this.revision, full: false, changes }
  }

  private stale(): boolean {
    return this.loadedVersion !== this.version() || Date.now() - this.loadedAt >= 1000
  }

  private async refresh(): Promise<void> {
    // Record the version from before the load, so a save that lands during it leaves the result stale.
    const version = this.version()
    const next = await this.load()
    const previous = this.history.get(this.revision)
    const snapshot = reuseEqual(previous, next)
    if (snapshot !== previous) {
      this.revision += 1
      this.history.set(this.revision, snapshot)
      // A slow or reloaded window can always recover with a full snapshot.
      if (this.history.size > 4) this.history.delete(this.history.keys().next().value!)
    }
    this.loadedVersion = version
    this.loadedAt = Date.now()
  }
}
