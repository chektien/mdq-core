import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./theme.css";
import App from "./App";
import { settleWithin } from "./boot";
import { fetchRuntimeClientConfig } from "./hooks/api";
import type { RuntimeClientConfig } from "./hooks/api";
import { applyClientPalette, applyClientTheme, readServedAppearance, resolveBootAppearance } from "./theme";

// A view that is still waiting for its deck (for example a slow session
// lookup) or a slow runtime config must not leave the page hidden for long;
// after this the boot fallback appears and the view switches to the deck
// theme when it arrives.
const THEME_WAIT_MS = 3000;

function bootConfig(served: ReturnType<typeof readServedAppearance>, fetched: RuntimeClientConfig): RuntimeClientConfig {
  const boot = resolveBootAppearance(served, fetched);
  return { ...fetched, theme: boot.theme, palette: boot.palette };
}

async function bootstrap(): Promise<void> {
  // Apply nothing yet: a theme guessed here would flash before the deck's own
  // theme. Attributes the server already rendered into <html> stay as served.
  const served = readServedAppearance(document.documentElement.dataset);
  let fetched: RuntimeClientConfig | undefined;

  // Started before the config request so a hung request cannot keep the page blank.
  window.setTimeout(() => {
    if (document.documentElement.dataset.theme) return;
    const fallback = bootConfig(served, fetched ?? {});
    applyClientTheme(fallback.theme);
    applyClientPalette(fallback.palette);
  }, THEME_WAIT_MS);

  const request = fetchRuntimeClientConfig().catch((): RuntimeClientConfig => ({}));
  fetched = await settleWithin(request, THEME_WAIT_MS);

  const root = createRoot(document.getElementById("root")!);
  const render = (config: RuntimeClientConfig) => root.render(
    <StrictMode>
      <App runtimeConfig={bootConfig(served, config)} />
    </StrictMode>,
  );
  render(fetched ?? {});
  // A config that arrives late still applies its settings once it lands.
  if (!fetched) void request.then((late) => { fetched = late; render(late); });
}

void bootstrap();
