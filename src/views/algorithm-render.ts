import { MarkdownRenderChild, MarkdownRenderer, type MarkdownPostProcessorContext } from "obsidian";
import type ScholarBridgePlugin from "../main";
import { t } from "../i18n";

/**
 * Pretty renderer for ```scholar-algorithm fences (converted \begin{algorithm}
 * bodies). Presentation only — the fence source stays verbatim so the LaTeX
 * export round-trip is untouched, mirroring how a LaTeX algorithm float looks:
 * top/bottom rules, a small-caps caption, numbered lines, bold control-flow
 * keywords and real MathJax for inline $…$ math.
 */

interface AlgoLine {
  indent: number;
  /** Bold control keyword (for / while / end if / return / ▷ …), or null. */
  keyword: string | null;
  /** Remainder after the keyword, still carrying LaTeX/markdown-ish markup. */
  rest: string;
  /** Trailing keyword such as the "do"/"then" of \FOR{…}/\IF{…}. */
  suffix: string | null;
}

function parseLine(raw: string): AlgoLine {
  const indent = Math.round((raw.length - raw.trimStart().length) / 2);
  const s = raw.trim();
  const kw = (keyword: string, rest: string, suffix: string | null = null): AlgoLine => ({
    indent,
    keyword,
    rest,
    suffix,
  });
  const plain = (rest: string): AlgoLine => ({ indent, keyword: null, rest, suffix: null });

  let m: RegExpExecArray | null;
  if ((m = /^\\(?:FOR|For)\s*\{(.+)\}$/.exec(s))) return kw("for", m[1], "do");
  if ((m = /^\\(?:WHILE|While)\s*\{(.+)\}$/.exec(s))) return kw("while", m[1], "do");
  if ((m = /^\\(?:IF|If)\s*\{(.+)\}$/.exec(s))) return kw("if", m[1], "then");
  if ((m = /^\\(?:ELSIF|Elsif)\s*\{(.+)\}$/.exec(s))) return kw("else if", m[1], "then");
  if (/^\\ELSE\b/.exec(s)) return kw("else", "");
  if (/^\\ENDIF\b/.exec(s)) return kw("end if", "");
  if (/^\\ENDFOR\b/.exec(s)) return kw("end for", "");
  if (/^\\ENDWHILE\b/.exec(s)) return kw("end while", "");
  if (/^\\(?:ENDFUNCTION|ENDPROCEDURE)\b/.exec(s)) return kw("end function", "");
  if ((m = /^\\(?:FUNCTION|PROCEDURE)\s*\{([^}]*)\}\s*\{(.+)\}$/.exec(s)))
    return kw("function", `**${m[1]}**(${m[2]})`);
  if ((m = /^\\RETURN\s*(.*)$/.exec(s))) return kw("return", m[1]);
  if ((m = /^\\(?:REQUIRE|Require)\b\s*(.*)$/.exec(s))) return kw("Require:", m[1]);
  if ((m = /^\\(?:ENSURE|Ensure)\b\s*(.*)$/.exec(s))) return kw("Ensure:", m[1]);
  if ((m = /^\\COMMENT\s*\{(.+)\}$/.exec(s))) return kw("▷", m[1]);
  if ((m = /^\\(?:STATE|State)\s+(.*)$/.exec(s))) return plain(m[1]);
  // Unknown statement: keep it verbatim (minus a bare \STATE prefix).
  return plain(s.replace(/^\\STATE\s*/i, ""));
}

/** LaTeX-ish inline markup → markdown that MarkdownRenderer understands. */
function inlineToMarkdown(rest: string): string {
  return rest
    .replace(/\\textbf\s*\{([^}]*)\}/g, "**$1**")
    .replace(/\\(?:textit|emph)\s*\{([^}]*)\}/g, "*$1*")
    .replace(/\\(?:CALL|Call)\s*\{([^}]*)\}\s*\{([^}]*)\}/g, "$1($2)")
    .replace(/\\to\b/g, "→")
    .replace(/\\TO\b/g, "→");
}

/** Caption/label live in the scholarbridge meta comment after the fence. */
function findMetaCaption(ctx: MarkdownPostProcessorContext, el: HTMLElement): string | null {
  try {
    const info = ctx.getSectionInfo(el);
    if (!info?.text) return null;
    const m = /<!--\s*scholarbridge\s*\n([\s\S]*?)-->/.exec(info.text);
    if (!m) return null;
    const meta = JSON.parse(m[1]) as { caption?: unknown };
    return typeof meta.caption === "string" && meta.caption ? meta.caption : null;
  } catch {
    return null;
  }
}

async function renderInline(
  plugin: ScholarBridgePlugin,
  component: MarkdownRenderChild,
  sourcePath: string,
  holder: HTMLElement,
  markdown: string,
): Promise<void> {
  const tmp = createDiv();
  await MarkdownRenderer.render(plugin.app, markdown, tmp, sourcePath, component);
  // Unwrap the generated <p> so the line stays one flex row.
  holder.append(...Array.from(tmp.childNodes));
}

export function registerAlgorithmRendering(plugin: ScholarBridgePlugin): void {
  plugin.registerMarkdownCodeBlockProcessor(
    "scholar-algorithm",
    async (source: string, el: HTMLElement, ctx: MarkdownPostProcessorContext) => {
      try {
        // Ties the rendered children to the post-processor lifecycle.
        const component = new MarkdownRenderChild(el);
        ctx.addChild(component);
        const block = el.createDiv({ cls: "scholar-bridge-algo" });

        const header = block.createDiv({ cls: "scholar-bridge-algo-header" });
        header.createSpan({ cls: "scholar-bridge-algo-name", text: t("Algorithm") });
        const caption = findMetaCaption(ctx, el);
        if (caption) {
          header.createSpan({ cls: "scholar-bridge-algo-caption", text: caption });
        }

        const body = block.createDiv({ cls: "scholar-bridge-algo-body" });
        for (const raw of source.split("\n")) {
          if (!raw.trim()) continue;
          const line = parseLine(raw);
          const row = body.createDiv({ cls: "scholar-bridge-algo-line" });
          if (line.indent > 0) row.style.paddingLeft = `${3.2 + line.indent * 1.5}em`;
          if (line.keyword) row.createSpan({ cls: "scholar-bridge-algo-kw", text: line.keyword });
          if (line.rest) {
            const holder = row.createSpan({ cls: "scholar-bridge-algo-text" });
            await renderInline(plugin, component, ctx.sourcePath, holder, inlineToMarkdown(line.rest));
          }
          if (line.suffix) row.createSpan({ cls: "scholar-bridge-algo-kw", text: line.suffix });
        }
      } catch {
        // Never break the document render: fall back to a plain code block.
        el.empty();
        const pre = el.createEl("pre");
        pre.createEl("code", { text: source });
      }
    },
  );
}
