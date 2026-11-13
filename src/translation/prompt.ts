import type { ChatMessage, TranslationRequest } from "./provider";

/** The request budget and transport use the exact same prompt. */
export function buildTranslationMessages(req: TranslationRequest): ChatMessage[] {
  const system = [
    req.customPrompt?.trim() || "You are a careful academic translator.",
    `Translate from ${req.sourceLanguage} to ${req.targetLanguage}.`,
    "Style: " + req.style + ".",
    ...(req.glossary && Object.keys(req.glossary).length > 0
      ? ["Use these fixed term translations:", JSON.stringify(req.glossary)]
      : []),
    "Rules:",
    "- Preserve every placeholder token (e.g. \u27e6MATH_001\u27e7, \u27e6LINK_001\u27e7) EXACTLY as written.",
    "- Do not translate mathematics, code, citations, or file names.",
    "- Respond with JSON only, in this exact shape:",
    '{"blocks":[{"id":"<block id>","translation":"<translated text>"}]}',
    "- Return one entry for every requested block id, with no extra ids.",
  ].join("\n");
  const user = req.blocks.map((block) => `### BLOCK ${block.id}\n${block.text}`).join("\n\n")
    + "\n\nRespond with the JSON object now.";
  return [{ role: "system", content: system }, { role: "user", content: user }];
}

/** UTF-8 byte counts bound common byte-fallback tokenizers conservatively. */
export function estimateRequestTokens(req: TranslationRequest): number {
  const bytes = (text: string) => new TextEncoder().encode(text).length;
  const input = buildTranslationMessages(req).reduce((total, message) => total + bytes(message.content) + 16, 64);
  const output = req.maxTokens && req.maxTokens > 0 ? req.maxTokens
    : bytes(JSON.stringify({ blocks: req.blocks.map((block) => ({ id: block.id, translation: block.text })) })) * 3 + 64;
  return input + output;
}
