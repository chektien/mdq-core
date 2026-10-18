import type { DeckValidationReport } from "@mdq/shared";

export default function DeckValidationNotice({ report }: { report: DeckValidationReport }) {
  return (
    <div role="alert" className="bg-red-900/50 border border-red-700 text-red-200 px-4 py-3 rounded-xl max-w-2xl w-full space-y-4 break-words">
      <h2 className="text-lg font-semibold">Fix deck Markdown before creating a session</h2>
      <p>{report.issueCount} {report.issueCount === 1 ? "issue" : "issues"} in {report.files.length} {report.files.length === 1 ? "file" : "files"}. All reported issues are listed below.</p>
      {report.files.map((file) => (
        <section key={file.sourceFile} className="space-y-3">
          <h3 className="font-mono font-semibold">{file.sourceFile}</h3>
          <ul className="space-y-4">
            {file.issues.map((issue, index) => (
              <li key={index} className="space-y-1">
                <p className="font-mono">{file.sourceFile}{issue.lineNumber === undefined ? "" : `:${issue.lineNumber}`} ({issue.questionIndex < 0 ? "header" : `item ${issue.questionIndex + 1}`})</p>
                <p>{issue.detail}</p>
                <p>Likely fix: {issue.likelyFix}</p>
              </li>
            ))}
          </ul>
        </section>
      ))}
      <p>Save the corrected Markdown, then choose Reload Decks below. No server restart is needed. More issues in the same item may appear after its first error is fixed.</p>
    </div>
  );
}
