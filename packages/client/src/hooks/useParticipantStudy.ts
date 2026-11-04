import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { API, isSlideType, type AnswerSubmitPayload, type ParticipantStudyPayload } from "@mdq/shared";
import type { QuestionState, UseSocketReturn } from "./useSocket";
import { mergeOwnAnswers, isEarlierAttemptDraft, toOptionLabels } from "../ownAnswers";
import { draftStorageKey, emptyDraft, readDraft, writeDraft, type ParticipantDraft } from "../participantDrafts";
import { answerForQuestion } from "../answerPair";
import { readStudyPosition, writeStudyPosition } from "../participantPosition";

/** Shared participant follow/browse/draft state for native and hosted adapters. */
export function useParticipantStudy(sessionId: string | null, sock: UseSocketReturn) {
  const seatKey = sessionId && sock.sessionToken && !sock.seatTaken ? `${sessionId}:${sock.sessionToken}` : null;
  const [snapshot, setSnapshot] = useState<{ seatKey: string; data: ParticipantStudyPayload } | null>(null);
  const [navigation, setNavigation] = useState<{ seatKey: string; index: number | null } | null>(null);
  const restoredNavigation = useMemo(() => seatKey ? { seatKey, index: readStudyPosition(seatKey) } : null, [seatKey]);
  const [draftVersion, setDraftVersion] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const drafts = useRef(new Map<string, ParticipantDraft>());
  const draftAttempts = useRef(new Map<string, number>());
  const draftContentVersions = useRef(new Map<string, number | undefined>());
  const persisted = useRef(new Map<string, boolean>());
  const generation = useRef(0);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const refresh = useCallback(() => setRefreshVersion(v => v + 1), []);
  useEffect(() => {
    generation.current += 1;
    const requestGeneration = generation.current;
    if (!sessionId || !seatKey || !sock.sessionToken) return;
    const sessionToken = sock.sessionToken;
    const requestAcceptanceEpoch = sock.getAnswerAcceptanceEpoch();
    const controller = new AbortController();
    let cancelled = false;
    const timer = setTimeout(() => { controller.abort(); if (!cancelled && requestGeneration === generation.current) setError("Available items could not be refreshed. Try again."); }, 10_000);
    fetch(API.SESSION_ITEMS.replace(":id", encodeURIComponent(sessionId)), {
      headers: { Authorization: `Bearer ${sessionToken}` }, signal: controller.signal,
    }).then(async response => {
      if (!response.ok) throw new Error("Available items could not be refreshed.");
      const data = await response.json() as ParticipantStudyPayload;
      if (requestGeneration !== generation.current || controller.signal.aborted || !sock.hasParticipantCredentials(sessionId, sessionToken)) return;
      // This list supplies refreshed item content and attempts, including for items this page is not on.
      for (const item of data.items) sock.noteQuestionAttempt(item.questionIndex, item.attempt ?? 1);
      sock.reconcileOwnAnswers(data.answers, requestAcceptanceEpoch);
      const stale = data.items.some(item => {
        const availableAttempt = data.policy?.pacing === "self-paced" ? item.attempt ?? 1
          : Math.max(item.attempt ?? 1, sock.currentQuestion?.questionIndex === item.questionIndex ? sock.currentQuestion.attempt ?? 1 : 1);
        return availableAttempt < (sock.questionAttempts.get(item.questionIndex) ?? 1);
      });
      setSnapshot({ seatKey, data }); setError(stale ? "Available items could not be refreshed. Try again." : null);
    }).catch(() => {
      if (!controller.signal.aborted && requestGeneration === generation.current) setError("Available items could not be refreshed. Try again.");
    }).finally(() => clearTimeout(timer));
    return () => { cancelled = true; controller.abort(); clearTimeout(timer); };
  }, [sessionId, seatKey, sock.sessionToken, sock.connected, sock.currentQuestion, sock.sessionState, sock.answerRevision, sock.availability, refreshVersion]);

  const data = snapshot?.seatKey === seatKey ? snapshot.data : null;
  const selfPaced = data?.policy?.pacing === "self-paced";
  const canBrowse = selfPaced || sock.availability?.phase === "expired";
  const items = useMemo(() => {
    const list = data?.items ?? [];
    const current = sock.currentQuestion;
    if (!current || list.some(item => item.questionIndex === current.questionIndex && ((item.attempt ?? 1) > (current.attempt ?? 1)
      || ((item.attempt ?? 1) === (current.attempt ?? 1) && (item.contentVersion ?? -1) > (current.contentVersion ?? -1))))) return list;
    return [...list.filter(item => item.questionIndex !== current.questionIndex), current].sort((a, b) => a.questionIndex - b.questionIndex);
  }, [data, sock.currentQuestion]);
  const selectedNavigation = navigation?.seatKey === seatKey ? navigation : restoredNavigation;
  const following = !canBrowse || selectedNavigation?.index == null || !items.some(item => item.questionIndex === selectedNavigation.index);
  const viewedIndex = following ? sock.currentQuestion?.questionIndex ?? data?.currentQuestionIndex : selectedNavigation?.index;
  const item = items.find(item => item.questionIndex === viewedIndex);
  const attemptAt = (index: number) => Math.max(items.find(item => item.questionIndex === index)?.attempt ?? 1, sock.questionAttempts.get(index) ?? 1);
  const question: QuestionState | null = item && (item.attempt ?? 1) === attemptAt(item.questionIndex) ? { ...item, questionType: item.questionType ?? (item.isPoll ? "poll" : "multiple_choice"), isPoll: item.isPoll ?? false } : null;
  // Clear only the item being left. The new item's refusal may have arrived in
  // the same React batch as its opening and must survive this effect.
  const { clearAnswerRejection } = sock;
  const previousView = useRef({ seatKey, index: viewedIndex });
  useEffect(() => {
    const previous = previousView.current;
    previousView.current = { seatKey, index: viewedIndex };
    // Socket session/seat changes own their reset, before new-seat events arrive.
    if (previous.seatKey === seatKey && previous.index !== viewedIndex && previous.index != null) {
      clearAnswerRejection(previous.index);
    }
  }, [seatKey, viewedIndex, clearAnswerRejection]);
  const answers = mergeOwnAnswers(new Map(data?.answers.filter(answer => (answer.attempt ?? 1) === attemptAt(answer.questionIndex)).map(answer => [answer.questionIndex, answer])),
    [...sock.ownAnswers.values()].filter(answer => (answer.attempt ?? 1) === attemptAt(answer.questionIndex)));
  const snapshotAnswered = (data?.answeredQuestions ?? []).filter(index => (data?.items.find(item => item.questionIndex === index)?.attempt ?? 1) === attemptAt(index));
  const socketAnswered = sock.answeredQuestions.filter(index => attemptAt(index) === 1 || (sock.ownAnswers.get(index)?.attempt ?? 1) === attemptAt(index));
  const answered = new Set([...snapshotAnswered, ...socketAnswered, ...answers.keys()]);
  const saved = question ? answers.get(question.questionIndex) : null;
  const submitted = question ? answered.has(question.questionIndex) : false;
  const pending = question && submitted ? sock.pendingSubmittedAnswer(question) : null;
  const submittedOptions = pending ? pending.selectedOptions : question && saved ? toOptionLabels(saved.selectedOptions, question.options)
    : submitted && question?.questionIndex === sock.currentQuestion?.questionIndex ? sock.submittedOptions : [];
  const submittedResponseText = pending ? pending.responseText
    : saved?.responseText ?? (submitted && question?.questionIndex === sock.currentQuestion?.questionIndex ? sock.submittedResponseText : null);
  // Clear earlier drafts even while their content is waiting for a refresh or another item is being viewed.
  if (sessionId && seatKey && sock.sessionToken) for (const item of items) {
    const attempt = attemptAt(item.questionIndex);
    const itemKey = draftStorageKey(sessionId, sock.sessionToken, item.questionIndex);
    draftAttempts.current.set(itemKey, Math.max(attempt, draftAttempts.current.get(itemKey) ?? 1));
    if (attempt === 1) continue;
    const current = drafts.current.get(itemKey) ?? readDraft(itemKey);
    const saved = (item.attempt ?? 1) === attempt ? answers.get(item.questionIndex) : null;
    // An untouched cleared draft can take an answer that arrives with refreshed content.
    if (current && (isEarlierAttemptDraft(current, attempt) || (saved && (current.attempt ?? 1) === attempt && current.revision === 0 && !current.selectedOptions.length && !current.responseText))) {
      const next = { ...emptyDraft(), selectedOptions: saved ? toOptionLabels(saved.selectedOptions, item.options) : [], responseText: saved?.responseText ?? "", attempt, ...(item.contentVersion !== undefined ? { contentVersion: item.contentVersion } : {}) };
      drafts.current.set(itemKey, next); persisted.current.set(itemKey, writeDraft(itemKey, next));
    }
  }
  const key = sessionId && seatKey && sock.sessionToken && item ? draftStorageKey(sessionId, sock.sessionToken, item.questionIndex) : null;
  // Reads are scoped synchronously, so a seat change cannot show a previous seat's draft for one frame.
  let draft: ParticipantDraft | null = null;
  if (key && item) {
    const attempt = attemptAt(item.questionIndex);
    draftContentVersions.current.set(key, item.contentVersion);
    draft = drafts.current.get(key) ?? readDraft(key);
    if (!draft || (draft.attempt ?? 1) > attempt) draft = { ...emptyDraft(), selectedOptions: submittedOptions, responseText: submittedResponseText ?? "", ...(attempt > 1 ? { attempt } : {}), ...(item.contentVersion !== undefined ? { contentVersion: item.contentVersion } : {}) };
    // Labels can mean something else in replacement content. Keep text for deliberate
    // review, but never carry an earlier choice into the replacement's submit handler.
    // Unknown provenance (drafts saved by older clients) also needs a fresh choice.
    if (item.contentVersion !== undefined && draft.contentVersion !== item.contentVersion && draft.selectedOptions.length) {
      draft = { ...draft, selectedOptions: [] };
      drafts.current.set(key, draft); persisted.current.set(key, writeDraft(key, draft));
    }
  }
  void draftVersion;
  const setDraft = useCallback((patch: Partial<Pick<ParticipantDraft, "selectedOptions" | "responseText">>) => {
    if (!key || !question || (question.attempt ?? 1) < (draftAttempts.current.get(key) ?? 1)) return;
    if (draftContentVersions.current.get(key) !== question.contentVersion) return;
    let current = drafts.current.get(key) ?? readDraft(key);
    if (!current || (current.attempt ?? 1) > (question.attempt ?? 1)) current = { ...emptyDraft(), selectedOptions: submittedOptions, responseText: submittedResponseText ?? "" };
    const next = { ...current, ...patch, revision: current.revision + 1, ...(question?.attempt ? { attempt: question.attempt } : {}), ...(question.contentVersion !== undefined ? { contentVersion: question.contentVersion } : {}) };
    drafts.current.set(key, next); persisted.current.set(key, writeDraft(key, next)); setDraftVersion(v => v + 1);
  }, [key, submittedOptions, submittedResponseText, question?.attempt, question?.contentVersion, !!question]);
  const canAnswer = (!sock.availability || sock.availability.phase === "active") && !!question && sock.sessionState === "QUESTION_OPEN" && !isSlideType(question.questionType)
    && (selfPaced ? (data?.answerableQuestionIndexes.includes(question.questionIndex) ?? false)
      : question.questionIndex === sock.currentQuestion?.questionIndex)
    && (question.questionType === "open_response" || !submitted);
  const available = items.filter(item => !isSlideType(item.questionType ?? "multiple_choice"));
  const answeredCount = available.filter(item => answered.has(item.questionIndex)).length;
  const upToDate = available.length > 0 && answeredCount === available.length;
  const progressLabel = available.length ? `${answeredCount} of ${available.length} available questions answered` : null;
  const browse = (index: number) => {
    if (canBrowse && seatKey && items.some(item => item.questionIndex === index)) {
      setNavigation({ seatKey, index }); writeStudyPosition(seatKey, index);
    }
  };
  const backToPresenter = () => { if (seatKey) { setNavigation({ seatKey, index: null }); writeStudyPosition(seatKey, null); } };
  const submitAnswer = (payload: AnswerSubmitPayload) => {
    if (canAnswer && sock.connected && question && payload.questionIndex === question.questionIndex) sock.submitAnswer(answerForQuestion(payload, question), question.options);
  };
  return { selfPaced, canBrowse, following, items, viewedIndex, question, canAnswer, submitted, submittedOptions, submittedResponseText,
    draft, draftPersisted: !!key && (persisted.current.get(key) ?? !!readDraft(key)), setDraft, submitAnswer, browse, backToPresenter, progressLabel, upToDate, error, refresh };
}
