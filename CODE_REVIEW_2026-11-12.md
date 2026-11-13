# ScholarBridge 全仓库代码审查

## 修复状态

2026-11-12：下列 21 项问题均已完成代码修复和自动化回归验证。新增 57 项测试，当前共 276 项测试全部通过；Node.js 22 下类型检查及生产构建通过。未启动真实 GGUF 模型，也未在真实 Obsidian Vault 中进行写入测试。

| 原问题 | 修复 | 回归位置 |
|---|---|---|
| 1. 缺失结束标记删除后续章节 | 只接受完整且非嵌套的标记对，跳过损坏标记并提示 | `review-regressions.test.ts` / `editor-workflows.test.ts` |
| 2. 失败重译清空旧译文 | 失败项默认排除，禁止应用空译文，重试成功后恢复可用 | `editor-workflows.test.ts` |
| 3. 未接受新增仍写入 | 新增块在输出前检查接受状态 | `review-regressions.test.ts` |
| 4. 代码块被拆开翻译 | 按全文 Scholar IR 的正文范围选择翻译目标 | `editor-workflows.test.ts` |
| 5. 重译不核对原文 | 同时核对原文和目标译文快照，切换焦点后再次验证 | `editor-workflows.test.ts` |
| 6. 替换译文导出为空 | 元数据记录写入模式，导出保留替换正文；旧标记保守兼容 | `review-regressions.test.ts` |
| 7. 固定译法未传给模型 | provider 请求和模型提示词携带相关术语映射，提示词版本更新 | `review-regressions.test.ts` |
| 8. 未知行内命令往返改写 | 代码片段和隐藏注释保留完整命令、参数及引用类型 | `review-regressions.test.ts` / 新增 LaTeX fixture |
| 9. 单行显示公式吞正文 | 检查当前行闭合分隔符，未闭合输入原样保留 | `review-regressions.test.ts` / 新增 Markdown fixture |
| 10. 行内公式分支不可达 | 在通用转义处理前识别反斜杠括号公式 | `review-regressions.test.ts` |
| 11. multirow 多插一列 | 跨行续行消费已有空占位单元格 | `review-regressions.test.ts` |
| 12. 导出缺少宏包 | 递归检测数学、代码及替换译文正文的宏包依赖 | `review-regressions.test.ts` |
| 13. 图片路径未重定位 | 解析真实附件路径，以主导出目录为基准重写路径 | `editor-workflows.test.ts` |
| 14. 保留原文取消了粘贴 | 取消转换时插入原文，使用捕获的选区并拒绝过期编辑器内容 | `editor-workflows.test.ts` |
| 15. 重复应用写入两次 | 首次等待前获取应用锁，并禁用相应控件 | `editor-workflows.test.ts` |
| 16. 副本重名清空预览 | 重名返回可恢复错误，保留预览和手工编辑 | `editor-workflows.test.ts` |
| 17. 服务沿用旧配置 | 对比配置快照，等待旧进程停止后重建管理器 | `editor-workflows.test.ts` |
| 18. 新增段落分隔丢失 | 同时维护新增块前后边界 | `review-regressions.test.ts` |
| 19. 图注修改不进入差异 | 比较图片、表格和算法的说明文字 | `review-regressions.test.ts` |
| 20. 差异预览内容为空 | 复用递归内容提取，覆盖格式嵌套、链接、列表和引用 | `editor-workflows.test.ts` |
| 21. 行内代码保护不完整 | 按包含关系选取完整保护范围，支持不同长度代码分隔符 | `review-regressions.test.ts` |

正式回归测试：[转换、翻译与持久化](D:/scholar-bridge/tests/unit/review-regressions.test.ts)、[编辑器完整工作流](D:/scholar-bridge/tests/unit/editor-workflows.test.ts)。下文保留修复前的诊断和原始行号，作为审查记录。

三项优化建议也已实施：源文恢复改为线性扫描，超长单段按请求预算拆分且整段成功才缓存或应用，设置保存增加去抖与串行队列。10,000 行旧格式源文恢复用例通过 1 秒上限的性能回归检查。中英文 README 已同步说明翻译范围、旧译文导出和资源路径行为。

## 修复前审查

审查日期：2026-11-12。范围为当前版本的全部 43 个源码文件、现有测试、构建与发布配置，不限定于提交差异。未修改产品源码和现有测试。

以下 21 项均有最小输入或 Obsidian 接口替身复现。P1 表示应优先处理的数据写入和内容保护问题；P2 表示应修复的功能、转换和界面正确性问题。性能建议另列，不计入缺陷数量。

## 优先修复的问题

### 1. [P1] 译文缺少结束标记时，重译会删除后续章节

位置：[freshness.ts:87](D:/scholar-bridge/src/translation/freshness.ts:87)，`scanFreshness`。

多行开始标记存在，但 `scholarbridge:translation:end` 缺失时，扫描器把文件最后一行当作译文结束位置。若前面的源文已经变化，“翻译变更块”会把从译文开始到文末的全部内容作为替换范围；写入检查也会通过，因为 `verifyRaw` 同样包含了这些内容。

复现：有效的多行译文开始标记及 JSON，后接旧译文，省略结束标记，再添加 `# Unrelated section` 和正文。执行重译并应用后，无关标题和正文均消失。

建议：没有找到结束标记就跳过该块并报告标记损坏；遇到新的开始标记时也应中止当前配对，不能猜测结束位置。

### 2. [P1] 重译失败的块仍默认勾选，应用会清空旧译文

位置：[translate-commands.ts:449](D:/scholar-bridge/src/editor/translate-commands.ts:449)、[translate-commands.ts:469](D:/scholar-bridge/src/editor/translate-commands.ts:469)，`translateChangedBlocks`。

部分块在逐块回退后仍失败时，结果映射中没有对应译文。这里使用空字符串作为译文，同时设置 `included: true`，随后仍以 `replace` 模式打开预览。用户应用其余成功结果时，失败块的旧译文也被空内容覆盖。

复现：两块过期译文中，一块成功、一块始终缺失。预览项分别是 `{ included: true, translation: "NEW FIRST" }` 和 `{ included: true, translation: "" }`。应用全部默认勾选项后，第二块原来的 `KEEP SECOND` 消失。

建议：为失败项保留独立失败状态，默认不勾选且禁止应用；重试成功后才能纳入写入集合。

### 3. [P1] 差异合并会写入未接受的新增块

位置：[diff-apply.ts:163](D:/scholar-bridge/src/diff/diff-apply.ts:163)，`emitAdd`。

函数仅在记录 `applied` 时检查 `accepted`，实际输出 `newLines` 没有检查。所有新增块都会进入 `pendingAdds`，所以接受任意其他修改并应用时，未接受的新增内容也会落盘，且应用计数不包含这些内容。

复现：旧笔记为 `Original.\n\nAnchor.`，新笔记为 `Changed.\n\nAnchor.\n\nRejected addition.`，只接受首段修改。结果仍包含 `Rejected addition.`，但 `applied` 仅报告首段索引。

建议：在入队或输出之前拒绝未接受的新增块，并覆盖“接受一处修改、拒绝另一处新增”的混合场景。

### 4. [P1] 带空行的代码块会被拆开并送去翻译

位置：[translate-commands.ts:180](D:/scholar-bridge/src/editor/translate-commands.ts:180)、[translate-commands.ts:197](D:/scholar-bridge/src/editor/translate-commands.ts:197)，`splitParagraphs` / `isTranslatablePart`。

翻译入口按空行切分，然后仅检查片段是否以反引号围栏开头。代码块中空行之后的片段失去开头围栏，会被判定为正文；波浪号围栏也未排除。替换模式可能改写代码或破坏围栏结构。

复现：选中包含 `print('first')`、空行、`print('second')` 的 Python 围栏代码块。实际请求包含 `print('second')` 及结束围栏。

建议：利用解析器和真实源位置选择可翻译的正文块，或在切分时维护完整的围栏状态，覆盖不同围栏字符及长度。

### 5. [P1] 增量重译应用时没有再次核对原文

位置：[translate-commands.ts:458](D:/scholar-bridge/src/editor/translate-commands.ts:458)，以及 [main.ts:115](D:/scholar-bridge/src/main.ts:115) 的写入检查。

增量重译的 `verifyRaw` 只记录旧译文块。推理期间若用户修改原文而没有改变行数，旧译文块依旧匹配，过时的结果就可以应用，原文变化不会触发拒绝。

复现：对 `Changed source.` 生成重译结果前，将原文改成同一行的 `Newer source.`。对 `Changed source.` 的旧结果仍成功写入。

建议：任务同时保存原文与目标译文的源位置和快照；应用前必须同时验证两者。

规则依据：[AGENTS.md:40](D:/scholar-bridge/AGENTS.md:40) 明确要求应用编辑时保留原文过期检查。

## 其他已复现的问题

### 6. [P2] 替换模式生成的译文在 LaTeX 导出中全部丢失

位置：[latex-writer.ts:173](D:/scholar-bridge/src/core/writer/latex/latex-writer.ts:173)，`writeBlock`。

导出器无条件丢弃 `translation-block`。插入模式下可以保留原文，但替换模式已经删除原文，剩余正文全在译文块里。

复现：把单段原文以替换模式改为 `Translated prose.`，再导出 LaTeX 片段，结果只有一个换行。

建议：在元数据中记录写入模式，并明确导出原文或译文的选择；不能无条件丢弃替换模式的唯一正文。

### 7. [P2] 固定译法术语表没有传给模型

位置：[translator.ts:253](D:/scholar-bridge/src/translation/translator.ts:253)，`translateOneChunk`。

`relevantGlossary` 的结果虽然被计算，但没有进入 `TranslationRequest`，客户端的两个提示词也没有术语映射。`preserve` 通过占位符生效，普通固定译法则没有约束作用。

复现：设置 `neural network => FIXED_TRANSLATION_42` 后翻译含该术语的正文，捕获模型请求，系统和用户提示词均不包含固定译法。

建议：扩展 provider 请求契约，把相关术语和固定译法传入提示词，并增加请求级验证用例。

### 8. [P2] 未知行内 LaTeX 命令往返后被转成普通文本

位置：[markdown-writer.ts:135](D:/scholar-bridge/src/core/writer/markdown/markdown-writer.ts:135)，配合 [markdown/inline.ts:30](D:/scholar-bridge/src/core/parser/markdown/inline.ts:30)。

LaTeX 解析器生成的 `inline-raw` 被直接输出为 Markdown 文本，但 Markdown 解析器无法恢复其原始类型。再次导出时，反斜杠和花括号会按普通文本转义。

复现：`Use \custom{one}{two} now.` 经 LaTeX → Markdown → LaTeX 后变为 `Use \textbackslash{}custom\{one\}\{two\} now.`。

建议：为未知行内命令提供可恢复的表示，保存整个命令及其参数，避免它们在中间格式中失去类型。

规则依据：[AGENTS.md:40](D:/scholar-bridge/AGENTS.md:40) 明确要求不支持的语法原样保留。

### 9. [P2] 单行反斜杠显示公式会吞入后续正文

位置：[markdown-parser.ts:214](D:/scholar-bridge/src/core/parser/markdown/markdown-parser.ts:214)。

`\[...\]` 分支直接从下一行寻找结束分隔符，没有先检查当前行是否已经闭合。

复现：`\[x=y\]\n\nKeep this paragraph.` 被解析为一个数学块，数学内容包含 `x=y\]` 以及后续整个段落。

建议：像 `$$...$$` 分支一样先处理同一行的闭合位置，并分别保留公式后面的文字；未闭合输入应保守回退。

### 10. [P2] 反斜杠括号行内公式无法被识别

位置：[latex/inline.ts:128](D:/scholar-bridge/src/core/parser/latex/inline.ts:128)。

`readCommand` 对 `\(` 返回 `null`，随后被当作转义符号处理，后面的 `case "\\("` 因而不可达。

复现：`Energy \(E=mc^2\) here.` 只生成普通文本 `Energy (E=mc^2) here.`，没有数学节点。

建议：在通用控制序列或转义符处理前识别 `\(...\)`。

### 11. [P2] 标准 multirow 续行被额外插入一列

位置：[latex-parser.ts:710](D:/scholar-bridge/src/core/parser/latex/latex-parser.ts:710)，`resolveSpans`。

LaTeX 的跨行单元格续行通常已经用空单元格占位。这里又插入一个 `rowSpanContinue`，然后仍保留原有空单元格，导致后续数据右移、表格列数增加。

复现：两列表格首行为 `\multirow{2}{*}{A} & B \\`、次行为 ` & C \\`。解析后的行宽为 `[2, 3]`，导出次行为 ` &  & C \\`。

建议：区分 LaTeX 的显式空占位与 HTML 的隐式缺省位置，续行应消费相应的原始单元格。

### 12. [P2] 完整文章导出缺少实际使用的宏包

位置：[latex-writer.ts:42](D:/scholar-bridge/src/core/writer/latex/latex-writer.ts:42)，`detectPackages`。

宏包检测没有处理数学节点和代码节点，但输出器会生成 `align` 和 `lstlisting` 等环境。

复现：含一个 `align` 节点和一个 Python 代码节点的文档，`detectPackages` 返回空数组，完整文章也没有加载 `amsmath` 和 `listings`。

建议：按实际输出的环境补全宏包依赖，包括嵌套内容；用生成的文章内容验证依赖闭包。

### 13. [P2] 项目导出没有重定位图片路径

位置：[project-export.ts:66](D:/scholar-bridge/src/export/project-export.ts:66)，以及 [latex-writer.ts:144](D:/scholar-bridge/src/core/writer/latex/latex-writer.ts:144)。

项目入口移动到了 `paper/latex/main.tex`，但图片目标仍按原 Markdown 字符串输出，也没有复制资源或设置搜索路径。

复现：`paper/intro.md` 引用 `paper/figures/plot.png`，项目导出后仍使用 `\includegraphics{figures/plot.png}`，实际只生成主文件和章节文件。从 `paper/latex` 编译时路径错误。

建议：先通过 Obsidian 解析资源真实路径，再重写为相对导出入口的路径，或统一复制到导出目录。

### 14. [P2] 粘贴询问框的“保留原文”实际上取消了粘贴

位置：[commands.ts:38](D:/scholar-bridge/src/editor/commands.ts:38)。

粘贴事件已经 `preventDefault()`，但确认框只配置了转换回调，没有配置取消回调。“保留原文”按钮和关闭对话框都不会插入任何内容。

复现：默认询问模式下粘贴 `\begin{equation}x=y\end{equation}`，选择保留原文，编辑器仍为空。

建议：取消转换时插入捕获的原始文本，同时保留明确的目标选区和源文检查。

### 15. [P2] 连续点击两次应用会重复写入译文

位置：[translation-preview.ts:166](D:/scholar-bridge/src/views/translation-preview.ts:166)。

`job.applied` 在异步写入完成后才置位。两次调用都能先通过检查，并在 `revealLeaf` 的等待期间同时进入写入流程。

复现：对同一插入模式任务同时调用两次 `applyJob`，正文中的同一译文出现两次。

建议：在第一次等待前获取任务应用锁并禁用按钮，失败时释放；成功后再标记已应用。

### 16. [P2] 译文副本重名时，未应用的预览被当作成功清空

位置：[main.ts:134](D:/scholar-bridge/src/main.ts:134)，以及 [translation-preview.ts:182](D:/scholar-bridge/src/views/translation-preview.ts:182)。

目标副本已经存在时，写入方法显示提示后正常返回。预览无法区分未写入与成功，于是显示成功提示、标记应用并丢弃当前任务，手工编辑的译文也随之丢失。

复现：存在 `note.translated.md` 时应用译文副本，先出现“already exists”，接着出现“applied”，预览被清空。

建议：返回明确的应用结果或抛出可恢复错误，未实际写入时保留预览；另行允许改名。

### 17. [P2] 修改模型或服务配置后，重新启动仍使用旧参数

位置：[translator-commands.ts:159](D:/scholar-bridge/src/editor/translator-commands.ts:159)，`ensureTranslatorReadyOnce`。

服务管理器构造时复制配置，停止后仍保留同一个实例。设置发生变化也没有重建，因此重新启动继续沿用旧模型、端口和 GPU 参数；客户端却从新设置读取连接地址，可能进一步造成连接错配。

复现：用 `old-model.gguf` 创建管理器，修改设置为 `new-model.gguf` 后再次启动，管理器仍使用旧路径。

建议：比较配置快照，在确认旧进程已停止后重建管理器；设置界面明确需要重启的参数。

### 18. [P2] 在中间插入差异块时丢失后侧段落分隔

位置：[diff-apply.ts:188](D:/scholar-bridge/src/diff/diff-apply.ts:188)。

插入逻辑只在新增内容前补空行，随后直接输出下一个旧块，没有补足两者之间的分隔。新旧两段因此可能合并，列表和代码围栏等边界也会受到影响。

复现：将 `A.\n\nB.` 与 `A.\n\nX.\n\nB.` 对比并接受新增块，实际得到 `A.\n\nX.\nB.`。

建议：在新增块两侧分别维护块边界，覆盖开头、中间、连续插入及结尾的精确文本断言。

### 19. [P2] 图片说明变化被报告为完全相同

位置：[node-text.ts:70](D:/scholar-bridge/src/diff/node-text.ts:70)，`blockComparableText`。

图片对齐签名只有路径，未纳入说明文字，因而相同路径的两张图即使说明内容变化，也会直接被判为相等。

复现：比较 `![Old scientific claim](plot.png)` 与 `![Corrected scientific claim](plot.png)`，统计为一个相等块、零个变化块。

建议：把图注等承载内容的字段纳入比较键，并对表格和算法说明做同类检查。

### 20. [P2] 新增或删除的粗体正文、列表在差异预览中为空

位置：[diff-view.ts:237](D:/scholar-bridge/src/views/diff-view.ts:237)，`plainOf`。

段落只处理文本、数学和代码行内节点，忽略粗体、强调和链接；列表与引用块则落入空字符串默认分支。新增和删除的块依赖这个函数显示，用户无法看到将要接受的实际内容。

复现：`plainOf(parseMarkdown("**Critical result.**").children[0])` 和列表对应调用均返回空字符串。

建议：复用完整的递归内容提取或只读渲染，不要在视图中维护不完整的第二套节点序列化。

### 21. [P2] 行内代码含美元内容时，代码保护会被内部数学匹配打断

位置：[protector.ts:53](D:/scholar-bridge/src/translation/protector.ts:53)、[protector.ts:107](D:/scholar-bridge/src/translation/protector.ts:107)。

数学规则先注册内部匹配，代码规则发现重叠后会跳过整个代码范围，导致代码其余部分仍被当作可翻译文字。占位符数量检查无法发现这些原本没有被保护的内容遭到修改。

复现：包含行内代码 `print("$x$")` 的正文，保护后仍为 `Use ` + 反引号 + `print("⟦MATH_001⟧")` + 反引号 + ` here.`，`print` 和外围代码没有被保护。

建议：遵循语法包含关系，优先保护完整代码节点；不能仅依据正则规则顺序决定重叠范围。

## 优化空间

1. **优先优化源文恢复的二次扫描。** [freshness.ts:169](D:/scholar-bridge/src/translation/freshness.ts:169) 为每个候选后缀重新 `slice`、`join`、归一化和散列。在本机 Node.js 22 下，长连续文本末行对应译文的最小用例，1,000 行约 60 ms、2,000 行约 238 ms、4,000 行约 946 ms。它在编辑器主线程执行。建议记录可恢复的源块边界并缩小搜索范围，避免对每个后缀重复处理全部文本。

2. **超长单段应受上下文预算约束。** [translator.ts:175](D:/scholar-bridge/src/translation/translator.ts:175) 只拆分块的集合，单块超过预算时仍完整发送。建议根据上下文空间和预计输出长度拆分长段，并保留可正确写回的源位置；这项需要结合实际模型验证。

3. **设置持久化应去抖并串行化。** [settings-tab.ts:48](D:/scholar-bridge/src/settings/settings-tab.ts:48) 等输入回调在逐字符修改时调用保存，且不等待保存结果。建议统一管理保存队列和错误提示，减少完整缓存随设置反复序列化的次数。

4. **补齐编辑器工作流测试。** 当前单元测试对解析、缓存、HTTP 和进程管理覆盖较多，但未覆盖命令到预览再到真实写入方法的组合。优先增加部分成功重译、拒绝新增、畸形标记、重复点击、文件重名及推理期间修改原文的测试。不要只验证辅助数组函数。

## 修复前验证记录

- 使用临时 Node.js 22.23.5 运行，匹配仓库规定的 Node.js 22 主版本。
- `npm test`：15 个文件、219 项测试全部通过。
- `npm run build`：类型检查和生产构建通过。
- [临时诊断脚本](D:/scholar-bridge/node_modules/.cache/scholar-bridge-review/probes.mjs)：21 项期望契约检查均复现相应问题；脚本中输出 `FAIL` 表示当前实现违反对应期望，并非已有测试套件失败。
- 诊断使用实际项目实现，编辑器、视图和 Vault 接口采用最小替身；没有启动真实模型，也没有在真实 Obsidian Vault 中进行写入测试。
- 保留了用户已有的未跟踪 `AGENTS.md`。本次新增本报告，诊断脚本及运行依赖位于忽略目录；产品源码和现有测试保持原样。
