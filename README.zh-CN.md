[English](./README.md) | 简体中文

# ScholarBridge

面向 [Obsidian](https://obsidian.md) 的学术写作桥接插件：LaTeX ↔ Markdown 转换、公式感知的对比（diff）、以及完全本地化的 AI 翻译。

## 功能

### LaTeX ↔ Markdown 转换

- 将选中文本或粘贴的 LaTeX 通过共享中间表示（Scholar IR）进行转换，双向往返结果可预期。
- 支持常见学术结构：`equation`、`align`、`gather`、`multline`，表格（`tabular` 配合 `booktabs`/`multirow`/`multicolumn`），figure，algorithm/algorithmic，列表、引用和 verbatim 代码块。
- 刻意保守的设计：语法范围之外的内容**原样保留**，解析不确定时绝不改写你的原文。
- 可将当前笔记导出为 `.tex`、将整个文件夹导出为片段，或执行项目导出（生成 `latex/main.tex` + `latex/sections/*.tex`）。

### 公式感知的对比

- 逐块对比两个笔记（或笔记与任意其他版本），分词器同时理解中文、英文和数学公式。
- 表格按行对比；每处修改都可以单独接受或拒绝，并且只有当原块仍然匹配时才会写入——绝不近似改写。

### 本地翻译（llama.cpp）

- 中英互译选区、段落、小节，或只翻译自上次以来变更的块，翻译时自动保护数学公式、代码和链接。
- 基于 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server`：**一切都在你的电脑上运行**，不会向任何云服务发送数据。
- 每次翻译都会先预览再写入：可插入到下方、替换原文，或创建译文副本。
- 支持术语表（`术语 => 译文`；`术语 => preserve` 表示保持原文不译）与 YAML 导入，并内置持久化 LRU 翻译缓存，重跑瞬时完成。

## 环境要求

- Obsidian 1.5.0 或更高版本，**仅限桌面端**（翻译功能需要管理本地进程，移动端无法支持）。
- 翻译功能需要 [llama.cpp](https://github.com/ggml-org/llama.cpp) 的 `llama-server` 可执行文件和 GGUF 模型——也可以连接到你已经在运行的任意 `llama-server` 实例。

## 安装

**从社区插件市场安装**（上架后）：设置 → 第三方插件 → 浏览 → 搜索 "ScholarBridge"。

**手动安装**：将 `manifest.json`、`main.js`、`styles.css` 复制到 `<仓库>/.obsidian/plugins/scholar-bridge/`，然后在 设置 → 第三方插件 中启用。

## 翻译快速上手

1. 下载或编译 llama.cpp，打开 设置 → ScholarBridge，填入：
   - `llama-server` 可执行文件路径，
   - GGUF 模型路径，
   - 主机/端口（默认 `127.0.0.1:8080`）。
2. 运行命令 **ScholarBridge：启动本地翻译服务**。插件会替你启动 `llama-server`，闲置时或关闭 Obsidian 时自动停止。
   - 将可执行文件路径留空即为"仅连接"模式：把主机/端口指向你自己启动的服务即可。
3. 选中文字，运行 **ScholarBridge：翻译选中内容**（或在命令面板中选择翻译段落/小节）。在预览中确认后再应用。

## 隐私

所有转换、对比和翻译全部在本地完成。插件只会向你配置的 llama-server 主机（默认 `127.0.0.1`）发起 HTTP 请求，不收集、不上传任何遥测数据。

## 已知限制

- LaTeX 解析器刻意保守：不支持的宏/环境会原样保留，而不是强行转换。
- 不识别 Setext 风格标题（`Title` 下方用 `===`/`---` 下划线）；请使用 ATX 标题（`#`、`##`）。
- 公式 diff 是词法层面的——只标出差异，不证明数学等价。
- 对比在主线程上运行；超过约 100,000 字符的块会整体报告为一次替换。
- 过旧的 llama.cpp 版本使用的 `llama-server` 命令行参数可能不同，需要相应调整配置。

## 开发

```bash
npm install
npm run dev       # esbuild watch
npm run build     # 类型检查 + 生产构建 → main.js
npm test          # vitest 单元 + fixture + mock-server 测试
```

## 许可证

[MIT](./LICENSE)
