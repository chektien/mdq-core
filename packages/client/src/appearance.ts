import { isDeckPalette, type DeckPalette, type DeckTheme } from "@mdq/shared";

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
  return isDeckPalette(palette) ? palette : fallback;
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
    palette: isDeckPalette(palette) ? palette : undefined,
  };
}

/**
 * The fallback appearance for views that have no deck of their own yet.
 * Attributes served in the HTML describe this page more closely than the
 * global runtime config, so they win; `fallbackTheme` and the classic palette
 * come last.
 */
export function resolveBootAppearance(
  served: ClientAppearance,
  runtime: { theme?: unknown; palette?: unknown },
  fallbackTheme: DeckTheme = DEFAULT_CLIENT_THEME,
): { theme: DeckTheme; palette: DeckPalette } {
  return {
    theme: served.theme ?? resolveClientTheme(runtime.theme, fallbackTheme),
    palette: served.palette ?? resolveClientPalette(runtime.palette),
  };
}

/**
 * The theme to show before any theme is known: light on a device set to a
 * light colour scheme, so it does not go from the light neutral to dark.
 */
export function systemFallbackTheme(prefersLight: boolean): DeckTheme {
  return prefersLight ? "light" : DEFAULT_CLIENT_THEME;
}
