# mdq

MCQs are passe. Enter MDQs. Human- and agent-friendly Markdown Quizzes.
No clunky interfaces. No proprietary nonsense. No database.
Just your own machine and a public secure tunnel.

MDQ turns a markdown file into a live class session: sparse slides, quiz
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
`dark` or `light`.

Individual decks can override that global fallback in the Markdown preamble:

```markdown
# My Deck
theme: light

---
```

`theme` accepts only `light` or `dark` (case-insensitive, with optional quotes).
When it is omitted, every instructor, student, and projector view uses the
global runtime theme. The PDF export theme remains controlled independently by
its `--theme` command-line option.

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
- `Prev` and `Next` stay pinned together near the top-left of the live surface so their click targets do not drift when other controls appear or disappear.
- In live mode, `Next` includes the next item's markdown heading inside the button. In review mode, `Next` stays a plain button.
- `End Session` remains available from the live controls and opens a confirmation dialog before closing the room. The dialog shows how many quiz questions and slides are left.
- The fullscreen control appears when the browser supports the Fullscreen API, letting the instructor/projector surface fill the display without browser chrome.
- Review mode lets the instructor step through previous slides/questions without moving students, then return to the current live item with `Back to Live`.
- On narrow screens, the same controls stack from the top-left so small-device use keeps the same visual order.

### 3) student join flow (share this one)

- Share only the student join URL or QR code from the instructor screen.
- Student QR codes resolve to `/#/join/<SESSION_CODE>` and do not need instructor login.
- Student join flow does not depend on `VITE_INSTRUCTOR_ROUTE_SEGMENT`.

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
- `--title <title>` overrides the cover title.
- `--html <file>` also writes the generated print HTML for visual debugging.

Examples:

```bash
npm run print:pdf -- data/decks/sample-session.md --theme dark --no-foldouts
npm run print:pdf -- data/decks/sample-session.md --theme dark --answers --presenter-notes
npm run print:pdf -- data/decks/week00.md --theme light --page-size Letter --out exports/week00-letter.pdf
```

PDF images keep their source aspect ratio. MDQ only scales images down to fit the print layout, so portrait screenshots and wide diagrams are not stretched, cropped, or reframed.

## Deck Markdown Format

Decks can start with an optional preamble title before the first `---`. This title is used in the instructor deck picker and PDF cover, while the `## ...` headings remain the individual live items.

```markdown
title: Demo Presentation Session

---
```

If the preamble title is omitted, MDQ falls back to the first `# ...` heading for backward compatibility.

Each interactive question supports the existing `time_limit:` metadata plus optional `multi_select:` and `type:` flags. `question_type:` remains accepted as a backward-compatible alias. Question stems, slide bodies, and option text can also include standard markdown images.

```markdown
---

## Example Topic: Selection Modes

time_limit: 45
multi_select: true

**Which items belong in the release checklist?**

A. Run verification
B. Delete git history
C. Write a short rollout note

> Correct Answers: A, C
> Overall Feedback: Verification plus a short note makes the release easier to trust and easier to hand off.
```

Rules:

- Omit `multi_select:` for backward compatibility. mdq will still treat `> Correct Answers: ...` as multi-select and `> Correct Answer: ...` as single-select.
- Use `multi_select: true` when you want students to be allowed to pick more than one option for that question.
- Use `type: poll` when you want a non-scored poll question. Poll questions must not include `> Correct Answer:` or `> Correct Answers:` lines.
- Poll questions still respect `multi_select:`. Omit it for a single-choice poll, or set `multi_select: true` for a multi-select poll.
- Use `type: open_response` for a written, non-scored response prompt.
- Use `type: slide` for non-interactive slide content. Slides have no timer, answer choices, correct answers, submissions, or leaderboard weight.
- Add standard markdown images to slide bodies when you want MDQ to arrange media beside the text. Images are scaled proportionately and never cropped or stretched.
- Use `live_url: https://...` on a slide when you want the instructor/projector surface to embed a live website as the slide itself. Add `live_title_overlay: true` to keep the slide title and body text over the live surface, and keep a normal markdown image in the slide as the static fallback for PDF exports and non-live surfaces.
- Use `video_card: https://...` on a slide to show a contained, clickable video card instead of a full-slide embed. Add `video_thumbnail: ../images/poster.png` for the poster frame, `video_caption:` for a caption under the card, and `video_label:` for the play badge. The card shows a visible fallback link and opens a modal player (closes with the close control, backdrop, or `Escape`). Unlike presenter notes, the card is audience-safe and appears on the projector.
- Add slide references with blockquote labels such as `> Reference:` or `> Image Source:`. References render as small, grey, right-aligned footer text and links.
- Do not combine `multi_select: false` with multiple correct answers.
- The instructor live `Next` button preview uses the existing `## ...` item heading, including both sides of `Topic: Subtopic` when present.

Slide example:

```markdown
---

## Retrieval Practice With Evidence

type: slide
live_url: https://example.edu/live-demo
live_title_overlay: true
live_interactive: true

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

### Presenter notes (instructor-only panel)

Presenter notes are authored per item as `> Presenter Note:` blockquotes, with
`> ` continuation lines for wrapped text and bullets. They work on `slide`,
`poll`, and `open_response` items. On non-slide items you may place the note
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
presenter_notes: false
presenter_notes_default_open: false

---
```

- `presenter_notes: false` disables the panel and prevents note bodies from
  being served for that deck. A deck cannot enable presenter notes when the
  global master switch or instructor authentication is unavailable.
- `presenter_notes_default_open` overrides the global initial open/closed state
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

Poll example:

```markdown
---

## Example Topic: Live Poll

question_type: poll
time_limit: 20

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

time_limit: 35

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

## Media Scope

Image attachments are supported for quiz stems, option text, and slide bodies through standard markdown syntax. Slide images are automatically arranged into a media layout and keep their original aspect ratio while scaling to fit. Rendered quiz and slide images can be expanded into an overlay for closer inspection without changing their aspect ratio.

Embedded video is still out of scope for now. Keep video context in slides or a separate instructor-controlled window while mdq handles the prompt, options, explanations, and scoring.

## Security and Risk

The primary protection model is instructor authentication plus session scoping and careful link sharing. Tailscale Funnel still provides encrypted transport, but Funnel URLs are publicly reachable by anyone who has the link.

Worst-case scenarios and realistic impact:

- **Link sharing outside class**: Someone with the join URL could submit answers, mitigated by short-lived sessions, visible participant counts, and per-session closure. Likelihood low, impact low to medium.
- **Student impersonation (same room)**: A student could type another student ID. This affects fairness, not host compromise. Token-based reconnect protection prevents easy socket hijack after first join. Likelihood low, impact medium for grading integrity.
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

## Disclaimer

MDQ is provided as-is, and you use it at your own risk. This was developed for personal use and shared in the spirit of open source, but it is not a polished commercial product. It may have security vulnerabilities, bugs, or data loss risks if used in production or with sensitive data. Always review the code and test in a safe environment before using it for real classes.

MDQ is an independent project and is not affiliated with, endorsed by, or sponsored by Tailscale, is.gd, or any other third-party services mentioned here.
