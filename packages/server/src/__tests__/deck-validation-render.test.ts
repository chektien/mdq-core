import path from "path";
import { buildSync } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { DeckValidationReport } from "@mdq/shared";

// Use the real client JSX, as in the cover-rendering tests. No browser or service is opened.
function component<Props extends object>(entry: string): ComponentType<Props> {
  const root = path.resolve(__dirname, "../../..");
  const bundle = buildSync({
    entryPoints: [path.join(root, "client/src", entry)],
    bundle: true,
    platform: "node",
    format: "cjs",
    jsx: "automatic",
    write: false,
    packages: "external",
    alias: { "@mdq/shared": path.join(root, "shared/src/index.ts") },
  });
  const compiled = { exports: {} };
  new Function("require", "module", "exports", bundle.outputFiles[0].text)(require, compiled, compiled.exports);
  return (compiled.exports as { default: ComponentType<Props> }).default;
}

const InstructorView = component("views/InstructorView.tsx");
const DeckValidationNotice = component<{ report: DeckValidationReport }>("components/DeckValidationNotice.tsx");

describe("authoring recovery rendering", () => {
  it("keeps Reload Decks available when no deck chooser can be rendered", () => {
    const html = renderToStaticMarkup(createElement(InstructorView));
    expect(html).toContain("No decks found");
    expect(html).toMatch(/<button\b[^>]*>Reload Decks<\/button>/);
    expect(html).not.toContain("Create Session");
  });

  it("renders every grouped diagnostic, locations and likely fixes without interpreting author text as HTML", () => {
    const report: DeckValidationReport = {
      issueCount: 8,
      files: ["first.md", "second.md"].map((sourceFile) => ({
        sourceFile,
        issues: Array.from({ length: 4 }, (_, index) => ({
          questionIndex: index - 1,
          lineNumber: index + 2,
          detail: `Diagnostic ${sourceFile} ${index} <script>`,
          likelyFix: `Fix ${sourceFile} ${index} with type: open_response`,
        })),
      })),
    };
    const html = renderToStaticMarkup(createElement(DeckValidationNotice, { report }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("8 issues in 2 files");
    expect(html.match(/<section\b/g)).toHaveLength(2);
    expect(html.match(/<li\b/g)).toHaveLength(8);
    for (const file of report.files) {
      for (const issue of file.issues) {
        expect(html).toContain(`${file.sourceFile}:${issue.lineNumber}`);
        expect(html).toContain(issue.likelyFix);
        expect(html).toContain(issue.detail.replace("<script>", "&lt;script&gt;"));
      }
    }
    expect(html).not.toContain("<script>");
    expect(html).toContain("No server restart is needed");
    expect(html).toContain("Reload Decks below");
  });
});
