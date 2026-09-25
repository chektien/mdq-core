# Dry-Run Classroom Checklist

Pre-class verification steps for running mdq live. Covers both Tailscale-available and LAN-only fallback scenarios.

## Before Class (30 min)

### 1. Environment Check

- [ ] Node.js installed (`node -v`, need v18+)
- [ ] Dependencies installed (`cd /path/to/mdq && npm install`)
- [ ] Local data dirs bootstrapped (`npm run setup:local`)
- [ ] Deck file ready (`data/decks/<deck-id>.md` exists, validated)
- [ ] If deck markdown was edited while server is already running, use "Reload Decks" in instructor setup (no rebuild needed)
- [ ] Build is current (`npm run build`)

### 2. Quick Smoke Test

```bash
# Run the full quality gate (takes ~30s)
./scripts/verify.sh --quick

# Or just the e2e test
npm test -- --testPathPattern e2e-lifecycle --forceExit
```

If any step fails, fix before proceeding.

### 3. Network Setup

#### Option A: Tailscale Available

Tailscale lets students reach your laptop from campus Wi-Fi without port forwarding.

1. Ensure Tailscale is running: `tailscale status`
2. If using Tailscale Funnel (public URL):
   ```bash
   tailscale funnel 3000
   ```
   This creates a public `https://<machine>.ts.net` URL.
3. Start the server:
   ```bash
   cd /path/to/mdq
   npm run start --workspace=@mdq/server
   ```
4. The server will auto-detect Tailscale and print the access URL + QR code.
5. Verify from your phone: open the URL, you should see the student join page.

#### Option B: Tailscale Unavailable (LAN Fallback)

If Tailscale is not installed or campus Wi-Fi blocks peer-to-peer:

1. Connect your laptop to the same Wi-Fi as students.
2. Find your local IP: `ipconfig getifaddr en0` (macOS)
3. Start the server:
   ```bash
   PORT=3000 npm run start --workspace=@mdq/server
   ```
4. The server will print a LAN URL like `http://192.168.x.x:3000`.
5. Test from your phone on the same Wi-Fi. If it does not connect:
   - Check macOS firewall: System Settings > Network > Firewall. Allow incoming connections for Node.js.
   - Try a different port: `PORT=8080 npm run start --workspace=@mdq/server`
   - As a last resort, use USB tethering from your phone and share the hotspot with students.

### 4. Projector Setup

- [ ] Connect projector to laptop
- [ ] Open browser to `http://localhost:3000` (instructor view)
- [ ] Verify the quiz title and question count are correct
- [ ] Test advancing through one question to confirm projector display works

## During Class

### 5. Start a Session

1. On the instructor view, select the quiz week and click "Create Session".
2. Note the 6-character session code displayed.
3. Share the join URL/QR code with students (displayed on the instructor screen).
4. Wait for student count to stabilize in the lobby.

### 6. Run the Quiz

For each question:

1. Click "Start" (or "Next Question") to open the question.
2. The timer starts automatically (default 35s, or per-question `time-limit`).
3. Watch the submission count. The question auto-closes when time runs out, or you can close it early.
   - If a student disconnects mid-question, the denominator may drop because only currently connected participants are counted.
4. Click "Reveal" to show the correct answer, explanation, and answer distribution chart.
5. Click "Next Question" to advance, or "Show Leaderboard" after the last question.

### 7. Leaderboard and Wrap-up

1. After the final reveal, click "Show Leaderboard".
2. The leaderboard ranks students by correct answers (descending), then response time (ascending).
3. Take a screenshot or note the top 3 for bonus marks.
4. Click "End Session" to close. Data is persisted to `data/sessions/` and `data/winners/`.

## After Class

### 8. Verify Persistence

```bash
# Check session data was saved
ls data/sessions/
ls data/winners/

# View cumulative leaderboard
curl http://localhost:3000/api/leaderboard/cumulative | jq
```

### 9. Known Limitations

- **Single session at a time**: The server supports one active session. End the current session before starting a new one.
- **No authentication**: Students self-identify with their student ID. Impersonation is mitigated by session tokens (reconnection requires the original token), but not prevented.
- **In-memory state**: If the server crashes mid-session, in-progress data is lost. Completed sessions are persisted to disk.
- **Submission denominator semantics**: During a question, the `submitted/total` denominator tracks currently connected participants. Mid-question disconnects can make the denominator shrink.
- **Browser support**: Tested on Chrome, Safari, Firefox (desktop + mobile). No IE support.

## Troubleshooting

| Symptom | Likely cause | Fix |
|---------|-------------|-----|
| Students cannot connect | Firewall blocking port | Allow Node.js in macOS firewall, or use Tailscale Funnel |
| QR code not showing | Tailscale not running, tinyurl rate-limited | Use the session code instead; students type `http://<your-ip>:3000/join/CODE` |
| Timer not ticking | Browser tab throttled | Keep the instructor tab visible (foreground) |
| Leaderboard empty | No students submitted | Check submission count during questions |
| "Session not found" on join | Wrong session code or session ended | Create a new session; codes are case-insensitive |
