// Benchmark driver only; no debugging endpoint or product preload API is added.
// One process per trial: the app opens the paper directly, as after a launch, then scrolls it.
const { app, protocol } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const config = JSON.parse(require('node:fs').readFileSync(process.env.FREDDIE_BENCH_CONFIG, 'utf8'))
app.setPath('userData', path.join(config.work, 'chromium-profile'))
app.setAppPath(config.root)
process.env.ELECTRON_RENDERER_URL = config.renderer

// Time each raster request at the protocol, and fail the trial on any error: a failing worker
// silently falls back to the browser renderer and would otherwise be measured instead.
const raster = []
const failures = []
const originalHandle = protocol.handle.bind(protocol)
protocol.handle = (scheme, handler) => originalHandle(scheme, async (request) => {
  const url = new URL(request.url)
  if (!url.pathname.includes('/raster/')) return handler(request)
  if (config.noWorker) return new Response('disabled', { status: 503 })
  const entry = { start: Date.now(), page: Number(url.pathname.split('/').pop()), attachment: url.pathname.split('/')[3]?.slice(0, 8),
    scale: Number(url.searchParams.get('scale')), ratio: Number(url.searchParams.get('ratio')) }
  raster.push(entry)
  try {
    const response = await handler(request)
    entry.status = response.status
    return response
  } catch (error) { entry.status = 'error'; throw error } finally {
    entry.ms = Date.now() - entry.start
    entry.aborted = request.signal.aborted
    if (entry.status !== 200 && !entry.aborted) failures.push(entry)
  }
})

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const processStart = Date.now()
let navigationStart
let started = false
app.on('browser-window-created', (_event, window) => {
  if (started) return
  started = true
  const contents = window.webContents
  const originalLoad = contents.loadURL.bind(contents)
  let first = true
  contents.loadURL = async (...args) => {
    if (first) {
      first = false
      window.setSize(config.width, config.height)
      window.center()
      // CDP page domains answer only once a renderer exists; install the probe on a blank page first.
      await originalLoad('about:blank')
      contents.debugger.attach('1.3')
      await contents.debugger.sendCommand('Page.enable')
      await contents.debugger.sendCommand('Performance.enable')
      await contents.debugger.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: probe })
      contents.once('did-finish-load', () => run(window).catch(async (error) => {
        console.error(error)
        await fs.writeFile(path.join(config.work, 'failure.txt'), String(error.stack || error))
        app.exit(1)
      }))
      navigationStart = Date.now()
    }
    return originalLoad(...args)
  }
})

// Runs before any page script: open milestones, a 16 ms visible-page sampler, frames and long tasks.
// A page counts as blank while its visible part has no finished bitmap.
const probe = `(() => {
  const P = window.__bench = { longTasks: [], events: {}, frames: [], workers: [], blank: { samples: 0, anyBlank: 0, blankArea: 0, area: 0 }, recording: false };
  const OriginalWorker = window.Worker;
  window.Worker = function (url, options) { P.workers.push(options && options.name || String(url).split('/').pop()); return new OriginalWorker(url, options) };
  window.Worker.prototype = OriginalWorker.prototype;
  new PerformanceObserver((list) => { for (const e of list.getEntries()) P.longTasks.push([e.startTime, e.duration]) }).observe({ type: 'longtask', buffered: true });
  const visiblePages = (reader) => {
    const top = reader.scrollTop, bottom = top + reader.clientHeight;
    return [...reader.querySelectorAll('.pdf-page:not(.missing)')].map((p) => {
      const t = parseFloat(p.style.top), h = parseFloat(p.style.height);
      return { p, visible: Math.min(bottom, t + h) - Math.max(top, t) };
    }).filter(({ visible }) => visible > 0);
  };
  P.state = () => {
    const readers = [...document.querySelectorAll('.pdf-scroller')];
    let pages = 0, painted = 0, area = 0, blankArea = 0, text = true;
    for (const r of readers) for (const { p, visible } of visiblePages(r)) {
      pages++; area += visible;
      if (p.querySelector('.pdf-page-canvas canvas')?.width > 0) painted++; else blankArea += visible;
      const layer = r.querySelector('.pdf-canvas-area')?.shadowRoot?.querySelector('[data-page-index="' + p.dataset.pageIndex + '"] .textLayer');
      if (!(layer && layer.childElementCount > 0 && layer.getAttribute('aria-busy') !== 'true')) text = false;
    }
    return { readers: readers.length, pages, painted, area, blankArea, text };
  };
  const tick = () => {
    const now = performance.now();
    if (P.recording) {
      const s = P.state(); P.blank.samples++; P.blank.area += s.area; P.blank.blankArea += s.blankArea; if (s.blankArea > 0) P.blank.anyBlank++;
    }
    if (!P.events.ready && document.readyState !== 'loading') {
      const s = P.state();
      if (s.readers && !P.events.reader) P.events.reader = now;
      if (s.painted && !P.events.firstPaint) P.events.firstPaint = now;
      if (s.pages && s.painted === s.pages && !P.events.viewportPaint) P.events.viewportPaint = now;
      if (P.events.viewportPaint && s.text && !P.events.textReady) P.events.textReady = now;
      // Scanned pages have no text layer; stop waiting for one after three seconds.
      if (P.events.viewportPaint && (P.events.textReady || now - P.events.viewportPaint > 3000)) P.events.ready = now;
    }
    setTimeout(tick, 16);
  };
  tick();
  let previous; const frame = (t) => { if (P.recording && previous !== undefined) P.frames.push(t - previous); previous = t; requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})()`

const median = (list) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null }
const percentile = (list, p) => { const s = [...list].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(s.length * p))] : null }
const round = (value) => value == null ? value : Math.round(value * 10) / 10

async function run(window) {
  const scenario = config.scenario
  const evaluate = (expression) => window.webContents.executeJavaScript(expression, true)
  const cdp = (method, params = {}) => window.webContents.debugger.sendCommand(method, params)
  window.show(); window.focus()
  const gpu = await app.getGPUInfo('basic')
  const system = { cpu: os.cpus()[0]?.model, memoryGB: os.totalmem() / 2 ** 30, release: os.release(), electron: process.versions.electron,
    chrome: process.versions.chrome, gpu: gpu.gpuDevice?.find((device) => device.active), noWorker: config.noWorker, window: [config.width, config.height] }
  const deadline = Date.now() + 90000
  let events
  while (Date.now() < deadline) {
    events = await evaluate('window.__bench.events')
    if (events.ready) break
    await delay(100)
  }
  if (!events?.ready) throw new Error(`Reader not ready: ${JSON.stringify(events)} ${JSON.stringify(await evaluate('window.__bench.state()'))}`)
  const open = { launchToNavigation: navigationStart - processStart, ...Object.fromEntries(Object.entries(events).map(([k, v]) => [k, Math.round(v)])),
    raster: raster.map((r) => ({ attachment: r.attachment, page: r.page, ms: r.ms, at: r.start - navigationStart, status: r.status, ratio: r.ratio, scale: round(r.scale) })) }
  const geometry = await evaluate(`(() => { const r = [...document.querySelectorAll('.pdf-scroller')]; const b = r[0].getBoundingClientRect();
    return { x: b.x + b.width / 2, y: b.y + b.height / 2, height: r[0].scrollHeight, viewport: r[0].clientHeight, dpr: devicePixelRatio, panes: r.length } })()`)
  const scrolls = []
  for (const speed of config.speeds) {
    await delay(1500)
    const distance = Math.min(config.distance, geometry.height - geometry.viewport - 50)
    raster.length = 0
    const startTop = await evaluate(`(() => { const P = window.__bench; P.frames = []; P.longTasks = []; P.blank = { samples: 0, anyBlank: 0, blankArea: 0, area: 0 }; P.recording = true; return document.querySelector('.pdf-scroller').scrollTop })()`)
    const before = await cdp('Performance.getMetrics')
    const direction = startTop + distance < geometry.height - geometry.viewport ? -1 : 1
    await cdp('Input.synthesizeScrollGesture', { x: geometry.x, y: geometry.y, yDistance: direction * distance, speed, gestureSourceType: 'mouse' })
    // Keep sampling until the final viewport is painted (at most five seconds).
    const settleStart = Date.now()
    let settleMs = null
    while (Date.now() - settleStart < 5000) {
      const state = await evaluate('window.__bench.state()')
      if (state.pages && state.painted === state.pages) { settleMs = Date.now() - settleStart; break }
      await delay(30)
    }
    const after = await cdp('Performance.getMetrics')
    const sample = await evaluate(`(() => { const P = window.__bench; P.recording = false; return { frames: P.frames, longTasks: P.longTasks, blank: P.blank, top: document.querySelector('.pdf-scroller').scrollTop } })()`)
    if (Math.abs(sample.top - startTop) < distance * 0.5) throw new Error(`Scroll gesture did not move the reader: ${sample.top}`)
    const metric = (list, name) => list.metrics.find((m) => m.name === name)?.value || 0
    const completed = raster.filter((r) => r.status === 200 && !r.aborted).map((r) => r.ms)
    scrolls.push({
      speed, distance, moved: Math.round(Math.abs(sample.top - startTop)), settleMs, frames: sample.frames.length,
      meanFrame: round(sample.frames.reduce((a, b) => a + b, 0) / sample.frames.length), p95Frame: round(percentile(sample.frames, 0.95)),
      maxFrame: round(Math.max(...sample.frames)), over50: sample.frames.filter((f) => f > 50).length,
      longTasks: sample.longTasks.length, longTaskMs: Math.round(sample.longTasks.reduce((a, [, d]) => a + d, 0)),
      taskMs: Math.round(1000 * (metric(after, 'TaskDuration') - metric(before, 'TaskDuration'))),
      blankSampleRatio: round(100 * sample.blank.anyBlank / Math.max(1, sample.blank.samples)),
      blankAreaRatio: round(100 * sample.blank.blankArea / Math.max(1, sample.blank.area)),
      rasterRequests: raster.length, rasterMedianMs: median(completed), rasterP90Ms: percentile(completed, 0.9)
    })
  }
  if (failures.length) throw new Error('Raster request failed: ' + JSON.stringify(failures.slice(0, 5)))
  const workers = await evaluate('window.__bench.workers')
  const result = { paper: scenario.title, paperId: scenario.paperId, mode: scenario.mode, trial: config.trial, system, workers, geometry, open, scrolls }
  const { raster: openRaster, ...openSummary } = open
  console.log(JSON.stringify({ paper: scenario.title, mode: scenario.mode, trial: config.trial, open: openSummary }))
  console.log('  open raster: ' + openRaster.slice(0, 8).map((r) => `${r.attachment}/p${r.page}:${r.ms}ms@+${r.at}`).join(' '))
  for (const scroll of scrolls) console.log('  ' + JSON.stringify(scroll))
  await fs.writeFile(path.join(config.work, 'result.json'), JSON.stringify(result, null, 2))
  if (config.trial === 1) await fs.writeFile(path.join(config.work, `${scenario.paperId.slice(0, 8)}-${scenario.mode}.png`), (await window.webContents.capturePage()).toPNG())
  app.exit(0)
}

require(path.join(config.root, 'out/main/index.cjs'))
