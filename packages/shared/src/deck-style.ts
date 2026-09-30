/**
 * Appearance settings a deck can write in its header, such as
 * `title-size: large` or `accent-color: teal`. Each value is a named preset,
 * a plain length or a colour, and nothing else, so a deck cannot inject
 * arbitrary CSS. A valid value resolves to CSS custom properties that the
 * slide surface carries, and the stylesheet reads each one with Core's own
 * value as the fallback, so a deck without these keys looks exactly as before.
 */

/** CSS custom property name to value, ready for an inline `style` on the slide surface. */
export type DeckStyle = Record<string, string>;

/** The value an author wrote for each setting key, in its dashed spelling. */
export type DeckStyleSettings = Record<string, string>;

type Kind = "size" | "color" | "width" | "spacing" | "list-indent" | "list-gap" | "bullet-size" | "image-corners" | "image-spacing" | "image-width";

interface Spec {
  key: string;
  kind: Kind;
  /** Words shown in messages, as in "is not a size". */
  noun: string;
  /** Preset name to the custom properties it sets. Absent for colours. */
  presets?: Record<string, DeckStyle>;
  /** Length units accepted for a plain length. Absent when no length is accepted. */
  units?: readonly string[];
  /** Whether a length of zero is allowed. */
  allowZero?: boolean;
  /** Custom properties a valid length sets. */
  length?: (value: string) => DeckStyle;
  /** Custom properties a valid colour sets. */
  color?: (value: string) => DeckStyle;
  /** An example length or colour for messages. */
  example: string;
}

const SIZE_SCALES: Record<string, string> = { small: "0.85", medium: "1", large: "1.2", "x-large": "1.4" };
const SPACING_SCALES: Record<string, string> = { tight: "0.6", normal: "1", roomy: "1.5" };

function sizeSpec(key: string, name: string): Spec {
  return {
    key,
    kind: "size",
    noun: "a size",
    presets: Object.fromEntries(Object.entries(SIZE_SCALES).map(([preset, scale]) => [preset, { [`--mdq-${name}-scale`]: scale }])),
    units: ["px", "rem", "em"],
    length: (value) => ({ [`--mdq-${name}-size`]: value }),
    example: "4rem",
  };
}

function scaledSpacingSpec(key: string, name: string, noun: string, kind: Kind = "spacing"): Spec {
  return {
    key,
    kind,
    noun,
    presets: Object.fromEntries(Object.entries(SPACING_SCALES).map(([preset, scale]) => [preset, { [`--mdq-${name}-scale`]: scale }])),
    units: ["px", "rem", "em"],
    allowZero: true,
    length: (value) => ({ [`--mdq-${name}`]: value }),
    example: "1.5rem",
  };
}

function widthSpec(key: string, name: string, presets: Record<string, string>, example: string): Spec {
  return {
    key,
    kind: "width",
    noun: "a width",
    presets: Object.fromEntries(Object.entries(presets).map(([preset, value]) => [preset, { [`--mdq-${name}`]: value }])),
    units: ["px", "rem", "em", "ch", "%"],
    length: (value) => ({ [`--mdq-${name}`]: value }),
    example,
  };
}

function colorSpec(key: string, vars: string[]): Spec {
  return {
    key,
    kind: "color",
    noun: "a colour",
    color: (value) => Object.fromEntries(vars.map((name) => [name, value])),
    example: "#0f766e",
  };
}

/** Space between list items: a preset sets the top-level and the nested gap together. */
const LIST_GAPS: Record<string, [string, string]> = {
  tight: ["0.25em", "0.08em"],
  normal: ["0.5em", "0.16em"],
  roomy: ["0.85em", "0.3em"],
};

/** Every deck header appearance setting, in the order the README lists them. */
const SPECS: Spec[] = [
  sizeSpec("title-size", "title"),
  sizeSpec("heading-size", "heading"),
  sizeSpec("body-size", "body"),
  sizeSpec("small-size", "small"),
  sizeSpec("caption-size", "caption"),
  colorSpec("accent-color", ["--mdq-slide-accent"]),
  colorSpec("link-color", ["--mdq-link-color"]),
  colorSpec("text-color", ["--mdq-slide-ink", "--mdq-slide-heading"]),
  colorSpec("muted-color", ["--mdq-slide-ink-soft"]),
  colorSpec("background-color", ["--mdq-slide-bg", "--mdq-slide-bg-soft"]),
  colorSpec("surface-color", ["--mdq-slide-bg-soft"]),
  colorSpec("bullet-color", ["--mdq-bullet-color"]),
  widthSpec("content-width", "content-width", { narrow: "min(42cqi, 44rem)", medium: "min(62cqi, 70rem)", wide: "min(80cqi, 90rem)", full: "100%" }, "40rem, 60ch or 80%"),
  widthSpec("slide-width", "slide-width", { narrow: "min(60cqi, 56rem)", medium: "min(82cqi, 92rem)", wide: "min(92cqi, 110rem)", full: "100%" }, "80rem, 60ch or 90%"),
  widthSpec("text-width", "text-width", { narrow: "36ch", medium: "56ch", wide: "76ch", full: "100%" }, "40ch, 30rem or 80%"),
  scaledSpacingSpec("slide-padding", "slide-padding", "a spacing"),
  scaledSpacingSpec("block-spacing", "block-spacing", "a spacing"),
  scaledSpacingSpec("inline-spacing", "inline-spacing", "a spacing"),
  {
    key: "list-spacing",
    kind: "spacing",
    noun: "a spacing",
    presets: { tight: { "--mdq-list-spacing": "0" }, normal: { "--mdq-list-spacing": "0" }, roomy: { "--mdq-list-spacing": "0.4em" } },
    units: ["px", "rem", "em"],
    allowZero: true,
    length: (value) => ({ "--mdq-list-spacing": value }),
    example: "0.5em",
  },
  {
    key: "list-indent",
    kind: "list-indent",
    noun: "a list indent",
    presets: { small: { "--mdq-list-indent": "0.9em" }, medium: { "--mdq-list-indent": "1.3em" }, large: { "--mdq-list-indent": "1.8em" } },
    units: ["px", "rem", "em"],
    allowZero: true,
    length: (value) => ({ "--mdq-list-indent": value }),
    example: "2em",
  },
  {
    key: "list-gap",
    kind: "list-gap",
    noun: "a list gap",
    presets: Object.fromEntries(Object.entries(LIST_GAPS).map(([preset, [gap, nested]]) => [preset, { "--mdq-list-gap": gap, "--mdq-list-gap-nested": nested }])),
    units: ["px", "rem", "em"],
    allowZero: true,
    length: (value) => ({ "--mdq-list-gap": value, "--mdq-list-gap-nested": `calc(${value} * 0.32)` }),
    example: "0.6em",
  },
  {
    key: "bullet-size",
    kind: "bullet-size",
    noun: "a bullet size",
    presets: { small: { "--mdq-bullet-scale": "0.8" }, medium: { "--mdq-bullet-scale": "1" }, large: { "--mdq-bullet-scale": "1.35" } },
    units: ["px", "rem", "em"],
    length: (value) => ({ "--mdq-bullet-size": value }),
    example: "1.2em",
  },
  {
    key: "image-corners",
    kind: "image-corners",
    noun: "an image corner",
    presets: { square: { "--mdq-image-corners": "0" }, rounded: { "--mdq-image-corners": "0.48rem" }, round: { "--mdq-image-corners": "1.4rem" } },
    units: ["px", "rem", "em"],
    allowZero: true,
    length: (value) => ({ "--mdq-image-corners": value }),
    example: "1rem",
  },
  scaledSpacingSpec("image-spacing", "image-spacing", "an image spacing", "image-spacing"),
  {
    key: "image-width",
    kind: "image-width",
    noun: "an image width",
    presets: Object.fromEntries(Object.entries({ narrow: "50%", medium: "75%", wide: "90%", full: "100%" }).map(([preset, value]) => [preset, { "--mdq-image-width": value, "--mdq-image-inset": "auto" }])),
    units: ["px", "rem", "em", "ch", "%"],
    length: (value) => ({ "--mdq-image-width": value, "--mdq-image-inset": "auto" }),
    example: "30rem, 20em or 60%",
  },
];

/** The appearance setting keys, dashed, in documentation order. */
export const DECK_STYLE_KEYS: readonly string[] = SPECS.map((spec) => spec.key);

const SPEC_BY_KEY = new Map(SPECS.map((spec) => [spec.key, spec]));

/** True when `key` (dashed or underscored) is a deck appearance setting. */
export function isDeckStyleKey(key: string): boolean {
  return SPEC_BY_KEY.has(key.replace(/_/g, "-").toLowerCase());
}

/** The presets a key accepts, in order, or none for a colour. */
export function deckStylePresets(key: string): string[] {
  return Object.keys(SPEC_BY_KEY.get(key)?.presets ?? {});
}

const CSS_COLOR_NAMES = new Set(
  ("aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan " +
    "darkblue darkcyan darkgoldenrod darkgray darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue darkslategray darkslategrey " +
    "darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink " +
    "indianred indigo ivory khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen lightgrey lightpink lightsalmon lightseagreen " +
    "lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue " +
    "mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise " +
    "palevioletred papayawhip peachpuff peru pink plum powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue slateblue slategray " +
    "slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke yellow yellowgreen").split(" "),
);

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/;
const LENGTH = /^(\d+(?:\.\d+)?|\.\d+)(px|rem|em|ch|%)$/;

function describeChoices(spec: Spec): string {
  if (spec.kind === "color") {
    return "Use a colour name such as teal or navy, or a hex colour such as #0f766e.";
  }
  const presets = Object.keys(spec.presets ?? {});
  return `Use ${presets.join(", ")}, or a length such as ${spec.example}.`;
}

export type DeckStyleResult =
  | { ok: true; value: string; style: DeckStyle }
  | { ok: false; message: string };

/**
 * Validate one appearance setting. `key` is the dashed spelling, `raw` the
 * text after the colon (optional quotes allowed). A valid value returns the
 * author's value in a normalised spelling and the custom properties it sets.
 * Anything else returns a message that names the key, the value and what is allowed.
 */
export function resolveDeckStyleSetting(key: string, raw: string): DeckStyleResult {
  const spec = SPEC_BY_KEY.get(key);
  if (!spec) return { ok: false, message: `${key} is not a deck setting.` };
  const value = raw.trim().replace(/^(["'])(.*)\1$/, "$2").trim().toLowerCase();
  if (!value) return { ok: false, message: `${key} has no value. ${describeChoices(spec)}` };
  const invalid = (): DeckStyleResult => ({ ok: false, message: `${key}: ${raw.trim()} is not ${spec.noun}. ${describeChoices(spec)}` });

  if (spec.kind === "color") {
    if (HEX_COLOR.test(value) || CSS_COLOR_NAMES.has(value)) return { ok: true, value, style: spec.color!(value) };
    return invalid();
  }
  const preset = spec.presets && Object.prototype.hasOwnProperty.call(spec.presets, value) ? spec.presets[value] : undefined;
  if (preset) return { ok: true, value, style: { ...preset } };
  const match = LENGTH.exec(value);
  if (match && spec.units?.includes(match[2]) && (spec.allowZero || Number(match[1]) > 0)) {
    return { ok: true, value, style: spec.length!(value) };
  }
  return invalid();
}

const STYLE_VARS = new Set<string>(
  SPECS.flatMap((spec) => [
    ...Object.values(spec.presets ?? {}).flatMap((style) => Object.keys(style)),
    ...Object.keys(spec.length?.("1px") ?? {}),
    ...Object.keys(spec.color?.("red") ?? {}),
  ]),
);
const SAFE_STYLE_VALUE = /^[a-z0-9#.%,() *+-]+$/i;

/**
 * The entries of `style` that are known appearance properties with a plain
 * value, or undefined when none is left. Applied where the value is used, so
 * an unexpected payload can never write any other property or any function.
 */
export function safeDeckStyle(style: unknown): DeckStyle | undefined {
  if (!style || typeof style !== "object") return undefined;
  const safe: DeckStyle = {};
  for (const [name, value] of Object.entries(style as Record<string, unknown>)) {
    if (!STYLE_VARS.has(name) || typeof value !== "string" || !SAFE_STYLE_VALUE.test(value)) continue;
    if (/url\(|var\(|expression|@|\\/i.test(value)) continue;
    safe[name] = value;
  }
  return Object.keys(safe).length > 0 ? safe : undefined;
}
