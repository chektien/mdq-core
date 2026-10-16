import path from "path";
import { buildSync } from "esbuild";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const root = path.resolve(__dirname, "..", "..", "..");
const bundled = buildSync({ entryPoints: [path.join(root, "client/src/components/AvailabilityChoice.tsx")], bundle: true, platform: "node", format: "cjs", jsx: "automatic", write: false, packages: "external", alias: { "@mdq/shared": path.join(root, "shared/src/index.ts") } });
const compiled = { exports: {} };
new Function("require", "module", "exports", bundled.outputFiles[0].text)(require, compiled, compiled.exports);
type Choice = { kind: "preset"; key: string } | { kind: "exact"; value: string };
const choice = compiled.exports as {
  default: ComponentType<{ choice: Choice; onChange: (choice: Choice) => void; now: number; previous?: number; extension?: boolean }>;
  boundedCustomTime: (value: string, now: number, previous?: number) => string;
  firstCustomTime: (now: number, previous?: number) => string;
  latestCustomTime: (now: number) => string;
  deadlineProblem: (choice: Choice, now: number, previous?: number) => string | null;
};

// Local wall-clock times, so the expectations hold in any test time zone.
const now = new Date(2026, 9, 8, 17, 10).getTime();

describe("custom availability day and time stay within the allowed window", () => {
  it("pulls a later time on the last allowed day back to the latest allowed time", () => {
    expect(choice.latestCustomTime(now)).toBe("2026-10-15T17:00");
    const bounded = choice.boundedCustomTime("2026-10-15T18:30", now);
    expect(bounded).toBe("2026-10-15T17:00");
    expect(choice.deadlineProblem({ kind: "exact", value: bounded }, now)).toBeNull();
  });

  it("pulls an earlier time up to the first allowed time, after the current end when extending", () => {
    expect(choice.boundedCustomTime("2026-10-08T09:00", now)).toBe(choice.firstCustomTime(now));
    const previous = new Date(2026, 9, 9, 10, 0).getTime();
    expect(choice.boundedCustomTime("2026-10-09T08:00", now, previous)).toBe("2026-10-09T10:15");
  });

  it("keeps an allowed or incomplete value unchanged", () => {
    expect(choice.boundedCustomTime("2026-10-12T09:45", now)).toBe("2026-10-12T09:45");
    expect(choice.boundedCustomTime("2026-10-15T", now)).toBe("2026-10-15T");
  });

  it("says when the chosen end is the latest allowed", () => {
    const html = renderToStaticMarkup(createElement(choice.default, { choice: { kind: "exact", value: "2026-10-15T17:00" }, onChange: () => undefined, now, extension: true }));
    expect(html).toContain(", the latest allowed");
    expect(html).not.toContain('role="alert"');
  });
});
