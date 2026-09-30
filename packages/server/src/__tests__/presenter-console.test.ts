import fs from "fs";
import path from "path";
import { closedLabel, formatRemaining, pluralize, positionLabel } from "../../../client/src/instructorText";
import { readShowStudentIds, saveShowStudentIds } from "../../../client/src/showStudentIds";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string => fs.readFileSync(path.join(clientSrc, rel), "utf-8");
/** The last rule of `selector` in the file: the one that wins where rules tie. */
const lastRule = (css: string, selector: string): string => {
  const found = css.lastIndexOf(`\n${selector} {`);
  expect(found).toBeGreaterThanOrEqual(0);
  const start = found + 1;
  return css.slice(start, css.indexOf("}", start));
};

describe("presenter wording", () => {
  it("says what is left with the right plurals and no zero counts", () => {
    expect(pluralize(1, "slide")).toBe("1 slide");
    expect(pluralize(2, "slide")).toBe("2 slides");
    expect(formatRemaining(0, 1)).toBe("1 slide");
    expect(formatRemaining(2, 0)).toBe("2 quiz questions");
    expect(formatRemaining(1, 1)).toBe("1 quiz question and 1 slide");
    expect(formatRemaining(3, 2)).toBe("3 quiz questions and 2 slides");
    expect(formatRemaining(0, 0)).toBe("");
  });

  it("calls a question closed by the presenter 'Answers closed' and only a timer running out 'Time's up'", () => {
    expect(closedLabel(false)).toBe("Answers closed");
    expect(closedLabel(true)).toBe("Time's up");
    for (const view of ["views/InstructorView.tsx", "views/PresentationView.tsx"]) {
      const tsx = read(view);
      expect(tsx).toContain("closedLabelFor(sock.timedOut)");
      expect(tsx).not.toMatch(/>Time(?:'|&apos;)s up</);
    }
  });

  it("numbers questions the way the phones do: slides are not counted and show no number", () => {
    expect(positionLabel({ questionNumber: 3, questionTotal: 8 })).toBe("3/8");
    expect(positionLabel({})).toBeUndefined();
    expect(positionLabel(null)).toBeUndefined();
    for (const view of ["views/InstructorView.tsx", "views/PresentationView.tsx"]) {
      const tsx = read(view);
      expect(tsx).toContain("positionLabelFor(");
      expect(tsx).not.toContain("formatPositionLabel");
      expect(tsx).not.toMatch(/Q\{\w+\.questionIndex \+ 1\}/);
    }
  });

  it("asks nothing vague when ending a session", () => {
    const tsx = read("views/InstructorView.tsx");
    expect(tsx).not.toContain("Are you sure?");
    expect(tsx).toContain("Everyone&apos;s screen will show the final results.");
  });
});

describe("Student IDs on the instructor's console", () => {
  const store = new Map<string, string>();
  const storage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  };
  beforeEach(() => store.clear());

  it("hides IDs until the presenter turns them on, and remembers the choice", () => {
    expect(readShowStudentIds(storage)).toBe(false);
    saveShowStudentIds(true, storage);
    expect(readShowStudentIds(storage)).toBe(true);
    saveShowStudentIds(false, storage);
    expect(readShowStudentIds(storage)).toBe(false);
  });

  it("keeps working when storage is unavailable or refuses", () => {
    expect(readShowStudentIds(undefined)).toBe(false);
    expect(() => saveShowStudentIds(true, undefined)).not.toThrow();
    const refusing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } };
    expect(readShowStudentIds(refusing)).toBe(false);
    expect(() => saveShowStudentIds(true, refusing)).not.toThrow();
  });

  it("feeds every ID-bearing list from the toggle, never straight from the deck setting", () => {
    const tsx = read("views/InstructorView.tsx");
    expect(tsx).toContain("useState(readShowStudentIds)");
    expect(tsx).toContain("const idsVisible = idsAvailable && showStudentIds;");
    expect(tsx).not.toContain("showStudentIds={!autoGenerateStudentIds}");
    expect(tsx).toContain("showStudentIds={idsVisible}");
    // The projector never shows IDs at all.
    expect(read("views/PresentationView.tsx")).not.toContain("showStudentIds={true}");
  });

  it("offers no ID toggle and no ID text when the deck turns Student IDs off", () => {
    const tsx = read("views/InstructorView.tsx");
    // The console learns the deck's setting from the create and restore responses; absent means IDs are on.
    expect(tsx).toContain("setDeckUsesStudentIds(info.studentIds !== false)");
    expect(tsx).toContain("setDeckUsesStudentIds(snapshot.studentIds !== false)");
    expect(tsx).toContain("const idsAvailable = deckUsesStudentIds && !autoGenerateStudentIds;");
    // Every toggle sits behind idsAvailable: the lobby and the Participants dialog (switch rows) and the ended screen (a button).
    expect(tsx.match(/className="student-ids-toggle/g)?.length).toBe(1);
    expect(tsx.match(/\{idsAvailable && \(\s*<button\s+type="button"\s+className="student-ids-toggle/g)?.length).toBe(1);
    expect(tsx.match(/<SettingSwitch\s+label="Show Student IDs"/g)?.length).toBe(2);
    expect(tsx.match(/\{idsAvailable && \(\s*<SettingSwitch\s+label="Show Student IDs"/g)?.length).toBe(2);
    // With the toggle gone, idsVisible is false, and that reaches every list.
    expect(tsx).toContain("const idsVisible = idsAvailable && showStudentIds;");
    expect(tsx).toContain('nameOnly ? "name" : idsAvailable ? "ID" : "ID or name"');
  });
});

describe("resuming a session", () => {
  it("says 'resumed' only after a real reload of the tab, and lets the notice go", () => {
    const tsx = read("views/InstructorView.tsx");
    expect(tsx).toContain('entry?.type === "reload"');
    expect(tsx).toContain("isPageReload() ? INSTRUCTOR_RESTORE_SUCCESS_NOTICE : null");
    expect(tsx).toContain("RESTORE_NOTICE_MS");
    expect(lastRule(read("index.css"), ".slide-status-pill-fades")).toContain("animation: mdq-status-fade");
  });
});

describe("leaderboard button", () => {
  it("is offered only once a scored question has been revealed", () => {
    const tsx = read("views/InstructorView.tsx");
    expect(tsx).toContain('reveal.questionType === "multiple_choice" && !reveal.isPoll');
    expect(tsx).toContain("state === \"REVEAL\" && !liveIsSlide && hasRevealedScoredQuestion");
  });
});

describe("presenter toolbar", () => {
  const css = read("index.css");

  it("keeps the status label in the toolbar's flow so the controls never cover it", () => {
    const pill = lastRule(css, ".slide-status-pill");
    expect(pill).toContain("position: static");
    expect(pill).toContain("transform: none");
    expect(css).toMatch(/@media \(min-width: 761px\) and \(max-width: 1299px\) \{[\s\S]*?\.slide-toolbar-stack \{\s*grid-column: 1 \/ -1;\s*grid-row: 2;/);
  });

  it("makes every presenter control at least 44px tall", () => {
    expect(lastRule(css, ".slide-action-button,\n.slide-fullscreen-button")).toContain("min-height: 2.75rem");
    expect(lastRule(css, ".session-code-card-toggle")).toContain("min-height: 2.75rem");
    expect(lastRule(css, ".session-code-card-link")).toContain("min-height: 2.75rem");
    expect(lastRule(css, ".instructor-ended-link")).toContain("min-height: 2.75rem");
    expect(lastRule(css, ".participant-action,\n.student-ids-toggle")).toContain("min-height: 2.75rem");
    expect(lastRule(css, ".participants-close")).toMatch(/width: 2\.75rem;\s*height: 2\.75rem/);
    expect(lastRule(css, ".setting-switch")).toContain("min-height: 2.75rem");
  });

  it("tells a waiting control why, and greys the online count when offline", () => {
    const tsx = read("views/InstructorView.tsx");
    expect(tsx).toContain('const waitingReason = !sock.connected ? "Reconnecting..." : null;');
    expect(tsx).toContain("reason: waitingReason");
    expect(tsx).toContain("offline={!sock.connected}");
    expect(read("components/LiveSurface.tsx")).toContain("title={action.disabled && action.reason ? action.reason : undefined}");
    expect(css).toContain(".session-code-card-meta-offline");
  });
});

describe("projector", () => {
  const tsx = read("views/PresentationView.tsx");

  it("holds the counts and 'next up' until the first state arrives", () => {
    expect(tsx).toContain("const stateReady = sock.sessionState !== null;");
    expect(tsx).toContain("if (!stateReady && !sock.error)");
    expect(tsx).toContain("const participantCount = sock.participants ? sock.participants.count : undefined;");
  });

  it("says so when a poll has no votes", () => {
    expect(tsx).toContain("No votes yet");
    expect(read("views/InstructorView.tsx")).toContain("No votes yet");
  });

  it("opens the join QR large from the chip", () => {
    const card = read("components/SessionCodeCard.tsx");
    expect(card).toContain("createPortal(");
    expect(card).toContain('className="qr-enlarged-image"');
    expect(lastRule(read("index.css"), ".qr-enlarged-image")).toContain("width: min(70dvh, 82vw, 40rem)");
  });

  it("grows the question and options on a portrait screen", () => {
    expect(read("index.css")).toMatch(/@media \(orientation: portrait\) and \(min-width: 700px\) \{\s*\.quiz-surface-content-fit \{\s*--quiz-fit-question-size: clamp\(2rem/);
  });
});

describe("Participants dialog", () => {
  const tsx = read("views/InstructorView.tsx");
  const start = tsx.indexOf("const participantsDialog = showParticipants");
  const dialog = tsx.slice(start, tsx.indexOf(") : null;", start));

  it("hides the closed native dialog and avoids adding the UA backdrop shade", () => {
    const css = read("index.css");
    expect(lastRule(css, "dialog.participants-overlay:not([open])")).toContain("display: none");
    expect(lastRule(css, "dialog.participants-overlay::backdrop")).toContain("background: transparent");
  });

  it("wires native modal lifetime to the dialog node, including node replacement", () => {
    expect(dialog).toMatch(/<dialog\s+ref=\{participantsDialogRef\}/);
    expect(dialog).toContain('aria-labelledby="participants-title"');
    expect(dialog).toContain("onCancel={(event) => { event.preventDefault(); setShowParticipants(false); }}");
    expect(tsx).toContain("return mountParticipantsDialog(dialog, participantsOpenerRef.current)");
    expect(tsx).toContain("participantsOpenerRef.current = event?.currentTarget ?? document.activeElement");
    expect(tsx).toContain('<h1 ref={endedHeadingRef} tabIndex={-1}');
  });

  it("does not open a top-layer modal over an existing QR or end-confirm dialog", () => {
    const start = tsx.indexOf("const participantsAction:");
    const action = tsx.slice(start, tsx.indexOf("const liveSurfaceActions:", start));
    expect(action).toContain("if (documentHasOpenDialog(document)) return;");
    expect(action.indexOf("documentHasOpenDialog(document)")).toBeLessThan(action.indexOf("setShowParticipants(true)"));
  });

  it("closes with an icon button named Close, at least 44px square", () => {
    expect(dialog).toMatch(/className="participants-close"\s+aria-label="Close"/);
    expect(dialog).toContain("<svg");
    expect(dialog).not.toMatch(/>\s*Close\s*<\/button>/);
    expect(lastRule(read("index.css"), ".participants-close")).toMatch(/width: 2\.75rem;\s*height: 2\.75rem/);
  });

  it("groups Lock joining and Show Student IDs under a labelled Session settings area, each with its description", () => {
    expect(dialog).toContain('aria-labelledby="session-settings-title"');
    expect(dialog).toContain("Session settings");
    expect(dialog).toContain("<JoinLockToggle");
    expect(dialog).toContain('label="Show Student IDs"');
    expect(dialog).toContain("description={STUDENT_IDS_DESCRIPTION}");
    // The settings come after the participant list, which stays the main content.
    expect(dialog.indexOf("<ParticipantList")).toBeLessThan(dialog.indexOf("session-settings-title"));
    const toggle = read("components/JoinLockToggle.tsx");
    expect(toggle).toContain("Stop new people joining once everyone is in.");
    expect(toggle).toContain("<SettingSwitch");
    const row = read("components/SettingSwitch.tsx");
    expect(row).toContain('role="switch"');
    expect(row).toContain("aria-checked={checked}");
    expect(row).toContain("aria-labelledby={labelId}");
    expect(row).toContain('<span id={labelId} className="setting-switch-label">{label}</span>');
    expect(row).toContain("aria-describedby={descriptionId}");
  });
});

describe("open join card", () => {
  it("widens the address area, with the QR at least as large as before", () => {
    const css = read("index.css");
    expect(css).toContain("--slide-expanded-join-width: clamp(11.5rem, 16cqi, 16rem)");
    expect(css).toMatch(/\.slide-join-panel\.session-code-card-expanded,[\s\S]*?width: var\(--slide-expanded-join-width\)/);
    expect(css).toMatch(/\.slide-join-panel\.session-code-card-expanded \.session-code-card-qr \{\s*width: min\(100%, 9rem\)/);
  });

  it("reserves the widened floating card beside media and references, but adds no inset when it is in flow", () => {
    const css = read("index.css");
    expect(css).toMatch(/\.slide-safe:has\(\.slide-join-panel\.session-code-card-expanded\) \{\s*--slide-join-reserve: var\(--slide-expanded-join-width\)/);
    for (const selector of [
      ".slide-safe:has(.slide-join-panel) .slide-content-grid-with-media .slide-media-grid",
      ".slide-safe:has(.slide-join-panel) .slide-content-grid-media-only .slide-media-groups",
      ".slide-safe:has(.slide-join-panel) .slide-references",
    ]) expect(lastRule(css, selector)).toContain("var(--slide-join-reserve, 0px)");
    expect(css).toMatch(/@media \(min-width: 761px\) and \(max-width: 1180px\) \{\s*\.slide-live-shell-controls:has\(\.presenter-notes-panel\) \.slide-safe \{\s*--slide-join-reserve: 0px/);
  });
});

describe("participant list", () => {
  it("asks in place, in plain words, before freeing a seat", () => {
    const tsx = read("components/ParticipantList.tsx");
    expect(tsx).toContain("Let {label} join again from a new device? Their answers are kept.");
    expect(tsx).toContain("onRelease");
    expect(read("hooks/api.ts")).toContain("API.SESSION_RELEASE_SEAT");
  });
});
