import { hueClass, type Hue } from "../theme/hues.ts";
import { Icon, type IconName } from "./icons.tsx";

/**
 * A type stamp: a 19 px stroked glyph in one hue, on that hue's tint. It marks an Inbox kind, a Heads-up or an
 * Approvals group. Decorative: the type's word always stands beside it, so colour and shape never carry it alone.
 * `size` "md" is the 34 px stamp of a row; "sm" the 25 px stamp of a narrow row.
 */
export function TypeIcon({ icon, hue, size = "md" }: { icon: IconName; hue: Hue; size?: "md" | "sm" }) {
  return (
    <span className={size === "md" ? `type-icon ${hueClass(hue)}` : `type-icon sm ${hueClass(hue)}`} aria-hidden>
      <Icon name={icon} size={size === "md" ? 19 : 15} />
    </span>
  );
}
