/**
 * Text tokenization for CJK / English / mixed prose (TECHNICAL_DESIGN.md §9.2).
 *
 * Strategy: classify Unicode spans, segment CJK with the zh-CN word
 * segmenter, segment Latin text into words, keep punctuation separate.
 * Character-level fallback where Intl.Segmenter is unavailable.
 */

export type TokenLang = "zh" | "en" | "num" | "punct" | "space" | "other";

export interface TextToken {
  text: string;
  lang: TokenLang;
}

export interface TextDiffOptions {
  ignoreWhitespace?: boolean;
  caseSensitive?: boolean;
  /** Terms that must stay atomic (protected academic tokens). */
  atomicTerms?: string[];
}

const CJK = /[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF\u3040-\u30FF\uAC00-\uD7AF]/;
const LATIN = /[A-Za-z0-9]/;
const hasSegmenter = typeof Intl !== "undefined" && typeof (Intl as never as { Segmenter?: unknown }).Segmenter === "function";

let zhSegmenter: Intl.Segmenter | null | undefined;
let enSegmenter: Intl.Segmenter | null | undefined;

function getSegmenter(locale: string): Intl.Segmenter | null {
  if (!hasSegmenter) return null;
  try {
    return new Intl.Segmenter(locale, { granularity: "word" });
  } catch {
    return null;
  }
}

function segmentWith(locale: string, text: string): string[] {
  if (locale === "zh-CN") {
    zhSegmenter ??= getSegmenter("zh-CN");
    if (!zhSegmenter) return [...text];
    return [...zhSegmenter.segment(text)].map((s) => s.segment);
  }
  enSegmenter ??= getSegmenter("en");
  if (!enSegmenter) return text.match(/[A-Za-z0-9]+|[^A-Za-z0-9]/g) ?? [];
  return [...enSegmenter.segment(text)].map((s) => s.segment);
}

function classifyChar(ch: string): TokenLang {
  if (/\s/.test(ch)) return "space";
  if (CJK.test(ch)) return "zh";
  if (LATIN.test(ch)) return "en";
  if (/[.,;:!?'"()\-—_%$@#&*/\\[\]{}<>|+=~^`，。、；：！？「」『』（）]/.test(ch)) return "punct";
  return "other";
}

/** Split into homogeneous spans before segmentation (mixed text). */
function splitSpans(text: string): { text: string; lang: TokenLang }[] {
  const spans: { text: string; lang: TokenLang }[] = [];
  let current = "";
  let currentLang: TokenLang | null = null;
  const bucketOf = (lang: TokenLang): TokenLang => (lang === "num" ? "en" : lang);
  for (const ch of text) {
    const lang = classifyChar(ch);
    const bucket = bucketOf(lang);
    if (currentLang === null) {
      currentLang = bucket;
      current = ch;
      continue;
    }
    if (bucket === currentLang) {
      current += ch;
    } else {
      spans.push({ text: current, lang: currentLang });
      current = ch;
      currentLang = bucket;
    }
  }
  if (current) spans.push({ text: current, lang: currentLang ?? "other" });
  return spans;
}

/** Tokenize a prose string into comparable word tokens. */
export function tokenizeText(text: string, opts: TextDiffOptions = {}): TextToken[] {
  const atomicMatchers = (opts.atomicTerms ?? [])
    .filter((t) => t.length > 0)
    .map((t) => ({ term: t, lower: t.toLowerCase() }));

  const tokens: TextToken[] = [];
  for (const span of splitSpans(text)) {
    if (span.lang === "zh") {
      for (const piece of segmentWith("zh-CN", span.text)) {
        tokens.push({ text: piece, lang: "zh" });
      }
    } else if (span.lang === "en") {
      for (const piece of segmentWith("en", span.text)) {
        const lang: TokenLang = /^[0-9]+$/.test(piece) ? "num" : /[A-Za-z]/.test(piece) ? "en" : "punct";
        tokens.push({ text: piece, lang });
      }
    } else {
      // whitespace/punct/other: keep characters as tokens
      for (const piece of [...span.text]) {
        tokens.push({ text: piece, lang: span.lang === "space" ? "space" : langOfChar(span.lang, piece) });
      }
    }
  }

  // Merge atomic terms so protected academic tokens never split.
  return mergeAtomic(tokens, atomicMatchers);
}

function langOfChar(spanLang: TokenLang, ch: string): TokenLang {
  if (spanLang === "space") return "space";
  const c = classifyChar(ch);
  return c === "other" ? spanLang : c;
}

function mergeAtomic(tokens: TextToken[], matchers: { term: string; lower: string }[]): TextToken[] {
  if (!matchers.length) return tokens;
  const out: TextToken[] = [];
  let i = 0;
  while (i < tokens.length) {
    let matched = false;
    for (const m of matchers) {
      const parts = m.term.split(/\s+/).length;
      // try to match the term's token sequence
      const seq: TextToken[] = [];
      let j = i;
      let consumed = "";
      while (j < tokens.length && consumed.length < m.term.length * 2 && seq.length <= parts + 2) {
        seq.push(tokens[j]);
        consumed += tokens[j].text;
        j++;
        const normalized = consumed.toLowerCase().replace(/\s+/g, " ");
        if (normalized === m.lower) {
          out.push({ text: seq.map((s) => s.text).join(""), lang: "en" });
          i = j;
          matched = true;
          break;
        }
        if (normalized.replace(/\s/g, "") === m.lower.replace(/\s/g, "")) {
          out.push({ text: seq.map((s) => s.text).join(""), lang: "en" });
          i = j;
          matched = true;
          break;
        }
      }
      if (matched) break;
    }
    if (!matched) {
      out.push(tokens[i]);
      i++;
    }
  }
  return out;
}

/** Normalized comparable form used for equality (options-aware). */
export function tokenKey(token: TextToken, opts: TextDiffOptions = {}): string {
  let text = token.text;
  if (opts.ignoreWhitespace && token.lang === "space") return " ";
  if (!opts.caseSensitive) text = text.toLowerCase();
  return text;
}

/** Concatenate token texts back to a display string. */
export function tokensToString(tokens: TextToken[]): string {
  return tokens.map((t) => t.text).join("");
}
