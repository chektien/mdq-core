import * as fs from "fs";
import * as path from "path";
import { getSessionResultsCsvPath, getSessionSummaryMarkdownPath, reconcileWeeklyResult, resolveDataDir } from "./persistence";
import { isRunEligible, loadRunClassification, setRunClassification, updateSummaryClassification, validateSessionId } from "./run-classification";

const USAGE = "Usage: npm run classify:local -- [--data-dir DIR] --session ID [--set trial|normal --reason TEXT] (or --eligible-csvs instead of --session)";

/** Operates on ended local artifacts only, without a running server or Cloud access. */
export function classifyLocalRun(args: string[]): object {
  const options: Record<string, string> = {};
  let manifest = false;
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (option === "--eligible-csvs") {
      if (manifest) throw new Error(USAGE);
      manifest = true;
      continue;
    }
    if (!["--data-dir", "--session", "--set", "--reason"].includes(option) || !args[i + 1] || options[option]) {
      throw new Error(USAGE);
    }
    options[option] = args[++i];
  }
  const dataDir = resolveDataDir(options["--data-dir"]);
  if (manifest) {
    if (options["--session"] || options["--set"] || options["--reason"]) throw new Error(USAGE);
    const sessions = path.join(dataDir, "sessions");
    const csvFiles: string[] = [];
    for (const filename of fs.existsSync(sessions) ? fs.readdirSync(sessions).filter(file => file.endsWith(".json")).sort() : []) {
      const snapshot = JSON.parse(fs.readFileSync(path.join(sessions, filename), "utf8"));
      if (typeof snapshot.sessionId !== "string" || filename !== `${snapshot.sessionId}.json` ||
          typeof snapshot.sessionCode !== "string" || !Number.isFinite(snapshot.createdAt) || !Number.isFinite(snapshot.endedAt)) {
        throw new Error("Invalid ended local session snapshot; consolidation manifest not produced");
      }
      if (!isRunEligible(snapshot.sessionId, dataDir)) continue;
      const csv = getSessionResultsCsvPath(snapshot, dataDir);
      if (fs.existsSync(csv)) csvFiles.push(csv);
    }
    return { csvFiles, scope: "eligible ended local runs only; raw inputs unchanged" };
  }
  const sessionId = options["--session"];
  if (!sessionId) throw new Error(USAGE);
  validateSessionId(sessionId);
  const file = path.join(dataDir, "sessions", `${sessionId}.json`);
  if (!fs.existsSync(file)) throw new Error("No ended local session snapshot found for that ID");
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  if (snapshot.sessionId !== sessionId || typeof snapshot.week !== "string" ||
      typeof snapshot.sessionCode !== "string" || !Number.isFinite(snapshot.createdAt) ||
      !Number.isFinite(snapshot.endedAt) || (!snapshot.week || snapshot.week === "." || snapshot.week === ".." || /[\\/\0]/.test(snapshot.week))) {
    throw new Error("Invalid ended local session snapshot");
  }
  let classification = loadRunClassification(sessionId, dataDir);
  if (options["--set"]) {
    const kind = options["--set"];
    if (kind !== "normal" && kind !== "trial") throw new Error("--set must be trial or normal");
    if (!options["--reason"]) throw new Error("--reason is required when changing classification");
    classification = setRunClassification(sessionId, kind, options["--reason"], dataDir);
    // Sidecar is written first, so failures in derived view refresh still fail closed.
    reconcileWeeklyResult(snapshot.week, dataDir);
    updateSummaryClassification(getSessionSummaryMarkdownPath(snapshot, dataDir), classification);
  } else if (options["--reason"]) {
    throw new Error("--reason requires --set");
  }
  return {
    sessionId,
    classification: classification?.classification || "normal",
    source: classification?.source || "legacy (no classification metadata)",
    eligibleForOrdinaryResults: isRunEligible(sessionId, dataDir),
    reasons: classification?.reasons || [],
    history: classification?.history || [],
    scope: "local artifacts only; no Cloud history or billing meaning",
  };
}

if (require.main === module) {
  try {
    console.log(JSON.stringify(classifyLocalRun(process.argv.slice(2)), null, 2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Local classification failed");
    process.exitCode = 1;
  }
}
