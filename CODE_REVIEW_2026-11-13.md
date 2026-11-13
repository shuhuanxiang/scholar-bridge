# ScholarBridge 全仓库代码审查

审查日期: 2026-11-13。审查对象是当前工作区内容, 包含已有的未提交修改, 不限于 Git diff。

## 修复状态

2026-11-13 已完成下列 17 项已确认问题的修复, 并落实四类优化。保留工作区已有修改, 更新中英文 README, 未提交 Git commit。后面的原始问题描述和复现结果保留为修复前的历史记录, 其中的行号也对应修复前版本。

本轮新增三个回归测试文件, 合计 83 项测试:

- **C: 转换和差异不变量** — [review-conversion.test.ts](D:/scholar-bridge/tests/unit/review-conversion.test.ts), 40 项。
- **W: 并发、生命周期和导出流程** — [review-workflows.test.ts](D:/scholar-bridge/tests/unit/review-workflows.test.ts), 15 项。
- **T: 占位符、响应类型、请求预算和配置** — [request-budget.test.ts](D:/scholar-bridge/tests/unit/request-budget.test.ts), 28 项。

| 编号 | 修复结果 | 回归证据 |
| --- | --- | --- |
| 1 | 比较结果携带整篇原文快照; 在原子写入回调内检查快照, 用原始块范围和完整元数据定位。原文过期时全部跳过, 不重定位到后续重复段落。兼容并保留 CRLF 换行。 | C: 重复段落、过期新增、格式不同的同文块、未接受区域和末尾空行、附带元数据、CRLF; W: 原子应用流程。 |
| 2 | 列规格限制为 256 列、16 层重复, 验证次数为有限安全整数; 超预算保留整个原始表格。 | C: 十亿次重复、400 位次数、乘法展开超预算和深层重复。 |
| 3 | IR 和隐藏 Markdown 元数据保留导言区、文末内容、类选项、宏定义和标题作者。完整导出恢复导言区, 项目导出共享导言区; 冲突在任何文件写入前报错。 | C: 完整 fixture 往返、粘贴到已有笔记、冲突保留; W: 项目导言区提升、冲突预检; 真实 TeX 编译。 |
| 4 | 应用操作在第一次等待前加锁, 同步禁用操作按钮; 写入时核对比较任务、文件、插件状态及编辑器未保存内容。 | W: 两次并发调用只插入一次、未保存编辑拒绝写入。 |
| 5 | 复用平衡语法扫描器, 完整保护带可选参数和嵌套参数的命令、Markdown 链接及隐藏 HTML 元数据; 可选参数识别转义和花括号内的方括号。 | T: 完整引用、嵌套链接、元数据、转义括号及带花括号的可选参数。 |
| 6 | 行与单元格分隔共用环境、数学、花括号、注释和转义状态; 矩阵的 `&` 和 `\\` 留在原单元格中。 | C: 单元格内矩阵往返。 |
| 7 | 跨行或跨列命令有尾随内容、不支持的宽度或对齐规格时, 整表保留 raw LaTeX; 不再丢弃尾部文字。 | C: multirow / multicolumn 尾部、宽度、跨度及规格回退; 新增原文 fixture。 |
| 8 | 根据实际环境分派 `tabular*`, 分别保存宽度和列规格。 | C: 带宽度的 `tabular*` 与 `table*` 往返; 真实 TeX 编译。 |
| 9 | IR、Markdown 元数据和 LaTeX 写入器保存星号浮动体及完整 graphics 选项。 | C: `figure*`、`table*`、高度及 keepaspectratio; 真实 TeX 编译。 |
| 10 | 文本签名与结构签名分开; 列表类型、起始编号、嵌套、代码语言、表格对齐、跨度和图片尺寸参与比较。纯结构变化显示对应源码。 | C: 六种结构差异; W: 代码语言和表格对齐可见; 浏览器截图。 |
| 11 | 打开已有翻译预览只显示原视图, 不重新设置空任务。 | W: 手工编辑、接受状态和原任务对象保持不变。 |
| 12 | 严格验证响应对象、blocks 数组及字符串字段; 损坏响应返回 malformed, 不强制转成字符串或写入缓存。 | T: null、数组、损坏项、数字、布尔值、对象译文共七种拒绝用例。 |
| 13 | 链接显示文字按行内结构转义, 保留加粗和数学; URL 独立处理 TeX 特殊字符及编码中的百分号, 解析时恢复已有 TeX URL 转义。 | C: 普通链接、wikilink、格式化标签、URL 往返、花括号和反斜杠; 真实 TeX 编译。 |
| 14 | 章节名称生成有长度限制的安全 ASCII 标识, 处理设备保留名; `main.tex` 注释记录原始笔记路径, 直接规划危险名称会报错。 | C: 特殊字符、中文、保留名、超长名称及危险路径; W: 来源映射; 真实项目编译。 |
| 15 | 插件生命周期 AbortController 关闭等待确认、取消请求并阻止卸载后写入; 停止服务取消启动代次、等待器和轮询。并发请求计数绑定原管理器。 | W: 卸载中确认、卸载后写入、请求取消、管理器替换、健康检查期间停止; 原有服务生命周期测试仍通过。 |
| 16 | 只解析可完整表示的 HTML 表格子集, 未知属性、图片、嵌套表格和自定义元素整块保留 raw HTML; 实体仅解码一次。 | C: 图片、嵌套、样式、未知标签原文保留和实体往返。 |
| 17 | 用最终输出名称集合分配后缀并忽略大小写, 规划时断言路径唯一; 预先生成全部输出并检查目录冲突。 | C: 后缀碰撞、大小写冲突; W: 多篇碰撞笔记各自输出, 正文均保留。 |

## 优化结果

1. **完整请求预算。** 新增共享 [prompt.ts](D:/scholar-bridge/src/translation/prompt.ts), 预算与实际发送采用同一组消息。估算纳入提示词、术语表、块标识、JSON 和输出额度, 自动缩小分块; 最小分块仍超预算则在请求前报错。占位符策略更新后的缓存版本升至 `v4`。
2. **差异视图局部更新与按需加载。** 单块接受切换保留已有 DOM、滚动和焦点; 超过 200 行时先显示 100 行, 随滚动分批追加。关闭视图释放观察器。布局增加窄屏约束, 避免左右列溢出。比较计算仍在主线程, 保留现有计算预算; 本轮没有引入 worker。
3. **共享配置校验。** 界面、持久化加载和运行前检查共用九个数值字段的边界; 无效输入显示校验反馈, 损坏的枚举、布尔值和主机配置回退到可用值。
4. **补齐不变量和异步交错覆盖。** 新增 83 项回归和两个 LaTeX fixture, 覆盖未接受区域、未知语法、结构差异、过期快照、并发应用、卸载取消、导出碰撞及损坏响应, 并完成真实 TeX 和浏览器组件检查。

## 修复后验证

- 使用已有缓存中的 Node.js `v22.23.5`; 未安装或升级依赖。
- `npm test`: **21 个文件、375 项测试全部通过**, 初次审查时为 18 个文件、292 项。
- `npm run build`: TypeScript 检查和生产构建通过。
- `git diff --check`: 通过; Git 仅提示已有 `editor-workflows.test.ts` 的 LF/CRLF 转换, 没有空白错误。
- [TeX 验证脚本](D:/scholar-bridge/node_modules/.cache/scholar-bridge-review-2026-11-13/verify-export.mjs) 使用本机 `pdflatex`、禁用 shell escape, 对往返恢复的完整文章 `article.tex` 和安全章节名的项目 `main.tex` 均编译成功, 包含矩阵、星号浮动体、宏定义、图像与特殊字符链接。
- [浏览器验证脚本](D:/scholar-bridge/node_modules/.cache/scholar-bridge-review-2026-11-13/verify-view.mjs) 在 Chrome 中加载实际 DiffView 与 Obsidian 宿主替身, 验证 1200px / 380px 布局、无横向溢出、切换后行 DOM 保持、100 到 251 行的按需加载及无页面错误。已检查 [桌面截图](D:/scholar-bridge/node_modules/.cache/scholar-bridge-review-2026-11-13/ui/diff-1200.png) 和 [窄屏截图](D:/scholar-bridge/node_modules/.cache/scholar-bridge-review-2026-11-13/ui/diff-380.png)。
- 构建结果、TeX 输出、浏览器截图和独立验证脚本均位于 Git 忽略目录; 业务修复、正式回归测试、fixtures 和双语文档留在工作区供审阅。

验证边界: 未启动真实 GGUF 模型, 未在真实 Obsidian Vault 中执行写入。编辑器、Vault 和进程交错使用接口替身; 浏览器检查不等同于完整 Obsidian 集成测试。上下文预算使用保守 UTF-8 字节估算, 并非目标模型的精确 tokenizer。

## 原始审查记录（修复前）

初次审查范围: 全部 46 个源码文件, 18 个单元测试文件, 测试替身和转换 fixtures, 样式、本地化、构建及发布配置。确认 17 项问题, 其中 P1 三项、P2 十四项, 另列四项优化建议。初次审查阶段只新增报告和诊断脚本, 未修改业务源码。

### 优先修复

### 1. [P1] 原块变动后, 差异应用会误改后面的重复段落

位置: [diff-apply.ts:117](D:/scholar-bridge/src/diff/diff-apply.ts:117), [diff-apply.ts:241](D:/scholar-bridge/src/diff/diff-apply.ts:241)。

定位逻辑从游标向后搜索第一个匹配的序列化文本, 没有将匹配绑定到生成差异时的源块身份。目标块已经被编辑时, 后面的同文段落仍可通过匹配, 被当作原目标写入。

复现:

```text
生成差异时的旧文档: Alpha.\n\nAlpha.
新版本:             Changed.\n\nAlpha.
应用时的实际旧文档: Hand edited.\n\nAlpha.
只接受第一个块后的结果: Hand edited.\n\nChanged.
```

结果报告 `applied: [0]`, `skipped: []`, 但改动落在了未接受修改的第二段。

建议: 保存比较时的原文快照与块范围, 在 Vault 原子更新回调中核对; 原文已变时拒绝应用或重新计算差异。若允许重定位, 必须验证上下文和唯一性, 不能采用第一个文本命中。

### 2. [P1] 表格列规格可以用极短输入阻塞主线程

位置: [latex-parser.ts:515](D:/scholar-bridge/src/core/parser/latex/latex-parser.ts:515)。

`*{n}{spec}` 直接按 `n` 循环展开, 没有次数、展开列数或递归深度限制。输入字符数限制无法约束这种语义展开。

复现: 50 字符的 `\begin{tabular}{*{1000000000}{}}A \\ \end{tabular}` 在独立子进程中超过 1500 ms 仍未完成, 被诊断脚本终止。重复次数使用 400 位数字时会解析为 `Infinity`, 相同循环无法结束。非空列规格还会不断增加内存占用。

解析调用位于编辑器线程; 自动粘贴和手动转换均可到达这里。

建议: 在循环前验证有限整数及上限, 对总展开列数、递归深度统一设预算。超出预算的整个结构按 raw LaTeX 保留。

### 3. [P1] 完整 LaTeX 文档转换会丢失导言区, 使保留的宏调用失效

位置: [latex-parser.ts:55](D:/scholar-bridge/src/core/parser/latex/latex-parser.ts:55), [latex-parser.ts:69](D:/scholar-bridge/src/core/parser/latex/latex-parser.ts:69), [markdown-writer.ts:22](D:/scholar-bridge/src/core/writer/markdown/markdown-writer.ts:22)。

解析完整文档时先移除导言区, 只提取少量已知元数据。`\newcommand` 等不支持的内容没有形成 raw 节点。Markdown 写入器又只输出 YAML 元数据, 因而标题、作者和宏包信息也没有跨格式保存。

复现: 含 `\newcommand{\foo}{IMPORTANT}`、`\title{Paper title}` 和正文 `Use \foo.` 的完整文档经过 LaTeX -> Markdown -> LaTeX 后, 仅保留宏调用, 定义与标题消失。重新导出的文章无法依靠原定义编译。

建议: 在 IR 中保留完整导言区, 并提供可往返的 Markdown 元数据表示; 或在暂不支持完整文档时保守拒绝转换, 保留原始文本。

## 其他已确认问题（修复前）

### 4. [P2] 差异视图连续应用会重复插入新增块

位置: [diff-view.ts:138](D:/scholar-bridge/src/views/diff-view.ts:138)。

`applyAccepted` 在首次等待前没有设置应用锁, 按钮也不禁用。两次调用均能捕获相同的 accepted 集合; 即使 `vault.process` 串行运行, 第二次仍会再次应用没有旧块校验的新增项。

复现: 比较 `Anchor.` 与 `Anchor.\n\nAdded.`, 接受新增并并发调用两次应用, 得到两份 `Added.`。使用的是实际差异实现和串行修改回调, 不依赖真实模型。

建议: 参照翻译预览, 在第一次 await 前获取应用锁, 禁用应用和接受状态修改; 成功后更新比较状态, 失败后释放锁。

### 5. [P2] 带可选参数的引用没有完整保护, 改坏引用仍可通过校验

位置: [protector.ts:66](D:/scholar-bridge/src/translation/protector.ts:66), [protector.ts:68](D:/scholar-bridge/src/translation/protector.ts:68)。

引用规则只处理命令后立即跟 `{...}` 的情况。`\citep[see][p.~5]{smith2024}` 只保护了命令名, 可选参数和引用键仍暴露给模型。

复现: 本地 provider 替身将 `smith2024` 改为 `changed2024`, 全部占位符校验仍通过, 返回的完整引用已经变为另一个文献键。

同一处还存在两种保护缺口: 含嵌套括号的 Markdown 链接只保护到首个右括号; LaTeX 转换生成的 `scholarbridge:inline-latex` 注释也没有整体保护, 元数据前缀和 JSON 结构可被改写。这两个现象已通过保护结果检查确认。

建议: 复用语法扫描器识别完整引用、平衡括号链接和隐藏元数据, 再进行占位符替换; 增加“允许改写未保护文本”的 provider 回归用例。

### 6. [P2] 表格单元格中的矩阵会被拆成多列, 同时丢失矩阵换行

位置: [latex-parser.ts:624](D:/scholar-bridge/src/core/parser/latex/latex-parser.ts:624)。

行分割器记录了嵌套环境, 单元格分割器却只记录花括号深度。矩阵内部 `&` 会被当作外层表格分隔符; 拆坏后的片段又失去完整数学边界, 内部 `\\` 被当作普通行内换行处理。

复现: 两列表格中的 `Name & $\begin{pmatrix} a & b \\ c & d \end{pmatrix}$` 被解析为四个单元格, 导出内容不再是原来的矩阵。

建议: 用同一套环境、数学、花括号和转义状态解析行及单元格边界; 无法可靠解析时回退为原始表格。

### 7. [P2] multirow / multicolumn 后面的单元格内容被丢弃

位置: [latex-parser.ts:667](D:/scholar-bridge/src/core/parser/latex/latex-parser.ts:667), [latex-parser.ts:683](D:/scholar-bridge/src/core/parser/latex/latex-parser.ts:683)。

识别到跨行或跨列命令后立即返回, 只解析第三个参数, 没有处理 `contentG.end` 后面的剩余文本。

复现: 单元格 `\multirow{2}{*}{A} IMPORTANT` 转换后只剩 `A`; `\multicolumn{2}{c}{A} IMPORTANT` 有相同路径。附加文本或用于标注的命令都可能消失。

建议: 消费并保留剩余内容, 或在当前 IR 无法准确表示时将整个表格保留为 raw LaTeX。

### 8. [P2] table 中的 tabular* 将宽度误当成列规格

位置: [latex-parser.ts:454](D:/scholar-bridge/src/core/parser/latex/latex-parser.ts:454)。

正则接受 `tabular*`, 但调用 `parseTabularFloat` 时固定传入 `starred: false`。

复现: `\begin{table}\begin{tabular*}{\textwidth}{ll}A & B \\\end{tabular*}\end{table}` 得到 `columnSpec: "\\textwidth"`, `{ll}` 进入首个单元格, `\end{tabular*}` 进入额外一行, 重新导出后结构无效。

建议: 从实际匹配的环境名传递 starred 标记, 同时保留宽度和环境类型。

### 9. [P2] 星号浮动体和不支持的图片选项被静默改写

位置: [latex-parser.ts:357](D:/scholar-bridge/src/core/parser/latex/latex-parser.ts:357), [latex-parser.ts:758](D:/scholar-bridge/src/core/parser/latex/latex-parser.ts:758), [latex-writer.ts:180](D:/scholar-bridge/src/core/writer/latex/latex-writer.ts:180)。

`figure` / `figure*` 进入相同节点, 没有保存环境名称; `includegraphics` 只保留 width。table / table* 也没有保存星号语义。

复现: `figure*` 中 `[width=1cm,height=2cm]` 的图片往返后成为普通 `figure`, `height=2cm` 消失。双栏跨栏语义和显示尺寸均发生变化。

建议: 在 IR 和隐藏元数据中保存原环境及完整选项; 不支持的选项应触发 raw 回退。

### 10. [P2] 差异签名忽略结构属性, 明显变化会显示为相同

位置: [structural-diff.ts:274](D:/scholar-bridge/src/diff/structural-diff.ts:274), [node-text.ts:60](D:/scholar-bridge/src/diff/node-text.ts:60)。

签名主要比较内容文本, 没有包括列表类型、代码语言、表格对齐、图片尺寸等字段。签名相同时直接返回 equal, 后续专门比较逻辑也不会运行。

已分别确认以下比较均报告一个相等块、零个修改, 即使关闭“忽略包裹格式差异”也一样:

- `- A` -> `1. A`。
- 相同代码内容的 `js` 围栏 -> `py` 围栏。
- 相同单元格内容, 左对齐 -> 右对齐。
- `![[x.png|100]]` -> `![[x.png|200]]`。

建议: 将文本相等与结构相等分开, 明确每种节点需要比较的属性。先定义结构差异, 再决定需要显示的文字细节。

### 11. [P2] “打开翻译预览”会清空已有任务和手工编辑

位置: [translate-commands.ts:489](D:/scholar-bridge/src/editor/translate-commands.ts:489)。

打开命令调用 `showPreview(plugin, [], ...)`, 后者复用已有预览并无条件设置一个空任务。

复现: 预览中保留一项已手工修改、尚未应用的译文; 再执行“打开翻译预览”, 原 job 被空 job 替换, 译文丢失。

建议: 打开命令只定位并显示现有视图; 只有创建新任务时才设置 job。确需覆盖未应用任务时提供明确操作。

### 12. [P2] 非字符串模型输出被强制转成译文, 而不是拒绝

位置: [client.ts:203](D:/scholar-bridge/src/translation/llama/client.ts:203)。

输出通过 JSON 解析后, `id` 和 `translation` 被直接 `String(...)` 强制转换。对象、数字和布尔值能变成非空字符串, 通过后续非空和占位符检查。

复现: 模型返回 `{"blocks":[{"id":"p_1","translation":{"bad":true}}]}`, 实际翻译管线接受译文 `[object Object]`。该结果还可进入缓存。

建议: 对顶层对象、数组项及两个字段做严格运行时校验, 类型不正确时返回 malformed 错误; 不做强制字符串转换。

### 13. [P2] 链接显示文字没有进行 LaTeX 转义

位置: [latex-writer.ts:287](D:/scholar-bridge/src/core/writer/latex/latex-writer.ts:287)。

普通文本使用 `escapeLatexText`, 链接 alias / target 作为显示文字时却直接拼入花括号。

复现: `[a_b & c](https://example.com)` 输出 `\href{https://example.com}{a_b & c}`, 其中 `_` 和 `&` 不再是普通文字, 会破坏 LaTeX 排版或编译。wikilink 的显示文字也走未转义路径。

建议: 对显示文字采用与正文一致的结构解析及转义; URL 使用适合 hyperref 参数的独立编码策略。

### 14. [P2] 合法笔记名中的 TeX 特殊字符会破坏项目入口

位置: [project-export-plan.ts:62](D:/scholar-bridge/src/export/project-export-plan.ts:62)。

`latexInputName` 只判断空格和非 ASCII, 没有处理 `%`、`#` 等 TeX 特殊字符。给文件名加双引号不能改变 `%` 的注释语义。

复现: `100% ablation.md` 导出的入口包含 `\input{"sections/100% ablation"}`, 百分号之后的内容和右括号会被 TeX 作为注释处理。

建议: 将实际导出文件名映射为安全 ASCII 标识, 保留笔记名到导出名的映射; 或实现经过验证的 TeX 文件名编码。

### 15. [P2] 插件卸载没有取消正在等待确认的启动流程

位置: [translator-commands.ts:172](D:/scholar-bridge/src/editor/translator-commands.ts:172), [translator-commands.ts:184](D:/scholar-bridge/src/editor/translator-commands.ts:184), [main.ts:201](D:/scholar-bridge/src/main.ts:201)。

卸载只停止当时存在的管理器。启动流程若仍在等待确认, 此时管理器为空; 确认返回后仍会新建管理器并启动服务, 没有检查插件是否已卸载。

复现: 启动确认尚未返回时调用卸载, 再完成确认, `ensureTranslatorReady` 仍成功并给已卸载插件赋予新的 ready 管理器。验证使用进程替身, 没有实际启动 llama-server。

建议: 维护插件生命周期标记或 AbortController, 卸载时取消等待、关闭确认框和中止请求; 每个 await 之后检查任务及插件状态。

### 16. [P2] 非本插件生成的 HTML 表格被有损解析

位置: [markdown-parser.ts:526](D:/scholar-bridge/src/core/parser/markdown/markdown-parser.ts:526), [markdown-parser.ts:593](D:/scholar-bridge/src/core/parser/markdown/markdown-parser.ts:593)。

函数注释说明只解析 ScholarBridge 生成的表格, 实际入口却对任意 `<table>` 尝试结构化解析。单元格随后无条件 `stripTags`, 不支持的元素也被删除。

复现: `<table><tr><td><img src="plot.png"></td></tr></table>` 转换后变为空单元格的 GFM 表格, 图片及路径完全消失。

建议: 只解析确认受支持的表格子集; 遇到图片、嵌套表格或其他未知子元素时, 保留整个 raw HTML 表格。

### 17. [P2] 导出名去重没有检查生成的后缀是否已经占用

位置: [project-export-plan.ts:72](D:/scholar-bridge/src/export/project-export-plan.ts:72), [project-export.ts:63](D:/scholar-bridge/src/export/project-export.ts:63)。

去重只记录原始清理后的 base, 不记录最终输出名。数字后缀可能与另一篇笔记清理后的名字相同, 最终规划出相同章节路径。

复现: `a?`、`a*`、`a--2` 得到 `a-`、`a--2`、`a--2`。在允许这些文件名的平台上, 导出后第三节会覆盖第二节, main.tex 又会两次引用同一路径。当前 Windows 文件系统通常无法创建前两个名字, 但插件也支持其他桌面平台。

建议: 用最终输出名集合分配名称, 对候选后缀循环检查冲突; 导出前断言全部输出路径唯一, 并考虑目标文件系统的大小写规则。

## 原始优化建议

1. **按完整请求计算上下文预算。** [translator.ts:173](D:/scholar-bridge/src/translation/translator.ts:173) 目前根据正文字符数分块, 不纳入自定义提示词、相关术语表、JSON 结构和指定输出预算。建议优先使用服务端 tokenizer 或保守估算完整请求, 使较长术语表和自定义提示词也受预算约束。

2. **减少差异视图的完整重绘。** [diff-view.ts:98](D:/scholar-bridge/src/views/diff-view.ts:98) 每次切换一个接受按钮都会重建全部块的 DOM。长文档可采用局部状态更新, 大量块时使用虚拟列表。转换与 diff 的计算还可逐步移入 worker, 同时保留现有预算保护。

3. **统一界面输入和加载时的设置约束。** [settings-tab.ts:84](D:/scholar-bridge/src/settings/settings-tab.ts:84) 等控件与 [settings.ts:101](D:/scholar-bridge/src/settings/settings.ts:101) 的边界不一致。例如界面允许 context size 为 1, 重新加载时却最少为 256。建议共用字段校验器, 在启动服务和构建请求前再验证一次, 给用户显示可理解的错误。

4. **扩充测试中的不变量和异步交错场景。** 已有用例侧重具体历史回归。建议增加“未接受区域逐字不变”“未知语法往返仍在”“结构变化不能判 equal”“过期或卸载后的任务不能写入”的共享断言, 并覆盖差异应用并发、重名导出和损坏模型输出。HTTP 和流程替身仍有价值, 同时应补少量真实 Obsidian Vault 手工验证。

## 初次审查验证记录和限制

- 找到并使用现有缓存中的 Node.js `v22.23.5`, 符合仓库的 Node.js 22 要求; 无需下载安装依赖。
- `npm test`: 18 个文件, 292 项测试全部通过。
- `npm run build`: TypeScript 检查和生产构建通过。生成的 main.js 按仓库规则被 Git 忽略。
- [独立诊断脚本](D:/scholar-bridge/node_modules/.cache/scholar-bridge-review-2026-11-13/probes.mjs) 对以上 17 项分别执行契约检查, 全部输出 `REPRODUCED`。这里表示当前实现违反相应预期, 不表示正式 Vitest 套件失败。
- 对可能长时间运行的列规格展开使用独立子进程和 1500 ms 超时, 未在主审查进程中无限执行。
- 编辑器、Vault、视图和进程生命周期使用接口替身; 未启动真实 GGUF 模型, 未在真实 Obsidian Vault 中执行写入。
- 第 14 项已确认生成的入口字符串包含未处理的 TeX 注释字符; 本次没有调用 TeX 编译器进行实际编译。
- 初次审查阶段保留用户已有修改, 未自动实施产品修复; 后续修复状态以本报告前半部分为准。
