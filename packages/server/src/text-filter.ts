/** A modest deterministic filter, shared by every transport that runs the engine. */
export const BLOCKED_LANGUAGE_MESSAGE = "Please revise your response and remove inappropriate language.";

// Deliberately omit ambiguous short terms such as "ass" and "dick". Matching
// whole terms avoids rejecting classroom words such as class or assessment.
export const BLOCKED_TERMS: readonly string[] = [
  "fuck", "fucks", "fucking", "fucked", "fucker", "fuckers", "motherfucker",
  "shit", "shits", "shitty", "bullshit", "bitch", "bitches", "bastard",
  "cunt", "cunts", "asshole", "assholes", "dickhead",
  "cheebye", "chibai", "lanjiao", "pukimak", "kanina", "nabei", "knn", "kns",
];

/** Normalization is for matching only. Accepted text is never rewritten. */
export function normalizeFilterText(text: string): string {
  return text.normalize("NFKC").toLowerCase();
}

/**
 * Compile once, then reuse for any text input. Punctuation, whitespace and
 * format characters between letters cannot evade an otherwise whole-term match.
 * No substring matching or remote moderation service is involved.
 */
export function createBlockedTextMatcher(terms: readonly string[]): (text: string) => boolean {
  const patterns = terms.map(term => {
    const normalized = normalizeFilterText(term).replace(/[\s\p{P}\p{Cf}]+/gu, "");
    if (!/^[\p{L}\p{N}]+$/u.test(normalized)) throw new Error("Blocked terms must contain letters or numbers.");
    return [...normalized].join("[\\s\\p{P}\\p{Cf}]*");
  });
  if (!patterns.length) return () => false;
  const pattern = new RegExp(`(?<![\\p{L}\\p{N}])(?:${patterns.join("|")})(?![\\p{L}\\p{N}])`, "u");
  return text => pattern.test(normalizeFilterText(text));
}

export const containsBlockedLanguage = createBlockedTextMatcher(BLOCKED_TERMS);
