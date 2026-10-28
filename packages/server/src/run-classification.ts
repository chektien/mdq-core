import { activeSubmissions } from "./attempts";
import * as fs from "fs";
import * as path from "path";
import { Quiz, Session } from "@mdq/shared";
import { getQuestionType } from "./scoring";
import { isSlideType } from "@mdq/shared";

export type LocalRunKind = "normal" | "trial" | "possible-trial";
export interface LocalRunDecision {
  classification: LocalRunKind;
  source: "manual" | "heuristic";
  reasons: string[];
  at: number;
}
export interface LocalRunClassification extends LocalRunDecision {
  version: 1;
  sessionId: string;
  history: LocalRunDecision[];
  evidence?: { participantCount: number; durationMs: number; answeredQuestions: number; questionCount: number };
}

export function validateSessionId(sessionId: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) throw new Error("Invalid local session ID");
}
export function classificationPath(sessionId: string, dataDir: string): string {
  validateSessionId(sessionId);
  return path.join(dataDir, "classifications", `${sessionId}.json`);
}

/** Missing metadata is legacy/normal. Unreadable metadata fails closed. */
export function loadRunClassification(sessionId: string, dataDir: string): LocalRunClassification | null {
  const file = classificationPath(sessionId, dataDir);
  if (!fs.existsSync(file)) return null;
  const value = JSON.parse(fs.readFileSync(file, "utf8")) as LocalRunClassification;
  if (value.version !== 1 || value.sessionId !== sessionId ||
      !["normal", "trial", "possible-trial"].includes(value.classification) ||
      !["manual", "heuristic"].includes(value.source) || !Array.isArray(value.reasons) ||
      !value.reasons.every(reason => typeof reason === "string") || !Array.isArray(value.history)) {
    throw new Error(`Invalid classification metadata for ${sessionId}`);
  }
  return value;
}

function writeClassification(value: LocalRunClassification, dataDir: string): void {
  const file = classificationPath(value.sessionId, dataDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, file);
}

/** Suggestions only. A small, short, incomplete classroom run alone is not evidence of a trial. */
export function ensureRunClassification(
  session: Session, quiz: Quiz, dataDir: string, endedAt = Date.now(),
): LocalRunClassification {
  const existing = loadRunClassification(session.sessionId, dataDir);
  if (existing) return existing;
  const questionIndexes = new Set(quiz.questions.flatMap((question, index) =>
    isSlideType(getQuestionType(question)) ? [] : [index]));
  const evidence = {
    participantCount: session.participants.size,
    durationMs: Math.max(0, endedAt - session.createdAt),
    answeredQuestions: new Set(activeSubmissions(session).map(sub => sub.questionIndex).filter(index => questionIndexes.has(index))).size,
    questionCount: questionIndexes.size,
  };
  // Match explicit synthetic identifiers, never names, score, or ordinary student IDs.
  const syntheticId = /^(?:test|trial|demo|dummy|preview)(?:[-_](?:user|student|participant))?(?:[-_]?\d+)?$/i;
  const possibleTrial = evidence.participantCount > 0 && evidence.participantCount <= 2 &&
    [...session.participants.keys()].every(id => syntheticId.test(id)) &&
    evidence.durationMs <= 120_000 && evidence.questionCount >= 2 &&
    evidence.answeredQuestions < evidence.questionCount;
  const decision: LocalRunDecision = {
    classification: possibleTrial ? "possible-trial" : "normal",
    source: "heuristic",
    reasons: possibleTrial ? [
      "Only one or two participants, all using explicit test/demo/trial/dummy/preview identifiers.",
      "Run lasted at most two minutes and left a multi-question quiz incomplete.",
      "Suggestion only. Review and explicitly mark normal if this was a genuine classroom run.",
    ] : ["No conservative trial-run suggestion. Small classes and incomplete runs alone are not flagged."],
    at: endedAt,
  };
  const value: LocalRunClassification = { version: 1, sessionId: session.sessionId, ...decision, evidence, history: [decision] };
  writeClassification(value, dataDir);
  return value;
}

/** Overrides are durable and retain previous decisions, including heuristic evidence. */
export function setRunClassification(
  sessionId: string, classification: "normal" | "trial", reason: string, dataDir: string,
): LocalRunClassification {
  if (!["normal", "trial"].includes(classification)) throw new Error("Choose normal or trial");
  if (!reason.trim() || reason.length > 500) throw new Error("A reason of 1–500 characters is required");
  const existing = loadRunClassification(sessionId, dataDir);
  const decision: LocalRunDecision = { classification, source: "manual", reasons: [reason.trim()], at: Date.now() };
  const value: LocalRunClassification = {
    version: 1, sessionId, ...decision, evidence: existing?.evidence,
    history: [...(existing?.history || []), decision],
  };
  writeClassification(value, dataDir);
  return value;
}

export function isRunEligible(sessionId: string, dataDir: string): boolean {
  try {
    const classification = loadRunClassification(sessionId, dataDir);
    return !classification || classification.classification === "normal";
  } catch {
    // Corrupt metadata must not silently promote a flagged run into ordinary results.
    return false;
  }
}

export function classificationSummary(value: LocalRunClassification): string {
  return [
    "<!-- mdq-local-run-classification -->",
    "## Local Run Classification", "",
    `- Classification: ${value.classification}`,
    `- Source: ${value.source}`,
    `- Ordinary winner/consolidation eligibility: ${value.classification === "normal" ? "included" : "excluded"}`,
    ...value.reasons.map(reason => `- Reason: ${reason.replace(/[\r\n]/g, " ")}`),
    "- Local artifact housekeeping only. No Cloud history or billing meaning.",
    "<!-- /mdq-local-run-classification -->", "",
  ].join("\n");
}

export function updateSummaryClassification(file: string, value: LocalRunClassification): void {
  if (!fs.existsSync(file)) return;
  const text = fs.readFileSync(file, "utf8");
  const block = classificationSummary(value);
  const marker = /<!-- mdq-local-run-classification -->[\s\S]*?<!-- \/mdq-local-run-classification -->\n?/;
  fs.writeFileSync(file, marker.test(text) ? text.replace(marker, () => block) : `${block}\n${text}`, "utf8");
}
