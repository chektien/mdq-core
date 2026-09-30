import { resolveDeckStyleSetting, safeDeckStyle, type Quiz } from "@mdq/shared";

/**
 * How a deck's header appearance settings apply to the printed deck. The
 * print layout has its own colour tokens, so colour settings replace those,
 * and `body-size` scales the body text. Sizes, widths, spacing and image
 * settings describe the slide canvas and do not apply on paper.
 */
export interface PrintDeckStyle {
  /** Declarations added to the print `:root` after the palette tokens. */
  tokens: string;
  /** The page background colour, when the deck sets a background. */
  pageBackground?: string;
  /** Rules added at the end of the print stylesheet. */
  rules: string;
}

function validColor(settings: Record<string, string>, key: string): string | undefined {
  const value = settings[key];
  if (value === undefined) return undefined;
  const result = resolveDeckStyleSetting(key, value);
  return result.ok ? result.value : undefined;
}

export function printDeckStyle(quiz: Pick<Quiz, "style" | "styleSettings">): PrintDeckStyle {
  const settings = quiz.styleSettings ?? {};
  const tokens: string[] = [];
  const rules: string[] = [];
  const accent = validColor(settings, "accent-color");
  const text = validColor(settings, "text-color");
  const muted = validColor(settings, "muted-color");
  const background = validColor(settings, "background-color");
  const surface = validColor(settings, "surface-color");
  const link = validColor(settings, "link-color");
  const bullet = validColor(settings, "bullet-color");
  if (accent) tokens.push(`--accent: ${accent};`);
  if (text) tokens.push(`--ink: ${text};`, `--body: ${text};`);
  if (muted) tokens.push(`--muted: ${muted};`);
  if (background) tokens.push(`--page-bg: ${background};`, `--paper: ${background};`);
  if (surface) tokens.push(`--wash: ${surface};`);

  const style = safeDeckStyle(quiz.style) ?? {};
  for (const name of ["--mdq-body-size", "--mdq-body-scale"]) {
    if (style[name]) tokens.push(`${name}: ${style[name]};`);
  }
  if (link) rules.push(`a { color: ${link}; }`);
  if (bullet) rules.push(`.body-copy li::marker, .body-copy li li::marker { color: ${bullet}; }`);
  return { tokens: tokens.join("\n      "), pageBackground: background, rules: rules.join("\n    ") };
}
