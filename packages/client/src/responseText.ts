import { MAX_OPEN_RESPONSE_LENGTH } from "@mdq/shared";

/**
 * How many characters a response has. An emoji or other character outside the
 * Basic Multilingual Plane counts once, the same as on the server (a textarea's
 * own maxLength counts it twice, so the box is limited here instead).
 */
export const countCharacters = (text: string): number => [...text].length;

/** The text cut to the longest a response can be, never splitting a character. */
export function clampOpenResponse(text: string): string {
  const characters = [...text];
  return characters.length > MAX_OPEN_RESPONSE_LENGTH ? characters.slice(0, MAX_OPEN_RESPONSE_LENGTH).join("") : text;
}

/** The full stop to put after a name in a sentence, none when the name already ends in punctuation. */
export const sentenceStop = (name: string): string => (/[.!?…]$/.test(name) ? "" : ".");
