/**
 * Links inside slide HTML open in a new tab, so a tap on one never replaces the
 * presenter, projector or phone page mid-session. Deck authors write plain
 * markdown links, so the page adds the attributes when it shows the HTML.
 * Only web links change. In-page anchors, mail and phone links, and anything
 * that is not a link to another page are left as written.
 */

export const SLIDE_LINK_TARGET = "_blank";
/** noopener stops the new tab reaching back to the session page, noreferrer keeps the session address out of its Referer. */
export const SLIDE_LINK_REL = "noopener noreferrer";

/** True when a link with this href leaves the page and should open in a new tab. */
export function opensInNewTab(href: string | null | undefined, baseHref: string): boolean {
  const value = href?.trim();
  if (!value || value.startsWith("#")) return false;
  try {
    const { protocol } = new URL(value, baseHref);
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/** The parts of a link element the update reads and writes. */
export interface SlideLinkElement {
  getAttribute: (name: string) => string | null;
  setAttribute: (name: string, value: string) => void;
}

/** Sets target and rel on every web link in the list and returns how many it changed. */
export function openLinksInNewTab(links: Iterable<SlideLinkElement>, baseHref: string): number {
  let changed = 0;
  for (const link of links) {
    if (!opensInNewTab(link.getAttribute("href"), baseHref)) continue;
    link.setAttribute("target", SLIDE_LINK_TARGET);
    link.setAttribute("rel", SLIDE_LINK_REL);
    changed += 1;
  }
  return changed;
}
