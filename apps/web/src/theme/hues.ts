/**
 * The twelve hues of the Dashboard, each with four steps in `styles/tokens.css`:
 * `--<hue>` (solid: tiles, bars, icons), `--<hue>-ink` (text), `--<hue>-soft` (tinted background) and `--<hue>-line` (borders).
 * A component never names a hue's tokens: it puts `hueClass(hue)` on an element, and everything inside reads
 * `--c`, `--c-ink`, `--c-soft` and `--c-line`.
 * Colour never carries meaning alone: a hue always comes with an icon and a word.
 */
export const HUES = ["indigo", "green", "amber", "red", "rose", "purple", "sky", "teal", "moss", "orange", "gold", "slate"] as const;

export type Hue = (typeof HUES)[number];

/** The class that sets `--c`, `--c-ink`, `--c-soft` and `--c-line` to one hue's steps. */
export function hueClass(hue: Hue): `c-${Hue}` {
  return `c-${hue}`;
}
