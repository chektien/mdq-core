import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./theme.css";
import App from "./App";
import { fetchRuntimeClientConfig } from "./hooks/api";
import type { RuntimeClientConfig } from "./hooks/api";
import { applyClientPalette, applyClientTheme, readServedAppearance, resolveBootAppearance } from "./theme";

// A view that is still waiting for its deck (for example a slow session
// lookup) must not leave the page hidden for long; after this the boot
// fallback appears and the view switches to the deck theme when it arrives.
const THEME_WAIT_MS = 3000;

async function bootstrap(): Promise<void> {
  // Apply nothing yet: a theme guessed here would flash before the deck's own
  // theme. Attributes the server already rendered into <html> stay as served.
  const served = readServedAppearance(document.documentElement.dataset);
  let fetched: RuntimeClientConfig = {};

  try {
    fetched = await fetchRuntimeClientConfig();
  } catch {
    // Fall back to the served attributes, then the built-in defaults.
  }

  const boot = resolveBootAppearance(served, fetched);
  const runtimeConfig: RuntimeClientConfig = { ...fetched, theme: boot.theme, palette: boot.palette };

  window.setTimeout(() => {
    if (document.documentElement.dataset.theme) return;
    applyClientTheme(runtimeConfig.theme);
    applyClientPalette(runtimeConfig.palette);
  }, THEME_WAIT_MS);

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App runtimeConfig={runtimeConfig} />
    </StrictMode>,
  );
}

void bootstrap();
