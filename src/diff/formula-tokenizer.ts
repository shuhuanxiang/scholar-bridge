/**
 * LaTeX formula tokenizer (TECHNICAL_DESIGN.md §9.3).
 *
 * Never diff raw characters: control sequences, identifiers, numbers,
 * operators, braces, sub/superscripts and delimiters are atomic tokens, so
 * `\lambda → \alpha` is one replacement.
 */

export type FormulaTokenType =
  | "control"     // \lambda
  | "ident"       // L
  | "number"      // 0.5
  | "operator"    // + = -
  | "brace"       // { }
  | "script"      // _ ^
  | "delimiter"   // ( ) [ ] |
  | "align"       // &
  | "space"       // whitespace run
  | "other";

export interface FormulaToken {
  text: string;
  type: FormulaTokenType;
}

const OPERATORS = "+-*/=<>!,.;:";
const DELIMITERS = "()[]|";

export function tokenizeFormula(latex: string): FormulaToken[] {
  const tokens: FormulaToken[] = [];
  let i = 0;
  while (i < latex.length) {
    const ch = latex[i];

    if (/\s/.test(ch)) {
      let j = i;
      while (j < latex.length && /\s/.test(latex[j])) j++;
      tokens.push({ text: latex.slice(i, j), type: "space" });
      i = j;
      continue;
    }

    if (ch === "\\") {
      const m = /^\\[A-Za-z]+/.exec(latex.slice(i));
      if (m) {
        tokens.push({ text: m[0], type: "control" });
        i += m[0].length;
      } else {
        // escaped symbol like \{ or \\
        tokens.push({ text: latex.slice(i, i + 2), type: "control" });
        i += 2;
      }
      continue;
    }

    if (ch === "_" || ch === "^") {
      tokens.push({ text: ch, type: "script" });
      i++;
      continue;
    }

    if (ch === "{" || ch === "}") {
      tokens.push({ text: ch, type: "brace" });
      i++;
      continue;
    }

    if (ch === "&") {
      tokens.push({ text: ch, type: "align" });
      i++;
      continue;
    }

    if (/[0-9.]/.test(ch)) {
      let j = i;
      while (j < latex.length && /[0-9.]/.test(latex[j])) j++;
      tokens.push({ text: latex.slice(i, j), type: "number" });
      i = j;
      continue;
    }

    if (/[A-Za-z]/.test(ch)) {
      let j = i;
      while (j < latex.length && /[A-Za-z]/.test(latex[j])) j++;
      tokens.push({ text: latex.slice(i, j), type: "ident" });
      i = j;
      continue;
    }

    if (OPERATORS.includes(ch)) {
      tokens.push({ text: ch, type: "operator" });
      i++;
      continue;
    }

    if (DELIMITERS.includes(ch)) {
      tokens.push({ text: ch, type: "delimiter" });
      i++;
      continue;
    }

    tokens.push({ text: ch, type: "other" });
    i++;
  }
  return mergeTokens(tokens);
}

/** Merge adjacent operator tokens so multi-character operators (`+=`, `<=`,
 *  `!=`, `->`) stay atomic and a formula diff sees one replacement instead of
 *  two noisy single-char edits (CODE_REVIEW_R2 §7 leftover). Runs are merged
 *  only when directly adjacent — a space between operators keeps them apart. */
function mergeTokens(tokens: FormulaToken[]): FormulaToken[] {
  const out: FormulaToken[] = [];
  for (const t of tokens) {
    const prev = out[out.length - 1];
    if (t.type === "operator" && prev && prev.type === "operator") {
      prev.text += t.text;
      continue;
    }
    out.push(t);
  }
  return out;
}

/** Comparable key: whitespace ignored. */
export function formulaTokenKey(token: FormulaToken): string {
  return token.type === "space" ? " " : token.text;
}

/** Tokenize for diff equality: collapse whitespace runs. */
export function formulaDiffTokens(latex: string): FormulaToken[] {
  const tokens = tokenizeFormula(latex);
  return tokens.filter((t) => t.type !== "space" || t.text.includes("\n"));
}
