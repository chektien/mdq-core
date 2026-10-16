import { DECK_STYLE_KEYS, FONT_SIZE_ROLES, resolveDeckStyleSetting, type DeckStyle, type DeckStyleSettings } from "./deck-style";
import { normalizeDeckSettingKeys } from "./setting-keys";

export interface DeckStyleHeaderLine { key: string; value: string; line: number }
export interface DeckStyleHeaderProblem { key: string; line: number; message: string }
export interface DeckStyleHeader {
  settings: DeckStyleSettings;
  style: DeckStyle;
  lines: Map<string, DeckStyleHeaderLine>;
  warnings: DeckStyleHeaderProblem[];
  shadowed: (DeckStyleHeaderLine & { winner: string; winnerLine: number })[];
}

/** Read exactly the parser's preamble and first occurrence of each key.
 * Resolve font roles before emitting properties, so an older exact length cannot
 * override a valid new scale. Invalid new keys fall back without hiding warnings.
 * Reading never changes the source and valid older decks gain no warnings.
 */
export function readDeckStyleHeader(source: string): DeckStyleHeader {
  const markdown = normalizeDeckSettingKeys(source);
  const preamble = markdown.split(/^---+\s*$/m, 1)[0] || markdown;
  const accepted = new Map<string, DeckStyleHeaderLine & { style: DeckStyle }>();
  const warnings: DeckStyleHeaderProblem[] = [];
  for (const key of DECK_STYLE_KEYS) {
    const match = preamble.match(new RegExp(`^${key.replace(/-/g, "_")}:[ \t]*(.*?)\\s*$`, "im"));
    if (!match) continue;
    const line = preamble.slice(0, match.index).split("\n").length;
    const result = resolveDeckStyleSetting(key, match[1]);
    if (result.ok) accepted.set(key, { key, value: result.value, line, style: result.style });
    else warnings.push({ key, line, message: result.message });
  }
  const shadowed: DeckStyleHeader["shadowed"] = [];
  for (const [human, older] of FONT_SIZE_ROLES) {
    const winner = accepted.get(human);
    const previous = accepted.get(older);
    if (winner && previous) {
      shadowed.push({ key: older, value: previous.value, line: previous.line, winner: human, winnerLine: winner.line });
      accepted.delete(older);
    }
  }
  const settings: DeckStyleSettings = {};
  const style: DeckStyle = {};
  const lines: DeckStyleHeader["lines"] = new Map();
  for (const [key, entry] of accepted) {
    settings[key] = entry.value;
    Object.assign(style, entry.style);
    lines.set(key, { key, value: entry.value, line: entry.line });
  }
  warnings.sort((a, b) => a.line - b.line);
  return { settings, style, lines, warnings, shadowed };
}
