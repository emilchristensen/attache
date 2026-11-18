/**
 * The role hues of the Dashboard, each with two steps in `styles/tokens.css`:
 * `--<hue>` (the kind word, the stamped glyph, a tag's words) and `--<hue>-soft` (the stamp's or tag's tint).
 * blue: reviews, pull requests, meetings and Jira work. rust: replies, deadlines and Replication.
 * plum: mentions and direct messages. green: assigned work, invites and facts to check.
 * amber: something the owner can fix, or that was partly read. red: failed or refused. slate: not known.
 * A component never names a hue's tokens: it puts `hueClass(hue)` on an element, and everything inside reads
 * `--c` and `--c-soft`.
 * Colour never carries meaning alone: a hue always comes with an icon and a word.
 */
export const HUES = ["blue", "rust", "plum", "green", "amber", "red", "slate"] as const;

export type Hue = (typeof HUES)[number];

/** The class that sets `--c` and `--c-soft` to one hue's steps. */
export function hueClass(hue: Hue): `c-${Hue}` {
  return `c-${hue}`;
}
