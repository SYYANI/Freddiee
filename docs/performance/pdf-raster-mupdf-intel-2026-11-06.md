# Intel Mac PDF 位图改用 MuPDF（2026-11-06）

在同一台 Intel MacBook Pro 上，把主进程绘制 worker 的引擎从 PDF.js + `@napi-rs/canvas` 换成 MuPDF（`mupdf` npm 包，WebAssembly），其余管线（双 worker 调度、内存缓存、取消、原始 RGBA 传输、renderer 显示）不变。基线是 `2943e2f`（[上一份报告](./pdf-open-intel-2026-11-06.md)的最终版本），两边在同一时段、同一方法下各测 3 轮。

结论：图表和图片较重的页面单页绘制快 5–16 倍。GLM-5 双栏视口绘制完成从 4.2 s 降到 1.2 s，1500 px/s 滚动的空白从 95% 降到 0；MinerU 和 MAI-Thinking-1 的快速滚动空白也降到 0。P95 帧间隔不变，无 long task。GLM-5 在 4000 px/s 下仍有空白，见“未解决”。

## 为什么换引擎而不是用 GPU

上一份报告剩下的问题是 GLM-5 第 3 页单页绘制约 5.5 s。这页只有约 1000 个绘制操作，CPU profile 显示时间主要花在两处：

- **PDF.js 用 JavaScript 解码图片**（`fillGrayBuffer`、`getRgbBuffer`、JPEG 解码、色彩转换），约 6 s。Node 中没有 `OffscreenCanvas`、`createImageBitmap`、`ImageDecoder`，PDF.js 只能逐像素解码和缩放。
- **Skia CPU 缩放大图**（3544 px 的源图逐级 `drawImage`，以及软蒙版的 `putImageData`），约 4 s。

先验证了 GPU 方案：在 renderer 的 Web Worker 中用 PDF.js + `OffscreenCanvas` + `enableHWA: true` 绘制（PDF.js 默认 `enableHWA: false`，画布以 `willReadFrequently` 创建，Chromium 会走 CPU 光栅，所以现有浏览器回退绘制并未使用 GPU）。这一页降到 2.4 s，其中大部分收益来自 Chromium 的原生图片解码，GPU 本身只再快 20–40%。在 renderer 主线程用 GPU 绘制会产生最长 656 ms 的 long task；PDF.js 的 `enableWebGPU` 只作用于网格渐变，测不出差别。

再比较了原生 PDF 引擎。单页首次绘制（ms，scale 0.7 × DPR 2，文档已打开，预热用的是另一页）：

| 页面 | PDF.js + napi（基线） | PDF.js + Chromium GPU | MuPDF WASM | MuPDF 原生 | PDFium 原生 | PDFium WASM |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| GLM-5 原文 p3 | 7778 | 2447 | **484** | 445 | 492 | 1170 |
| GLM-5 译文 p3 | 7910 | 2416 | **476** | 444 | 500 | 1113 |
| GLM-5 原文 p1 | 513 | 261 | **145** | 88 | 74 | 111 |
| MAI-Thinking-1 译文 p9 | 3296 | 1529 | **388** | 252 | 216 | 246 |
| MinerU p1 / p7 | 699 / 1570 | 261 / 774 | **123 / 133** | 118 / 119 | 83 / 162 | 153 / 255 |

选择 MuPDF WASM 的理由：

- 只比原生慢约 10%，PDFium 的 WASM 构建在图片重的页面上慢一倍多。
- 一份 WASM 文件覆盖所有打包目标，不需要为每个平台和架构准备原生库；每个 `worker_threads` 有独立的 WASM 实例，可以并行。PDFium 原生库有进程级全局状态，同一进程的两个线程只能串行。
- 解析恶意 PDF 时，内存错误被限制在 WASM 线性内存内。
- 许可证：MuPDF 为 AGPL-3.0-or-later，与本项目的 AGPL-3.0-only 兼容；若将来改变分发许可，PDFium（BSD）是替代方案。

## 修改

- `electron/main/pdfRasterWorker.ts`：用 MuPDF 打开文档、绘制页面。位图尺寸严格为 PDF.js 的 `floor(viewport × ratio)`，像素上限算法与原来相同。MuPDF 的页面边界已包含旋转、CropBox 和 UserUnit，与 PDF.js viewport 一致（用普通页、非零原点 CropBox、旋转 270° 和 UserUnit=2 的页面逐一核对过）。白底不透明画布上绘制，MuPDF 的预乘 RGBA 即为直通 RGBA，一次复制即可输出；纸张色调用查表做正片叠底。需要密码的文档报错，由 renderer 的浏览器回退绘制处理。MuPDF 的控制台输出被丢弃（GLM-5 译文的畸形字体会逐字形告警）。
- 每个 worker 仍最多保留两个已解析文档。WASM 内存只增不减：打开 45 MB 的 GLM-5 译文后单个 worker 约 230 MiB，清空 MuPDF 缓存只降到 208 MiB，因此 worker 空闲 2 分钟后退出，下一个请求再启动（MuPDF 初始化约 40 ms）。
- 启动预热仍绘制内置的单页 PDF，测试改为检查 MuPDF 能不经修复地读取它。
- 打包：`node_modules/mupdf/**` 解包到 asar 外（Emscripten 从模块旁读取 `.wasm`，ES 模块需要同目录上层的 `package.json`），排除包内的 `.br` 压缩副本。`@napi-rs/canvas` 仍由 `RebuildPDFKit` 使用，保留。
- 绘制注释和表单控件的外观。PDF.js 原来的模式会跳过有表单字段的控件（本应用没有表单层，所以这些控件此前不可见）。

PDF.js 仍负责文字层、搜索、目录和浏览器回退绘制。渲染器权限、协议路径校验、位图格式、批注、同步格式均未改变。

## 结果（中位数，3 轮）

| 文档 | 指标 | 基线 | MuPDF |
| --- | --- | ---: | ---: |
| DeepSeek-R1 | 首页可见 | 639 ms | 581 ms |
|  | 滚动中单个位图请求中位耗时 | 76–78 ms | 34–36 ms |
| Symbian（940 页） | 视口绘制完成 | 636 ms | 602 ms |
| MinerU | 首页可见 | 1232 ms | 801 ms |
|  | 1500 px/s 空白采样 / 面积 | 17.9% / 11.3% | 0% / 0% |
|  | 4000 px/s 空白采样 / 面积 | 6.7% / 2.0% | 0% / 0% |
| GLM-5（双栏） | 首页可见 / 视口绘制完成 | 1466 / 4225 ms | 668 / 1195 ms |
|  | 1500 px/s 空白采样 / 面积 | 95.4% / 93.0% | 0% / 0% |
|  | 4000 px/s 空白采样 / 面积 | 98.9% / 61.0% | 44.8% / 21.0% |
|  | 1500 px/s 位图请求中位耗时 | 5159 ms | 35 ms |
| MAI-Thinking-1（双栏） | 首页可见 / 视口绘制完成 | 1052 / 1525 ms | 611 / 697 ms |
|  | 4000 px/s 空白采样 / 面积 | 7.3% / 1.0% | 0% / 0% |

DeepSeek-R1 和 Symbian 两版滚动均无空白。所有场景 P95 帧回调间隔为 17.5–18.6 ms，均无 long task。MAI-Thinking-1 在 1500 px/s 下两版都有一次 67–82 ms 的峰值，GLM-5 在 4000 px/s 下两版都有约 34 ms 的峰值，与上一份报告相同。滚动停止后到视口画完的时间，GLM-5 在 4000 px/s 下从 1.8 s 降到 0.6 s。

## 未解决

- **GLM-5 在 4000 px/s 下仍有空白**（三轮面积 9–22%）。这个速度下双栏每秒经过约 15 页，两个 worker 平均每页约 130 ms，而 GLM-5 译文页首次绘制需 150–250 ms，吞吐量本身不够。可以考虑增加 worker 数量，或先出低分辨率位图再补清晰版。
- 内存：每个 worker 的 WASM 内存峰值由最大的已打开文档决定，空闲 2 分钟后才释放。两个 worker 同时持有大文档时约 0.5 GiB。
- 渲染差异：MuPDF 的字形笔画比 PDF.js 略细；对未嵌入字体，两者使用的替代字体不同，选区高亮可能有细微偏移，尚未找到样本验证。
- 只测了这一台 Intel Mac；未覆盖缩放、手写、后台翻译并发负载、Apple Silicon、Windows、Linux 和只有集成显卡的机器。

## 功能验证

- 类型检查、全量测试（440 通过、1 跳过）和生产构建通过。新增测试覆盖位图尺寸严格等于 PDF.js viewport（非零原点 CropBox）、CropBox 原点平移，以及空闲 worker 退出后重启。
- 11 页 GLM-5 原文和译文与基线输出逐像素比对：内容一致，差异只在抗锯齿（像素差 > 64 的比例为 0.6–1.6%，与 Chromium 版 PDF.js 相对基线的差异相当），中文字体、图表和带软蒙版的图片均正确。MuPDF WASM 与原生 MuPDF 的输出逐像素相同。
- `electron-builder --mac --x64 --dir` 打包后：asar 内的 worker 能从 `app.asar.unpacked` 加载 MuPDF，最重的页面包括 worker 启动在内用时 680 ms；打包应用打开双栏文献，挂载的 8 页全部绘制，两个附件的位图请求均返回 200。通过 SSH 直接启动打包应用时窗口不可见，未修改的版本同样如此，与本次修改无关。
- 测试使用临时文库副本，没有修改源文库，也没有替换已安装的应用。

逐轮数据、单页对比和源码哈希保存在[实测 JSON](./pdf-raster-mupdf-intel-2026-11-06.json)。

## 复测

与[上一份报告](./pdf-open-intel-2026-11-06.md#复测)相同的命令和场景；对比基线需先检出 `2943e2f` 再运行一次。
