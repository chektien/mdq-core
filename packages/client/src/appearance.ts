import type { DeckPalette, DeckTheme } from "@mdq/shared";

// DOM-free theme and palette rules, shared by theme.ts and the boot code.
// The theme and palette themselves live only on <html> as data-theme and
// data-palette (see theme.ts).

export const DEFAULT_CLIENT_THEME: DeckTheme = "dark";
export const DEFAULT_CLIENT_PALETTE: DeckPalette = "classic";

export interface ClientAppearance {
  theme?: DeckTheme;
  palette?: DeckPalette;
}

export function resolveClientTheme(theme: unknown, fallback: DeckTheme = DEFAULT_CLIENT_THEME): DeckTheme {
  if (theme === "light" || theme === "dark") return theme;
  return fallback;
}

export function resolveClientPalette(palette: unknown, fallback: DeckPalette = DEFAULT_CLIENT_PALETTE): DeckPalette {
  if (palette === "classic" || palette === "gruvbox") return palette;
  return fallback;
}

/**
 * The supported theme and palette already present on <html> when the page
 * loads, for example because the server rendered the deck's appearance into
 * the HTML. Unsupported or missing values come back undefined.
 */
export function readServedAppearance(dataset: { theme?: string; palette?: string }): ClientAppearance {
  const { theme, palette } = dataset;
  return {
    theme: theme === "light" || theme === "dark" ? theme : undefined,
    palette: palette === "classic" || palette === "gruvbox" ? palette : undefined,
  };
}

/**
 * The fallback appearance for views that have no deck of their own yet.
 * Attributes served in the HTML describe this page more closely than the
 * global runtime config, so they win; the built-in defaults come last.
 */
export function resolveBootAppearance(
  served: ClientAppearance,
  runtime: { theme?: unknown; palette?: unknown },
): { theme: DeckTheme; palette: DeckPalette } {
  return {
    theme: served.theme ?? resolveClientTheme(runtime.theme),
    palette: served.palette ?? resolveClientPalette(runtime.palette),
  };
}
