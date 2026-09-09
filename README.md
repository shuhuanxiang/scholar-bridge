# ScholarBridge

An academic-writing bridge for [Obsidian](https://obsidian.md): LaTeX ↔ Markdown conversion, formula-aware diffing, and fully local AI translation.

## Features

### LaTeX ↔ Markdown conversion

- Convert selected text or pasted LaTeX through a shared intermediate representation (Scholar IR), so both directions round-trip predictably.
- Supports the common academic constructs: `equation`, `align`, `gather`, `multline`, tables (`tabular` with `booktabs`/`multirow`/`multicolumn`), figures, algorithm/algorithmic, lists, quotes, and verbatim blocks.
- Conservative by design: constructs outside the supported grammar are preserved **verbatim**, and uncertain parses never rewrite your source.
- Export the active note to `.tex`, export a whole folder as fragments, or run a project export that writes `latex/main.tex` + `latex/sections/*.tex`.

### Formula-aware diff

- Compare two notes (or a note against any other version) block by block, with tokenization that understands Chinese, English, and math formulas.
- Tables are diffed row by row; each change can be accepted or rejected individually, and a change is only written when its original block still matches — never approximated.

### Local translation (llama.cpp)

- Chinese ↔ English translation of selections, paragraphs, sections, or only the blocks changed since the last pass, with math, code, and links protected from translation.
- Powered by [llama.cpp](https://github.com/ggml-org/llama.cpp)'s `llama-server`: **everything runs on your machine**, nothing is sent to any cloud service.
- Every translation is shown in a preview before anything is written; you can insert below, replace, or create a translated copy.
- Glossary support (`term => translation`, `term => preserve` to keep terms verbatim) with YAML import, plus a persistent LRU translation cache so re-runs are instant.

## Requirements

- Obsidian 1.5.0 or later, **desktop only** (the translation feature manages a local process, which mobile cannot do).
- For translation: a [llama.cpp](https://github.com/ggml-org/llama.cpp) `llama-server` executable and a GGUF model — or any `llama-server` instance you already have running.

## Installation

**From the community plugin directory** (once published): Settings → Community plugins → Browse → search for "ScholarBridge".

**Manual:** copy `manifest.json`, `main.js`, and `styles.css` into `<vault>/.obsidian/plugins/scholar-bridge/`, then enable the plugin in Settings → Community plugins.

## Getting started with translation

1. Download or build llama.cpp, then open Settings → ScholarBridge and set:
   - `llama-server` executable path,
   - GGUF model path,
   - host/port (defaults: `127.0.0.1:8080`).
2. Run the command **ScholarBridge: Start local translator**. The plugin launches `llama-server` for you and shuts it down when idle or when Obsidian closes.
   - Leave the executable path empty to connect-only mode: point host/port at a server you started yourself.
3. Select some text and run **ScholarBridge: Translate selection** (or translate a paragraph/section from the command palette). Review the preview, then apply.

## Privacy

All conversion, diffing, and translation run locally. The plugin performs HTTP requests **only** to the llama-server host you configure (default `127.0.0.1`) and does not collect or send any telemetry.

## Known limitations

- The LaTeX parser is intentionally conservative: unsupported macros/environments pass through verbatim rather than being converted.
- Setext-style headings (`Title\n===`) are not recognized; use ATX headings (`#`, `##`).
- Formula diffs are token-syntactic — they highlight differences but do not prove mathematical equivalence.
- Diffing runs on the main thread; blocks longer than ~100,000 characters are reported as one whole-block replacement.
- Very old llama.cpp builds may use different `llama-server` CLI flags and need configuration adjustments.

## Development

```bash
npm install
npm run dev       # esbuild watch
npm run build     # typecheck + production bundle → main.js
npm test          # vitest unit + fixture + mock-server tests
```

## License

[MIT](./LICENSE)
