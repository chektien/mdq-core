import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { chromium, type Browser } from "playwright";
import { parseQuizMarkdown } from "../parser";
import { buildHtml, main, missingImageLabel, parseArgs } from "../print-mdq";

jest.mock("playwright", () => ({ chromium: { launch: jest.fn() } }));

const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX1cAAAAASUVORK5CYII=", "base64");
const dataUrl = `data:image/png;base64,${png.toString("base64")}`;
const externalSources = [
  "https://example.invalid/image.png",
  "http://example.invalid/image.png",
  dataUrl,
  "file:///example/image.png",
  "mailto:example@example.invalid",
];

function deck(missingSource = "images/gone.png"): string {
  return `# Image deck

---

## Opening
type: cover

Welcome.

---

## Pictures
type: slide

![Missing](${missingSource})

![Existing](images/present.png)

${externalSources.map((src) => `![External](${src})`).join("\n\n")}

---

## Again
type: slide

Here it is again: ![Missing](${missingSource})
`;
}

let directory: string;
let inputFile: string;
const originalArgv = process.argv;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "mdq-print-images-"));
  inputFile = path.join(directory, "deck.md");
  fs.mkdirSync(path.join(directory, "images"));
  fs.writeFileSync(path.join(directory, "images/present.png"), png);
});

afterEach(() => {
  process.argv = originalArgv;
  jest.restoreAllMocks();
  jest.clearAllMocks();
  fs.rmSync(directory, { recursive: true, force: true });
});

it("collects each missing local source once with its first printed item number without warning", () => {
  const result = parseQuizMarkdown(deck(), "deck.md");
  expect(result.errors).toEqual([]);
  const options = parseArgs([inputFile]).options;
  const missingImages = new Map<string, number>();
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});

  const html = buildHtml(result.quiz!, options, missingImages);

  expect(missingImages).toEqual(new Map([["images/gone.png", 2]]));
  expect(html).toBe(buildHtml(result.quiz!, options));
  expect(warn).not.toHaveBeenCalled();
  expect(html).toContain(`<img src="${dataUrl}" alt="Existing"`);
  const missingUrl = pathToFileURL(path.join(directory, "images/gone.png")).href;
  expect(html.split(`src="${missingUrl}"`)).toHaveLength(3);
  for (const src of externalSources) expect(html).toContain(`src="${src}"`);
});

it("collects missing images in visible notes and skips hidden presenter notes", () => {
  const result = parseQuizMarkdown(`## Notes
type: slide

> Attendee Note: ![Visible](visible.png)
> Presenter Note: ![Hidden](hidden.png)
`, "deck.md");
  expect(result.errors).toEqual([]);
  const options = parseArgs([inputFile]).options;
  const missingImages = new Map<string, number>();

  buildHtml(result.quiz!, options, missingImages);

  expect(missingImages).toEqual(new Map([["visible.png", 1]]));
  const withoutNotes = new Map<string, number>();
  buildHtml(result.quiz!, { ...options, includeFoldouts: false }, withoutNotes);
  expect(withoutNotes.size).toBe(0);
});

it.each(["relative", "absolute"])("warns once for a missing %s image at command level and finishes printing", async (kind) => {
  const missingSource = kind === "absolute" ? path.join(directory, "gone.png") : "images/gone.png";
  fs.writeFileSync(inputFile, deck(missingSource));
  const outputFile = path.join(directory, "deck.pdf");
  const htmlOut = path.join(directory, "deck.html");
  process.argv = [process.argv[0], "print-mdq", inputFile, "--html", htmlOut];
  const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
  const log = jest.spyOn(console, "log").mockImplementation(() => {});
  const exitCode = process.exitCode;
  const page = {
    setContent: jest.fn().mockResolvedValue(undefined),
    emulateMedia: jest.fn().mockResolvedValue(undefined),
    pdf: jest.fn().mockImplementation(async ({ path: file }: { path: string }) => {
      await fs.promises.writeFile(file, "%PDF-1.4\n");
    }),
  };
  const close = jest.fn().mockResolvedValue(undefined);
  jest.mocked(chromium.launch).mockResolvedValue({
    newPage: jest.fn().mockResolvedValue(page), close,
  } as unknown as Browser);

  await main();

  expect(warn).toHaveBeenCalledTimes(1);
  const source = kind === "absolute" ? "gone.png" : missingSource;
  expect(warn).toHaveBeenCalledWith(`Missing in deck.md, item 2: image "${source}" was not found; the printed page has no picture there.`);
  expect(warn.mock.calls[0][0]).not.toContain(directory);
  expect(page.setContent.mock.calls[0][0]).toContain(`<img src="${dataUrl}" alt="Existing"`);
  expect(fs.readFileSync(htmlOut, "utf-8")).toBe(page.setContent.mock.calls[0][0]);
  expect(log).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(`Printed 3 items to ${outputFile} (0.00 MB)`);
  expect(process.exitCode).toBe(exitCode);
  expect(close).toHaveBeenCalledTimes(1);
});

it("names one source once whether it came from Markdown media or escaped HTML", () => {
  const result = parseQuizMarkdown(`## Mixed
type: slide

![Media](gone.png?a=1&b=2)

> Attendee Note: <img src="gone.png?a=1&amp;b=2" alt="Again">
`, "deck.md");
  expect(result.errors).toEqual([]);
  const missingImages = new Map<string, number>();
  buildHtml(result.quiz!, parseArgs([inputFile]).options, missingImages);
  expect([...missingImages.keys()]).toEqual(["gone.png?a=1&b=2"]);
});

it("labels missing sources without exposing an absolute path on this machine", () => {
  expect(missingImageLabel("images/gone.png")).toBe("images/gone.png");
  expect(missingImageLabel("/data/images/topic/gone.png")).toBe("/data/images/topic/gone.png");
  expect(missingImageLabel("/Users/author/private/gone.png")).toBe("gone.png");
  expect(missingImageLabel("%2FUsers%2Fauthor%2Fprivate%2Fgone.png")).toBe("gone.png");
});
