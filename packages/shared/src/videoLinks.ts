/**
 * The video link convention. A paragraph that is only one Markdown link whose
 * text starts with `Video:` becomes a video on the slide:
 *
 *   [Video: How a lens focuses light](https://www.youtube.com/watch?v=abc123DEF45)
 *
 * Any other link stays an ordinary link, so the line still reads as a usable
 * link in every other Markdown renderer. This module only recognises and
 * writes the convention. The provider rules live in videoProviders.ts.
 */
import { resolveVideoUrl, type VideoProvider } from "./videoProviders";

export interface VideoLinkDescriptor {
  /** The address as the author wrote it. */
  url: string;
  /** The text after `Video:`. It is also the accessible name of the video. */
  label: string;
  provider: VideoProvider;
  embedUrl?: string;
  fileUrl?: string;
  startSeconds?: number;
}

export interface VideoLinkMatch {
  /** Index of the line in the lines that were scanned. */
  lineIndex: number;
  url: string;
  label: string;
  /** Present when the address is supported. */
  video?: VideoLinkDescriptor;
  /** Present when the address is not supported: why, and what is supported. */
  reason?: string;
}

/** The label shown when the author writes `Video:` with nothing after it. */
export const DEFAULT_VIDEO_LABEL = "Video";

const PREFIX = /^video:[ \t]*/i;
// [text](destination "title"), where the text may hold escaped brackets and
// the destination is either <...> or a run without spaces that may nest one
// level of balanced parentheses.
const LINK_ONLY = /^\[((?:\\.|[^\]\\])*)\]\(\s*(<[^<>\n]*>|(?:\\.|[^\s()\\]|\((?:\\.|[^\s()\\])*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)$/;

function unescapeMarkdown(text: string): string {
  return text.replace(/\\([!-/:-@[-`{-~])/g, "$1");
}

/** Reads one line as `[Video: label](url)`, or returns null when it is anything else. */
export function parseVideoLinkLine(line: string): { label: string; url: string } | null {
  const leading = line.match(/^ */)![0].length;
  if (leading > 3 || line.startsWith("\t")) return null;
  const match = line.trim().match(LINK_ONLY);
  if (!match) return null;
  const text = unescapeMarkdown(match[1]).trim();
  if (!PREFIX.test(text)) return null;
  const label = text.replace(PREFIX, "").trim() || DEFAULT_VIDEO_LABEL;
  const destination = match[2].startsWith("<") ? match[2].slice(1, -1) : match[2];
  return { label, url: unescapeMarkdown(destination.trim()) };
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const ATX_HEADING = /^ {0,3}#{1,6}(?:[ \t]|$)/;
const THEMATIC_BREAK = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;

/**
 * Finds every video link paragraph in slide Markdown lines. Fenced code, code
 * indented four spaces, links inside a sentence, list items and quotes are
 * never matched, and neither is a link that shares its paragraph with other
 * lines.
 */
export function findVideoLinks(lines: readonly string[]): VideoLinkMatch[] {
  const matches: VideoLinkMatch[] = [];
  const boundary = new Array<boolean>(lines.length).fill(false);
  const code = new Array<boolean>(lines.length).fill(false);
  let fence: { char: string; length: number } | null = null;

  lines.forEach((line, index) => {
    if (fence) {
      code[index] = true;
      const close = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/);
      if (close && close[1][0] === fence.char && close[1].length >= fence.length) {
        fence = null;
        boundary[index] = true;
      }
      return;
    }
    const open = line.match(FENCE);
    if (open) {
      fence = { char: open[1][0], length: open[1].length };
      code[index] = true;
      boundary[index] = true;
      return;
    }
    boundary[index] = !line.trim() || ATX_HEADING.test(line) || THEMATIC_BREAK.test(line);
  });

  const isBoundary = (index: number) => index < 0 || index >= lines.length || boundary[index];
  lines.forEach((line, index) => {
    if (code[index] || boundary[index]) return;
    if (!isBoundary(index - 1) || !isBoundary(index + 1)) return;
    const link = parseVideoLinkLine(line);
    if (!link) return;
    const resolved = resolveVideoUrl(link.url);
    if (resolved.ok) {
      const { target } = resolved;
      matches.push({
        lineIndex: index,
        ...link,
        video: {
          url: link.url,
          label: link.label,
          provider: target.provider,
          ...(target.embedUrl ? { embedUrl: target.embedUrl } : {}),
          ...(target.fileUrl ? { fileUrl: target.fileUrl } : {}),
          ...(target.startSeconds ? { startSeconds: target.startSeconds } : {}),
        },
      });
    } else {
      matches.push({ lineIndex: index, ...link, reason: resolved.reason });
    }
  });
  return matches;
}

/** Finds the video link paragraphs in a Markdown string. */
export function findVideoLinksInMarkdown(markdown: string): VideoLinkMatch[] {
  return findVideoLinks(markdown.split("\n"));
}

/**
 * The canonical line for a video link. Brackets and backslashes in the label
 * are escaped and spaces and parentheses in the address are percent-encoded,
 * so the line parses back to the same label and address.
 */
export function videoLinkMarkdown(url: string, label: string): string {
  const text = label.replace(/\s+/g, " ").trim().replace(/[\\[\]]/g, "\\$&");
  const href = url.trim().replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
  return `[Video: ${text}](${href})`;
}
