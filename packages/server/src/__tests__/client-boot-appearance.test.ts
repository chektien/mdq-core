import { readServedAppearance, resolveBootAppearance } from "../../../client/src/appearance";

describe("client boot appearance", () => {
  it("keeps supported theme and palette attributes served on <html>", () => {
    expect(readServedAppearance({ theme: "light", palette: "gruvbox" })).toEqual({ theme: "light", palette: "gruvbox" });
    expect(readServedAppearance({ theme: "sepia", palette: "neon" })).toEqual({ theme: undefined, palette: undefined });
    expect(readServedAppearance({})).toEqual({ theme: undefined, palette: undefined });
  });

  it("prefers served attributes over the runtime config", () => {
    expect(resolveBootAppearance({ theme: "light", palette: "gruvbox" }, { theme: "dark", palette: "classic" })).toEqual({
      theme: "light",
      palette: "gruvbox",
    });
  });

  it("uses the runtime config when nothing was served", () => {
    expect(resolveBootAppearance({}, { theme: "light", palette: "gruvbox" })).toEqual({ theme: "light", palette: "gruvbox" });
  });

  it("falls back to dark classic when neither source is usable", () => {
    expect(resolveBootAppearance({}, { theme: "bogus" })).toEqual({ theme: "dark", palette: "classic" });
  });
});
