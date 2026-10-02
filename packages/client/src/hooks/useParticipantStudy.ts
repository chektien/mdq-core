import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API, isSlideType, type AnswerSubmitPayload, type ParticipantStudyPayload } from "@mdq/shared";
import type { QuestionState, UseSocketReturn } from "./useSocket";
import { toOptionLabels } from "../ownAnswers";
import { draftStorageKey, emptyDraft, readDraft, writeDraft, type ParticipantDraft } from "../participantDrafts";

/** Shared participant follow/browse/draft state for native and hosted adapters. */
export function useParticipantStudy(sessionId: string | null, sock: UseSocketReturn) {
  const seatKey = sessionId && sock.sessionToken && !sock.seatTaken ? `${sessionId}:${sock.sessionToken}` : null;
  const [snapshot, setSnapshot] = useState<{ seatKey: string; data: ParticipantStudyPayload } | null>(null);
  const [navigation, setNavigation] = useState<{ seatKey: string; index: number | null } | null>(null);
  const [draftVersion, setDraftVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const drafts = useRef(new Map<string, ParticipantDraft>());
  const persisted = useRef(new Map<string, boolean>());
  const generation = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => setRefreshVersion(v => v + 1), []);
  useEffect(() => {
    generation.current += 1;
    const requestGeneration = generation.current;
    if (!sessionId || !seatKey || !sock.sessionToken) return;
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => { controller.abort(); if (!cancelled && requestGeneration === generation.current) setError("Available items could not be refreshed. Try again."); }, 10_000);
    fetch(API.SESSION_ITEMS.replace(":id", encodeURIComponent(sessionId)), {
      headers: { Authorization: `Bearer ${sock.sessionToken}` }, signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error("Available items could not be refreshed.");
      const data = await response.json() as ParticipantStudyPayload;
      if (requestGeneration !== generation.current || controller.signal.aborted) return;
      setSnapshot({ seatKey, data }); setError(null);
    }).catch(() => {
      if (!controller.signal.aborted && requestGeneration === generation.current) setError("Available items could not be refreshed. Try again.");
    }).finally(() => clearTimeout(timer));
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [sessionId, seatKey, sock.sessionToken, sock.connected, sock.currentQuestion, sock.sessionState, sock.answerRevision, sock.availability, refreshVersion]);

  const data = snapshot?.seatKey === seatKey ? snapshot.data : null;
  const selfPaced = data?.policy?.pacing === "self-paced";
  const canBrowse = selfPaced || sock.availability?.phase === "expired";
  const following = !canBrowse || navigation?.seatKey !== seatKey || navigation.index === null;
  const items = useMemo(() => {
    const list = data?.items ?? [];
    const current = sock.currentQuestion;
    if (!current) return list;
    return [...list.filter(item => item.questionIndex !== current.questionIndex), current].sort((a, b) => a.questionIndex - b.questionIndex);
  }, [data, sock.currentQuestion]);
  const viewedIndex = following ? sock.currentQuestion?.questionIndex ?? data?.currentQuestionIndex : navigation?.index;
  const item = items.find(item => item.questionIndex === viewedIndex);
  const question: QuestionState | null = item ? { ...item, questionType: item.questionType ?? (item.isPoll ? "poll" : "multiple_choice"), isPoll: item.isPoll ?? false } : null;
  const answers = new Map(data?.answers.map(answer => [answer.questionIndex, answer]));
  for (const [index, answer] of sock.ownAnswers ?? []) answers.set(index, answer);
  const answered = new Set([...(data?.answeredQuestions ?? []), ...sock.answeredQuestions, ...answers.keys()]);
  const saved = question ? answers.get(question.questionIndex) : null;
  const submitted = question ? answered.has(question.questionIndex) : false;
  const submittedOptions = question && saved ? toOptionLabels(saved.selectedOptions, question.options)
    : submitted && question?.questionIndex === sock.currentQuestion?.questionIndex ? sock.submittedOptions : [];
  const submittedResponseText = saved?.responseText ?? (submitted && question?.questionIndex === sock.currentQuestion?.questionIndex ? sock.submittedResponseText : null);
  const key = sessionId && seatKey && sock.sessionToken && question ? draftStorageKey(sessionId, sock.sessionToken, question.questionIndex) : null;
  // Reads are scoped synchronously, so a seat change cannot show a previous seat's draft for one frame.
  let draft: ParticipantDraft | null = null;
  if (key) {
    draft = drafts.current.get(key) ?? readDraft(key);
    if (!draft) draft = { ...emptyDraft(), selectedOptions: submittedOptions, responseText: submittedResponseText ?? "" };
  }
  void draftVersion;
  const setDraft = useCallback((patch: Partial<Pick<ParticipantDraft, "selectedOptions" | "responseText">>) => {
    if (!key) return;
    const current = drafts.current.get(key) ?? readDraft(key) ?? { ...emptyDraft(), selectedOptions: submittedOptions, responseText: submittedResponseText ?? "" };
    const next = { ...current, ...patch, revision: current.revision + 1 };
    drafts.current.set(key, next); persisted.current.set(key, writeDraft(key, next)); setDraftVersion(v => v + 1);
  }, [key, submittedOptions, submittedResponseText]);
  const canAnswer = (!sock.availability || sock.availability.phase === "active") && !!question && sock.sessionState === "QUESTION_OPEN" && !isSlideType(question.questionType)
    && (selfPaced ? (data?.answerableQuestionIndexes.includes(question.questionIndex) ?? false)
      : question.questionIndex === sock.currentQuestion?.questionIndex)
    && (question.questionType === "open_response" || !submitted);
  const available = items.filter(item => !isSlideType(item.questionType ?? "multiple_choice"));
  const answeredCount = available.filter(item => answered.has(item.questionIndex)).length;
  const upToDate = available.length > 0 && answeredCount === available.length;
  const progressLabel = available.length ? `${answeredCount} of ${available.length} available questions answered` : null;
  const browse = (index: number) => {
    if (canBrowse && seatKey && items.some(item => item.questionIndex === index)) setNavigation({ seatKey, index });
  };
  const backToPresenter = () => { if (seatKey) setNavigation({ seatKey, index: null }); };
  const submitAnswer = (payload: AnswerSubmitPayload) => {
    if (canAnswer && sock.connected && question && payload.questionIndex === question.questionIndex) sock.submitAnswer(payload, question.options);
  };
  return { selfPaced, canBrowse, following, items, question, canAnswer, submitted, submittedOptions, submittedResponseText,
    draft, draftPersisted: !!key && (persisted.current.get(key) ?? !!readDraft(key)), setDraft, submitAnswer, browse, backToPresenter, progressLabel, upToDate, error, refresh };
}
