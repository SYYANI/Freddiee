// Benchmark driver only; no debugging endpoint or product preload API is added.
const { app } = require('electron')
const fs = require('node:fs/promises')
const path = require('node:path')
const os = require('node:os')
const config = require(process.env.FREDDIE_BENCH_CONFIG)
app.setPath('userData', path.join(config.work, 'chromium-profile'))
app.setAppPath(config.root)
process.env.ELECTRON_RENDERER_URL = config.variants.baseline

const delay = (ms) => new Promise((done) => setTimeout(done, ms))
const results = []
let started = false
app.on('browser-window-created', (_event, window) => {
  if (started) return
  started = true
  window.webContents.once('did-finish-load', () => run(window).catch(async (error) => {
    console.error(error)
    await fs.writeFile(path.join(config.work, 'failure.txt'), String(error.stack || error))
    app.exit(1)
  }))
})
require(path.join(config.root, 'out/main/index.cjs'))

async function evaluate(window, expression) {
  return window.webContents.executeJavaScript(expression, true)
}

async function waitReady(window, dual) {
  const deadline = Date.now() + 45000
  while (Date.now() < deadline) {
    const ready = await evaluate(window, `(() => {
      const readers = [...document.querySelectorAll('.pdf-scroller')];
      return readers.length === ${dual ? 2 : 1} && readers.every(reader => {
        const center = reader.scrollTop + reader.clientHeight / 2;
        const page = [...reader.querySelectorAll('.pdf-page')].find(page => {
          const top = parseFloat(page.style.top), height = parseFloat(page.style.height);
          return center >= top && center < top + height;
        });
        return page?.querySelector('.pdf-page-canvas canvas')?.width > 0 && page.querySelector('.textLayer')?.textContent.length > 0;
      });
    })()`)
    if (ready) { await delay(800); return }
    await delay(100)
  }
  throw new Error('PDF reader did not become ready')
}

async function run(window) {
  window.setSize(1220, 780)
  window.show(); window.focus()
  window.webContents.debugger.attach('1.3')
  const cdp = (method, params = {}) => window.webContents.debugger.sendCommand(method, params)
  await cdp('Performance.enable')
  const system = {
    platform: os.platform(), release: os.release(), arch: os.arch(),
    cpu: os.cpus()[0]?.model, memoryGB: os.totalmem() / 2 ** 30,
    electron: process.versions.electron, chrome: process.versions.chrome,
    gpu: await app.getGPUInfo('basic'), gpuFeatures: app.getGPUFeatureStatus()
  }
  await fs.writeFile(path.join(config.work, 'system.json'), JSON.stringify(system, null, 2))
  for (const scenario of config.scenarios) {
    for (let trial = 1; trial <= config.trials; trial++) {
      // Alternate order to limit warm-cache and thermal bias.
      const variants = config.onlyVariant ? [config.onlyVariant] : trial % 2 ? ['baseline', 'optimized'] : ['optimized', 'baseline']
      for (const variant of variants) {
        console.log(`Measuring ${scenario.label} ${scenario.mode} ${variant} trial ${trial}`)
        await evaluate(window, `(async () => {
          await window.freddie.library.saveReadingState(${JSON.stringify({ paperId: scenario.paperId, readerMode: scenario.mode, pageIndex: config.startPage || 0, scrollRatio: 0, zoomScale: 1 })});
          await window.freddie.library.selectPaper(${JSON.stringify(scenario.paperId)});
        })()`)
        await window.loadURL(config.variants[variant])
        await waitReady(window, scenario.mode === 'bilingualPDF')
        const geometry = await evaluate(window, `(() => {
          const reader = document.querySelector('.pdf-scroller');
          const box = reader.getBoundingClientRect();
          return {x: box.x + box.width / 2, y: box.y + box.height / 2, height: reader.scrollHeight, startTop: reader.scrollTop,
            viewport: box.height, pages: reader.querySelectorAll('.pdf-page').length, dpr: devicePixelRatio,
            visibility: document.visibilityState, focus: document.hasFocus(), effects: document.documentElement.dataset.effects};
        })()`)
        if (geometry.visibility !== 'visible') throw new Error('Benchmark window is hidden')
        if (variant === 'optimized' && geometry.pages > 50) throw new Error('Optimized renderer is not virtualized; refusing an invalid comparison')
        const distance = Math.min(config.distance || 12000, geometry.height - geometry.startTop - geometry.viewport - 50)
        if (distance < 1000) throw new Error('Selected PDF is too short for scroll measurement')
        await evaluate(window, `(() => {
          const bench = window.__pdfBench = { intervals: [], longTasks: [], positions: [], running: true, start: performance.now() };
          bench.paint = {samples: 0, missingBitmap: 0};
          bench.paintTimer = setInterval(() => {
            for (const reader of document.querySelectorAll('.pdf-scroller')) {
              const center = reader.scrollTop + reader.clientHeight / 2;
              const page = [...reader.querySelectorAll('.pdf-page')].find(page => {
                const top = parseFloat(page.style.top), height = parseFloat(page.style.height);
                return center >= top && center < top + height;
              });
              if (!page || page.classList.contains('missing')) continue;
              bench.paint.samples++;
              if (!(page.querySelector('.pdf-page-canvas canvas')?.width > 0)) bench.paint.missingBitmap++;
            }
          }, 100);
          bench.observer = new PerformanceObserver(list => bench.longTasks.push(...list.getEntries().map(e => ({start: e.startTime, duration: e.duration}))));
          bench.observer.observe({type: 'longtask'});
          let previous;
          const frame = time => {
            if (!bench.running) return;
            if (previous !== undefined) bench.intervals.push(time - previous);
            previous = time;
            bench.positions.push(document.querySelector('.pdf-scroller').scrollTop);
            requestAnimationFrame(frame);
          };
          requestAnimationFrame(frame);
        })()`)
        const before = await cdp('Performance.getMetrics')
        if (config.trace) await cdp('Tracing.start', { categories: 'devtools.timeline,v8,blink,cc', transferMode: 'ReturnAsStream', streamCompression: 'gzip' })
        if (config.profile) { await cdp('Profiler.enable'); await cdp('Profiler.start') }
        await cdp('Input.synthesizeScrollGesture', { x: geometry.x, y: geometry.y, yDistance: -distance, speed: config.speed || 2400, gestureSourceType: 'mouse' })
        await cdp('Input.synthesizeScrollGesture', { x: geometry.x, y: geometry.y, yDistance: distance, speed: config.speed || 2400, gestureSourceType: 'mouse' })
        const after = await cdp('Performance.getMetrics')
        if (config.trace) {
          const completed = new Promise((resolve) => {
            const handler = (_event, method, params) => {
              if (method === 'Tracing.tracingComplete') { window.webContents.debugger.removeListener('message', handler); resolve(params.stream) }
            }
            window.webContents.debugger.on('message', handler)
          })
          await cdp('Tracing.end')
          const stream = await completed, chunks = []
          while (true) {
            const result = await cdp('IO.read', { handle: stream })
            chunks.push(Buffer.from(result.data, result.base64Encoded ? 'base64' : 'utf8'))
            if (result.eof) break
          }
          await cdp('IO.close', { handle: stream })
          await fs.writeFile(path.join(config.work, `${scenario.label}-${variant}-${trial}.trace.json.gz`), Buffer.concat(chunks))
        }
        if (config.profile) {
          const { profile } = await cdp('Profiler.stop')
          await fs.writeFile(path.join(config.work, `${scenario.label}-${variant}-${trial}.cpuprofile`), JSON.stringify(profile))
        }
        const sample = await evaluate(window, `(() => {
          const bench = window.__pdfBench; bench.running = false; bench.observer.disconnect(); clearInterval(bench.paintTimer);
          return {intervals: bench.intervals, longTasks: bench.longTasks, duration: performance.now()-bench.start,
            maxScrollTop: Math.max(...bench.positions), mountedPages: [...document.querySelectorAll('.pdf-scroller')].map(r => r.querySelectorAll('.pdf-page').length),
            canvasPixels: [...document.querySelectorAll('.pdf-page-canvas canvas')].reduce((n,c) => n+c.width*c.height,0), paint: bench.paint};
        })()`)
        if (sample.maxScrollTop - geometry.startTop < distance * 0.5) throw new Error(`Scroll gesture did not move the reader: ${sample.maxScrollTop}`)
        const metric = (list, name) => list.metrics.find((m) => m.name === name)?.value || 0
        const sorted = [...sample.intervals].sort((a, b) => a - b)
        const summary = {
          label: scenario.label, mode: scenario.mode, variant, trial, geometry, durationMs: sample.duration,
          frames: sorted.length, meanIntervalMs: sorted.reduce((a, b) => a + b, 0) / sorted.length,
          p95IntervalMs: sorted[Math.floor(sorted.length * 0.95)], maxIntervalMs: sorted.at(-1),
          over50ms: sorted.filter((ms) => ms > 50).length,
          longTaskCount: sample.longTasks.length, longTaskMs: sample.longTasks.reduce((n, t) => n + t.duration, 0),
          taskDurationMs: 1000 * (metric(after, 'TaskDuration') - metric(before, 'TaskDuration')),
          mountedPages: sample.mountedPages, canvasPixels: sample.canvasPixels, maxScrollTop: sample.maxScrollTop, paint: sample.paint
        }
        results.push({ ...summary, raw: sample })
        console.log(JSON.stringify(summary))
        await fs.writeFile(path.join(config.work, 'results.json'), JSON.stringify(results, null, 2))
        if (trial === 1) {
          await waitReady(window, scenario.mode === 'bilingualPDF')
          const screenshot = await window.webContents.capturePage()
          await fs.writeFile(path.join(config.work, `${scenario.label}-${variant}.png`), screenshot.toPNG())
        }
      }
    }
  }
  console.log(`Completed. Results: ${path.join(config.work, 'results.json')}`)
  app.quit()
}
