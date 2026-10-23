// macOS reads the Dock label from the bundle's Info.plist, which app.setName()
// cannot change at runtime. Rename the development Electron.app bundle so
// `npm run dev` shows "Freddie" instead of "Electron". Packaged builds use
// electron-builder's productName and are unaffected.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

const APP_NAME = 'Freddie'

if (process.platform === 'darwin') {
  const plist = join(process.cwd(), 'node_modules/electron/dist/Electron.app/Contents/Info.plist')
  if (existsSync(plist)) {
    for (const key of ['CFBundleName', 'CFBundleDisplayName']) {
      execFileSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${APP_NAME}`, plist])
    }
    console.log(`Patched development Electron.app name to ${APP_NAME}`)
  }
}
