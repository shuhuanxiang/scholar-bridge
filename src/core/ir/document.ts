import type {
  ScholarBlockNode,
  ScholarDocument,
  ScholarInlineNode,
} from "./nodes";

/**
 * Deterministic, document-order node ids (`p_3`, `m_7`, …).
 * Parsers allocate ids while walking the source top-to-bottom, so the same
 * input always yields the same id assignment (IMPLEMENTATION_PLAN.md rule 5–6).
 */
const BLOCK_PREFIX: Record<string, string> = {
  heading: "h",
  paragraph: "p",
  list: "l",
  "list-item": "li",
  quote: "q",
  code: "c",
  math: "m",
  table: "t",
  figure: "f",
  algorithm: "a",
  "raw-latex": "r",
  "raw-html": "html",
  "translation-block": "tr",
};

export class IdAllocator {
  private counter = 0;

  prefix(type: string): string {
    return BLOCK_PREFIX[type] ?? "n";
  }

  next(type: string): string {
    this.counter += 1;
    return `${this.prefix(type)}_${this.counter}`;
  }

  /** Inline nodes are not referenced by id in v0.1. */
  inline(): string {
    return "";
  }
}

export function makeDocument(
  children: ScholarBlockNode[],
  metadata?: Record<string, unknown>,
): ScholarDocument {
  return { type: "document", children, ...(metadata ? { metadata } : {}) };
}

export function isBlockNode(n: ScholarBlockNode | ScholarInlineNode): n is ScholarBlockNode {
  return ![
    "text",
    "inline-math",
    "code-span",
    "inline-raw",
    "strong",
    "emph",
    "link",
    "citation",
  ].includes(n.type);
}

/** Depth-first iteration over all nodes (blocks and inline). */
export function* walkNodes(doc: ScholarDocument): Generator<ScholarBlockNode | ScholarInlineNode> {
  function* walkNode(node: ScholarBlockNode | ScholarInlineNode): Generator<ScholarBlockNode | ScholarInlineNode> {
    yield node;
    switch (node.type) {
      case "heading":
      case "paragraph":
        for (const child of node.children) yield* walkNode(child);
        break;
      case "list":
        for (const item of node.items) {
          yield item;
          for (const child of item.children) yield* walkNode(child);
        }
        break;
      case "quote":
        for (const child of node.children) yield* walkNode(child);
        break;
      case "table":
        for (const row of node.rows) {
          for (const cell of row) {
            for (const child of cell.content) yield* walkNode(child);
          }
        }
        break;
      default:
        break;
    }
  }
  for (const child of doc.children) yield* walkNode(child);
}

/** Convenience inline constructors (ids left empty by design). */
export const inline = {
  text(text: string): ScholarInlineNode {
    return { id: "", type: "text", text };
  },
  math(latex: string): ScholarInlineNode {
    return { id: "", type: "inline-math", latex };
  },
  codeSpan(code: string): ScholarInlineNode {
    return { id: "", type: "code-span", code };
  },
  strong(children: ScholarInlineNode[]): ScholarInlineNode {
    return { id: "", type: "strong", children };
  },
  emph(children: ScholarInlineNode[]): ScholarInlineNode {
    return { id: "", type: "emph", children };
  },
  link(kind: "url" | "wikilink", target: string, alias?: string, title?: string): ScholarInlineNode {
    return {
      id: "",
      type: "link",
      kind,
      target,
      ...(alias !== undefined ? { alias } : {}),
      ...(title !== undefined ? { title } : {}),
    };
  },
  citation(raw: string, keys: string[]): ScholarInlineNode {
    return { id: "", type: "citation", raw, keys };
  },
};
