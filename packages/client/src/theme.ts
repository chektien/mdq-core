import type { DeckPalette, DeckTheme } from "@mdq/shared";

export const DEFAULT_CLIENT_THEME: DeckTheme = "dark";
export const DEFAULT_CLIENT_PALETTE: DeckPalette = "classic";

export function resolveClientTheme(theme: unknown, fallback: DeckTheme = DEFAULT_CLIENT_THEME): DeckTheme {
  if (theme === "light" || theme === "dark") return theme;
  return fallback;
}

export function applyClientTheme(theme: unknown, fallback: DeckTheme = DEFAULT_CLIENT_THEME): DeckTheme {
  const resolved = resolveClientTheme(theme, fallback);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export function resolveClientPalette(palette: unknown, fallback: DeckPalette = DEFAULT_CLIENT_PALETTE): DeckPalette {
  if (palette === "classic" || palette === "gruvbox") return palette;
  return fallback;
}

export function applyClientPalette(palette: unknown, fallback: DeckPalette = DEFAULT_CLIENT_PALETTE): DeckPalette {
  const resolved = resolveClientPalette(palette, fallback);
  document.documentElement.dataset.palette = resolved;
  return resolved;
}
