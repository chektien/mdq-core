import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import "./theme.css";
import App from "./App";
import { fetchRuntimeClientConfig } from "./hooks/api";
import type { RuntimeClientConfig } from "./hooks/api";
import { applyClientPalette, applyClientTheme } from "./theme";

async function bootstrap(): Promise<void> {
  applyClientTheme("dark");
  applyClientPalette("classic");
  let runtimeConfig: RuntimeClientConfig = {};

  try {
    runtimeConfig = await fetchRuntimeClientConfig();
    applyClientTheme(runtimeConfig.theme);
    applyClientPalette(runtimeConfig.palette);
  } catch {
    applyClientTheme("dark");
    applyClientPalette("classic");
  }

  createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <App runtimeConfig={runtimeConfig} />
    </StrictMode>,
  );
}

void bootstrap();
