/** Stable source identity shared by translation metadata and legacy exports. */
export function sourceHash(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  let hash = 0x811c9dc5;
  for (let i = 0; i < normalized.length; i++) {
    hash ^= normalized.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16).padStart(8, "0")}_${normalized.length.toString(16)}`;
}
