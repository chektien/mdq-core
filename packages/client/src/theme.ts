import type { DeckPalette, DeckTheme } from "@mdq/shared";
import {
  DEFAULT_CLIENT_PALETTE,
  DEFAULT_CLIENT_THEME,
  resolveClientPalette,
  resolveClientTheme,
} from "./appearance";

export {
  DEFAULT_CLIENT_PALETTE,
  DEFAULT_CLIENT_THEME,
  readServedAppearance,
  resolveBootAppearance,
  resolveClientPalette,
  resolveClientTheme,
} from "./appearance";

// <html data-theme data-palette> is the single place the appearance lives.
// Until a view sets data-theme, index.css keeps the page unpainted and the
// app hidden, so views apply a theme only once they know which one applies.

export function applyClientTheme(theme: unknown, fallback: DeckTheme = DEFAULT_CLIENT_THEME): DeckTheme {
  const resolved = resolveClientTheme(theme, fallback);
  document.documentElement.dataset.theme = resolved;
  return resolved;
}

export function applyClientPalette(palette: unknown, fallback: DeckPalette = DEFAULT_CLIENT_PALETTE): DeckPalette {
  const resolved = resolveClientPalette(palette, fallback);
  document.documentElement.dataset.palette = resolved;
  return resolved;
}
