import { moment } from "obsidian";

/**
 * UI strings: English + Simplified Chinese.
 *
 * The English string IS the key — `t("ScholarBridge: exported to {{path}}")`
 * renders English by default and looks the string up in the zh map when
 * Obsidian's language is set to a zh variant. Placeholders use {{name}} and
 * are substituted from the optional vars argument; unused vars are ignored,
 * so translations may drop or reorder them freely.
 *
 * Obsidian applies a language change only after a reload, so the choice is
 * detected once and cached.
 */

const zh: Record<string, string> = {
  // main.ts
  "ScholarBridge {{v}} — scaffold loaded (desktop-only).":
    "ScholarBridge {{v}}——已加载（仅桌面端）。",
  "Show plugin status": "显示插件状态",
  "Algorithm": "算法",
  "ScholarBridge: {{path}} already exists.": "ScholarBridge：{{path}} 已存在。",

  // commands.ts — paste & convert
  "ScholarBridge: converted pasted LaTeX.": "ScholarBridge：已转换粘贴的 LaTeX。",
  "LaTeX detected": "检测到 LaTeX",
  "Convert the pasted LaTeX to Obsidian Markdown?": "将粘贴的 LaTeX 转换为 Obsidian Markdown 吗？",
  "Convert selected LaTeX to Obsidian": "将选中的 LaTeX 转换为 Obsidian",
  "ScholarBridge: select LaTeX text first.": "ScholarBridge：请先选中 LaTeX 文本。",
  "ScholarBridge: nothing recognizable — source kept as-is.":
    "ScholarBridge：未识别出可转换的内容——已保留原文。",

  // commands.ts — copy/export
  "Copy selection as LaTeX": "将选中内容复制为 LaTeX",
  "ScholarBridge: LaTeX copied to clipboard.": "ScholarBridge：LaTeX 已复制到剪贴板。",
  "ScholarBridge: could not write to the clipboard — {{msg}}":
    "ScholarBridge：无法写入剪贴板——{{msg}}",
  "Export current note to LaTeX": "将当前笔记导出为 LaTeX",
  "Export folder/project to LaTeX": "将文件夹/项目导出为 LaTeX",
  "Export folder “{{name}}” to LaTeX": "将文件夹“{{name}}”导出为 LaTeX",
  "Complete article (main.tex + sections/)": "完整文章（main.tex + sections/）",
  "Export profile": "导出格式",
  "LaTeX fragment": "LaTeX 片段",
  "Complete article": "完整文章",
  "Chinese/mixed article (ctexart)": "中文/混合文档（ctexart）",
  "Overwrite existing export?": "覆盖已存在的导出文件？",
  "Overwrite existing project export?": "覆盖已存在的项目导出？",
  "{{path}} already exists. Replace it with the LaTeX exported from this note?":
    "{{path}} 已存在。要用本笔记导出的 LaTeX 替换它吗？",
  "Some files under {{dir}} already exist ({{list}}). Replace them with the freshly exported LaTeX?":
    "{{dir}} 下已存在部分文件（{{list}}）。要用新导出的 LaTeX 覆盖它们吗？",
  "Overwrite": "覆盖",
  "Cancel": "取消",
  "ScholarBridge: exported to {{path}}": "ScholarBridge：已导出到 {{path}}",
  "ScholarBridge: project exported to {{path}} (sections/ alongside).":
    "ScholarBridge：项目已导出到 {{path}}（sections/ 位于同目录）。",
  "ScholarBridge export failed: {{msg}}": "ScholarBridge 导出失败：{{msg}}",

  // translate-commands.ts
  "Translate selection": "翻译选中内容",
  "Translate current paragraph": "翻译当前段落",
  "Translate current section": "翻译当前小节",
  "Translate changed blocks": "翻译已更改的块",
  "Open translation preview": "打开翻译预览",
  "ScholarBridge: nothing to translate at the cursor.": "ScholarBridge：光标处没有可翻译的内容。",
  "ScholarBridge: selection contains no translatable prose.":
    "ScholarBridge：选中内容不含可翻译的正文。",
  "ScholarBridge: translator not ready — {{detail}}": "ScholarBridge：翻译服务未就绪——{{detail}}",
  "ScholarBridge: local translator failed to become ready.":
    "ScholarBridge：本地翻译服务未能就绪。",
  "ScholarBridge: llama-server is not reachable (start it or configure the executable).":
    "ScholarBridge：无法连接 llama-server（请启动服务或检查可执行文件配置）。",
  "ScholarBridge: translation failed — {{msg}}": "ScholarBridge：翻译失败——{{msg}}",
  "ScholarBridge: could not open preview.": "ScholarBridge：无法打开翻译预览。",
  "ScholarBridge: retry failed — {{msg}}": "ScholarBridge：重试失败——{{msg}}",
  "ScholarBridge: this note has no stored translations.":
    "ScholarBridge：这篇笔记没有已存储的翻译。",
  "ScholarBridge: all translations are up to date.": "ScholarBridge：所有翻译均为最新。",
  "ScholarBridge: retranslation failed — {{msg}}": "ScholarBridge：重新翻译失败——{{msg}}",
  "ScholarBridge: {{n}} paragraph(s) could not be translated — retry them from the preview.":
    "ScholarBridge：有 {{n}} 个段落未能翻译——可在预览中单独重试。",

  // translator-commands.ts
  "Start local translator": "启动本地翻译服务",
  "Stop local translator": "停止本地翻译服务",
  "Check translator connection": "检查翻译服务连接",
  "○ Translator stopped": "○ 翻译服务已停止",
  "● Translator ready": "● 翻译服务就绪",
  "◐ Loading model": "◐ 正在加载模型",
  "! Translator error": "! 翻译服务出错",
  "ScholarBridge: translator is starting — wait for it to become ready.":
    "ScholarBridge：翻译服务正在启动，请稍候。",
  "ScholarBridge: llama-server reachable at {{label}}.":
    "ScholarBridge：已连接 llama-server（{{label}}）。",
  "ScholarBridge: no llama-server at {{label}}.": "ScholarBridge：{{label}} 上没有 llama-server。",
  "ScholarBridge: health check failed — {{msg}}": "ScholarBridge：连接检查失败——{{msg}}",
  "Start local translator?": "启动本地翻译服务？",
  "ScholarBridge is about to spawn llama-server on {{label}}.":
    "ScholarBridge 即将在 {{label}} 启动 llama-server。",
  "Start": "启动",
  "Not now": "暂不",
  "ScholarBridge: external llama-server is reachable (connect-only mode).":
    "ScholarBridge：已连接外部 llama-server（仅连接模式）。",
  "ScholarBridge: no running llama-server found and no executable configured.":
    "ScholarBridge：未发现运行中的 llama-server，也未配置可执行文件。",
  "ScholarBridge: local translator ready.": "ScholarBridge：本地翻译服务已就绪。",
  "ScholarBridge: local translator is not running.": "ScholarBridge：本地翻译服务未运行。",
  "ScholarBridge: local translator failed to start — {{detail}}":
    "ScholarBridge：本地翻译服务启动失败——{{detail}}",
  "ScholarBridge: local translator stopped.": "ScholarBridge：本地翻译服务已停止。",
  "ScholarBridge: no local translator is owned by the plugin.":
    "ScholarBridge：插件当前没有托管的翻译服务。",

  // modal.ts defaults
  "Confirm": "确认",
  "Keep original": "保留原文",

  // translation-preview.ts
  "Apply": "应用",
  "Discard all": "全部放弃",
  "Source": "原文",
  "Translation": "翻译",
  "Translation (edited)": "翻译（已编辑）",
  "Accept": "接受",
  "✓ Accepted": "✓ 已接受",
  "Retry": "重试",
  "Edit": "编辑",
  "Reject": "拒绝",
  "ScholarBridge: nothing accepted to apply.": "ScholarBridge：没有已接受的内容可应用。",
  "ScholarBridge: applied {{n}} translation block(s).": "ScholarBridge：已应用 {{n}} 个翻译块。",
  "ScholarBridge: apply failed — {{msg}}": "ScholarBridge：应用失败——{{msg}}",

  // diff-view.ts
  "Compare current note with...": "将当前笔记与…对比",
  "Compare two files...": "对比两个文件…",
  "Compare with which note?": "与哪篇笔记对比？",
  "Compare which note?": "选择第一篇笔记",
  "…compare against which note?": "…与哪篇笔记对比？",
  "ScholarBridge: could not open diff view.": "ScholarBridge：无法打开对比视图。",
  "ScholarBridge: diff failed — {{msg}}": "ScholarBridge：对比失败——{{msg}}",
  "  {{n}} changed · {{a}} added · {{r}} removed":
    "  修改 {{n}} 处 · 新增 {{a}} 处 · 删除 {{r}} 处",
  "{{n}} change(s) accepted": "已接受 {{n}} 处更改",
  "Apply to “{{name}}”": "应用到“{{name}}”",
  "Clear": "清除",
  "Accept change": "接受此更改",
  "Accepted ✓ (click to reject)": "已接受 ✓（点击撤销）",
  "ScholarBridge: applied {{n}} change(s); skipped {{s}} (original block not found verbatim — the note may have changed).":
    "ScholarBridge：已应用 {{n}} 处更改；跳过 {{s}} 处（未能逐字定位原块——笔记可能已改动）。",
  "ScholarBridge: applied {{n}} change(s) to {{name}}.":
    "ScholarBridge：已将 {{n}} 处更改应用到 {{name}}。",

  // settings-tab.ts
  "ScholarBridge settings": "ScholarBridge 设置",
  "Conversion": "转换",
  "LaTeX paste handling": "LaTeX 粘贴处理",
  "What to do when pasted text looks like LaTeX.": "粘贴内容疑似 LaTeX 时的处理方式。",
  "Auto convert": "自动转换",
  "Ask": "询问",
  "Never": "从不",
  "Local translation (llama.cpp)": "本地翻译（llama.cpp）",
  "llama-server executable": "llama-server 可执行文件",
  "Leave empty to connect to an already running server only.": "留空则仅连接已在运行的服务。",
  "GGUF model file": "GGUF 模型文件",
  "Host": "主机",
  "Port": "端口",
  "GPU layers": "GPU 层数",
  "Number of layers to offload to the GPU (0 = CPU only).": "卸载到 GPU 的层数（0 = 仅用 CPU）。",
  "Context size": "上下文大小",
  "Temperature": "温度",
  "Idle shutdown (minutes)": "空闲自动关闭（分钟）",
  "Stop the local server after this many idle minutes; 0 keeps it running.":
    "本地服务空闲指定分钟后自动停止；0 表示保持运行。",
  "Request timeout (ms)": "请求超时（毫秒）",
  "Abort a translation request after this many milliseconds (minimum 1000).":
    "翻译请求超过该毫秒数后中止（最小 1000）。",
  "Confirm server start": "启动前确认",
  "Ask before spawning the local llama-server process.": "启动本地 llama-server 进程前先询问。",
  "Start translator on launch": "随 Obsidian 启动翻译服务",
  "Bring llama-server up automatically after Obsidian opens, so translation is always one click away. The confirm dialog above still applies.":
    "Obsidian 打开后自动启动 llama-server，翻译随时可用。上方的“启动前确认”仍然生效。",
  "Source language": "源语言",
  "Target language": "目标语言",
  "Chinese": "中文",
  "English": "英文",
  "Translation style": "译文风格",
  "Academic": "学术",
  "Plain": "通俗",
  "Literal": "直译",
  "Write mode": "写入模式",
  "Insert below source": "插入到原文下方",
  "Replace source": "替换原文",
  "Create translated copy": "创建译文副本",
  "Bilingual interleave": "双语交错",
  "Glossary": "术语表",
  "One entry per line: term => fixed translation. Use “term => preserve” to keep a term untranslated. “|” is also accepted as the separator.":
    "每行一条：术语 => 固定译法。“术语 => preserve” 表示该术语保留不译。也接受“|”作为分隔符。",
  "Import YAML…": "导入 YAML…",
  "Import glossary from YAML": "从 YAML 导入术语表",
  "Nested form: a term line, then indented “action: preserve” or “zh: translation”. Imported entries override colliding ones.":
    "嵌套格式：先写术语行，再缩进写“action: preserve”或“zh: 译文”。导入的条目会覆盖同名条目。",
  "Import": "导入",
  "ScholarBridge: imported {{n}} glossary entr{{suffix}}.{{detail}}":
    "ScholarBridge：已导入 {{n}} 条术语。{{detail}}",
  " Skipped {{n}} unusable entr{{suffix}}.": "（跳过 {{n}} 条无法识别的条目）",
  "Diff": "对比",
  "Ignore whitespace": "忽略空白差异",
  "Ignore Markdown/LaTeX wrapper formatting": "忽略 Markdown/LaTeX 包裹格式差异",
  "Ignore citation/reference changes": "忽略引文/参考文献变化",
  "Case sensitive": "区分大小写",
};

let detected: "zh" | "en" | null = null;

function detectLang(): "zh" | "en" {
  if (detected) return detected;
  try {
    // Obsidian sets moment's locale to the chosen UI language ("zh" for
    // 简体中文, "zh-TW" for 繁體中文, "en" otherwise).
    const loc = (moment.locale() || "").toLowerCase();
    detected = loc.startsWith("zh") ? "zh" : "en";
  } catch {
    detected = "en";
  }
  return detected;
}

/** True when Obsidian's UI language is a Chinese variant. */
function isZh(): boolean {
  return detectLang() === "zh";
}

/** Localize `english` (the key), substituting {{var}} placeholders when vars given. */
export function t(english: string, vars?: Record<string, string | number>): string {
  let out = isZh() ? (zh[english] ?? english) : english;
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.split(`{{${name}}}`).join(String(value));
    }
  }
  return out;
}
