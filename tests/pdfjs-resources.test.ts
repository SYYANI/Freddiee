import { describe, expect, it } from 'vitest'
import { pdfjsResourceBase } from '../electron/main/pdfjsResources'

describe('PDF.js resource paths', () => {
  it('always ends filesystem directories with the forward slash PDF.js requires', () => {
    expect(pdfjsResourceBase('/app/node_modules/pdfjs-dist/wasm')).toBe('/app/node_modules/pdfjs-dist/wasm/')
    expect(pdfjsResourceBase(String.raw`C:\app\node_modules\pdfjs-dist\wasm`)).toBe(String.raw`C:\app\node_modules\pdfjs-dist\wasm/`)
    expect(pdfjsResourceBase('C:\\app\\node_modules\\pdfjs-dist\\wasm\\')).toBe(String.raw`C:\app\node_modules\pdfjs-dist\wasm/`)
  })
})
