import fs from "fs";
import path from "path";

const css = fs.readFileSync(path.resolve(__dirname, "..", "..", "..", "client", "src", "index.css"), "utf-8");

const declarations = (selector: string) => {
  const rules = [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]*)\{([^{}]*)\}/g)]
    .filter(([, selectors]) => selectors.trim() === selector);
  expect(rules).toHaveLength(1);
  return Object.fromEntries([...rules[0][2].matchAll(/([^:;]+):([^;]+);?/g)]
    .map(([, property, value]) => [property.trim(), value.trim()]));
};

describe("cover media sizing in the stylesheet", () => {
  it("fills the card's image row so themed images can resolve percentage height limits", () => {
    expect(declarations(".slide-cover-media .slide-media-expand-button")).toMatchObject({
      height: "100%",
      width: "auto",
      "max-width": "100%",
      "aspect-ratio": "auto",
    });
  });

  it("keeps cover images at their natural height within the cover media limit", () => {
    expect(declarations(".slide-cover-media img")).toMatchObject({
      height: "auto",
      "max-height": "var(--cover-media-height)",
    });
  });
});
