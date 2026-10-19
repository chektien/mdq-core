# Fixing deck validation errors

If a deck cannot load, the instructor setup page lists every reported issue,
grouped by Markdown filename. Each issue includes its file and line, item or
header, original parser diagnostic, and a likely syntax fix. Validation blocks
new sessions until the files are corrected. Other valid files do not hide a
broken file's diagnostics.

1. Edit the named Markdown file at the reported line.
2. Save the file.
3. Choose **Reload Decks** on the instructor setup page. This button remains
   available even when no decks loaded.
4. Check the updated report. The parser reports the first blocking error in
   each item, so fixing it can uncover another error in the same item.
5. When validation passes, select a deck and create the session.

No server restart or page refresh is needed. Reload Decks reads the configured
deck directory again and replaces cached validation results. If the library is
empty, add a deck and choose the same button. A network or permissions error
is not a successful reload; the page reports the error so you can retry.

## Written responses need an explicit type

A question defaults to multiple choice. Bold prompt text such as **Short Answer
Question** does not change its type. An item without lettered answer options
therefore needs `type: open_response` if participants should write a response.

```markdown
# Example deck

---

## Reflection
type: open_response

Name one tool you would use and explain why.

> Overall Feedback: Compare the tools and their trade-offs.
```

Open responses must not contain lettered options, `multi_select:`, or a
`> Correct Answer:` / `> Correct Answers:` line. Use `> Overall Feedback:` for
discussion guidance. For multiple choice, keep the default and supply options
such as `A. First choice`, `B. Second choice`, and `> Correct Answer: A`.

## API behavior

`GET /api/decks`, `POST /api/decks/reload`, and session creation return HTTP 409
when deck validation is blocked. The existing `error` string remains available
to clients and includes all reported diagnostics and likely fixes. The additive
`validation` object contains `issueCount` and `files`, each with `sourceFile`
and `issues`. Each issue includes `questionIndex`, `lineNumber` when known,
unchanged parser `detail`, and presentation-only `likelyFix` guidance.
The legacy `/api/quizzes` and `/api/quizzes/reload` aliases behave identically.
Reload still requires instructor authentication when configured.
