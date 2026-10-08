import fs from "fs";
import path from "path";

const css = fs.readFileSync(
  path.resolve(__dirname, "..", "..", "..", "client", "src", "index.css"),
  "utf-8",
);

// Bodies of every rule whose whole selector is `selector`, media queries included.
function blocks(selector: string): string[] {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...css.matchAll(new RegExp(`(?:^|\\n)\\s*${escaped} \\{([^}]*)\\}`, "g"))].map((match) => match[1]);
}

describe("slide reference footer spacing", () => {
  const footers = blocks(".slide-references");

  it("leaves room for link underlines between wrapped lines at every width", () => {
    const heights = footers.flatMap((block) => [...block.matchAll(/line-height:\s*([\d.]+)/g)].map((match) => Number(match[1])));
    expect(heights.length).toBeGreaterThanOrEqual(2);
    for (const height of heights) expect(height).toBeGreaterThanOrEqual(1.4);
  });

  it("balances wrapped lines and spaces separate references further apart", () => {
    expect(footers[0]).toMatch(/text-wrap: balance;/);
    expect(blocks(".slide-references ol")[0]).toMatch(/gap: 0\.4em;/);
  });

  it("keeps every reference link underlined with a hairline", () => {
    const link = blocks(".slide-reference-text a")[0];
    expect(link).toMatch(/text-decoration: underline;/);
    expect(link).toMatch(/text-decoration-thickness: max\(1px, 0\.06em\);/);
  });
});
