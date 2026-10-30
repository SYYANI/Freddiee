import electron from 'electron'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWriteFile } from './files'

const { safeStorage } = electron

interface SecretFile {
  /** Written by schema 2, before keys were stored per provider. */
  apiKey?: string
  providers?: Record<string, string>
  /** Library sync device tokens, by server and device. */
  sync?: Record<string, string>
}

/**
 * API keys encrypted with the operating system's credential storage (Keychain, DPAPI, or
 * the Linux secret service). Keys never leave the main process.
 */
export class SecretStore {
  private readonly path: string
  private queue: Promise<void> = Promise.resolve()

  constructor(root: string) {
    this.path = join(root, 'secrets.json')
  }

  private async read(): Promise<SecretFile> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as SecretFile
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
      throw error
    }
  }

  private update(change: (file: SecretFile) => void): Promise<void> {
    this.queue = this.queue.catch(() => undefined).then(async () => {
      const file = await this.read()
      change(file)
      await atomicWriteFile(this.path, `${JSON.stringify(file, null, 2)}\n`, 0o600)
    })
    return this.queue
  }

  async setKey(providerId: string, value: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is not available on this system.')
    const encrypted = safeStorage.encryptString(value).toString('base64')
    await this.update((file) => {
      file.providers = { ...file.providers, [providerId]: encrypted }
    })
  }

  async removeKey(providerId: string): Promise<void> {
    await this.update((file) => {
      if (file.providers) delete file.providers[providerId]
    })
  }

  async key(providerId: string): Promise<string | undefined> {
    const encrypted = (await this.read()).providers?.[providerId]
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return undefined
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  }

  async setSyncToken(account: string, token: string): Promise<void> {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('Secure credential storage is not available on this system.')
    const encrypted = safeStorage.encryptString(token).toString('base64')
    await this.update((file) => {
      file.sync = { ...file.sync, [account]: encrypted }
    })
  }

  async syncToken(account: string): Promise<string | undefined> {
    const encrypted = (await this.read()).sync?.[account]
    if (!encrypted || !safeStorage.isEncryptionAvailable()) return undefined
    return safeStorage.decryptString(Buffer.from(encrypted, 'base64'))
  }

  async configuredProviderIds(): Promise<Set<string>> {
    return new Set(Object.keys((await this.read()).providers ?? {}))
  }

  /** Moves the single schema-2 key to the provider profile that replaced its settings. */
  async migrateLegacyKey(providerId: string): Promise<void> {
    await this.update((file) => {
      if (!file.apiKey) return
      file.providers = { ...file.providers, [providerId]: file.apiKey }
      delete file.apiKey
    })
  }
}
