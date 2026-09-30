import fs from "fs";
import path from "path";
import { marked } from "marked";
import {
  SLIDE_LINK_REL,
  SLIDE_LINK_TARGET,
  openLinksInNewTab,
  opensInNewTab,
  type SlideLinkElement,
} from "../../../client/src/slideLinks";

const clientSrc = path.resolve(__dirname, "..", "..", "..", "client", "src");
const read = (rel: string): string => fs.readFileSync(path.join(clientSrc, rel), "utf-8");
const base = "https://mdq.example/";

const link = (href: string | null): SlideLinkElement & { attrs: Record<string, string> } => {
  const attrs: Record<string, string> = {};
  return {
    attrs,
    getAttribute: (name) => (name === "href" ? href : attrs[name] ?? null),
    setAttribute: (name, value) => { attrs[name] = value; },
  };
};

describe("slide links", () => {
  it("opens web links in a new tab", () => {
    expect(opensInNewTab("https://example.com/page", base)).toBe(true);
    expect(opensInNewTab("http://example.com", base)).toBe(true);
    expect(opensInNewTab("HTTPS://EXAMPLE.COM", base)).toBe(true);
    expect(opensInNewTab("//example.com/x", base)).toBe(true);
  });

  it("also moves a relative link, since it would replace the session page", () => {
    expect(opensInNewTab("/docs/guide", base)).toBe(true);
    expect(opensInNewTab("guide.html", base)).toBe(true);
  });

  it("leaves in-page anchors, mail, phone, script and empty links as written", () => {
    for (const href of ["#notes", "#/", "mailto:someone@example.com", "tel:+6500000000", "javascript:void(0)", "", "   ", null, undefined]) {
      expect(opensInNewTab(href, base)).toBe(false);
    }
  });

  it("sets target _blank and rel noopener noreferrer, and reports how many it changed", () => {
    const web = link("https://example.com");
    const anchor = link("#top");
    const mail = link("mailto:someone@example.com");
    const authored = link("https://example.com/other");
    authored.attrs.target = "_self";
    authored.attrs.rel = "author";
    expect(openLinksInNewTab([web, anchor, mail, authored], base)).toBe(2);
    expect(web.attrs).toEqual({ target: "_blank", rel: "noopener noreferrer" });
    expect(authored.attrs).toEqual({ target: "_blank", rel: "noopener noreferrer" });
    expect(anchor.attrs).toEqual({});
    expect(mail.attrs).toEqual({});
    expect(SLIDE_LINK_TARGET).toBe("_blank");
    expect(SLIDE_LINK_REL).toBe("noopener noreferrer");
  });

  it("changes markdown output only in the browser, so the served HTML and any sanitising stay as they were", () => {
    const html = marked.parse("A [link](https://example.com/a) here.", { async: false }) as string;
    expect(html).toContain('<a href="https://example.com/a">');
    expect(html).not.toContain("target=");
    const parser = fs.readFileSync(path.resolve(__dirname, "..", "parser.ts"), "utf-8");
    expect(parser).not.toContain("_blank");
  });

  it("is applied wherever slide HTML is shown, which is the one QuizHtml component", () => {
    const quizHtml = read("components/QuizHtml.tsx");
    expect(quizHtml).toContain('openLinksInNewTab(container.querySelectorAll("a[href]"), document.baseURI);');
    expect(quizHtml.match(/dangerouslySetInnerHTML/g)).toHaveLength(1);
    for (const dir of ["components", "views"]) {
      for (const file of fs.readdirSync(path.join(clientSrc, dir))) {
        if (!file.endsWith(".tsx") || file === "QuizHtml.tsx") continue;
        expect(read(path.join(dir, file))).not.toContain("dangerouslySetInnerHTML");
      }
    }
  });

  it("gives the inline markdown text the same rel", () => {
    expect(read("components/InlineMarkdownText.tsx")).toContain('rel="noopener noreferrer"');
  });
});
