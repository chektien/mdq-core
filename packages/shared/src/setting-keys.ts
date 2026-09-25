/**
 * Deck setting keys, written with dashes (`presenter-notes: false`,
 * `time-limit: 60`). Earlier decks wrote them with underscores
 * (`presenter_notes`), and both spellings keep working.
 */
export const DECK_SETTING_KEYS = [
  "title",
  "theme",
  "presenter-notes",
  "presenter-notes-default-open",
  "type",
  "question-type",
  "time-limit",
  "multi-select",
  "media-group",
  "live-url",
  "live-title-overlay",
  "live-interactive",
  "video-card",
  "video-thumbnail",
  "video-caption",
  "video-label",
  "slide-background",
  "slide-background-position",
  "slide-background-size",
] as const;

const UNDERSCORED = new Set<string>(DECK_SETTING_KEYS.map((key) => key.replace(/-/g, "_")));
// `[^\n]*`, not `.*`, so a CRLF line's trailing `\r` is kept and still matches.
const SETTING_LINE = /^(\s*)([A-Za-z]+(?:[-_][A-Za-z]+)*)(\s*:)([^\n]*)$/;
const FENCE = /^\s*(```|~~~)/;

/**
 * The deck with every setting key in the underscored form the parser
 * matches, so dashed and underscored spellings are read the same way. Only a
 * key's `-` separators change (and `open-response` in a `type:` line), so the
 * text keeps its length and every line number and offset is unchanged. Lines
 * inside fenced code and blockquotes are left as written.
 */
export function normalizeDeckSettingKeys(markdown: string): string {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced;
        return line;
      }
      if (fenced || /^\s*>/.test(line)) return line;
      const match = SETTING_LINE.exec(line);
      if (!match) return line;
      const key = match[2].replace(/-/g, "_");
      if (!UNDERSCORED.has(key.toLowerCase())) return line;
      const value = /^(type|question_type)$/i.test(key) ? match[4].replace(/open-response/i, (found) => found.replace("-", "_")) : match[4];
      return `${match[1]}${key}${match[3]}${value}`;
    })
    .join("\n");
}

/** A setting key as authors should write it: `presenter_notes` → `presenter-notes`. */
export function dashedSettingKey(key: string): string {
  return key.replace(/_/g, "-");
}
