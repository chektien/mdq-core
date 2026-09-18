# AGENTS.md - MDQ

## Project
- MDQ Core is the open-source markdown-driven presentation and interaction engine.
- This is a public-facing repository. Do not commit real quiz data, private class data, session exports, submissions, access logs, or other teaching-instance data.
- The only quiz/deck content that may be committed is intentional smoke/sample content meant for public distribution, such as files under `samples/decks/` or minimal non-real fixtures used by automated tests.
- Keep private/runtime quiz data under ignored local data paths. If real quiz data is accidentally committed, stop and remove it from history before continuing normal development.
- Keep agent-generated planning, handoff, scratch, and review markdown out of the public repository unless Chek explicitly asks to publish a specific document.

## Local Runtime
- The local MDQ server commonly runs on port `2081`.
- A stable HTTPS URL is preferred for student-facing/public access when configured.
- A Cloudflare tunnel or Worker route may proxy to the local MDQ server. Prefer repairing that route before touching Tailscale Serve/Funnel.
- Active classroom session continuity is a hard requirement. Recover browser,
  network, tunnel, and client-control failures by reconnecting and reconciling
  against the existing server session; do not restart the deck or discard
  participant quiz progress as a routine recovery step.
- Never restart or redeploy the MDQ server while an active session may exist
  unless Chek explicitly approves the interruption after being told that the
  current in-memory session and participant progress may be lost.

## Tailscale Routing Warning
- Do not repoint a bare Tailscale hostname or shared HTTPS route for MDQ unless Chek explicitly asks for that exact routing.
- Shared hostnames may already be used by other local services. Repointing a bare route to MDQ can break unrelated WebSocket or gateway clients.
- If MDQ needs temporary Tailscale exposure, prefer a non-conflicting hostname, port, or path and verify the existing route map before and after any Tailscale Serve/Funnel change.

## Verification
- For MDQ changes, run the repo's existing typecheck/build/test commands when practical.
- For routing changes, verify both local MDQ health and the intended public URL. If the task touches Tailscale, also verify any pre-existing shared routes still serve their original services afterward.
