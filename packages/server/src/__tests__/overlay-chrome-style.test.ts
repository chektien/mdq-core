import fs from "fs";
import path from "path";

const css = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "..", "client", "src", "index.css"),
  "utf-8",
).replace(/\/\*[\s\S]*?\*\//g, "");

const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((match) => ({
  selector: match[1].trim().replace(/\s+/g, " "),
  body: match[2],
}));

// Our own chrome over the slide is calm and secondary to it. A left stripe is an
// accent that has to tell the reader something nothing else does, and none of the
// chrome does: the next-up label, the notes, the join card and the toolbar say
// what they are in their own label. The one stripe left is the quote mark inside
// a note's own text, which is the note author's content.
describe("overlay chrome uses no left accent stripe", () => {
  it("draws no left border on any rule except a quote inside a note", () => {
    const stripes = rules
      .filter((rule) => /border-(left|inline-start)(-[a-z]+)?\s*:/.test(rule.body))
      .map((rule) => rule.selector);
    expect(stripes).toEqual([".foldout-note-body blockquote"]);
  });

  it("draws no left-anchored accent bar with a hard-stop gradient", () => {
    const bars = rules.filter((rule) => /linear-gradient\(90deg,.*\s0\s+[0-9.]+(cqi|px|rem)\b/.test(rule.body));
    expect(bars.map((rule) => rule.selector)).toEqual([]);
  });

  it("keeps the next-up label and the notes outlined all round", () => {
    for (const selector of [".slide-next-up", ".foldout-note"]) {
      const outlined = rules.some((rule) => rule.selector.split(",").map((s) => s.trim()).includes(selector) && /border:\s*1px solid/.test(rule.body));
      expect(outlined).toBe(true);
    }
  });

  it("keeps the projector's next-up label in the top-left corner below 1300px", () => {
    expect(css).toMatch(/\.slide-toolbar:not\(:has\(\.slide-toolbar-nav, \.slide-status-pill\)\) \.slide-toolbar-stack \{\s*grid-column: 1;\s*grid-row: 1;/);
  });
});
