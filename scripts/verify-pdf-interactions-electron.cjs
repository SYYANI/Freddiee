// Real Electron interaction checks against an isolated library produced by benchmark-pdf.mjs.
// Native menu items are selected programmatically; no debug bridge is exposed to the renderer.
const { app, Menu } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const config = require(process.env.FREDDIE_BENCH_CONFIG)
if (path.resolve(config.dataRoot) !== path.resolve(config.work, 'library')) throw new Error('An isolated benchmark library is required')
const scenario = config.scenarios[0]
if (scenario.mode !== 'bilingualPDF') throw new Error('These checks require a bilingual PDF scenario')
const library = require(path.join(config.dataRoot, 'library.json'))
const attachment = library.attachments.find(item => item.paperId === scenario.paperId && item.kind === 'translatedPDF')
if (!attachment) throw new Error('A registered translated PDF is required')
app.setPath('userData', path.join(config.work, 'interaction-profile'))
app.setAppPath(config.root)
process.env.ELECTRON_RENDERER_URL = config.variants.optimized
const delay = ms => new Promise(done => setTimeout(done, ms))
const report = {checks: []}
const evaluate = async (window, expression) => {
  const result = await window.webContents.executeJavaScript('(async()=>{try{return {value:await ('+expression+')}}catch(e){return {error:String(e.stack||e)}}})()', true)
  if (result.error) throw new Error(result.error)
  return result.value
}
let started = false
app.on('browser-window-created', (_, window) => {
  if (started) return
  started = true
  window.webContents.once('did-finish-load', () => run(window).catch(async error => {
    console.error(error)
    report.error = String(error.stack || error)
    await fs.writeFile(path.join(config.work, 'interactions.json'), JSON.stringify(report, null, 2))
    app.exit(1)
  }))
})
require(path.join(config.root, 'out/main/index.cjs'))
async function until(window, expression, message) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    if (await evaluate(window, expression)) return
    await delay(100)
  }
  throw new Error(message)
}
async function ready(window) {
  await until(window, `(() => document.querySelectorAll('.pdf-scroller').length === 2 && [...document.querySelectorAll('.pdf-scroller')].every(reader => {
    const center = reader.scrollTop + reader.clientHeight/2;
    const page = [...reader.querySelectorAll('.pdf-page')].find(p => center >= parseFloat(p.style.top) && center < parseFloat(p.style.top)+parseFloat(p.style.height));
    const layer = reader.querySelector('.pdf-canvas-area').shadowRoot?.querySelector('[data-page-index="'+page?.dataset.pageIndex+'"] .textLayer');
    return page?.querySelector('canvas')?.width > 0 && layer?.textContent.length > 0 && !layer.hasAttribute('aria-busy');
  }))()`, 'PDF text/bitmap readiness timed out')
  await delay(300)
}
async function click(window, labels) {
  await evaluate(window, `(() => {
    const button = [...document.querySelectorAll('button')].find(b => ${JSON.stringify(labels)}.includes(b.getAttribute('aria-label')));
    if (!button || button.disabled) throw new Error('Unavailable control: '+${JSON.stringify(labels[0])});
    button.click();
  })()`)
}
async function run(window) {
  window.setSize(1220,780); window.show(); window.focus()
  await ready(window)
  await evaluate(window, `(async () => {
    await window.freddie.annotations.save(${JSON.stringify(scenario.paperId)},${JSON.stringify(attachment.id)},[]);
  })()`)
  window.reload()
  await delay(500)
  await ready(window)
  await evaluate(window, `window.freddie.settings.save({showPDFZoomControls:true,pdfHandToolEnabled:true})`)
  await delay(200)
  const selected = await evaluate(window, `(() => {
    const reader = [...document.querySelectorAll('.pdf-scroller')].at(-1), root = reader.querySelector('.pdf-canvas-area').shadowRoot;
    const box = reader.getBoundingClientRect();
    const node = [...root.querySelectorAll('.textLayer tspan')].find(n => {
      const r = n.getBoundingClientRect(); return n.textContent.trim().length >= 2 && r.width > 2 && r.height > 2 && r.left > box.left && r.right < box.right && r.top > box.top && r.bottom < box.bottom;
    });
    if (!node) throw new Error('Dense visible text not found');
    node.dispatchEvent(new PointerEvent('pointerdown',{bubbles:true,composed:true,button:0}));
    const range = document.createRange(); range.setStart(node.firstChild,0); range.setEnd(node.firstChild,2);
    const s = root.getSelection(); s.removeAllRanges(); s.addRange(range);
    node.dispatchEvent(new MouseEvent('mouseup',{bubbles:true,composed:true}));
    const rect = range.getBoundingClientRect();
    return {quote:s.toString(), page:Number(node.closest('[data-page-index]').dataset.pageIndex), rect:{width:rect.width,height:rect.height}};
  })()`)
  await delay(100)
  if (!(await evaluate(window, `!!document.querySelector('.selection-assistant')`))) throw new Error('Selection not reported')
  report.checks.push({selection:selected})
  const previousPopup = Menu.prototype.popup
  let labels
  Menu.prototype.popup = function(options) {
    const item = this.items.find(item => labels.includes(item.label))
    if (!item || !item.enabled) throw new Error('Annotation action is disabled: '+labels[0])
    item.click(item, window, {})
    options.callback?.()
  }
  try {
    for (const [action, expected] of [
      [['Highlight Selection','高亮所选内容'],true],
      [['Undo PDF Annotation','撤销 PDF 标注'],false],
      [['Redo PDF Annotation','重做 PDF 标注'],true]
    ]) {
      labels = action
      await delay(300)
      await click(window,['PDF Annotations','PDF 标注'])
      await until(window, `Boolean(document.querySelectorAll('.dual-pane:last-child .annotation-highlight').length) === ${expected}`, 'Annotation action failed: '+action[0])
      report.checks.push({action:action[0],passed:true})
    }
  } finally { Menu.prototype.popup = previousPopup }
  await evaluate(window, `document.querySelectorAll('.pdf-canvas-area').forEach(h=>h.shadowRoot.getSelection().removeAllRanges())`)
  const before = await evaluate(window, `(() => {
    const p = document.querySelector('.dual-pane:last-child .pdf-page[data-page-index="${selected.page}"]');
    return {pixels:p.querySelector('canvas').width,width:parseFloat(p.style.width)};
  })()`)
  for (const [labels, factor] of [[['Zoom In','放大'],1.2],[['Zoom Out','缩小'],1]]) {
    await click(window,labels)
    await until(window, `(() => {
      const p = document.querySelector('.dual-pane:last-child .pdf-page[data-page-index="${selected.page}"]');
      return p && Math.abs(parseFloat(p.style.width)-${before.width*factor})<1 && Math.abs(p.querySelector('canvas').width-${before.pixels*factor})<3;
    })()`, 'Zoom bitmap failed')
    await ready(window)
    report.checks.push({action:labels[0],passed:true})
  }
  await click(window,['Find in Document','在文档中查找'])
  await evaluate(window, `document.querySelectorAll('.find-bar [role=radio]')[1].click()`)
  const query = process.env.FREDDIE_BENCH_QUERY || 'MAI'
  await evaluate(window, `(() => {
    const input = document.querySelector('.find-field input');
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(query)});
    input.dispatchEvent(new Event('input',{bubbles:true}));
  })()`)
  await until(window, `(() => {
    const all = [...CSS.highlights].filter(([name])=>name.startsWith('rp-find-') && !name.startsWith('rp-find-current-'));
    return all.some(([,highlight])=>highlight.size>0);
  })()`, 'PDF search highlights did not appear')
  await ready(window)
  const find = await evaluate(window, `({status:document.querySelector('.find-status')?.textContent, ranges:[...CSS.highlights].filter(([name])=>name.startsWith('rp-find-')).map(([name,h])=>({name,count:h.size,dense:[...h].some(r=>r.startContainer.parentElement.closest('svg'))}))})`)
  report.checks.push({action:'Search',...find})
  await fs.writeFile(path.join(config.work,'interactions.json'),JSON.stringify(report,null,2))
  const screenshot = await window.webContents.capturePage()
  await fs.writeFile(path.join(config.work,'interactions.png'),screenshot.toPNG())
  console.log(JSON.stringify(report))
  app.quit()
}
