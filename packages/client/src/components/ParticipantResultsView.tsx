import type { ParticipantResultsPayload } from "@mdq/shared";
import QuizHtml from "./QuizHtml";
import InlineMarkdownText from "./InlineMarkdownText";
import Leaderboard from "./Leaderboard";
import { toOptionLabels } from "../ownAnswers";

/** Own answers plus the deliberately narrow public board, never an instructor result record. */
export default function ParticipantResultsView({ results, onDone }: { results: ParticipantResultsPayload; onDone?: () => void }) {
  const scored = results.summary.scoredQuestionCount ?? 0;
  return (
    <main className="student-screen min-h-dvh p-4 pb-safe space-y-6">
      <h1 className="text-2xl font-semibold text-white">{scored ? "Your results" : "Your participation"}{results.deckTitle ? ` for ${results.deckTitle}` : ""}</h1>
      <p className="student-screen-quiet text-sm text-zinc-400">
        {results.summary.availableQuestionCount > 0
          ? `${results.summary.answeredCount} of ${results.summary.availableQuestionCount} available questions answered.`
          : "No questions were shown in this session."}
      </p>
      {scored > 0 && results.leaderboard && (
        <Leaderboard entries={results.leaderboard.map(row => ({ publicKey: row.publicKey, label: row.label, rank: row.rank, correctCount: row.score }))}
          totalQuestions={scored} highlightPublicKey={results.publicKey} showStudentIds={false} compact />
      )}
      {results.questions.map(({ question, answer, correct, correctOptions, explanation }) => {
        const selected = answer ? toOptionLabels(answer.selectedOptions, question.options) : [];
        return (
          <section key={question.questionIndex} className="border-t border-zinc-700 pt-4 space-y-3" aria-label={question.topic || "Your answer"}>
            <h2 className="text-lg font-semibold text-white">{question.topic}</h2>
            <QuizHtml className="quiz-html student-question-text text-zinc-300" html={question.text} />
            <p className="student-screen-text text-zinc-300">{correct === undefined ? answer ? "Submitted" : "Not answered" : correct ? "Correct" : answer ? "Incorrect" : "Not answered"}</p>
            {answer?.responseText && <p className="student-panel-text whitespace-pre-wrap text-zinc-200">{answer.responseText}</p>}
            {question.options.filter(option => selected.includes(option.label)).map(option => (
              <div key={option.label} className="student-panel-text flex items-start gap-3 text-zinc-200"><span>{option.label}</span><QuizHtml className="quiz-html student-panel-text" html={option.text} as="span" /></div>
            ))}
            {correctOptions && <div className="student-screen-quiet text-sm text-zinc-400">Correct answer{correctOptions.length === 1 ? "" : "s"}: {correctOptions.join(", ")}</div>}
            {question.options.filter(option => correctOptions?.includes(option.label) && !selected.includes(option.label)).map(option => (
              <div key={option.label} className="student-panel-text flex items-start gap-3 text-zinc-200"><span>{option.label}</span><QuizHtml className="quiz-html student-panel-text" html={option.text} as="span" /></div>
            ))}
            {explanation && <InlineMarkdownText text={explanation} className="student-panel-text text-zinc-200" />}
          </section>
        );
      })}
      {onDone && <button type="button" onClick={onDone} className="student-done-button rounded-xl border border-zinc-600 px-6 py-3 text-white">Done</button>}
    </main>
  );
}
