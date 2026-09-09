/**
 * Translation placeholder protection (TECHNICAL_DESIGN.md §11).
 *
 * Non-translatable spans (math, code, links, citations, raw commands,
 * glossary-preserved terms) are replaced with ⟦KIND_NNN⟧ placeholders before
 * the text leaves the note, and restored verbatim afterwards. Validation
 * fails loudly if the model drops, duplicates or invents placeholders.
 */

export type ProtectedKind = "MATH" | "CODE" | "LINK" | "CITE" | "TERM" | "RAW";

export interface PlaceholderInfo {
  token: string;
  kind: ProtectedKind;
  value: string;
  /**
   * How many times this token legitimately occurs in the protected text.
   * Glossary "preserve" terms share a single token across every occurrence
   * (a term like "Transformer" normally appears many times in one block), so
   * validation must compare against this count instead of demanding exactly
   * one occurrence. Defaults to 1 when absent.
   */
  expectedCount?: number;
}

export interface ProtectionResult {
  protectedText: string;
  placeholders: PlaceholderInfo[];
}

export interface ProtectOptions {
  /** Glossary entries; value "preserve" protects the term verbatim. */
  glossary?: Record<string, string>;
}

// \d{3,} because generation uses padStart (no truncation); validation must
// still see tokens with more than three digits.
const PLACEHOLDER_RE = /⟦([A-Z]+)_(\d{3,})⟧/g;

interface Rule {
  kind: ProtectedKind;
  re: RegExp;
}

const RULES: Rule[] = [
  // A token-SHAPED literal in the user's own text (⟦MATH_001⟧) must be
  // protected before anything else: unmatched, it reaches the model as prose
  // and its faithful return either fails validation ("unknown placeholder")
  // or gets swapped for a real value on restore — silent corruption
  // (CODE_REVIEW_R2 P2-4). Pattern mirrors PLACEHOLDER_RE exactly.
  { kind: "RAW", re: /⟦[A-Z]+_\d{3,}⟧/g },
  // display/inline math first
  { kind: "MATH", re: /\$\$[\s\S]+?\$\$/g },
  // Inline math mirrors the parser's currency-safe rules (core/parser/
  // markdown/inline.ts): opening $ not followed by whitespace, closing $
  // not preceded by whitespace and not followed by a digit ($5 and $10
  // stays prose).
  { kind: "MATH", re: /\$(?!\s)(?:\\.|[^$\\\n])+?(?<!\s)\$(?!\d)/g },
  { kind: "MATH", re: /\\\([\s\S]+?\\\)/g },
  { kind: "CODE", re: /`[^`\n]+`/g },
  { kind: "LINK", re: /\[\[[^\]\n]+\]\]/g },
  { kind: "LINK", re: /\[[^\]\n]+\]\([^)\n]+\)/g },
  { kind: "LINK", re: /https?:\/\/[^\s)]+/g },
  { kind: "CITE", re: /\\[A-Za-z]*cite[A-Za-z]*\{[^}]*\}/g },
  { kind: "CITE", re: /\[\^[^\]\n]+\]/g },
  { kind: "RAW", re: /\\[A-Za-z]+(\{[^{}]*\})*/g },
];

// Ideographic scripts have no word boundaries: CJK terms must keep matching
// inside compounds (机器学习 inside 监督机器学习).
const CJK_CHAR_RE = /[\u3040-\u30FF\u3400-\u9FFF\uAC00-\uD7AF]/;
// Word characters that form boundaries around Latin/Cyrillic/Greek-style
// terms (letter/digit/underscore; CJK deliberately excluded).
const WORD_CHAR_RE = /[A-Za-z0-9_\u00C0-\u024F\u0370-\u04FF\u1E00-\u1EFF]/;
const LETTER_OR_DIGIT_RE = /[\p{L}\p{N}]/u;

export function protectBlock(text: string, opts: ProtectOptions = {}): ProtectionResult {
  const placeholders: PlaceholderInfo[] = [];
  const counters: Record<string, number> = {};

  const makeToken = (kind: ProtectedKind, value: string): string => {
    counters[kind] = (counters[kind] ?? 0) + 1;
    if (counters[kind] > 999) {
      throw new Error(`too many ${kind} placeholders in one block (>999)`);
    }
    return `⟦${kind}_${String(counters[kind]).padStart(3, "0")}⟧`;
  };

  // All matches become candidate spans in one pass: markup rules first, then
  // glossary "preserve" terms, so a term inside a formula is covered by the
  // formula's span instead of nesting a TERM token that the outer span would
  // swallow (and validation would then demand back).
  const spans: { start: number; end: number; replacement: string }[] = [];
  const overlaps = (start: number, end: number): boolean =>
    spans.some((s) => start < s.end && end > s.start);

  for (const rule of RULES) {
    rule.re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = rule.re.exec(text)) !== null) {
      if (m[0].length === 0) {
        rule.re.lastIndex++;
        continue;
      }
      const start = m.index;
      const end = start + m[0].length;
      if (overlaps(start, end)) continue;
      const token = makeToken(rule.kind, m[0]);
      placeholders.push({ token, kind: rule.kind, value: m[0], expectedCount: 1 });
      spans.push({ start, end, replacement: token });
    }
  }

  const preserveTerms = Object.entries(opts.glossary ?? {})
    .filter(([, action]) => action.trim().toLowerCase() === "preserve")
    .map(([term]) => term)
    .sort((a, b) => b.length - a.length);
  for (const term of preserveTerms) {
    for (const { start, end } of findTermMatches(text, term)) {
      if (overlaps(start, end)) continue;
      const value = text.slice(start, end);
      const existing = placeholders.find((p) => p.kind === "TERM" && p.value === value);
      let token: string;
      if (!existing) {
        token = makeToken("TERM", value);
        placeholders.push({ token, kind: "TERM", value, expectedCount: 1 });
      } else {
        // Same term again: reuse the token and record the extra occurrence so
        // validation accepts a faithful model output that repeats it.
        existing.expectedCount = (existing.expectedCount ?? 1) + 1;
        token = existing.token;
      }
      spans.push({ start, end, replacement: token });
    }
  }

  // Replace strictly right-to-left so earlier offsets stay valid; any other
  // order corrupts the text (and the corruption can still pass validation
  // because every placeholder would still appear exactly once).
  let out = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + span.replacement + out.slice(span.end);
  }

  // Merge placeholders with existing tokens in the result (validation covers
  // duplicates introduced by the model, not by us).
  return { protectedText: out, placeholders };
}

export function restorePlaceholders(text: string, placeholders: PlaceholderInfo[]): string {
  if (placeholders.length === 0) return text;
  // Single left-to-right pass over a combined alternation (CODE_REVIEW_R2
  // P2-3): a restored value is never rescanned, so a value that itself
  // contains another token literal cannot cascade into a second replacement.
  // The old sequential split/join corrupted exactly that case.
  const alternation = placeholders
    .map((p) => p.token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|");
  const byToken = new Map(placeholders.map((p) => [p.token, p.value] as const));
  return text.replace(new RegExp(alternation, "g"), (matched) => byToken.get(matched) ?? matched);
}

export interface ProtectionValidation {
  ok: boolean;
  problems: string[];
}

/**
 * Validate model output before any placeholder restoration:
 * every placeholder must appear exactly as often as it was emitted
 * (glossary terms legitimately repeat), and nothing unknown may appear.
 */
export function validateProtection(
  output: string,
  placeholders: PlaceholderInfo[],
): ProtectionValidation {
  const problems: string[] = [];
  const found = new Map<string, number>();
  for (const m of output.matchAll(PLACEHOLDER_RE)) {
    found.set(m[0], (found.get(m[0]) ?? 0) + 1);
  }
  for (const p of placeholders) {
    const count = found.get(p.token) ?? 0;
    const expected = p.expectedCount ?? 1;
    if (count === 0) problems.push(`placeholder ${p.token} disappeared`);
    else if (count > expected) {
      problems.push(`placeholder ${p.token} duplicated ${count}× (expected ${expected}×)`);
    } else if (count < expected) {
      problems.push(`placeholder ${p.token} appears ${count}×, expected ${expected}×`);
    }
    found.delete(p.token);
  }
  for (const token of found.keys()) {
    problems.push(`unknown placeholder ${token} introduced`);
  }
  return { ok: problems.length === 0, problems };
}

/** Terms from the glossary that actually occur in the text (§16). */
export function relevantGlossary(
  text: string,
  glossary: Record<string, string>,
  opts: { placeholders?: PlaceholderInfo[] } = {},
): Record<string, string> {
  const relevant: Record<string, string> = {};
  for (const [term, action] of Object.entries(glossary)) {
    if (action.trim().toLowerCase() === "preserve") continue; // already protected
    const inOriginal = findTermMatches(text, term).length > 0;
    const inPlaceholders = (opts.placeholders ?? []).some(
      (p) => p.kind === "TERM" && p.value.toLowerCase() === term.toLowerCase(),
    );
    if (inOriginal || inPlaceholders) relevant[term] = action;
  }
  return relevant;
}

function termBoundaryRegex(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(escaped, "gi");
}

/**
 * All occurrences of `term` in `text` that respect script-aware boundaries:
 * when the term's edge character is a letter/digit (non-CJK), the adjacent
 * character must not be a word character, so "AI" never matches inside
 * "said" or "HTML". CJK terms keep substring matching.
 */
function findTermMatches(text: string, term: string): { start: number; end: number }[] {
  const re = termBoundaryRegex(term);
  const matches: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[0].length === 0) {
      re.lastIndex++;
      continue;
    }
    if (termHasBoundary(text, m.index, m.index + m[0].length, term)) {
      matches.push({ start: m.index, end: m.index + m[0].length });
    }
  }
  return matches;
}

function termHasBoundary(text: string, start: number, end: number, term: string): boolean {
  const first = term[0] ?? "";
  const last = term[term.length - 1] ?? "";
  const checkLeft = LETTER_OR_DIGIT_RE.test(first) && !CJK_CHAR_RE.test(first);
  const checkRight = LETTER_OR_DIGIT_RE.test(last) && !CJK_CHAR_RE.test(last);
  if (checkLeft && start > 0 && WORD_CHAR_RE.test(text[start - 1] ?? "")) return false;
  if (checkRight && end < text.length && WORD_CHAR_RE.test(text[end] ?? "")) return false;
  return true;
}
