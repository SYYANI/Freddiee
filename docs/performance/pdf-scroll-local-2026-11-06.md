# 本机 PDF 滚动实测：2026-11-06

已在这台 Mac 的可见 Electron 窗口中使用真实文库 PDF 测量，且检查了单栏、双栏截图。单栏有稳定改善；双栏的整体帧间隔尚无稳定改善。不能据此声称已消除卡顿或达到稳定 60 FPS。

## 环境和方法

- MacBookPro15,1，Intel Core i7-9750H，16 GB RAM，macOS Darwin 24.6.0，Retina DPR 2。
- Electron 44.9.3 / Chromium 152.0.7977.167，GPU 合成与光栅化启用，应用使用 reduced effects。
- 生产构建，1220 × 780 窗口，可见且拥有焦点；保留真实文库的 129 篇文献元数据作为侧栏负载。
- 从原文库复制测试 PDF 到临时文库；未复制凭据，也未向原文库写入阅读位置或设置。测试库不含原笔记。
- 基线使用 `0341991ef4240908109790b14231402beea1d19d` 的 `PdfView.tsx`；优化版使用当前工作区。其他应用代码相同。
- 每个场景交替测试两个版本各三轮，共 12 次。每次重新加载 renderer，待首屏文字和画布准备好后等待 800 ms，再通过 Chromium 的原生鼠标滚动手势向下滚动 12,000 CSS px、再返回，速度 2400 px/s，每轮约 10.2 秒。
- 使用 `requestAnimationFrame` 记录主线程帧回调间隔，PerformanceObserver 记录 long task，CDP `Performance.getMetrics` 记录主线程 TaskDuration。下表取三轮各指标的中位数。
- 这些是主线程响应指标，不是显示器最终呈现帧率。没有测量持续缩放、手写、HTML 或后台翻译并发负载，也未量化滚动过程中的短暂空白页。

## 三轮结果

| 场景 / 指标 | 基线 | 优化版 | 结论 |
| --- | ---: | ---: | --- |
| 522 页单栏：平均帧回调间隔 | 23.49 ms | 22.31 ms | 小幅改善 |
| 522 页单栏：P95 帧回调间隔 | 50.0 ms | 34.0 ms | 降低 32% |
| 522 页单栏：主线程 TaskDuration | 4922 ms | 4050 ms | 降低约 18% |
| 522 页单栏：挂载页面数（首屏/返回后） | 522 | 2 | 页面组件数量明显减少 |
| 288 页原文 + 10 页部分译文双栏：平均帧回调间隔 | 30.72 ms | 30.72 ms | 无稳定改善 |
| 双栏：P95 帧回调间隔 | 66.9 ms | 66.7 ms | 无明显改善 |
| 双栏：主线程 TaskDuration | 6426 ms | 6145 ms | 降低约 4% |
| 双栏：long task 数 | 33 | 19 | 降低约 42%，但仍有卡顿 |
| 双栏：long task 总耗时 | 1878 ms | 1036 ms | 降低约 45% |
| 双栏：挂载页面数（首屏/返回后） | 288 + 10 | 3 + 3 | 页面组件数量明显减少 |

逐轮数据、机器信息和两份生产 renderer 的 SHA-256 保存在 [JSON 数据](./pdf-scroll-local-2026-11-06.json)。两份构建的哈希不同，且运行时确认了优化版仅挂载少量页面。构建隔离修正前曾错误加载相同版本；该轮数据已全部排除。

## 额外 CPU 采样

另用 43 页原文 + 40 页译文的图文混排 PDF，各采样一次双栏滚动 CPU profile。该次启用了采样器，不并入上面的三轮汇总。

优化版约 10.5 秒的采样中，`measureText` 的叶节点自耗时约 1.10 秒，`drawImage` 约 0.41 秒，`fillText` 约 0.28 秒。文字测量是明显的可命名热点；还有大量浏览器原生执行时间归入 `(program)`，这份 CPU profile 尚不足以进一步归因。因此，减少 React 页面组件和控制并发渲染还不足以解决所有双栏场景。

本次原始帧序列、截图、完整机器信息位于运行日志输出的临时目录 `freddie-pdf-bench-pLEFIS`；额外 CPU profile 和图文混排截图位于 `freddie-pdf-bench-jdVSEZ`。这些临时文件没有提交到仓库。

## 复测

在有图形会话的 macOS 上，在仓库根目录运行：

```sh
FREDDIE_BENCH_PAPERS=<单栏文献UUID>,<双栏文献UUID> node scripts/benchmark-pdf.mjs
```

默认读取 `~/Library/Application Support/Freddie`，也可用 `FREDDIE_BENCH_LIBRARY` 指定文库；`FREDDIE_BENCH_TRIALS` 控制轮数。脚本复制文件到新建的临时目录，构建基线和当前版本，再运行真实应用。不会启动远程调试监听端口，也不会向产品 preload 增加调试能力。

额外 CPU 采样可使用 `FREDDIE_BENCH_MODE=bilingualPDF FREDDIE_BENCH_PROFILE=1`。控制脚本会拒绝两份 renderer 哈希相同的比较，并检查优化版没有错误挂载整个长文档。
