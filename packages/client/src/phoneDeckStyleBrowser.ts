import type { PhoneColorEnv, Rgb } from "./phoneDeckStyle";

function parseRgb(value: string): Rgb | null {
  const match = value.match(/rgba?\(([^)]+)\)/);
  if (!match) return null;
  const parts = match[1].split(/[ ,/]+/).filter(Boolean).map(Number);
  if (parts.length < 3 || parts.slice(0, 3).some((n) => Number.isNaN(n))) return null;
  return [parts[0], parts[1], parts[2]];
}

/** Reads colours through the browser, so a colour name or a palette variable gives its real value. */
export function browserColorEnv(doc: Document = document): PhoneColorEnv {
  const resolve = (value: string): Rgb | null => {
    const probe = doc.createElement("span");
    probe.style.color = value;
    if (!probe.style.color) return null;
    doc.body.appendChild(probe);
    const result = parseRgb(doc.defaultView?.getComputedStyle(probe).color ?? "");
    probe.remove();
    return result;
  };
  return { resolve, page: resolve("var(--mdq-paper)") };
}
