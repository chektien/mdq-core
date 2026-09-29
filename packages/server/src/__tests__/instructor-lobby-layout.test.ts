import fs from "fs";
import path from "path";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string =>
  fs.readFileSync(path.join(clientSrc, rel), "utf-8");

describe("instructor lobby layout", () => {
  const index = read("index.css");
  const instructor = read("views/InstructorView.tsx");

  it("puts the join details beside the room status on landscape screens", () => {
    const start = index.indexOf("@media (min-width: 900px) and (orientation: landscape) {");
    expect(start).toBeGreaterThanOrEqual(0);
    const block = index.slice(start, index.indexOf("\n}\n", start));
    expect(block).toMatch(/\.instructor-lobby-body \{\s*flex-direction: row;/);
    expect(block).toContain(".instructor-lobby-side {");
  });

  it("keeps the QR panel in the join column and Start Session in the status column", () => {
    const lobby = instructor.slice(instructor.indexOf('<div className="instructor-lobby-body">'));
    const join = lobby.indexOf('<div className="instructor-lobby-join">');
    const side = lobby.indexOf('<div className="instructor-lobby-side">');
    expect(join).toBeGreaterThanOrEqual(0);
    expect(side).toBeGreaterThan(join);
    const qr = lobby.indexOf("<QRPanel");
    expect(qr).toBeGreaterThan(join);
    expect(qr).toBeLessThan(side);
    for (const marker of ["instructor-participant-count", "<ParticipantList", "restoreNotice", "instructor-start-button"]) {
      expect(lobby.indexOf(marker)).toBeGreaterThan(side);
    }
  });
});
