/** A title of at most `limit` characters, cut at a word and ended with an ellipsis, with no space before it. */
export function shortTitle(title: string | undefined, limit = 56): string | undefined {
  if (!title || title.length <= limit) return title;
  const cut = title.slice(0, limit - 1);
  // Cut at the last word that fits; only a title with no space at all is cut inside a word.
  const word = cut.lastIndexOf(" ");
  return `${(word > 0 ? cut.slice(0, word) : cut).trimEnd().replace(/[\s.,;:–—-]+$/, "")}…`;
}
