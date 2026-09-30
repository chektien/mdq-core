/**
 * The agenda look of a contents slide. A contents slide is ordinary deck
 * Markdown: a heading of Contents, Agenda or Table of contents, then nothing
 * but paragraphs that are one bold line each:
 *
 *     ## Contents
 *
 *     type: slide
 *
 *     **Why this course**
 *
 *     **What you will learn**
 *
 * There is no list, so there are no bullet markers. Such a slide shows its
 * lines larger with about two lines between them, in the deck's own text
 * colour and font, so an agenda reads from the back of a room. Anywhere that
 * does not know the convention still shows plain bold lines.
 */

const AGENDA_HEADING = /^(?:table of contents|contents|agenda)(?: \(continued\))?$/i;
// `<p><strong>...</strong></p>`, with nothing else in the paragraph.
const BOLD_LINE = "<p>\\s*<strong>(?:(?!<\\/?(?:p|strong)[\\s>])[\\s\\S])+<\\/strong>\\s*<\\/p>";
const ONLY_BOLD_LINES = new RegExp(`^\\s*(?:${BOLD_LINE}\\s*)+$`);

/** True for a slide headed Contents, Agenda or Table of contents whose body is only one-line bold paragraphs. */
export function isAgendaSlide(heading: string, bodyHtml: string): boolean {
  return AGENDA_HEADING.test(heading.trim()) && ONLY_BOLD_LINES.test(bodyHtml);
}
