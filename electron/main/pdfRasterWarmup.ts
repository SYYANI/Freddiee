// A one-page PDF the raster worker draws when it starts. The first page PDF.js draws in a fresh
// worker takes several times longer than later ones while V8 compiles its parser and drawing code;
// drawing this page first moves that cost ahead of the first page a reader asks for.

const content = [
  'BT /F1 11 Tf 8 90 Td (Aa 1) Tj ET',
  'BT /F2 11 Tf 8 70 Td (Bb 2) Tj ET',
  '0.2 0.4 0.8 rg 8 8 40 20 re f',
  '0 G 1.5 w 60 10 m 110 50 l S',
  'q 40 0 0 40 60 70 cm /Im1 Do Q'
].join('\n')
const image = 'FF0000 00FF00 0000FF FFFFFF>'

const objects = [
  '<< /Type /Catalog /Pages 2 0 R >>',
  '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
  '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 120 120] /Contents 6 0 R /Resources << /Font << /F1 4 0 R /F2 5 0 R >> /XObject << /Im1 7 0 R >> >> >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  '<< /Type /Font /Subtype /Type1 /BaseFont /Times-Roman >>',
  `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  `<< /Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /ASCIIHexDecode /Length ${image.length} >>\nstream\n${image}\nendstream`
]

/** Standard-font text, filled and stroked paths and an image: the drawing paths most pages use. */
export function warmupPdf(): Uint8Array {
  let text = '%PDF-1.4\n'
  const offsets = objects.map((body, index) => {
    const offset = text.length
    text += `${index + 1} 0 obj\n${body}\nendobj\n`
    return offset
  })
  const xref = text.length
  text += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) text += `${String(offset).padStart(10, '0')} 00000 n \n`
  text += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(text)
}
