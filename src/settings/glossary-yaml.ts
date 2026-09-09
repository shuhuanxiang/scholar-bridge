/**
 * Glossary YAML import (TECHNICAL_DESIGN.md §16, IMPLEMENTATION_PLAN.md M9).
 *
 * Accepts the documented nested form:
 *
 *   FedContra:
 *     action: preserve
 *
 *   federated learning:
 *     zh: 联邦学习
 *
 * and tolerates a flat `term: translation` line when nothing is nested below
 * it. Comments (`#`) and blank lines are ignored. Entries whose attributes do
 * not yield a translation (or a `preserve` action) are skipped — a partial
 * import must never silently drop or corrupt the existing glossary.
 */

/** Attribute keys that may carry the fixed translation, in priority order. */
const TRANSLATION_KEYS = ["zh", "en", "translation", "target"];

export interface YamlImportResult {
  /** term -> translation (or "preserve"), ready to merge into settings. */
  entries: Record<string, string>;
  /** Human-readable problems for entries that were skipped. */
  skipped: string[];
}

export function parseGlossaryYaml(text: string): YamlImportResult {
  const entries: Record<string, string> = {};
  const skipped: string[] = [];

  // Split into (indent, content) lines; strip a full-line or trailing comment
  // only when `#` is preceded by whitespace or starts the line, so terms or
  // values containing `#` (e.g. LaTeX `\#`) survive.
  const lines: { indent: number; content: string; lineNo: number }[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const withoutComment = stripComment(raw);
    const trimmed = withoutComment.trim();
    if (!trimmed || trimmed === ":") return;
    const indent = withoutComment.length - withoutComment.trimStart().length;
    lines.push({ indent, content: trimmed.replace(/:\s*$/, ":"), lineNo: i + 1 });
  });

  let currentTerm: string | null = null;
  let currentAttrs: Record<string, string> = {};

  const flush = () => {
    if (currentTerm === null) return;
    const value = resolveAttrs(currentAttrs);
    if (value === undefined) {
      skipped.push(
        `“${currentTerm}”: no usable attribute (expected “action: preserve” or one of ${TRANSLATION_KEYS.join("/")})`,
      );
    } else {
      entries[currentTerm] = value;
    }
    currentTerm = null;
    currentAttrs = {};
  };

  for (let i = 0; i < lines.length; i++) {
    const { indent, content, lineNo } = lines[i];
    const colon = content.indexOf(":");
    if (colon <= 0) {
      skipped.push(`line ${lineNo}: not a “key: value” mapping — ignored`);
      continue;
    }
    const key = unquote(content.slice(0, colon).trim());
    const value = unquote(content.slice(colon + 1).trim());

    if (indent === 0) {
      flush();
      if (value) {
        // Flat form: `term: translation` with nothing nested below.
        const next = lines[i + 1];
        if (!next || next.indent === 0) {
          entries[key] = normalizeValue(value);
        } else {
          // A nested block follows; treat the value as an `action` attribute.
          currentTerm = key;
          currentAttrs = { action: value };
        }
      } else {
        currentTerm = key;
        currentAttrs = {};
      }
      continue;
    }

    // Indented attribute of the current term.
    if (currentTerm === null) {
      skipped.push(`line ${lineNo}: indented entry without a term — ignored`);
      continue;
    }
    currentAttrs[key.toLowerCase()] = value;
  }
  flush();

  return { entries, skipped };
}

/** Pick the translation (or preserve) from a term's attribute set. */
function resolveAttrs(attrs: Record<string, string>): string | undefined {
  const action = (attrs.action ?? "").toLowerCase();
  if (action === "preserve") return "preserve";
  for (const key of TRANSLATION_KEYS) {
    const value = attrs[key];
    if (value) return normalizeValue(value);
  }
  return undefined;
}

/** protector.ts treats any-case "preserve" as keep-verbatim; normalize it. */
function normalizeValue(value: string): string {
  return value.toLowerCase() === "preserve" ? "preserve" : value;
}

function stripComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i);
    }
  }
  return line;
}

function unquote(value: string): string {
  if (value.length >= 2) {
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1);
    }
  }
  return value;
}
