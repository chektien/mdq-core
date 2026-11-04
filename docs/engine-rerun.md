# Re-running a question

`apply(session, quiz, command, now)` accepts a presenter command to ask a question
again as a new attempt. This is an engine API. Core provides no HTTP route or
instructor button for it.

```ts
const result = apply(session, quiz, {
  type: "rerun",
  role: "control",
  questionIndex: 0,
  archived: oldQuestion,
}, now)
```

The host installs `result.session`, persists it and routes `result.messages` by
audience in order, including scheduling any new question deadline. The command
archives the current answers, timing, reveal and moderation, advances the attempt
and clears that item's active answers. Earlier attempts remain in
`session.attemptArchive`. Counts and leaderboards use only active attempts.

`archived` is optional and defaults to the question in the session's current
snapshot. A host that has already replaced content must pass the old `Question`
as `archived`, so the archive keeps the prompt, options and key people answered.

A presenter-paced re-run only accepts the current question. It reopens from
QUESTION_OPEN, QUESTION_CLOSED, REVEAL or LEADERBOARD with a fresh clock. Timing
fairness is invalidated and the session ranks by correctness. A self-paced re-run
only accepts a released question. It keeps the current index, state, released set
and browsing positions, and emits state with `questionAttempts` to refresh item
lists. Availability is never extended.

The engine refuses a role other than `control`, LOBBY, ENDED, a final results
scope, inactive availability, a missing or invalid index, slides, an unreleased
self-paced item and a non-current presenter-paced item. Policy-less legacy
sessions cannot re-run, because their historical ranking ignores timing fairness.
Each refusal leaves the input session unchanged.

## Client compatibility

`QuestionOpenPayload.attempt` and `StudentAnswer.attempt` are absent on attempt 1
and contain the attempt number from 2 onwards. `SessionStatePayload.questionAttempts`
is a sparse map of indexes to attempts above 1, present after a re-run. Clients
use it to refresh items even if state and availability have not changed. After a
re-run, the snapshot a participant gets on joining or reconnecting also carries
this state, so a page that missed the announcement still learns each new attempt.
That participant-only state also includes `answers` with the participant's current
own answers across released items. Hosts route it only to the named participant,
in order before the opening and reveal replay. Clients reconcile attempts first,
then own answers, so a snapshot without a join restores an accepted answer from
the current attempt. Older clients can ignore the additive field. Control,
display and broadcast state never include it.
A participant snapshot in a session that was never re-run carries no state, as
before.

`AnswerSubmitPayload.attempt` is an optional positive safe integer. Omission means
attempt 1. An older client that omits it keeps working on a question that has never
re-run. After a re-run, a client must send the displayed item's current attempt.
The engine refuses missing, malformed, earlier or future attempts before accepting
an answer, so a delayed earlier selection cannot be scored against new options.
Core's client sends the displayed content's attempt after a re-run. An announced
attempt immediately invalidates earlier answers, drafts and the live poll cache,
including cached item answers. An item with older content shows a loading state
until refreshed content arrives. A failed refresh keeps it waiting and offers
Retry. If HTTP discovers a newer attempt while an archived reveal or leaderboard
is shown, the page hides that context and offers Retry until the current opening
or a fresh authoritative leaderboard arrives. An attempt advance invalidates the
cached leaderboard. This Retry refreshes items and reconnects for current socket
context, even if the page holds no opening for the re-run question. Initial
leaderboard joins without an attempt advance keep their normal rendering.
Submissions never use an announced attempt with earlier content.
After the session has re-run any question, newly accepted answers have a
server-owned `acceptedRevision`. The engine increments it within a seat, question
and attempt, starting at 1. This includes questions still on attempt 1 in that
session. It is stored on `Submission` and sent in `AnswerAcceptedPayload`, join
answers, participant snapshot answers and HTTP item answers. `submittedAt` is not
an ordering key, because two acceptances can share a timestamp and the host clock
can move backwards.

Clients compare attempts first. A higher attempt wins regardless of revision.
Within an attempt, when both answers carry revisions, only a higher revision
replaces known accepted content. Equal versions are idempotent. HTTP, snapshots,
same-seat joins and ACKs use this rule, including across disconnect. A missing
answer never means deletion. A later attempt watermark invalidates the earlier
answer instead. Re-run joins include `StudentJoinedPayload.questionAttempts` so
even an unanswered new attempt invalidates earlier knowledge before opening
replay. New seats start with fresh knowledge.

A missing `acceptedRevision` means unordered. Within the same attempt, if either
answer is unordered, the incoming server answer wins unless an HTTP request
started before the page accepted an ACK. That request cannot replace known
accepted content in the same attempt. The page records a local ACK epoch
synchronously so this protection applies before React renders. Requests started
after the ACK and reconnect replay still accept incoming unordered answers.
Such answers cannot otherwise express acceptance order, so a delayed server
response can replace a later one. Attempt watermarks still reject archived
answers. No client infers revisions from arrival or timestamps.

Stored-session readability after a rollback to main does not guarantee live
recovery of re-run questions. Main omits both `attempt` and `acceptedRevision`
from own answers and sends no participant `session:state` snapshot. A page that
already saw attempt 2 treats main's answers and openings as attempt 1 and rejects
them. HTTP refresh and reconnect cannot recover an accepted edit to that re-run
question. An accepted edit with a lost ACK can therefore leave the page stuck on
its previously known answer until reload. Reload clears the page's attempt
knowledge and lets it read main's current answer as attempt 1. On a fresh join,
a persisted draft for a later attempt displays the server's current answer or
an empty draft. The first edit replaces that stored draft at the reported attempt.
This keeps editing available while preserving a later draft if its matching
opening arrives before an edit. The page still rejects draft callbacks below the
highest attempt it has seen for that session and seat.

Successful item refreshes reconcile accepted answers into socket state for
presenter reveals and self-paced items. The study view compares revisions when
combining HTTP and socket answers, and keeps socket precedence for unordered
answers. A new HTTP response first reconciles into socket state using the ordering
and ACK epoch rules above. Pending display stays separate from that accepted
knowledge.

Pending submissions are separate from accepted knowledge. A snapshot or HTTP
response can update the accepted answer while the latest matching pending edit
stays on screen. Repeated openings and same-seat joins preserve that pending
display, including when returning to an item. ACKs consume pending submissions in
socket order and apply the accepted revision to the matching entry. An ACK from
an older attempt is consumed without changing own answers, answered marks or the
shown answer. An unmatched ACK is ignored. A current ACK marks the shown item
submitted only when its attempt matches. A later pending edit keeps its content
when an earlier ACK arrives. When no edit remains pending, display uses the
highest accepted version for ordered answers, including when an ACK is older
than a known snapshot. Unordered ACKs accept their matched pending content.
Rejections consume their entry and retain retry content without promoting it to
an accepted answer. The study view reads actual pending entries and returns to
the accepted answer after rejection, while keeping the retry draft.

Same-seat joins and snapshot replay never lower the highest known attempt. An
opening older than that attempt is ignored. Disconnect drops pending ACK matching
and retains accepted versions, so a lost ACK cannot consume a later submission and
a stale versioned reconnect response cannot roll accepted knowledge back. Equal or older
replay can still restore display from the highest accepted answer after pending
correlation is dropped. Openings also seed that accepted answer when no matching
pending entry remains. This does not replace accepted knowledge. Counts carry no
participant acceptance order and never write participant answer fields. Core
routes these projections to staff. Hosts must preserve socket message order,
including one acceptance or rejection to the submitting transport for each
submission.

## Reconciliation audit

Own means `ownAnswers`, answered means `answeredQuestions`, and display means
`submitted`, `submittedOptions` and `submittedResponseText`.

| Path and fields | Earlier delivery before advance | Advance before earlier delivery | Within an attempt |
| --- | --- | --- | --- |
| Attempt announcement, own, answered and display | A later watermark clears all three | Equal or lower watermarks cannot restore them | No revision is invented from an announcement |
| Join, own, answered and display | Join seeds accepted versions, later watermark clears them | Same-seat versions and attempt watermarks remain monotonic | Merge higher revisions or unordered server answers, keep pending display and FIFO correlation |
| Snapshot, own, answered and display | Reconcile watermarks before answers | Filter archived attempts before merging | Higher revisions or unordered server answers replace accepted content, pending display stays separate |
| Opening, display and invalidation | Invalidate old answers before seeding | Ignore an opening below the highest known attempt | Seed highest accepted content or latest matching pending content |
| Reveal, none of these fields | Read reconciled opening context | Cannot restore answer fields | Reveal carries results only |
| ACK, own, answered and display | Record acceptance, later watermark clears it | Consume archived or unmatched outcome without restoring fields | Merge revision, consume FIFO entry, display remaining pending or highest accepted answer |
| Rejection, none of these fields | Consume entry and show refusal | Cannot restore accepted state or answered mark | Keep retry content, never promote rejected content |
| HTTP refresh, own, answered and display | Reconcile item attempts before answers | Filter answers below highest attempt | Compare revisions, keep known unordered content if the request predates an ACK, study merge also compares versions |
| Submission, display | Record pending content, later watermark clears shown content | Old or mismatched content cannot seed display | Latest matching pending content wins until its outcome |
| Count, none of these fields | Staff evidence only | Cannot restore participant fields | No acceptance order, no participant reconciliation |
| Disconnect and reconnect, no immediate answer writes | Clear lost pending matching | Keep highest attempt and accepted revision | Reconcile versions and restore accepted display after pending correlation is dropped |
| Session, role or seat change, own reset | New credentialed view seeds fresh knowledge | Session or role changes disconnect the old transport. A new seat resets knowledge on join | Pending correlation is scoped to the seat and transport |

## Stored-session compatibility

Serialization preserves optional revisions on active and archived submissions.
Restoring old records does not invent revisions or change their serialized bytes.
After a session re-runs, the next accepted replacement of an unordered record
starts at revision 1. Re-run archives keep existing records unchanged and a new
attempt starts at revision 1. The policy-less `recordSubmission` helper cannot
re-run and keeps its original revisionless records.

Sessions that never re-run keep their first-opening payloads, accepted answer
records, ACKs, join answers, participant snapshots and HTTP items byte for byte.
They add neither attempt fields nor revisions. The original golden fixtures and
exact byte comparisons cover these paths. No migration or live restart is needed
to read old stored sessions.
