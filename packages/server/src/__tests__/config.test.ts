import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { DEFAULT_PORT } from "@mdq/shared";
import { loadRuntimeConfig } from "../config";

describe("loadRuntimeConfig", () => {
  function createRoot(): string {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-config-"));
    fs.mkdirSync(path.join(root, "data"), { recursive: true });
    return root;
  }

  it("uses existing defaults when config is absent", () => {
    const root = createRoot();
    const config = loadRuntimeConfig({ rootDir: root, env: {} });

    expect(config.loadedFromFile).toBe(false);
    expect(config.port).toBe(DEFAULT_PORT);
    expect(config.bindHost).toBe("");
    expect(config.portFallbacks).toBe(10);
    expect(config.quizDir).toBe(path.join(root, "data", "decks"));
    expect(config.instanceId).toBe("");
    expect(config.theme).toBe("dark");
    expect(config.palette).toBe("classic");
    expect(config.autoGenerateStudentIds).toBe(false);
  });

  it("loads runtime overrides from data/config.json", () => {
    const root = createRoot();
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({
        port: 3100,
        bindHost: "127.0.0.1",
        portFallbacks: 4,
        deckDir: "./alt-decks",
        instanceId: "room-a",
        theme: "light",
        palette: "gruvbox",
        autoGenerateStudentIds: true,
      }),
    );

    const config = loadRuntimeConfig({ rootDir: root, env: {} });

    expect(config.loadedFromFile).toBe(true);
    expect(config.port).toBe(3100);
    expect(config.bindHost).toBe("127.0.0.1");
    expect(config.portFallbacks).toBe(4);
    expect(config.quizDir).toBe(path.join(root, "data", "alt-decks"));
    expect(config.instanceId).toBe("room-a");
    expect(config.theme).toBe("light");
    expect(config.palette).toBe("gruvbox");
    expect(config.autoGenerateStudentIds).toBe(true);
  });

  it("lets environment variables override file config", () => {
    const root = createRoot();
    fs.writeFileSync(
      path.join(root, "data", "config.json"),
      JSON.stringify({ port: 3100, portFallbacks: 4, deckDir: "./alt-decks", instanceId: "room-a", theme: "light", palette: "gruvbox" }),
    );

    const config = loadRuntimeConfig({
      rootDir: root,
      env: {
        PORT: "3200",
        MDQ_BIND_HOST: "localhost",
        PORT_FALLBACKS: "1",
        MDQ_DECK_DIR: path.join(root, "custom-decks"),
        MDQ_INSTANCE_ID: "room-b",
        MDQ_THEME: "dark",
        MDQ_PALETTE: "classic",
        MDQ_AUTO_GENERATE_STUDENT_IDS: "false",
      },
    });

    expect(config.port).toBe(3200);
    expect(config.bindHost).toBe("localhost");
    expect(config.portFallbacks).toBe(1);
    expect(config.quizDir).toBe(path.join(root, "custom-decks"));
    expect(config.instanceId).toBe("room-b");
    expect(config.theme).toBe("dark");
    expect(config.palette).toBe("classic");
    expect(config.autoGenerateStudentIds).toBe(false);
  });

  it("falls back to an existing legacy data/quizzes directory", () => {
    const root = createRoot();
    fs.mkdirSync(path.join(root, "data", "quizzes"));

    const config = loadRuntimeConfig({ rootDir: root, env: {} });

    expect(config.quizDir).toBe(path.join(root, "data", "quizzes"));
  });

  it("accepts legacy quizDir config and QUIZ_DIR env overrides", () => {
    const root = createRoot();
    fs.writeFileSync(path.join(root, "data", "config.json"), JSON.stringify({ quizDir: "./legacy-quizzes" }));

    const fileConfig = loadRuntimeConfig({ rootDir: root, env: {} });
    const envConfig = loadRuntimeConfig({
      rootDir: root,
      env: { QUIZ_DIR: path.join(root, "custom-quizzes") },
    });

    expect(fileConfig.quizDir).toBe(path.join(root, "data", "legacy-quizzes"));
    expect(envConfig.quizDir).toBe(path.join(root, "custom-quizzes"));
  });
});
