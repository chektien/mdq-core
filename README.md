# MDQ Core

The open-source engine for MDQ: human- and agent-friendly Markdown Decks &
Quizzes.
No clunky interfaces. No proprietary nonsense. No database.
Just your own machine and a public secure tunnel.

MDQ Core turns a markdown file into a live class session: sparse slides, quiz
questions, polls, open responses, fold-out notes, live embedded demos, answer
reveals, leaderboards, and printable PDF packets all come from the same deck.

## Demo

https://github.com/user-attachments/assets/6ce84fce-3841-4ec1-979c-29df1631967e

The walkthrough shows the current flow: open MDQ, choose an instructor session,
pick a markdown deck, show the join QR, move through slides and questions, answer
from a phone-sized student view, reveal feedback, use fold-out notes and image
placement, and export a printable PDF.

A future cut should also show the presenter-view workflow: the projected laptop
opens the read-only presentation surface while the instructor advances and
reveals content from an authenticated phone view.

## What MDQ Does

- **Markdown-first authoring**: write decks as plain text, keep them in git, and
  let humans or agents revise them without an export/import round trip.
- **Slides and quizzes in one deck**: mix explanation slides, MCQs, multi-select
  questions, polls, open responses, and leaderboard moments in sequence.
- **Live instructor/projector surface**: run a session with pinned controls,
  fullscreen support, review mode, guarded session ending, QR/join links, and a
  read-only projector route.
- **Student join and answer flow**: students join from any device and answer
  without needing accounts.
- **Slide-friendly markdown**: sparse slide bodies can include bullets, images,
  references, and fold-out attendee or presenter notes.
- **Live embedded slides**: a slide can embed a live web demo while keeping normal
  markdown text and a static PDF fallback.
- **Image positioning**: slide images preserve aspect ratio and can be placed
  left, right, top, bottom, or background-style with markdown hints.
- **Printable PDFs**: export handouts, answer keys, and presenter-note packets
  from the same markdown deck.

## Why This Exists

MDQ is optimized for short instructor-led sessions where interaction matters more
than slide decoration. The authoring surface is markdown; the live surface is a
classroom tool. That makes it small enough to run locally, easy to version, and
easy to adapt during teaching.

Use MDQ when you want:

- markdown files as the source of truth
- quiz-centered pacing and discussion
- a lightweight local deployment instead of a multi-tenant quiz platform
- fast deck edits before or during a teaching session
- generated session artifacts that stay on the machine running the class

## Repo Layout

- `packages/`: client, server, and shared TypeScript code.
- `samples/decks/`: public sample decks for onboarding and smoke tests.
- `samples/images/`: public sample assets copied into local runtime storage.
- `docs/`: public documentation and demo media.
- `data/`: local runtime/private instance data. Keep real decks, generated
  sessions, submissions, winners, access URLs, and private images here.

The repository intentionally keeps `data/` local-first. Only public sample data
should be committed.

## Try MDQ Now

From a fresh checkout, run:

```bash
npm run try
```

This one command installs dependencies, creates local runtime folders, copies the
public sample deck, builds the app, checks the available network mode, and starts
the MDQ server. The launcher defaults to port `2081`; override it with `PORT`:

```bash
PORT=3000 npm run try
```

The launcher prints the requested instructor URL before the server starts, and
the server prints the actual bound URL if it has to use a fallback port. If
Tailscale is unavailable, it clearly marks the run as local/mock testing only:
good for checking how the quiz looks, projector flow, and mock students, but not
a real public classroom link. After creating a session, you can simulate students
locally with the mock-student command printed by the launcher.

If Tailscale is available, the launcher binds MDQ to localhost so it can sit
behind a proxy without competing with Tailscale's own listener. It checks whether
Funnel already proxies to the MDQ port, but it will not rewrite the shared
Tailscale hostname automatically because that hostname may already serve other
tools. To see the guarded publish path, run:

```bash
npm run try -- --publish
```

For a strictly local run that never offers to change Tailscale Funnel state:

```bash
npm run try -- --local-only
```

## Manual First-Time Setup

Install dependencies and create local runtime folders:

```bash
cd /path/to/mdq
npm install
npm run setup:local
```

This creates `data/` directories, copies public sample decks into
`data/decks/`, and copies sample images into `data/images/`. Deck filenames do
not need to start with `week`; MDQ uses the markdown filename stem as the deck
ID.

Optional local runtime settings live in `data/config.json` (copy from
`data/config.example.json`). The tracked example includes `theme`, which accepts
`dark` or `light`, and `palette`, which accepts `classic` (the default),
`gruvbox`, `rose-pine`, `catppuccin`, `seoul256`, `ayu`, or `tokyo-night`.
`MDQ_PALETTE` overrides the file's `palette`.

Individual decks can override those global fallbacks in the Markdown preamble:

```markdown
# My Deck
theme: light
palette: gruvbox

---
```

Use any palette name from the list below in place of `gruvbox`, for example
`palette: rose-pine` or `palette: tokyo-night`.

`theme` accepts only `light` or `dark` (case-insensitive, with optional quotes).
When it is omitted, every instructor, student, and projector view uses the
global runtime theme. The PDF export theme remains controlled independently by
its `--theme` command-line option.

`palette` chooses the slide colours independently of the light/dark theme. It
accepts `classic`, `gruvbox`, `rose-pine`, `catppuccin`, `seoul256`, `ayu`, or
`tokyo-night` (case-insensitive, with optional quotes); any other value is a
deck parse error. `classic` is MDQ's standard look. Every other palette applies
in both the light and dark theme, and each theme uses one official variant of
the upstream palette:

| Palette | Light theme | Dark theme |
| --- | --- | --- |
| `gruvbox` | Gruvbox light accents on a neutral grey | Gruvbox dark |
| `rose-pine` | Rosé Pine Dawn | Rosé Pine |
| `catppuccin` | Catppuccin Latte | Catppuccin Mocha |
| `seoul256` | seoul256 light | seoul256 dark |
| `ayu` | Ayu Light | Ayu Dark |
| `tokyo-night` | Tokyo Night Day | Tokyo Night (night style) |

Where an official colour is too faint to read as text, MDQ uses the nearest
shade from the same palette, or darkens or lightens it slightly, so text stays
legible. Upstream sources and licences are listed under
[Palette credits](#palette-credits). When `palette` is omitted, every instructor, student, and projector view
uses the global runtime palette. The PDF exporter follows the deck's palette
unless you pass `--palette`.

Build and run the app:

```bash
npm run build
npm run start --workspace=@mdq/server
```

Open the instructor route locally:

```text
http://localhost:2081/#/instructor
```

For class use, set `INSTRUCTOR_PASSWORD` and expose only the student join URL or
QR code shown by MDQ.

## Tailscale Funnel Setup

mdq works best when the instructor machine is reachable through Tailscale Funnel.

If you are starting from scratch with your own personal Tailscale account, do this:

1. Go to `https://tailscale.com/` and create an account.
2. Install Tailscale on the computer that will run mdq.
3. Sign in to Tailscale on that computer.
4. Turn Tailscale on:

```bash
tailscale up
```

5. Check that Tailscale is working and note your `*.ts.net` device name:

```bash
tailscale status
```

6. Publish the mdq port with Funnel:

```bash
tailscale funnel 3000
```

7. Start mdq.
8. mdq auto-discovers the current Tailscale DNS name by calling `tailscale status --json` on startup, so a tailnet hostname change does not need a repo edit. The detected public base URL is cached locally in `data/access/current.json` and the instructor screen uses it to generate the join URL, is.gd, and QR code.
9. Share the mdq join URL, is.gd, or QR code with students.

Common gotchas:

- If `tailscale status` does not show your device, finish signing in first.
- If `tailscale funnel 3000` fails, Funnel is usually not enabled yet for your account or device in the Tailscale admin page.
- If mdq starts on a port other than `3000`, run Funnel on that actual port instead.
- If you rename the device or change the tailnet hostname, restart mdq so it refreshes `data/access/current.json` from the latest `tailscale status --json` output.
- When class ends, stop mdq and stop the Funnel exposure.

## Run

### 1) Instructor setup (server machine)

```bash
# required if you want instructor-only controls
export INSTRUCTOR_PASSWORD="choose-a-strong-local-secret"

# optional: override instructor hash route (build-time)
# use a long cryptic segment for class use
export VITE_INSTRUCTOR_ROUTE_SEGMENT="instructor"

npm run build
npm run start --workspace=@mdq/server
```

Open `http://localhost:<server-port>/#/<instructor-route-segment>`.

Default server port is `3000`, with fallback retries enabled when that port is occupied.

If `VITE_INSTRUCTOR_ROUTE_SEGMENT` is unset, the default segment is `instructor` (backward compatible local dev behavior).

**For classroom security:** Assume students can see the final Tailscale host URL (is.gd redirects reveal it, and MDQ QR codes target the full join URL directly). Treat join links as classroom-shareable, and protect instructor controls with a strong `INSTRUCTOR_PASSWORD` plus a non-obvious instructor route.

**Security model:** mdq serves one built client bundle to everyone (students and instructor). `VITE_INSTRUCTOR_ROUTE_SEGMENT` is build-time routing only. Real instructor access is gated by a server-side login cookie created after entering `INSTRUCTOR_PASSWORD`. The password is never bundled into client code.

1. Build the client with route segment:
   ```bash
   export VITE_INSTRUCTOR_ROUTE_SEGMENT="instructor-9f2c7b1e4d8a6f3c"
   npm run build --workspace=@mdq/client
   ```

2. On your instructor device, open:

   `https://<your-mdq-host>/#/<VITE_INSTRUCTOR_ROUTE_SEGMENT>`

   Example:

   `https://abc123.ts.net/#/instructor-9f2c7b1e4d8a6f3c`

3. Enter the instructor password on the login page. Login persists for the current browser session (refresh-safe) until the browser session ends.

4. **Important limitation:** The longer route is still obscurity, not authentication by itself. Keep using a strong `INSTRUCTOR_PASSWORD` and avoid sharing your instructor route.

Tip for classroom privacy and mobility: project a separate presentation view from the laptop, then keep the authenticated instructor controls on a phone or other personal device. The projected browser shows only the live session surface while the instructor device moves the session forward.

**For classroom security:** Keep your Tailscale Funnel URL private. The security boundary is your private network (Tailscale) plus operational secrecy (don't share the instructor route with students).

### 2) instructor live surface controls

- The deck picker shows each deck summary as separate quiz question and slide counts, for example `(22 questions, 17 slides)`.
- The live surface uses the configured global presentation theme by default; a deck-level `theme: light` or `theme: dark` preamble setting overrides it for that session.
- The slide palette works the same way: the configured global `palette` applies by default, and a deck-level `palette:` preamble setting (any of the seven palette names) overrides it for that session.
- `Prev` and `Next` stay pinned together near the top-left of the live surface so their click targets do not drift when other controls appear or disappear.
- In live mode, `Next` includes the next item's markdown heading inside the button and `Prev` includes the previous item's heading, cut with an ellipsis when the two do not fit beside the other controls. In review mode, both stay plain buttons.
- The slide's top padding follows the toolbar's measured height plus a gap of 1.4 rem, so the slide title stays clear of the buttons however the toolbar wraps or fills.
- On the instructor and projector pages the page canvas behind the slide is painted in the slide's own bottom colour, in every palette and theme, so any strip a browser shows past the layout viewport (iPad Safari leaves one beside the home indicator in full screen) matches the slide. The home indicator itself is system UI that a page cannot hide.
- Links in slide text open in a new tab (`target="_blank"` with `rel="noopener noreferrer"`) on the instructor view, the projector and the phones, so a tap never replaces the session page. The page adds these attributes when it shows the slide. The generated slide HTML is unchanged. In-page `#` anchors, mail and phone links stay as written.
- In full screen, the controls start to the right of the top-left corner (about 64 by 60 px), where iPad Safari draws its own close button. Outside full screen they do not move.
- `End Session` remains available from the live controls and opens a confirmation dialog before closing the room. The dialog shows how many quiz questions and slides are left.
- The fullscreen control appears when the browser supports the Fullscreen API, letting the instructor/projector surface fill the display without browser chrome.
- Review mode lets the instructor step through previous slides/questions without moving students, then return to the current live item with `Back to Live`.
- Keyboard shortcuts on the instructor view run the same Prev and Next handlers as the buttons. Next: `Right arrow`, `Down arrow`, `Page Down`, `l` or `j`. Previous: `Left arrow`, `Up arrow`, `Page Up`, `h` or `k`. `Page Up` and `Page Down` are the keys most presentation clickers send. The keys do nothing while a button is disabled or the console is reconnecting, while focus is in a text field, while a dialog is open, or with `Ctrl`, `Cmd` or `Alt` held, a held key moves one step only, and they leave their own keys to a video or audio player with controls and to the presenter notes panel. On a narrow screen, where the slide scrolls, `Up arrow` and `Down arrow` scroll it and the other keys still navigate. After you click into a live embed, keys go to the embed until you tap outside it. `Space` is not a shortcut, because it presses whichever button has focus.
- On a touch screen or with a pen, swipe left on the instructor's slide area for Next and swipe right for Previous. A swipe is at least about 60 px and at least twice as far sideways as up or down. It does not start on a button, link, field or the join card, on a table or code block that can still scroll sideways, or within about 24 px of the left or right screen edge, which the system keeps for its own back and forward gestures. Scrolling up and down, pinching and tapping links work as before. The phone and projector views do not swipe.
- On narrow screens, the same controls stack from the top-left so small-device use keeps the same visual order.

### 3) student join flow (share this one)

- Share only the student join URL or QR code from the instructor screen.
- Student QR codes resolve to `/#/join/<SESSION_CODE>` and do not need instructor login.
- Student join flow does not depend on `VITE_INSTRUCTOR_ROUTE_SEGMENT`.

#### Student join form and privacy

The deck's `student-id` header setting decides what the join form asks for. It accepts only `true` or `false` (any other value is a deck parse error) and defaults to `true`. The form learns it from the session code before it shows any fields.

| Setting | Join form |
| --- | --- |
| `student-id: true` (or absent) | Student ID (required, up to 64 characters) and Name (optional, up to 60) |
| `student-id: false` | Name only (required, up to 60), and the name is the participant's ID |

Either way, each participant has one ID that is unique in the session.

- **Names as IDs.** With `student-id: false` the name is normalised (Unicode NFC, trimmed, runs of whitespace collapsed to one space) and compared without regard to case. A name another seat holds is refused straight away, with a message such as `Someone here is already using the name "Alex Tan". Add an initial or your surname, for example "Alex Tan B."`. A name stays held for the whole session, even after its holder leaves.
- **Student IDs.** An ID that is already in the session follows the usual seat rules: the same session token, or the same browser after it went offline, takes the seat back; anyone else is told `The Student ID "..." is already in this session on another device. Use that device, or check that you typed your own ID.`
- **Your own seat is never a clash.** Rejoining with your session token (a reload, a dropped connection) always works.
- **Labels.** Everyone gets a public label, fixed when they join and never reused in that session: their name (`Alex`), `Alex (2)` for the next participant with the same name (ignoring case), or `Participant 3` (in join order) when a participant with IDs on gave no name. A participant whose label differs from what they typed is told why on the waiting screen (`Another participant is also called Alex, so you appear as Alex (2).`).
- **Who sees IDs.** The projector, the leaderboard on phones and on the projector, and other students see labels only, never Student IDs. Each participant also gets a random per-session public key (not derived from the ID) which public payloads use in place of the ID, so a phone can still highlight its own leaderboard row. The instructor's view, and the results CSV, show Student IDs and names. `GET /api/session/:id/leaderboard` is public, so it returns labels and public keys only. `GET /api/leaderboard/cumulative` (saved results) and the open responses in the instructor's restore (`GET /api/session/:id/state`) return Student IDs and names only to a request that is logged in as the instructor. With an instructor login set, everyone else gets a 401 for both. With no login set nobody can prove they are the instructor, so both return labels only: saved results as `label` (the name, or `Participant N` by rank, with `(2)` added to repeats) instead of `studentId`, and restored open responses by label.
- **What the instructor view needs from a server.** The bundled instructor view hides its "Show Student IDs" button, and every place it would show an ID, for a deck with `student-id: false`, because the name is the ID. It learns this from a `studentIds` boolean in the `POST /api/session` response and in the `GET /api/session/:id/state` restore response (`false` when the deck turns IDs off). A server or adapter that serves this view should send it in both; when it is missing the view treats IDs as on.
- **Set an instructor login to keep IDs private.** Without an instructor login (`INSTRUCTOR_PASSWORD`), anyone who can reach the server on the network can open the instructor view or connect as the instructor and see Student IDs and names. That is how MDQ has always worked without a login. The labels-only rules above stop the projector, phones and public pages from showing IDs, but they cannot stop someone who joins as the instructor, so set a login whenever the network is not just your own class. The same goes for the results CSV and the Hide control: they are for the instructor, but without a login anyone who can reach the server can use them.
- **`autoGenerateStudentIds`.** The runtime option keeps working exactly as before for decks that use Student IDs: the ID field is hidden, the name is required, and an ID generated on the device is sent. A deck with `student-id: false` takes priority: it asks for a name only and the name is the ID, so no ID is generated, whether or not `autoGenerateStudentIds` is on.

Port fallback retries default to 10 attempts (`PORT_FALLBACKS=10`).

For off-LAN access during class, expose your local server with Tailscale Funnel (or an equivalent secure tunnel):

```bash
tailscale funnel 3000
```

Then share the detected `https://<machine>.<tailnet>.ts.net` URL (or the short URL / QR shown in the instructor screen). mdq reads this from Tailscale automatically on startup.

If students see `Session not found for that code`, verify your Tailscale Funnel is bound to the same port your active MDQ server process is using.

After each quiz session ends:

- Stop the MDQ server process (`Ctrl+C` in the terminal running `npm run start --workspace=@mdq/server`).
- Turn off your active Tailscale Funnel/node exposure for the quiz host before leaving class.

Why Tailscale works (plain language):

- Tailscale creates a secure, encrypted path between your class devices and your MDQ server.
- For normal Tailscale access, each device must be signed in and approved first.
- With Funnel, anyone who has the URL can reach that one published quiz page.
- When you run `tailscale funnel 3000`, you are publishing only the MDQ web app on that one port.
- This is not the same as opening your whole computer. It does not expose your files, terminal, or other apps unless you explicitly publish those too.
- If the link is shared outside class, outsiders could still reach the quiz page, so keep session links short-lived and private.

Student QR behavior:

- QR codes resolve directly to `/#/join/<SESSION_CODE>`
- Students land on the join page with the code pre-filled
- Instructor controls require a valid login session when `INSTRUCTOR_PASSWORD` is configured

### 4) presentation mode (read-only projector view)

- Open the session-scoped `Presentation view` link from the authenticated instructor screen when you want a second display that mirrors the instructor presentation without controls.
- The presentation route is intentionally not linked from the public home page. A code-based public entry point would let students discover the live projector feed and monitor the session outside the instructor flow.
- The presentation screen stays read-only. It never renders instructor action buttons or calls instructor REST actions.
- The projector names participants by label only (lobby, leaderboard and open responses). It never receives Student IDs.
- A common classroom setup is to connect the laptop to the projector, open the `Presentation view` there, then open the authenticated instructor view on a phone. Advancing, reviewing, revealing feedback, and ending the session from the phone updates the projected laptop view in real time.
- This keeps instructor-only controls and route details off the projector while still allowing the instructor to move around the room.

### 5) mock students (for testing)

Spawn fake students that join a session and answer questions randomly:

```bash
npx tsx scripts/mock-students.ts <sessionId|sessionCode> [count=10] [serverUrl=http://localhost:3000]
```

Accepts either a 6-character session code (e.g. `P2KU9R`) or a full session ID. The script resolves codes via the API automatically.

If no session is specified, the script auto-detects the only active session. When instructor auth is enabled, the script uses `INSTRUCTOR_PASSWORD` from the environment to authenticate.

Examples:

```bash
npx tsx scripts/mock-students.ts                # auto-detect active session
npx tsx scripts/mock-students.ts 20             # auto-detect, 20 students
npx tsx scripts/mock-students.ts P2KU9R         # by session code (no auth needed)
npx tsx scripts/mock-students.ts P2KU9R 50      # 50 students
```

Students connect with staggered timing and answer each question after a random delay. `Ctrl+C` disconnects them all.

Requires `socket.io-client` to be resolvable — run `npm install -D socket.io-client` at the repo root if needed.

## Print a Deck to PDF

Export a full MDQ markdown deck as a clean PDF packet from the CLI:

```bash
npm run print:pdf -- data/decks/week00.md --out exports/week00.pdf
```

The exporter builds the shared/server packages, parses the same markdown used by live sessions, renders a print-specific HTML view in Chromium, then writes a mostly vector PDF with crisp text and proportionally scaled images. Dark mode is the default so exported decks keep the original MDQ color direction; use `--theme light` when you want a conventional ink-friendly handout.

Printed decks hide correct-answer highlights, answer blocks, and feedback by default so submission/review packets do not become answer keys. Use `--answers` only when you intentionally need an instructor answer-key export.

The cover is submission-clean by default: it prints the deck title and contents, not local filenames, generated timestamps, theme labels, answer/notes settings, or quiz summary counters.

Run this once on a fresh machine if Chromium has not been installed for Playwright yet:

```bash
npx playwright install chromium
```

Options:

- `--out <file>` writes to a specific PDF path. By default, the PDF is created next to the input markdown file.
- `--foldouts` includes attendee fold-out notes expanded. This is the default.
- `--no-foldouts` hides all fold-out notes for a cleaner handout.
- `--presenter-notes` includes presenter notes as well when you need an instructor-only packet.
- `--answers` includes correct-answer highlights, answer blocks, and feedback for an answer-key packet.
- `--no-answers` hides correct answers and feedback. This is the default.
- `--page-size A4|Letter` chooses the print page size. A4 is the default.
- `--theme dark|light` chooses the PDF color theme. Dark is the default and recommended for submission packets that should preserve the original deck styling.
- `--palette classic|gruvbox|rose-pine|catppuccin|seoul256|ayu|tokyo-night` chooses the PDF color palette. It defaults to the deck's `palette:` setting, else `classic`.
- `--title <title>` overrides the cover title.
- `--html <file>` also writes the generated print HTML for visual debugging.

Examples:

```bash
npm run print:pdf -- data/decks/sample-session.md --theme dark --no-foldouts
npm run print:pdf -- data/decks/sample-session.md --theme dark --answers --presenter-notes
npm run print:pdf -- data/decks/week00.md --theme light --page-size Letter --out exports/week00-letter.pdf
npm run print:pdf -- data/decks/week00.md --theme light --palette gruvbox
```

PDF images keep their source aspect ratio. MDQ only scales images down to fit the print layout, so portrait screenshots and wide diagrams are not stretched, cropped, or reframed.

## Deck Markdown Format

Decks can start with an optional preamble title before the first `---`. This title is used in the instructor deck picker and PDF cover, while the `## ...` headings remain the individual live items.

```markdown
title: Demo Presentation Session

---
```

If the preamble title is omitted, MDQ falls back to the first `# ...` heading for backward compatibility.

A deck can also choose what its join form asks for with `student-id:` in the same preamble (see [Student join form and privacy](#student-join-form-and-privacy)):

```markdown
title: Demo Presentation Session
student-id: false

---
```

`student-id` accepts `true` or `false` (case-insensitive, with optional quotes) and defaults to `true` when it is omitted. `student_id` works too. Any other value is a deck parse error.

Each interactive question supports the existing `time-limit:` metadata plus optional `multi-select:` and `type:` flags. `question-type:` remains accepted as a backward-compatible alias. Questions default to multiple choice when `type:` is omitted, and `type: multiple_choice` can be written explicitly. Type values also accept hyphens in place of underscores, such as `open-response` for `open_response`. Question stems, slide bodies, and option text can also include standard markdown images.

Slide bodies take bulleted lists, numbered lists and nested lists in any mix, indented by two or more spaces. On a slide the top level uses accent markers and each level below it uses a smaller, quieter marker and slightly smaller text, with the same indent per level on the projector and on phones. A list item with no text (a bare `- ` or `1. `) is hidden when the slide is presented and printed, so no empty marker shows, and the numbers of a numbered list count only the items that show. The Markdown itself is left as written.

Setting keys are written with dashes, as above (`time-limit:`, `presenter-notes:`, `slide-background:`). Decks written with the earlier underscored spelling (`time_limit:`, `presenter_notes:`) still work, and so does `type: open_response`; the two spellings can be mixed in one deck.

```markdown
---

## Example Topic: Selection Modes

time-limit: 45
multi-select: true

**Which items belong in the release checklist?**

A. Run verification
B. Delete git history
C. Write a short rollout note

> Correct Answers: A, C
> Overall Feedback: Verification plus a short note makes the release easier to trust and easier to hand off.
```

Rules:

- Omit `multi-select:` for backward compatibility. mdq will still treat `> Correct Answers: ...` as multi-select and `> Correct Answer: ...` as single-select.
- Use `multi-select: true` when you want students to be allowed to pick more than one option for that question.
- Use `type: poll` when you want a non-scored poll question. Poll questions must not include `> Correct Answer:` or `> Correct Answers:` lines.
- Poll questions still respect `multi-select:`. Omit it for a single-choice poll, or set `multi-select: true` for a multi-select poll.
- Use `type: open_response` for a written, non-scored response prompt.
- Open responses can be up to 1000 characters. The instructor sees every response live, each with a Hide / Show button. While the question is open the projector shows only how many responses are in; once you reveal, it shows the responses that are not hidden, and hiding or showing one updates it at once. Phones never receive other participants' responses. The same control is available as `POST /api/session/:id/response-visibility` with `{ "questionIndex": 2, "publicKey": "...", "hidden": true }` (instructor login when one is configured).
- If a participant's phone dies, the instructor's participant list has a "Let rejoin" button beside their name. It frees their seat and keeps everything that belongs to it: their answers, label and public key. Between the release and the next join, any join with that Student ID (or the same name, when Student IDs are off) from any device takes the seat over, so share the moment with the person it is for. Once it is taken, the old device is told "You joined on another device. This screen is no longer in the session.", stops receiving the session and cannot answer; the new device carries on. Two tabs of the same seat that share one token keep working together.
- The same control is `POST /api/session/:id/release-seat` with `{ "publicKey": "..." }` (the participant's public key from the instructor's participant list, at most 128 characters). It needs the instructor login. With no login set, anyone who knows the session ID can call it, so set a login for real classes. It answers 400 for a missing, too long or unknown key and 404 for an unknown session.
- To stop new people joining, for example once the class is in, choose "Lock joining" beside the participant list (in the lobby and in the Participants dialog). It then reads "Joining locked"; choose it again to open joining. While it is locked, a phone that would take a new seat is told "This session is not taking new participants. Ask the presenter." Anyone who already has a seat can still rejoin it, with their token or browser, and a seat freed with "Let rejoin" can still be taken over. The projector's join card says "Joining is closed" instead of showing the code and QR. Only the instructor's screen and the projector receive the state, as `joinLocked: true` on the participants list (absent when open); phones only see the refusal. The lock is saved with the session.
- The same control is `POST /api/session/:id/join-lock` with `{ "locked": true }` or `{ "locked": false }`, answering `{ "locked": true|false }`. It needs the instructor login (with no login set, anyone who knows the session ID can call it). It answers 400 when `locked` is not a boolean and 404 for an unknown session. `GET /api/session/:id/state` and `GET /api/session/:id/presentation` also report `joinLocked`.
- `GET /api/session/:id/results.csv` downloads the results as a CSV file, while the session runs and after it ends (instructor login when one is configured). The instructor view links to it as "Download results (CSV)".
- Use `type: slide` for non-interactive slide content. Slides have no timer, answer choices, correct answers, submissions, or leaderboard weight.
- Add standard markdown images to slide bodies when you want MDQ to arrange media beside the text. Images are scaled proportionately and never cropped or stretched.
- Use `live-url: https://...` on a slide when you want the instructor/projector surface to embed a live website as the slide itself. Add `live-title-overlay: true` to keep the slide title and body text over the live surface, and keep a normal markdown image in the slide as the static fallback for PDF exports and non-live surfaces.
- Use `video-card: https://...` on a slide to show a contained, clickable video card instead of a full-slide embed. Add `video-thumbnail: ../images/poster.png` for the poster frame, `video-caption:` for a caption under the card, and `video-label:` for the play badge. The card shows a visible fallback link and opens a modal player (closes with the close control, backdrop, or `Escape`). Unlike presenter notes, the card is audience-safe and appears on the projector.
- Add slide references with blockquote labels such as `> Reference:` or `> Image Source:`. References render as small, grey, right-aligned footer text and links.
- Do not combine `multi-select: false` with multiple correct answers.
- The instructor live `Next` button preview uses the existing `## ...` item heading, including both sides of `Topic: Subtopic` when present.

Slide example:

```markdown
---

## Retrieval Practice With Evidence

type: slide
live-url: https://example.edu/live-demo
live-title-overlay: true
live-interactive: true

- Start with a low-stakes recall prompt.
  > Attendee Note: Retrieval before explanation is the key idea.
  > Presenter Note: Ask students to answer silently first.

- Reveal the common misconception after discussion.

![System schematic](../images/system-schematic.png "System schematic")
![Student view](../images/student-view.png "Student view")

> Reference: [Roediger and Karpicke, 2006](https://doi.org/10.1111/j.1467-9280.2006.01693.x)
> Image Source: [Example lab image](https://example.edu/lab-image)
> Attendee Note: This slide sets up the live quiz that follows.
```

Fold-out notes are written as `> Attendee Note:` or `> Presenter Note:` blockquotes. Attendee notes can appear in student and review-facing surfaces; presenter notes stay on authenticated instructor surfaces.

A note can be long enough to read as a short section of a paper. Keep every line
of it inside the blockquote, and use ordinary Markdown for structure: `###`
headings, paragraphs, lists, emphasis and inline code. When a note ends with an
ordered list, that list is shown as the note's references, in smaller type with
bracketed numbers.

```markdown
> Attendee Note: **Further reading**
>
> ### 1. Why retrieval first
>
> Taking a test on material improves long-term retention more than restudying it [1].
>
> ### References
>
> 1. Henry L. Roediger and Jeffrey D. Karpicke. 2006. Test-Enhanced Learning. *Psychological Science* 17, 3, 249–255. https://doi.org/10.1111/j.1467-9280.2006.01693.x
```

### Presenter notes (instructor-only panel)

Presenter notes are authored per item as `> Presenter Note:` blockquotes, with
`> ` continuation lines for wrapped text and bullets. They work on `slide`,
`poll`, and `open-response` items. On non-slide items you may place the note
after the options and any `> Overall Feedback:` explanation; MDQ associates it
with the correct item regardless of position. Empty or absent notes render no
UI.

Notes are Markdown, sanitised through the same rendering path as slide bodies.
A concise convention keeps them scannable during a talk:

```markdown
> Presenter Note:
> - SAY: the one main point in a sentence.
> - up to three supporting bullets.
> - TRANSITION: one line into the next item.
```

Delivery and privacy:

- Presenter notes are served **only** to the authenticated instructor
  controller, via `GET /api/deck/:week/presenter-notes` (guarded by instructor
  auth). They are never included on any Socket.IO/session payload, the public
  `GET /api/deck/:week` response, the student view, the projector/presentation
  view, or the default PDF export.
- In the instructor controller they appear in a labelled, keyboard-accessible
  fold-out panel directly below the current slide preview. Expanding or
  collapsing the panel never advances the slide, and its open/closed state
  persists across `Prev`/`Next`.

Configuration (in `data/config.json`, or the matching environment variables):

- `presenterNotes` (boolean, default `false`) — master switch. When `false`,
  the endpoint returns `enabled: false` with no note bodies and **no**
  presenter-notes UI can render anywhere. Override with `MDQ_PRESENTER_NOTES`.
  Presenter notes are only served when an instructor password is **also**
  configured (`INSTRUCTOR_PASSWORD`/`INSTRUCTOR_KEY`); without configured auth
  the endpoint returns `enabled: false` so notes cannot leak to a LAN client.
- `presenterNotesDefaultOpen` (boolean, default `false`) — whether the panel
  starts expanded when a slide loads. Override with
  `MDQ_PRESENTER_NOTES_DEFAULT_OPEN`. For a demo-led talk where the notes are
  the operating script, `true` is convenient; the projector never sees the
  instructor screen.

Individual decks can narrow those global settings in the Markdown preamble:

```markdown
# My talk
presenter-notes: false
presenter-notes-default-open: false

---
```

- `presenter-notes: false` disables the panel and prevents note bodies from
  being served for that deck. A deck cannot enable presenter notes when the
  global master switch or instructor authentication is unavailable.
- `presenter-notes-default-open` overrides the global initial open/closed state
  for that deck when presenter notes are enabled.

The PDF exporter keeps presenter notes hidden by default; pass
`--presenter-notes` to include them in a private rehearsal handout.

Slide images and references:

- For `type: slide`, ordinary markdown image lines are extracted into a structured media area instead of staying inline with the body copy.
- One to three images are the intended sweet spot. MDQ automatically chooses a balanced layout beside the text on wide screens and stacks the media cleanly on narrow screens.
- Image aspect ratios are preserved. MDQ only scales images within available width and height constraints, so portrait assets such as iPhone screenshots stay portrait.
- Slide images and quiz prompt images are expandable. Click or tap an image to open a responsive overlay; close it with the close control, backdrop, or `Escape`.
- Use the optional markdown image title for a figure caption: `![Alt text](../images/file.png "Visible caption")`.
- Supported reference labels are `Reference`, `References`, `Source`, `Sources`, `Image Source`, `Image Sources`, `Image Credit`, `Image Credits`, `Credit`, and `Credits`.
- Reference values may include markdown links and are rendered in the bottom-right of the slide surface.

Tables:

- Slides and fold-out notes accept standard Markdown tables. Colons in the separator row set column alignment, which suits numbers: `| --- | :---: | ---: |` gives left, centre and right.
- Tables take their colours from the deck theme and scroll sideways on narrow screens rather than squeezing their columns.

Poll example:

```markdown
---

## Example Topic: Live Poll

question-type: poll
time-limit: 20

**How confident do you feel about today's topic right now?**

A. Very confident
B. Mostly confident
C. Still unsure
D. Completely lost

> Overall Feedback: Thanks, this helps pace the discussion.
```

Image attachments:

```markdown
## Example Topic: Image Prompt

time-limit: 35

![](../images/xr-setup.png)

**Which device is responsible for scene capture in this setup?**

A. The iPad
B. The headset strap
C. The HDMI adapter

> Correct Answer: A
> Overall Feedback: The iPad captures the source scan for reconstruction.
```

- Store image files in `data/images/`.
- Reference them from deck markdown with `![](../images/<filename>)`.
- MDQ rewrites that quiz-relative path to `/data/images/...` when rendering, so the same markdown works cleanly in the live frontend.
- In quiz stems and option text, images stay inline with the prompt content. In slide bodies, images move into the slide media layout.
- MDQ preserves the source image aspect ratio in all quiz and slide surfaces.
- Images are keyboard-accessible expansion targets when rendered in quiz or slide surfaces.

## Architecture

```text
Instructor Browser                 Student Browsers
       |                                 |
       | REST (session control)          | Socket.IO (join/answer/reconnect)
       |                                 |
       +-------------+-------------------+
                     |
             Node.js + Express + Socket.IO (MDQ server)
                     |
          +----------+-----------+
          |                      |
    Deck source            Runtime output
  data/decks/*.md      data/sessions/*.json
                         data/submissions/*.json
                         data/winners/*.json
                         data/access/current.json (local only)
```

Design notes:

- markdown files are the single source of truth for quiz content
- live session state is in-memory for speed and simplicity
- completed session artifacts are persisted to local flat files
- access URL and QR generation are runtime concerns, not committed artifacts

Adapters that call the engine's `apply()` route its messages by audience:

- `all`: every socket; `staff`: control and display sockets. These payloads never carry a Student ID.
- `control`: the instructor only, with Student IDs and names. `display`: the projector only. `public`: the projector and participants. Their payloads carry `label` and `publicKey` in place of the ID.
- `participant:<id>`: that participant's own socket.

`audienceReaches(audience, role)` answers whether a socket of role `"control"`, `"display"` or `"participant"` should receive a message. For a connecting socket, `apply(..., { type: "snapshot", view: "control" | "display" })` builds the messages for that role, and `{ type: "snapshot", participantId }` builds a participant's. A `join` command may carry `newPublicKey` (a random key); without it the engine makes one. `leaderboardRows(session, quiz, "public" | "control")` gives the same rows for REST responses.

## Media Scope

Image attachments are supported for quiz stems, option text, and slide bodies through standard markdown syntax. Slide images are automatically arranged into a media layout and keep their original aspect ratio while scaling to fit. Rendered quiz and slide images can be expanded into an overlay for closer inspection without changing their aspect ratio.

Embedded video is still out of scope for now. Keep video context in slides or a separate instructor-controlled window while mdq handles the prompt, options, explanations, and scoring.

## Security and Risk

The primary protection model is instructor authentication plus session scoping and careful link sharing. Tailscale Funnel still provides encrypted transport, but Funnel URLs are publicly reachable by anyone who has the link.

Worst-case scenarios and realistic impact:

- **Link sharing outside class**: Someone with the join URL could submit answers, mitigated by short-lived sessions, visible participant counts, and per-session closure. Likelihood low, impact low to medium.
- **Student impersonation (same room)**: A student could type another student ID. This affects fairness, not host compromise. Token-based reconnect protection prevents easy socket hijack after first join, and a second device using a joined ID is refused with a clear message. Only the instructor's view sees Student IDs; other students and the projector see labels. Likelihood low, impact medium for grading integrity.
- **DoS on a session URL**: Spam joins/submits could disrupt one session, but does not expose host secrets by design. Likelihood low in typical classroom context, impact medium for that class period.
- **Accidental data exposure from git push**: If runtime files were tracked, URLs/session data could leak. This repo structure avoids that by keeping `data/` local-only and gitignored. Likelihood low when workflow is followed, impact medium if ignored.

What is intentionally out of scope for this deployment model:

- hard identity verification and anti-cheat guarantees
- internet-scale adversarial abuse resistance
- long-term PII storage and compliance-heavy workflows

## Security Considerations for MDQ

### Input Safety

Most quiz answering uses button-based selections, which limits payload shape. However, MDQ still accepts text input for fields like student ID and username, so normal input validation and output escaping remain important.

### Docker, Pros and Cons

Pros:

- Isolation: the app runs in a clean, consistent environment.
- Reproducibility: every run is identical, reducing surprises.

Cons:

- Slight complexity: you need to manage a Dockerfile and container setup.
- Overhead: minimal extra resource use, but not essential for a simple class deployment.

In summary, Docker offers structure, but may be overkill if you are running a simple Node.js quiz with controlled input. As long as you keep your app scoped, this is mostly sufficient but of course containerizing is always an option for extra isolation.

## Safe Contribution Workflow

Related docs:

- Read [`CONTRIBUTING.md`](CONTRIBUTING.md) before submitting changes. It
  explains the MIT contribution terms, contributor authority, and public-data
  safeguards.
- `docs/classquiz-analysis.md`: ClassQuiz codebase summary and MDQ feature roadmap notes
- Commit code changes under `packages/`, `docs/`, `samples/`, scripts, and config files
- Keep personal/local files under `data/`
- Keep local planning notes in `docs/` using `DEV-*.md` names so they stay untracked
- Keep the local product requirements doc at `docs/DEV-PRD.md` (gitignored)
- Keep public docs in `docs/` with non-`DEV-` names (for example runbooks or published evidence)
- Do not commit `.env*` or logs

You can push to `main` without exposing local runtime artifacts if you keep private files in `data/`.

## Palette credits

The slide palettes are based on these upstream colour schemes. Each is used
under its own licence, and MDQ is not affiliated with or endorsed by their
authors.

| Palette | Upstream | Licence |
| --- | --- | --- |
| Gruvbox | [morhetz/gruvbox](https://github.com/morhetz/gruvbox) | MIT/X11 |
| Rosé Pine | [rose-pine/rose-pine-palette](https://github.com/rose-pine/rose-pine-palette) | MIT |
| Catppuccin | [catppuccin/palette](https://github.com/catppuccin/palette) | MIT |
| seoul256 | [junegunn/seoul256.vim](https://github.com/junegunn/seoul256.vim) | MIT |
| Ayu | [ayu-theme/ayu-colors](https://github.com/ayu-theme/ayu-colors) | MIT |
| Tokyo Night | [folke/tokyonight.nvim](https://github.com/folke/tokyonight.nvim) | Apache-2.0 |

The colours are adapted. Where an upstream colour misses 4.5:1 for text or 3:1
for a control boundary, MDQ uses a darker or lighter shade of the same hue, and
the comment above each palette in `packages/client/src/index.css` names the
change. The Apache-2.0 licence text is at
<https://www.apache.org/licenses/LICENSE-2.0>.

## Disclaimer

MDQ is provided as-is, and you use it at your own risk. This was developed for personal use and shared in the spirit of open source, but it is not a polished commercial product. It may have security vulnerabilities, bugs, or data loss risks if used in production or with sensitive data. Always review the code and test in a safe environment before using it for real classes.

MDQ is an independent project and is not affiliated with, endorsed by, or sponsored by Tailscale, is.gd, or any other third-party services mentioned here.
