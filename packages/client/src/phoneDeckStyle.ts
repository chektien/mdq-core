import { safeDeckStyle, type DeckStyle } from "@mdq/shared";

/**
 * How the phone's own question and result screens take the deck's header
 * appearance settings (`accent-color:`, `background-color:`, `text-color:`,
 * `body-size:` and the rest). The slides on a phone read the same custom
 * properties straight from the stylesheet. These screens have answer controls
 * and status text on them, so each colour is checked here first and the
 * stylesheet only ever receives a set that is readable:
 *   - text holds 4.5:1 against the deck background, against the answer panels
 *     drawn on it and against the small chips inside them. A text colour that
 *     does not is replaced by black or white, whichever reads better;
 *   - the accent holds 3:1 against the background or it is not used, and the
 *     selected answer then takes the text colour instead;
 *   - the edge line of an answer holds 3:1 against the background.
 * A deck with none of these settings gets no style and no attributes, so the
 * screens keep Core's own colours and sizes.
 */

export type Rgb = [number, number, number];

export interface PhoneColorEnv {
  /** A deck colour (a name or a hex colour, or a CSS variable) as red, green and blue, or null when it cannot be read. */
  resolve: (css: string) => Rgb | null;
  /** The colour of the page behind the screen when the deck sets no background, or null when unknown. */
  page: Rgb | null;
}

export interface PhoneScreenAppearance {
  style?: DeckStyle;
  /** `data-deck-*` attributes for the screen's root element. Absent keys are left out. */
  attributes: Record<string, string>;
}

/** How much of the text colour tints an answer panel, and the chip inside it with the panel beneath (the rules at the end of index.css). */
const PANEL_TINT = 0.07;
const CHIP_TINT = 0.26;

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

export function contrastRatio(a: Rgb, b: Rgb): number {
  const [high, low] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (high + 0.05) / (low + 0.05);
}

/** `amount` of `top` over `bottom`, the way `color-mix(in srgb, top amount, bottom)` mixes. */
export function mix(top: Rgb, amount: number, bottom: Rgb): Rgb {
  return [0, 1, 2].map((i) => top[i] * amount + bottom[i] * (1 - amount)) as Rgb;
}

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

function css([r, g, b]: Rgb): string {
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

/** Black or white, whichever reads better on `fill`. */
function readableOn(fill: Rgb): { rgb: Rgb; css: string } {
  return contrastRatio(BLACK, fill) >= contrastRatio(WHITE, fill) ? { rgb: BLACK, css: "#000000" } : { rgb: WHITE, css: "#ffffff" };
}

export function phoneScreenAppearance(deckStyle: unknown, env?: PhoneColorEnv): PhoneScreenAppearance {
  const appearance = safeDeckStyle(deckStyle);
  if (!appearance) return { attributes: {} };
  const attributes: Record<string, string> = {};
  // Sizes and the background pass straight through. The colours go out as checked --student-* copies.
  const style: DeckStyle = {};
  for (const [name, value] of Object.entries(appearance)) {
    if (!["--mdq-deck-text", "--mdq-deck-muted", "--mdq-deck-accent"].includes(name)) style[name] = value;
  }
  const has = (name: string) => name in appearance;
  if (has("--mdq-body-size") || has("--mdq-body-scale")) attributes["data-deck-size"] = "true";
  const backgroundSet = has("--mdq-slide-bg") || has("--mdq-slide-bg-soft");
  if (backgroundSet) attributes["data-deck-background"] = "true";

  if (!env) {
    // Nothing to measure against: pass the settings through as the slides do.
    for (const [setting, name, attribute] of [["--mdq-deck-text", "--student-text", "data-deck-text"], ["--mdq-deck-muted", "--student-muted", "data-deck-muted"], ["--mdq-deck-accent", "--student-accent", "data-deck-accent"]]) {
      if (!has(setting)) continue;
      style[name] = appearance[setting];
      attributes[attribute] = "true";
    }
    return { style, attributes };
  }

  // The colours the deck's background runs between, top and bottom, or the page itself.
  const stopFor = (name: string): Rgb | null => (has(name) ? env.resolve(appearance[name]) : null);
  const top = stopFor("--mdq-slide-bg-soft") ?? stopFor("--mdq-slide-bg") ?? env.page;
  const bottom = stopFor("--mdq-slide-bg") ?? env.page;
  const stops = [top, bottom].filter((stop): stop is Rgb => stop !== null);
  if (stops.length === 0) return { style: Object.keys(style).length > 0 ? style : undefined, attributes };

  // Text is held against the answer panels and chips too, but only where the deck repaints the screen.
  const readable = (text: Rgb): boolean => stops.every((stop) => {
    if (contrastRatio(text, stop) < 4.5) return false;
    return !backgroundSet || (contrastRatio(text, mix(text, PANEL_TINT, stop)) >= 4.5 && contrastRatio(text, mix(text, CHIP_TINT, stop)) >= 4.5);
  });
  const textSetting = has("--mdq-deck-text") ? env.resolve(appearance["--mdq-deck-text"]) : null;
  let text: { rgb: Rgb; css: string } | null = null;
  if (textSetting && readable(textSetting)) text = { rgb: textSetting, css: appearance["--mdq-deck-text"] };
  else if (backgroundSet) {
    // A deck background with no usable text colour would leave the palette's text on it.
    const best = [BLACK, WHITE].filter(readable).sort((a, b) => Math.min(...stops.map((s) => contrastRatio(b, s))) - Math.min(...stops.map((s) => contrastRatio(a, s))))[0] ?? readableOn(stops[0]).rgb;
    text = { rgb: best, css: best === BLACK ? "#000000" : "#ffffff" };
  }
  if (text) {
    style["--student-text"] = text.css;
    attributes["data-deck-text"] = "true";
  }

  const mutedSetting = has("--mdq-deck-muted") ? env.resolve(appearance["--mdq-deck-muted"]) : null;
  if (mutedSetting && readable(mutedSetting)) {
    style["--student-muted"] = appearance["--mdq-deck-muted"];
    attributes["data-deck-muted"] = "true";
  } else if (backgroundSet && text) {
    style["--student-muted"] = text.css;
    attributes["data-deck-muted"] = "true";
  }

  // The accent marks the selected answer and fills Submit, so it holds 3:1 against the background or the text colour does its job.
  const accentSetting = has("--mdq-deck-accent") ? env.resolve(appearance["--mdq-deck-accent"]) : null;
  const accent = accentSetting && stops.every((stop) => contrastRatio(accentSetting, stop) >= 3)
    ? { rgb: accentSetting, css: appearance["--mdq-deck-accent"] }
    : backgroundSet && text ? text : null;
  if (accent) {
    style["--student-accent"] = accent.css;
    style["--student-on-accent"] = readableOn(accent.rgb).css;
    attributes["data-deck-accent"] = "true";
  }

  // An answer's edge line: the text colour toned down as far as 3:1 against the background allows.
  if (backgroundSet && text) {
    for (let share = 0.5; share <= 1.0001; share += 0.05) {
      const line = mix(text.rgb, Math.min(share, 1), stops[0]);
      if (stops.every((stop) => contrastRatio(line, stop) >= 3)) {
        style["--student-line"] = css(line);
        break;
      }
    }
    style["--student-line"] ??= text.css;
  }
  return { style: Object.keys(style).length > 0 ? style : undefined, attributes };
}
