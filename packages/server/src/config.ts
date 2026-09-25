import * as fs from "fs";
import * as path from "path";
import { DEFAULT_PORT } from "@mdq/shared";

const DEFAULT_PORT_FALLBACKS = 10;

interface RuntimeConfigFile {
  port?: unknown;
  host?: unknown;
  bindHost?: unknown;
  portFallbacks?: unknown;
  deckDir?: unknown;
  quizDir?: unknown;
  instanceId?: unknown;
  theme?: unknown;
  palette?: unknown;
  autoGenerateStudentIds?: unknown;
  presenterNotes?: unknown;
  presenterNotesDefaultOpen?: unknown;
}

export type RuntimeTheme = "dark" | "light";
export type RuntimePalette = "classic" | "gruvbox";

export interface RuntimeConfig {
  port: number;
  bindHost: string;
  portFallbacks: number;
  quizDir: string;
  instanceId: string;
  theme: RuntimeTheme;
  palette: RuntimePalette;
  autoGenerateStudentIds: boolean;
  presenterNotes: boolean;
  presenterNotesDefaultOpen: boolean;
  configPath: string;
  loadedFromFile: boolean;
}

export interface RuntimeConfigLoadOptions {
  rootDir?: string;
  env?: NodeJS.ProcessEnv;
}

function parsePositiveInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed > 0) {
      return parsed;
    }
  }

  return undefined;
}

function parseNonNegativeInt(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return value;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return undefined;
    const parsed = Number.parseInt(trimmed, 10);
    if (Number.isInteger(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  return undefined;
}

function parseString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function parseTheme(value: unknown): RuntimeTheme | undefined {
  const normalized = parseString(value)?.toLowerCase();
  if (normalized === "dark" || normalized === "light") {
    return normalized;
  }
  return undefined;
}

function parsePalette(value: unknown): RuntimePalette | undefined {
  const normalized = parseString(value)?.toLowerCase();
  if (normalized === "classic" || normalized === "gruvbox") {
    return normalized;
  }
  return undefined;
}

function parseBoolean(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (["1", "true", "yes", "on"].includes(normalized)) return true;
    if (["0", "false", "no", "off"].includes(normalized)) return false;
  }
  return undefined;
}

function readRuntimeConfigFile(configPath: string): RuntimeConfigFile {
  if (!fs.existsSync(configPath)) {
    return {};
  }

  const raw = fs.readFileSync(configPath, "utf-8");
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Config root must be a JSON object");
    }
    return parsed as RuntimeConfigFile;
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid JSON";
    throw new Error(`Invalid runtime config at ${configPath}: ${message}`);
  }
}

function resolveQuizDir(configDir: string, rawQuizDir: string | undefined, fallback: string): string {
  if (!rawQuizDir) return fallback;
  return path.isAbsolute(rawQuizDir) ? rawQuizDir : path.resolve(configDir, rawQuizDir);
}

function defaultDeckDir(dataDir: string): string {
  const deckDir = path.join(dataDir, "decks");
  const legacyQuizDir = path.join(dataDir, "quizzes");
  if (!fs.existsSync(deckDir) && fs.existsSync(legacyQuizDir)) {
    return legacyQuizDir;
  }
  return deckDir;
}

export function loadRuntimeConfig(options: RuntimeConfigLoadOptions = {}): RuntimeConfig {
  const rootDir = options.rootDir || path.resolve(__dirname, "../../../");
  const env = options.env || process.env;
  const dataDir = path.join(rootDir, "data");
  const configPath = path.join(dataDir, "config.json");
  const configDir = path.dirname(configPath);
  const fileConfig = readRuntimeConfigFile(configPath);
  const defaultQuizDir = defaultDeckDir(dataDir);
  const configuredDeckDir =
    parseString(env.MDQ_DECK_DIR)
    ?? parseString(env.DECK_DIR)
    ?? parseString(fileConfig.deckDir);
  const configuredQuizDir = parseString(env.QUIZ_DIR) ?? parseString(fileConfig.quizDir);

  return {
    port: parsePositiveInt(env.PORT) ?? parsePositiveInt(fileConfig.port) ?? DEFAULT_PORT,
    bindHost:
      parseString(env.MDQ_BIND_HOST)
      ?? parseString(env.HOST)
      ?? parseString(fileConfig.bindHost)
      ?? parseString(fileConfig.host)
      ?? "",
    portFallbacks:
      parseNonNegativeInt(env.PORT_FALLBACKS)
      ?? parseNonNegativeInt(fileConfig.portFallbacks)
      ?? DEFAULT_PORT_FALLBACKS,
    quizDir: resolveQuizDir(configDir, configuredDeckDir ?? configuredQuizDir, defaultQuizDir),
    instanceId: parseString(env.MDQ_INSTANCE_ID) ?? parseString(fileConfig.instanceId) ?? "",
    theme: parseTheme(env.MDQ_THEME) ?? parseTheme(fileConfig.theme) ?? "dark",
    palette: parsePalette(env.MDQ_PALETTE) ?? parsePalette(fileConfig.palette) ?? "classic",
    autoGenerateStudentIds:
      parseBoolean(env.MDQ_AUTO_GENERATE_STUDENT_IDS)
      ?? parseBoolean(fileConfig.autoGenerateStudentIds)
      ?? false,
    // Presenter notes ship DISABLED by default so existing installs see no
    // change and no instructor-only data endpoint is exposed. A deck runtime
    // opts in via data/config.json or MDQ_PRESENTER_NOTES.
    presenterNotes:
      parseBoolean(env.MDQ_PRESENTER_NOTES)
      ?? parseBoolean(fileConfig.presenterNotes)
      ?? false,
    presenterNotesDefaultOpen:
      parseBoolean(env.MDQ_PRESENTER_NOTES_DEFAULT_OPEN)
      ?? parseBoolean(fileConfig.presenterNotesDefaultOpen)
      ?? false,
    configPath,
    loadedFromFile: fs.existsSync(configPath),
  };
}
