import {
  findVideoLinksInMarkdown,
  parseStartSeconds,
  resolveVideoUrl,
  videoLinkMarkdown,
  videoProviderName,
} from "@mdq/shared";
import { parseQuizMarkdown } from "../parser";

const YT = "https://www.youtube.com/watch?v=abc123DEF45";

function target(url: string) {
  const result = resolveVideoUrl(url);
  if (!result.ok) throw new Error(`expected ${url} to resolve: ${result.reason}`);
  return result.target;
}

function refused(url: string) {
  const result = resolveVideoUrl(url);
  expect(result.ok).toBe(false);
  return result.ok ? "" : result.reason;
}

describe("video link detector", () => {
  it("turns a paragraph that is only a Video: link into a video descriptor", () => {
    const [match] = findVideoLinksInMarkdown(`Intro\n\n[Video: How a lens focuses light](${YT})\n\nAfter`);
    expect(match.lineIndex).toBe(2);
    expect(match.video).toEqual({
      url: YT,
      label: "How a lens focuses light",
      provider: "youtube",
      embedUrl: "https://www.youtube-nocookie.com/embed/abc123DEF45",
    });
  });

  it("accepts any case and an optional space after the colon", () => {
    for (const text of ["video:Lens", "VIDEO: Lens", "Video:   Lens"]) {
      const [match] = findVideoLinksInMarkdown(`[${text}](${YT})`);
      expect(match.video?.label).toBe("Lens");
    }
  });

  it("falls back to a plain label when nothing follows Video:", () => {
    expect(findVideoLinksInMarkdown(`[Video:](${YT})`)[0].video?.label).toBe("Video");
  });

  it("leaves ordinary links alone, including a video site written as prose", () => {
    const md = [
      `[How a lens focuses light](${YT})`,
      "",
      `[Watch the video: lens](${YT})`,
      "",
      `Watch it on [YouTube](${YT}) tonight.`,
      "",
      YT,
      "",
      `<${YT}>`,
    ].join("\n");
    expect(findVideoLinksInMarkdown(md)).toEqual([]);
  });

  it("leaves a Video: link inside a sentence, a list, a quote or a shared paragraph alone", () => {
    const md = [
      `See [Video: Lens](${YT}) for more.`,
      "",
      `- [Video: Lens](${YT})`,
      "",
      `> [Video: Lens](${YT})`,
      "",
      "A line above the link",
      `[Video: Lens](${YT})`,
      "",
      `[Video: Lens](${YT}) and a tail`,
    ].join("\n");
    expect(findVideoLinksInMarkdown(md)).toEqual([]);
  });

  it("leaves code fences, tilde fences and indented code untouched", () => {
    const md = [
      "```md",
      `[Video: In a fence](${YT})`,
      "```",
      "",
      "~~~",
      `[Video: In a tilde fence](${YT})`,
      "~~~",
      "",
      `    [Video: Indented code](${YT})`,
      "",
      "`[Video: in a span](" + YT + ")`",
    ].join("\n");
    expect(findVideoLinksInMarkdown(md)).toEqual([]);
  });

  it("still finds a link right after a closing fence", () => {
    const md = ["```", "code", "```", `[Video: After the fence](${YT})`].join("\n");
    expect(findVideoLinksInMarkdown(md).map((m) => m.label)).toEqual(["After the fence"]);
  });

  it("reports why an unsupported Video: link is not converted", () => {
    const [match] = findVideoLinksInMarkdown("[Video: Elsewhere](https://example.com/watch?v=abc123DEF45)");
    expect(match.video).toBeUndefined();
    expect(match.reason).toContain("example.com");
    expect(match.reason).toContain("youtu.be/ID");
    expect(match.reason).toContain("vimeo.com/ID");
    expect(match.reason).toContain(".mp4");
  });

  it("reads escaped brackets in the label, angle-bracket addresses and titles", () => {
    const [match] = findVideoLinksInMarkdown(`[Video: A \\[draft\\] cut](<${YT}> "Title")`);
    expect(match.label).toBe("A [draft] cut");
    expect(match.video?.provider).toBe("youtube");
  });
});

describe("video link writer", () => {
  it("writes the canonical line", () => {
    expect(videoLinkMarkdown(YT, "How a lens focuses light")).toBe(`[Video: How a lens focuses light](${YT})`);
  });

  it("escapes brackets and backslashes in the label and round-trips", () => {
    const label = "Part [2] of a\\b";
    const line = videoLinkMarkdown(YT, label);
    expect(line).toBe(`[Video: Part \\[2\\] of a\\\\b](${YT})`);
    const [match] = findVideoLinksInMarkdown(line);
    expect(match.label).toBe(label);
  });

  it("percent-encodes spaces and parentheses in the address and round-trips", () => {
    const url = "https://media.example.edu/clips/lens (final).mp4?t=1";
    const line = videoLinkMarkdown(url, "Lens");
    expect(line).toBe("[Video: Lens](https://media.example.edu/clips/lens%20%28final%29.mp4?t=1)");
    const [match] = findVideoLinksInMarkdown(line);
    expect(match.video?.provider).toBe("file");
    expect(decodeURI(new URL(match.url).href)).toBe(decodeURI(new URL(url).href));
  });

  it("collapses line breaks in the label", () => {
    expect(videoLinkMarkdown(YT, "one\ntwo   three")).toBe(`[Video: one two three](${YT})`);
  });
});

describe("YouTube adapter", () => {
  it.each([
    ["https://www.youtube.com/watch?v=abc123DEF45"],
    ["https://youtube.com/watch?v=abc123DEF45&list=PL1"],
    ["https://m.youtube.com/watch?v=abc123DEF45"],
    ["https://youtu.be/abc123DEF45"],
    ["https://www.youtube.com/shorts/abc123DEF45"],
    ["https://www.youtube.com/embed/abc123DEF45"],
  ])("accepts %s", (url) => {
    expect(target(url)).toEqual({
      provider: "youtube",
      embedUrl: "https://www.youtube-nocookie.com/embed/abc123DEF45",
    });
  });

  it("keeps t= and start= as the start time", () => {
    expect(target("https://youtu.be/abc123DEF45?t=90")).toMatchObject({
      startSeconds: 90,
      embedUrl: "https://www.youtube-nocookie.com/embed/abc123DEF45?start=90",
    });
    expect(target("https://www.youtube.com/watch?v=abc123DEF45&t=1m30s").startSeconds).toBe(90);
    expect(target("https://www.youtube.com/embed/abc123DEF45?start=12").startSeconds).toBe(12);
    expect(target("https://youtu.be/abc123DEF45?t=nonsense").startSeconds).toBeUndefined();
  });

  it("reads start times", () => {
    expect(parseStartSeconds("45")).toBe(45);
    expect(parseStartSeconds("45s")).toBe(45);
    expect(parseStartSeconds("1h2m3s")).toBe(3723);
    expect(parseStartSeconds("2m")).toBe(120);
    expect(parseStartSeconds("")).toBe(0);
    expect(parseStartSeconds("-5")).toBe(0);
    expect(parseStartSeconds("m")).toBe(0);
  });

  it.each([
    ["http://www.youtube.com/watch?v=abc123DEF45"],
    ["https://www.youtube.com/watch?v=short"],
    ["https://www.youtube.com/watch?v=abc123DEF45xx"],
    ["https://www.youtube.com/watch?v=abc123DE<45"],
    ["https://www.youtube.com/watch"],
    ["https://www.youtube.com/playlist?list=PL12345678901"],
    ["https://www.youtube.com/embed/abc123DEF45/extra"],
    ["https://youtu.be/abc123DEF45/extra"],
    ["https://youtube.com.evil.test/watch?v=abc123DEF45"],
    ["https://evilyoutube.com/watch?v=abc123DEF45"],
    ["https://youtube.com@evil.test/watch?v=abc123DEF45"],
    ["https://user:pw@www.youtube.com/watch?v=abc123DEF45"],
    ["https://www.youtube.com:8443/watch?v=abc123DEF45"],
    ["https://music.youtube.com/watch?v=abc123DEF45"],
    ["https://www.youtu.be/abc123DEF45"],
  ])("refuses %s", (url) => {
    refused(url);
  });
});

describe("Vimeo adapter", () => {
  it("accepts vimeo.com/ID, the www host and the player address", () => {
    const expected = { provider: "vimeo", embedUrl: "https://player.vimeo.com/video/76979871?dnt=1" };
    expect(target("https://vimeo.com/76979871")).toEqual(expected);
    expect(target("https://www.vimeo.com/76979871")).toEqual(expected);
    expect(target("https://player.vimeo.com/video/76979871")).toEqual(expected);
  });

  it("keeps the hash of an unlisted video", () => {
    const expected = { provider: "vimeo", embedUrl: "https://player.vimeo.com/video/76979871?h=a1b2c3d4e5&dnt=1" };
    expect(target("https://vimeo.com/76979871/a1b2c3d4e5")).toEqual(expected);
    expect(target("https://player.vimeo.com/video/76979871?h=a1b2c3d4e5")).toEqual(expected);
  });

  it.each([
    ["http://vimeo.com/76979871"],
    ["https://vimeo.com/channels/staffpicks/76979871"],
    ["https://vimeo.com/notanumber"],
    ["https://vimeo.com/76979871/NOTAHASH"],
    ["https://vimeo.com/76979871/a1b2c3d4e5/more"],
    ["https://vimeo.com/1234567890123"],
    ["https://player.vimeo.com/video/76979871?h=zz"],
    ["https://player.vimeo.com/76979871"],
    ["https://vimeo.com.evil.test/76979871"],
    ["https://notvimeo.com/76979871"],
    ["https://player.vimeo.com.evil.test/video/76979871"],
  ])("refuses %s", (url) => {
    refused(url);
  });
});

describe("direct video file adapter", () => {
  it.each(["mp4", "webm", "m4v", "mov", "MP4"])("accepts a .%s file", (ext) => {
    const url = `https://media.example.edu/clips/lens.${ext}`;
    expect(target(url)).toEqual({ provider: "file", fileUrl: url });
  });

  it("allows a query string", () => {
    const url = "https://media.example.edu/lens.mp4?token=abc&t=2";
    expect(target(url).fileUrl).toBe(url);
  });

  it.each([
    ["http://media.example.edu/lens.mp4"],
    ["https://media.example.edu/lens.mkv"],
    ["https://media.example.edu/lens"],
    ["https://media.example.edu/page?file=lens.mp4"],
    ["https://media.example.edu/lens.mp4/extra"],
    ["ftp://media.example.edu/lens.mp4"],
    ["//media.example.edu/lens.mp4"],
    ["/videos/lens.mp4"],
    ["javascript:alert(1)//lens.mp4"],
    ["data:video/mp4;base64,AAAA"],
    ["https://user:pw@media.example.edu/lens.mp4"],
    ["file:///tmp/lens.mp4"],
    [""],
  ])("refuses %s", (url) => {
    refused(url);
  });
});

describe("unsupported addresses", () => {
  it.each([
    ["javascript:alert(1)"],
    ["data:text/html,<b>x</b>"],
    ["https://example.com/watch?v=abc123DEF45"],
    ["https://dailymotion.com/video/x7tgad0"],
  ])("refuses %s and names the supported forms", (url) => {
    const reason = refused(url);
    expect(reason).toContain("youtube.com/watch?v=ID");
  });

  it("says that only https is accepted for http", () => {
    expect(refused("http://youtu.be/abc123DEF45")).toContain("https");
  });
});

describe("provider names", () => {
  it("names each provider and shows the host for a file", () => {
    expect(videoProviderName("youtube")).toBe("YouTube");
    expect(videoProviderName("vimeo")).toBe("Vimeo");
    expect(videoProviderName("file", "https://media.example.edu/a.mp4")).toBe("media.example.edu");
    expect(videoProviderName("file")).toBe("Video file");
  });
});

describe("parser: video links", () => {
  const deck = (body: string) => `# Deck

---

## Optics

type: slide

${body}

---`;

  it("makes the link the slide's video and removes the line from the text", () => {
    const result = parseQuizMarkdown(
      deck(`Rays bend.\n\n[Video: How a lens focuses light](${YT}&t=30)\n\nMore text.`),
      "week01.md",
    );
    expect(result.errors).toHaveLength(0);
    expect(result.diagnostics).toHaveLength(0);
    const q = result.quiz!.questions[0];
    expect(q.slideVideo).toEqual({
      embedUrl: "https://www.youtube-nocookie.com/embed/abc123DEF45?start=30",
      label: "How a lens focuses light",
      link: { url: `${YT}&t=30`, provider: "youtube", mode: "iframe", startSeconds: 30 },
    });
    expect(q.textMd).toBe("Rays bend.\n\n\nMore text.");
    expect(q.textHtml).not.toContain("youtube");
  });

  it("plays a direct file natively", () => {
    const url = "https://media.example.edu/lens.webm";
    const q = parseQuizMarkdown(deck(`[Video: Lens](${url})`), "week01.md").quiz!.questions[0];
    expect(q.slideVideo).toEqual({
      embedUrl: url,
      label: "Lens",
      link: { url, provider: "file", mode: "file" },
    });
  });

  it("keeps an ordinary link, and a Video: link inside a sentence, as links", () => {
    const q = parseQuizMarkdown(
      deck(`[Lens](${YT})\n\nSee [Video: Lens](${YT}) here.`),
      "week01.md",
    ).quiz!.questions[0];
    expect(q.slideVideo).toBeUndefined();
    expect(q.textHtml).toContain(`href="${YT}"`);
    expect(q.textHtml.match(/<a /g)).toHaveLength(2);
  });

  it("keeps an unsupported address as a link and adds an info diagnostic", () => {
    const result = parseQuizMarkdown(
      deck("[Video: Elsewhere](https://example.com/clip)\n"),
      "week01.md",
    );
    expect(result.errors).toHaveLength(0);
    expect(result.quiz!.questions[0].slideVideo).toBeUndefined();
    expect(result.quiz!.questions[0].textHtml).toContain('href="https://example.com/clip"');
    expect(result.diagnostics).toHaveLength(1);
    expect(result.diagnostics[0]).toMatchObject({ severity: "info", questionIndex: 0 });
    expect(result.diagnostics[0].message).toContain("youtu.be/ID");
  });

  it("keeps the first supported video and reports a second", () => {
    const result = parseQuizMarkdown(
      deck(`[Video: One](${YT})\n\n[Video: Two](https://vimeo.com/76979871)`),
      "week01.md",
    );
    const q = result.quiz!.questions[0];
    expect(q.slideVideo?.label).toBe("One");
    expect(q.textHtml).toContain("vimeo.com/76979871");
    expect(result.diagnostics).toHaveLength(1);
  });

  it("leaves a link in a code fence alone", () => {
    const q = parseQuizMarkdown(deck("```md\n[Video: Lens](" + YT + ")\n```"), "week01.md").quiz!.questions[0];
    expect(q.slideVideo).toBeUndefined();
    expect(q.textHtml).toContain("<code");
  });

  it("does not look for video links outside slides", () => {
    const md = `# Deck

---

## Poll

question_type: poll

**Which one?**

[Video: Lens](${YT})

A. one
B. two

---`;
    const result = parseQuizMarkdown(md, "week01.md");
    expect(result.quiz!.questions[0].slideVideo).toBeUndefined();
  });

  it("still supports the video_card syntax unchanged", () => {
    const result = parseQuizMarkdown(
      deck(
        "video_card: https://example.com/embed/xyz\nvideo_thumbnail: ../images/poster.png\nvideo_caption: A caption\nvideo_label: Play it\n\nBody.",
      ),
      "week01.md",
    );
    expect(result.quiz!.questions[0].slideVideo).toEqual({
      embedUrl: "https://example.com/embed/xyz",
      thumbnail: "/data/images/poster.png",
      caption: "A caption",
      label: "Play it",
    });
    expect(result.diagnostics).toHaveLength(0);
  });

  it("lets video_card win over a Video: link and says so", () => {
    const result = parseQuizMarkdown(
      deck(`video_card: https://example.com/embed/xyz\n\n[Video: Lens](${YT})`),
      "week01.md",
    );
    const q = result.quiz!.questions[0];
    expect(q.slideVideo?.embedUrl).toBe("https://example.com/embed/xyz");
    expect(q.slideVideo?.link).toBeUndefined();
    expect(q.textHtml).toContain("youtube.com");
    expect(result.diagnostics).toHaveLength(1);
  });
});
