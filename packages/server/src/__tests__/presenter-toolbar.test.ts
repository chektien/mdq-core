import fs from "fs";
import path from "path";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string => fs.readFileSync(path.join(clientSrc, rel), "utf-8");

describe("presenter toolbar", () => {
  const instructor = read("views/InstructorView.tsx");
  const surface = read("components/LiveSurface.tsx");
  const index = read("index.css");

  it("gives Prev the previous item's heading, the way Next shows the next one", () => {
    expect(instructor).toMatch(/const previousQuestionHeading = isReviewing \|\| liveQuestionIndex <= 0\s*\? null\s*: getQuestionHeading\(liveQuestionIndex - 1\);/);
    expect(instructor).toContain("detail: canPrev && waitingReason ? waitingReason : canPrev ? previousQuestionHeading : null,");
  });

  it("keeps Prev plain in review mode, like Next", () => {
    const review = instructor.slice(instructor.indexOf("if (isReviewing && reviewQuestionIndex !== null) {\n      return ["));
    const block = review.slice(0, review.indexOf("];"));
    expect(block).not.toContain("detail:");
  });

  it("marks <html> while the page is in full screen and clears it after", () => {
    expect(surface).toContain('document.documentElement.setAttribute("data-fullscreen", "true")');
    expect(surface).toContain('document.documentElement.removeAttribute("data-fullscreen")');
  });

  it("starts the toolbar clear of the top-left 64 by 60 px in full screen", () => {
    // The wide layout starts at 4.75rem (76 px), past the 64 px corner.
    expect(index).toMatch(/@media \(min-width: 761px\) \{\s*html\[data-fullscreen="true"\] \.slide-toolbar \{\s*left: max\(clamp\(1\.2rem, 3\.2cqi, 3\.5rem\), 4\.75rem\);/);
    // The stacked layout starts below the 60 px corner: 1.2rem padding plus 2.75rem.
    expect(index).toMatch(/@media \(max-width: 760px\) \{\s*html\[data-fullscreen="true"\] \.slide-toolbar \{\s*margin-top: 2\.75rem;/);
    expect(4.75 * 16).toBeGreaterThanOrEqual(64);
    expect((1.2 + 2.75) * 16).toBeGreaterThanOrEqual(60);
  });

  it("lets Prev and Next shrink so two titles never run under the controls", () => {
    expect(index).toMatch(/\.slide-nav-button\.slide-action-button-with-detail \{[^}]*flex: 0 1 auto;/);
    expect(index).toMatch(/\.slide-toolbar-nav \{\s*width: 100%;\s*pointer-events: none;/);
    expect(index).toMatch(/\.slide-toolbar-nav > \* \{\s*pointer-events: auto;/);
  });

  it("caps each titled Prev and Next at half the column between 761px and 1299px", () => {
    const block = index.match(/@media \(min-width: 761px\) and \(max-width: 1299px\) \{[\s\S]*?\n\}\n/);
    expect(block).not.toBeNull();
    // Each keeps at most half of the column, so two long titles cannot push the second under the controls.
    expect(block?.[0]).toMatch(/\.slide-nav-button\.slide-action-button-with-detail \{\s*min-width: min\(11rem, 22cqi, calc\(50% - 0\.225rem\)\);/);
    // Half of the column less half of the 0.45rem gap between the buttons.
    expect(index).toMatch(/\.slide-toolbar-nav \{\s*display: flex;[^}]*gap: 0\.45rem;/);
  });

  it("measures the join card and hands its height to the stylesheet", () => {
    expect(surface).toContain('safe?.querySelector<HTMLElement>(":scope > .slide-join-panel")');
    // A card pinned to the window (under 700 px tall) is measured the same way as one floating over the slide.
    expect(surface).toContain('if (style.position !== "absolute" && style.position !== "fixed") {');
    expect(surface).toContain('safe.style.setProperty("--slide-join-clear"');
    expect(surface).toContain("(parseFloat(style.bottom) || 0) + card.offsetHeight");
    expect(surface).toContain('safe.style.removeProperty("--slide-join-clear")');
  });

  it("keeps an open question's options clear of the floating join card up to a 1440 px laptop", () => {
    const block = index.match(/@media \(min-width: 761px\) and \(max-width: 1499px\) \{\s*\.quiz-surface \.slide-safe:has\(\.quiz-surface-content-answering\) \{[\s\S]*?\n\}\n/);
    expect(block).not.toBeNull();
    // The padding the fit step already subtracts grows to hold the card, never below the usual padding,
    // and only while the question is open for answers: a closed question and the results keep their own.
    expect(block?.[0]).toMatch(/:has\(\.quiz-surface-content-answering\) \{\s*padding-bottom: max\(clamp\(2\.8rem, 5cqi, 5\.5rem\), calc\(var\(--slide-join-clear, 0px\) \+ [\d.]+rem\)\);/);
    expect(index).not.toMatch(/\.quiz-surface \.slide-safe \{\s*padding-bottom: max\(clamp\(2\.8rem, 5cqi, 5\.5rem\), calc\(var\(--slide-join-clear/);
    // An open card is a short strip with the QR beside the text and no taller than the text, not the tall projector card.
    expect(block?.[0]).toMatch(/\.session-code-card-expanded \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\) auto 5\.25rem;/);
    expect(block?.[0]).toMatch(/\.session-code-card-expanded \.session-code-card-body \{\s*display: contents;/);
    expect(block?.[0]).toMatch(/\.session-code-card-expanded \.session-code-card-qr-hint \{\s*display: none;/);
  });

  it("marks the question surface as answering only while its options are a grid to choose from", () => {
    const fit = read("components/ResponsiveQuizSurface.tsx");
    expect(fit).toContain('answering ? "quiz-surface-content-answering" : ""');
    expect(instructor).toContain('const optionsAnswering = state !== "QUESTION_CLOSED" || isReviewing;');
    expect(instructor.match(/<ResponsiveQuizSurface answering=\{optionsAnswering\}>/g)).toHaveLength(2);
    const presentation = read("views/PresentationView.tsx");
    expect(presentation.match(/<ResponsiveQuizSurface answering=\{state !== "QUESTION_CLOSED"\}>/g)).toHaveLength(2);
    expect(presentation).not.toMatch(/<ResponsiveQuizSurface>/);
  });

  it("gives back the height a scaled question no longer uses, and steps down at any overflow", () => {
    const fit = read("components/ResponsiveQuizSurface.tsx");
    expect(fit).toContain('element.style.setProperty("--quiz-fit-height", layoutHeight)');
    expect(fit).toContain("if (overflowRatio > 1) return nextDensity(current);");
    expect(index).toMatch(/\[data-fit-density="scaled"\] \{\s*--quiz-fit-scale: 0\.9;[^}]*margin-block: calc\(var\(--quiz-fit-height, 0px\) \* \(var\(--quiz-fit-scale\) - 1\) \/ 2\);/);
  });

  it("pins the join card to the window on a question shorter than 700 px", () => {
    expect(index).toMatch(/@media \(min-width: 761px\) and \(max-height: 699px\) \{\s*\.quiz-surface \.slide-join-panel \{\s*position: fixed;/);
  });

  it("measures the toolbar's real height and hands it to the stylesheet", () => {
    expect(surface).toContain("toolbar.offsetTop + height");
    expect(surface).toContain('safe.style.setProperty("--slide-toolbar-clear"');
    expect(surface).toContain("new ResizeObserver(measure)");
    // Before the first paint, so the title does not jump.
    expect(surface).toContain("useLayoutEffect(() => {\n    const safe = safeRef.current;");
  });

  it("pads the slide's top by that height plus a 1.25 to 1.5 rem gap, from 761px up", () => {
    const gap = index.match(/--slide-toolbar-gap: ([\d.]+)rem;/);
    expect(gap).not.toBeNull();
    expect(Number(gap?.[1])).toBeGreaterThanOrEqual(1.25);
    expect(Number(gap?.[1])).toBeLessThanOrEqual(1.5);
    expect(index).toMatch(/@media \(min-width: 761px\) \{\s*\.slide-surface:not\(\.slide-surface-live-embed\) > \.slide-safe\[data-toolbar="true"\] \{\s*padding-top: calc\(var\(--slide-toolbar-clear\) \+ var\(--slide-toolbar-gap\)\);/);
  });
});
