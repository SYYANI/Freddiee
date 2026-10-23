import zhHans from './locales/zh-Hans.json'
import type { AppLanguage } from './types'

// Strings the native catalog does not have: platform-specific chrome and the
// cross-platform BabelDOC process settings.
const extraZhHans: Record<string, string> = {
  'Hide Sidebar': '隐藏侧栏',
  'Show Sidebar': '显示侧栏',
  'Show in File Manager': '在文件管理器中显示',
  'PDF Translation Runtime': 'PDF 翻译运行时',
  'BabelDOC command': 'BabelDOC 命令',
  'Command arguments (one per line)': '命令参数（每行一项）',
  'Freddie runs PDF translation through a local BabelDOC command. Arguments are passed without a shell; {input}, {outputDir}, {lang}, {model}, {baseUrl}, {apiKey}, {qps}, {pages} and {semanticHints} are replaced before it starts.':
    'Freddie 通过本地 BabelDOC 命令运行 PDF 翻译。参数不经过 shell 直接传递；启动前会替换 {input}、{outputDir}、{lang}、{model}、{baseUrl}、{apiKey}、{qps}、{pages} 和 {semanticHints}。',
  'Check BabelDOC': '检查 BabelDOC',
  'Restore Default Arguments': '恢复默认参数',
  'BabelDOC was not found. Install it (for example `uv tool install BabelDOC`) or set its full path.':
    '未找到 BabelDOC。请先安装（例如 `uv tool install BabelDOC`）或填写完整路径。',
  'API keys are encrypted with the operating system’s credential storage. Leaving the API key field blank while editing keeps the saved key.':
    'API 密钥由操作系统的凭据存储加密保存。编辑时将 API 密钥留空会保留已保存的密钥。',
  'LaTeX translation uses latexmk and XeLaTeX. Scanned PDF translation uses XeLaTeX and sends page images to the selected scanned-page model.':
    'LaTeX 翻译使用 latexmk 和 XeLaTeX。扫描版 PDF 翻译使用 XeLaTeX，并会把页面图像发送给所选的扫描页模型。',
  'TeX Live / MacTeX': 'TeX Live / MacTeX',
  'Download TeX Live': '下载 TeX Live',
  'Writing Window': '写作窗口',
  File: '文件',
  Edit: '编辑',
  View: '显示',
  Window: '窗口',
  Help: '帮助',
  'Choose a digest export folder in Settings first.': '请先在设置中选择文摘导出文件夹。',
  'The selected folder does not contain latexmk.': '所选文件夹中没有 latexmk。',
  'This paper has no abstract to translate.': '这篇论文没有可翻译的摘要。',
  'Enter an API key first.': '请先输入 API 密钥。',
  'Start writing…': '开始写作…',
  'Import Library from Freddie for macOS…': '从 Freddie for macOS 导入资料库…',
  'Import Library from Freddie for macOS?': '从 Freddie for macOS 导入资料库？',
  'Papers, notes, folders, translations, reading positions and writings are copied from the native app. Papers already in this library are skipped, and the native library is not changed. API keys are not copied.':
    '将从原生 App 复制论文、笔记、文件夹、翻译、阅读位置和写作稿。已在此资料库中的论文会被跳过，原生资料库不会被修改。API 密钥不会被复制。',
  'Import Complete': '导入完成',
  'Imported %lld papers, %lld notes and %lld writings.': '已导入 %1$lld 篇论文、%2$lld 条笔记和 %3$lld 篇写作稿。',
  'Connected. HTML and PDF translation now use %@.': '已连接。HTML 和 PDF 翻译现在使用 %1$@。',
  'Close Window': '关闭窗口'
}

const dictionaries: Record<'zh-Hans', Record<string, string>> = {
  'zh-Hans': { ...(zhHans as Record<string, string>), ...extraZhHans }
}

export type Translator = (key: string, ...args: Array<string | number>) => string

export function resolveLanguage(preference: AppLanguage | undefined, systemLocale: string): 'en' | 'zh-Hans' {
  if (preference === 'en' || preference === 'zh-Hans') return preference
  return systemLocale.toLowerCase().startsWith('zh') ? 'zh-Hans' : 'en'
}

export function createTranslator(language: 'en' | 'zh-Hans'): Translator {
  const dictionary = language === 'zh-Hans' ? dictionaries['zh-Hans'] : undefined
  return (key, ...args) => formatString(dictionary?.[key] ?? key, args)
}

/** Formats Foundation-style specifiers (`%@`, `%d`, `%lld`, `%1$@`, `%%`). */
export function formatString(format: string, args: Array<string | number>): string {
  let next = 0
  return format.replace(/%(?:(\d+)\$)?(@|lld|ld|d|f|s|%)/g, (match, position: string | undefined, specifier: string) => {
    if (specifier === '%') return '%'
    const index = position ? Number(position) - 1 : next++
    const value = args[index]
    if (value === undefined) return match
    if (specifier === 'd' || specifier === 'ld' || specifier === 'lld') return String(Math.trunc(Number(value)))
    return String(value)
  })
}
