import type { ReactNode } from "react";
import { hueClass, type Hue } from "../theme/hues.ts";

/**
 * neutral: ink on the sunken grey ("draft", "running", "v2", "read only").
 * attention: brass, for a tag that points at a decision.
 * danger: red, for failed, refused or removed.
 * outline: a hairline and no fill, for a quiet property.
 */
export type TagTone = "neutral" | "attention" | "danger" | "outline";

/** A hue a tag may take. Green is not one: a healthy state is plain text, never a tag. */
export type TagHue = Exclude<Hue, "green">;

type TagProps = { children: ReactNode; title?: string } & ({ tone?: TagTone; hue?: never } | { hue: TagHue; tone?: never });

/**
 * A small label for a state or a property, beside a title or in a row's meta line.
 * Give it a `tone`, or a `hue` (its soft step behind its ink step) when the tag belongs to a type or status family,
 * such as amber for a Connection the owner can fix or indigo for a Draft.
 */
export function Tag({ children, title, tone = "neutral", hue }: TagProps) {
  return (
    <span className={hue ? `tag hue ${hueClass(hue)}` : `tag ${tone}`} title={title}>
      {children}
    </span>
  );
}
