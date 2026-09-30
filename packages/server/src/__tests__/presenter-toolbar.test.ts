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
});
