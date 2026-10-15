/** A title of at most `limit` characters, cut at a word and ended with an ellipsis, with no space before it. */
export function shortTitle(title: string | undefined, limit = 56): string | undefined {
  if (!title || title.length <= limit) return title;
  const cut = title.slice(0, limit - 1);
  const word = cut.lastIndexOf(" ");
  return `${(word > limit / 2 ? cut.slice(0, word) : cut).trimEnd().replace(/[\s.,;:–—-]+$/, "")}…`;
}
