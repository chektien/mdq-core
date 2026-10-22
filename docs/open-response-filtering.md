# Open-response language filtering

MDQ checks open-response text in the shared server engine before accepting or
storing it. Blocked text is not sent to the instructor or projector. The phone
receives “Please revise your response and remove inappropriate language.” and
can submit revised text. A refused edit does not overwrite an earlier accepted
response. Manual Hide/Show remains available for accepted responses.

The modest English and Singapore-local blocked-term list lives in
`packages/server/src/text-filter.ts`. Matching uses whole terms, Unicode NFKC
normalization, case folding and optional punctuation, whitespace or format
characters between letters. It avoids short ambiguous terms and does not match
substrings inside classroom words such as “class” and “assessment”. Accepted
text is not rewritten. This is not comprehensive multilingual or adversarial
moderation and uses no AI or external service.

`createBlockedTextMatcher(terms)` can be reused for other server-side text
inputs. Host-specific policies stay in the host adapter. For example, a host
that already masks sensitive text before calling the engine can keep doing so.

Hosts can pass an optional fifth argument to `apply(input, quiz, command, now,
options)`: `EngineOptions.openResponseFilter` defaults to
`containsBlockedLanguage`, accepts `false` to disable the language check, or a
`(text: string) => boolean` matcher (for example, from
`createBlockedTextMatcher`) that returns `true` to refuse text instead of using
the default matcher. This option applies only to that call and is not stored;
trimming and all other answer checks are unchanged. The local server keeps the
default filter.

# Answer status and close retries

The presenter and projector show “N answered” independently of “M online”. A
device disconnect does not discard its answer, so the two numbers can differ.
The existing socket payload remains compatible with older clients.

Closing an already closed or revealed current question is harmless and does
not change the original timer/manual-close outcome or rebroadcast a close.
The presenter sends `questionIndex` and `startedAt` to identify the opening.
A delayed request for another opening is refused without closing the new one.
Older clients may still send a bodyless close, but cannot provide that stale
opening protection. No-op retries do not restart timers.
