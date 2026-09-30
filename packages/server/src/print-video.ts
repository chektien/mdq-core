import { videoProviderName, type Question } from "@mdq/shared";

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function hostnameOf(href: string): string | undefined {
  try {
    return new URL(href).hostname || undefined;
  } catch {
    return undefined;
  }
}

/**
 * A slide video prints as its label, its provider and its address as a link.
 * There is no player on paper. An address that is not a usable web link, such
 * as a local file path or a broken address, prints as plain text.
 */
export function renderVideoNote(question: Pick<Question, "slideVideo">): string {
  const video = question.slideVideo;
  if (!video) return "";
  const label = video.label || "Video";
  const href = video.link?.url ?? video.embedUrl;
  const host = /^https?:\/\//i.test(href) && !/\s/.test(href) ? hostnameOf(href) : undefined;
  const external = host !== undefined;
  const provider = video.link ? videoProviderName(video.link.provider, href) : host ?? "Video file";
  return `
    <section class="video-note" aria-label="Video">
      <span class="video-note-label">${escapeHtml(label)}</span>
      <span class="video-note-provider">${escapeHtml(provider)}</span>
      ${external
        ? `<a class="video-note-link" href="${escapeHtml(href)}">${escapeHtml(href)}</a>`
        : `<span class="video-note-link">${escapeHtml(href)}</span>`}
    </section>
  `;
}
