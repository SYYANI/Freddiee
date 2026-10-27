// Electron no longer downloads its binary during npm install. electron-vite
// reads path.txt directly, so install it before applying the development patches.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const installer = new URL('../node_modules/electron/install.js', import.meta.url)

// Electron is a devDependency; allow installs that omit development dependencies.
if (existsSync(installer)) {
  // The official installer checks the version and executable before downloading.
  console.log('Ensuring the Electron binary is installed...')
  const result = spawnSync(process.execPath, [fileURLToPath(installer)], { stdio: 'inherit' })
  if (result.error) {
    console.error('Unable to start the Electron installer:', result.error.message)
  }
  process.exit(result.status ?? 1)
}
