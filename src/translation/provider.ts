/**
 * Translation provider abstraction (TECHNICAL_DESIGN.md §10.4).
 *
 * llama.cpp must stay behind this interface so future providers can be added
 * without rewriting the translation system (IMPLEMENTATION_PLAN.md rule 2).
 */

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface TranslationRequestBlock {
  id: string;
  text: string;
}

export interface TranslationRequest {
  blocks: TranslationRequestBlock[];
  sourceLanguage: string;
  targetLanguage: string;
  style: string;
  temperature?: number;
}

export interface TranslationResultBlock {
  id: string;
  translation: string;
}

export interface TranslationResult {
  blocks: TranslationResultBlock[];
  raw: string;
  model: string;
}

export interface TranslationProvider {
  /** Quick reachability/model-readiness probe. */
  health(): Promise<boolean>;
  /** Translate a batch of protected blocks. */
  translate(req: TranslationRequest, signal?: AbortSignal): Promise<TranslationResult>;
}

export type ProviderErrorKind =
  | "unavailable"  // connection refused / DNS
  | "timeout"
  | "aborted"      // caller cancelled via AbortSignal (not a server fault)
  | "http"         // non-2xx
  | "malformed"    // unusable body
  | "config";

export class ProviderError extends Error {
  kind: ProviderErrorKind;
  status?: number;

  constructor(kind: ProviderErrorKind, message: string, status?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.status = status;
  }
}
