import { describe, expect, it } from "vitest";
import { parseGlossaryYaml } from "../../src/settings/glossary-yaml";
import {
  planProjectExport,
  buildMainTex,
  sectionBasenames,
  latexInputName,
} from "../../src/export/project-export-plan";

describe("glossary YAML import (M9, TECHNICAL_DESIGN §16)", () => {
  it("parses the documented nested form", () => {
    const yaml = `
FedContra:
  action: preserve

federated learning:
  zh: 联邦学习

backbone:
  zh: 主干网络
`;
    const { entries, skipped } = parseGlossaryYaml(yaml);
    expect(skipped).toHaveLength(0);
    expect(entries).toEqual({
      FedContra: "preserve",
      "federated learning": "联邦学习",
      backbone: "主干网络",
    });
  });

  it("normalizes any-case preserve and prefers zh over en", () => {
    const yaml = `
GPU:
  action: Preserve
model:
  en: model en
  zh: 模型
`;
    const { entries } = parseGlossaryYaml(yaml);
    expect(entries.GPU).toBe("preserve");
    expect(entries.model).toBe("模型");
  });

  it("tolerates a flat `term: translation` line and comments", () => {
    const yaml = `
# comment
tensor: 张量
quoted term: "值"
`;
    const { entries, skipped } = parseGlossaryYaml(yaml);
    expect(skipped).toHaveLength(0);
    expect(entries).toEqual({ tensor: "张量", "quoted term": "值" });
  });

  it("reports terms without usable attributes instead of dropping them silently", () => {
    const yaml = `
broken:
  unrelated: x
`;
    const { entries, skipped } = parseGlossaryYaml(yaml);
    expect(entries).toEqual({});
    expect(skipped).toHaveLength(1);
    expect(skipped[0]).toContain("broken");
  });

  it("keeps values containing hashes (LaTeX escapes) intact", () => {
    // `#` without preceding whitespace is part of the value (C#/F# style);
    // a ` # ` comment must be quoted per YAML semantics.
    const yaml = `
lang:
  zh: C# 与 F#
note:
  zh: "值 # 不是注释"
`;
    const { entries } = parseGlossaryYaml(yaml);
    expect(entries.lang).toBe("C# 与 F#");
    expect(entries.note).toBe("值 # 不是注释");
  });
});

describe("project export planning (M11)", () => {
  it("plans latex/main.tex + sections/*.tex under the folder", () => {
    const plan = planProjectExport("paper", ["abstract", "introduction"]);
    expect(plan.outDir).toBe("paper/latex");
    expect(plan.sectionsDir).toBe("paper/latex/sections");
    expect(plan.mainTex).toBe("paper/latex/main.tex");
    expect(plan.sectionFiles).toEqual([
      "paper/latex/sections/abstract.tex",
      "paper/latex/sections/introduction.tex",
    ]);
  });

  it("builds main.tex with the union of packages and one input per section", () => {
    const tex = buildMainTex("ctexart", ["graphicx", "booktabs"], ["abstract", "method"]);
    expect(tex).toBe(
      [
        "\\documentclass{ctexart}",
        "\\usepackage{graphicx}",
        "\\usepackage{booktabs}",
        "\\begin{document}",
        "\\input{sections/abstract}",
        "\\input{sections/method}",
        "\\end{document}",
        "",
      ].join("\n"),
    );
  });

  it("de-duplicates colliding section basenames with numeric suffixes", () => {
    const names = sectionBasenames([{ basename: "method" }, { basename: "method" }, { basename: "intro" }]);
    expect(names).toEqual(["method", "method-2", "intro"]);
  });

  it("quotes \\input names containing spaces or non-ASCII (R3 P3-1)", () => {
    // Example-vault titles: unquoted, pre-2020 TeX cuts "Translation Demo"
    // at the space and pdfTeX chokes on non-ASCII bytes.
    expect(latexInputName("abstract")).toBe("sections/abstract");
    expect(latexInputName("Translation Demo")).toBe('"sections/Translation Demo"');
    expect(latexInputName("未命名")).toBe('"sections/未命名"');
  });

  it("buildMainTex emits the quoted form for such names", () => {
    const tex = buildMainTex("article", [], ["abstract", "Translation Demo"]);
    expect(tex).toContain("\\input{sections/abstract}\n");
    expect(tex).toContain('\\input{"sections/Translation Demo"}\n');
  });
});
