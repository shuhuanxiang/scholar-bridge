# Repository Guidelines

## Project Structure & Module Organization

ScholarBridge is a desktop Obsidian plugin. `src/main.ts` handles plugin lifecycle and feature registration.

- `src/core/`: shared Scholar IR, LaTeX/Markdown parsers, and writers.
- `src/diff/`, `src/translation/`, `src/export/`: comparison, local translation, and project exports.
- `src/editor/`, `src/views/`, `src/settings/`, `src/i18n.ts`: commands, UI, configuration, and localization.
- `tests/unit/`: automated tests; `tests/fixtures/latex/` and `tests/fixtures/markdown/`: conversion samples.
- Root `styles.css` and `manifest.json`: plugin styling and metadata.

## Build, Test, and Development Commands

Use Node.js 22, matching the release workflow, and npm.

- `npm ci`: install dependencies from the lockfile.
- `npm run dev`: watch sources and rebuild `main.js` with inline source maps.
- `npm run typecheck`: check TypeScript without emitting files.
- `npm test`: run the full Vitest suite once.
- `npm run test:watch`: rerun tests during development.
- `npm run build`: typecheck and generate the minified production bundle.

For manual testing, copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/scholar-bridge/`, then reload the plugin. Generated `main.js` and source maps are ignored; do not commit them.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, double quotes, and semicolons. Follow existing kebab-case filenames, camelCase functions and variables, PascalCase types and classes, and UPPER_SNAKE_CASE constants. No dedicated formatter or linter is configured; match surrounding code.

## Testing Guidelines

Vitest uses `happy-dom`. Name files `tests/unit/<feature>.test.ts` and write descriptive `describe`/`it` cases. Add focused regressions for fixes and fixtures for conversion changes. Translation tests use local HTTP mocks and process doubles; no model is required. No coverage threshold is configured. Run `npm test` and `npm run build` before submitting.

## Commit & Pull Request Guidelines

Recent commits use `fix:`, `chore:`, and `docs:` prefixes. Follow that concise format, for example `fix: preserve equation labels`. Keep PRs focused; describe behavior changes, link relevant issues, report validation results, and include screenshots for visible UI changes. Update both READMEs when usage changes.

## Architecture & Data Preservation

Route conversions through Scholar IR. Preserve unsupported syntax verbatim. Require translation previews before writes and retain stale-source checks when applying edits. Keep translation local by default, using the configured llama-server endpoint (`127.0.0.1:8080`).
