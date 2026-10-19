# Local trial-run classification

Use this after ending a local quiz rehearsal or test. It is local artifact housekeeping only, with **no Cloud history, attendance-policy, or billing meaning**. No server restart is needed. It does not remove participant progress, submissions, CSVs, or session snapshots.

## Inspect or override an ended run

The session ID is in the generated quiz summary or `data/sessions/` snapshot filename. From the repository root, inspect its current decision and review history:

```sh
npm run classify:local -- --session SESSION_ID
```

Explicitly classify a rehearsal, or correct a suggestion for a genuine classroom run:

```sh
npm run classify:local -- --session SESSION_ID --set trial --reason "Instructor rehearsal before class"
npm run classify:local -- --session SESSION_ID --set normal --reason "Confirmed genuine small classroom run"
```

Add `--data-dir ./other-local-data` when the server uses a custom data directory. Use the same directory as the server. The command builds the local server CLI before running, requires an ended session snapshot, and never contacts Cloud or starts a server. Keep reasons free of unnecessary personal information.

Manual decisions take precedence over suggestions and remain effective if artifacts are saved again. Each change appends a timestamped decision and reason to the classification file. Repeating a decision appends another review entry. The command reports a nonzero exit status on invalid input or failed updates. If a derived summary or winner update fails, the classification is already durable and excluded runs remain blocked by the ordinary winner readers. Resolve the file error and rerun the same command to refresh derived artifacts.

## Conservative suggestions

On session-end persistence, a run is tagged `possible-trial` only when **all** these signals hold:

- One or two participants, all with clearly synthetic IDs such as `test1`, `demo`, or `trial-user-2`. Names are not used.
- At most two minutes from session creation to the end of the run.
- At least two non-slide questions and submissions for fewer than all those questions.

This is only a suggestion, not proof. A small class, a short or interrupted session, low scores, or incomplete participation alone never triggers it. An empty run is not flagged automatically. Ordinary IDs are not inferred to be tests from names or response behavior. Runs without these combined signals are `normal`; an instructor can explicitly mark a missed rehearsal `trial`.

`trial` and `possible-trial` runs are excluded from ordinary weekly/cumulative winners. A suggested genuine run needs an explicit `normal` override to include it. Existing runs without metadata retain their previous normal behavior and are not retroactively guessed.

## Artifacts and consolidation

- `data/classifications/SESSION_ID.json` holds the current decision, reasons, aggregate suggestion evidence, and complete decision history.
- The existing summary markdown has a **Local Run Classification** section. Overrides refresh that section without changing quiz statistics.
- Session snapshots, raw submission JSON, and CSV answers/timestamps retain their existing paths and content.
- `data/results/SESSION_ID.json` preserves per-session computed results, including excluded runs. This is an archive, not an ordinary winner directory.
- `data/winners/QUIZ_KEY.json` remains the ordinary weekly view. Reclassification selects the latest eligible archived result for that quiz key, without counting a week twice. If no eligible result remains, the old winner file is retained under `data/winners/excluded/` instead. Legacy winner files are archived before replacement. Pre-feature runs whose old winner was already overwritten cannot be reconstructed automatically.

Built-in weekly and cumulative winner readers exclude flagged runs, including when a classification file is unreadable. To obtain the safe input manifest for an external CSV consolidation, use:

```sh
npm run classify:local -- --eligible-csvs
```

The JSON result lists existing CSVs for eligible ended local runs only. After building once, `node packages/server/dist/classify-local-run.js --eligible-csvs` emits just JSON for scripting. It does not merge files, de-duplicate participant rows across runs, or include still-active reveal-progress CSVs.

**Do not consolidate by blindly globbing raw CSVs or the per-session result archive.** External consumers that do not use this manifest must consult each session's classification and include only `normal` runs (missing metadata means legacy normal, unreadable metadata means exclude pending repair). The server helper `isRunEligible(sessionId, dataDir)` applies that rule. Always preserve raw inputs and review `possible-trial` runs separately.

Classification files and exports are local runtime data. Do not commit classroom data to the public repository. This feature does not alter Cloud history or implement any deletion, retention, or payment policy.
