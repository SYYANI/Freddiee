// @electron/osx-sign vendors isbinaryfile 4.0.10, whose protobuf "taste" parse
// throws RangeError: Invalid array length on files whose leading varints encode
// a length far beyond the 512 bytes it reads — the DocLayout-YOLO ONNX model
// being the packaged trigger. The throw happens inside an fs.read callback, so
// it kills the whole electron-builder process during signing. Patch the vendored
// Reader.next to treat an impossible length as an error, which makes the file
// fall through to the ordinary binary magic checks. Upstream-fixed in newer
// isbinaryfile; drop this when @electron/osx-sign ships one.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const target = join(process.cwd(), 'node_modules/@electron/osx-sign/node_modules/isbinaryfile/lib/index.js')
if (!existsSync(target)) {
  process.exit(0)
}

const broken = `        const n = new Array();`
const fixed = `        const n = new Array();
        if (len < 0 || len > this.size) {
            this.error = true;
            return n;
        }`
const source = readFileSync(target, 'utf8')
if (source.includes(fixed) || !source.includes(broken)) {
  process.exit(0)
}
writeFileSync(target, source.replace(broken, fixed))
console.log('Patched vendored isbinaryfile against oversized protobuf lengths (ONNX signing crash)')
