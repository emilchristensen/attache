import { hueClass, type Hue } from "../theme/hues.ts";
import { Icon, type IconName } from "./icons.tsx";

/**
 * An icon on a rounded tile in one hue's solid step, with the on-colour for the glyph: the mark of an Inbox type
 * family, a Heads-up or a group. Decorative: the type's word always stands beside it.
 * `size` is the tile: "md" 24 px for rows and group headers, "lg" 32 px for a Heads-up card.
 */
export function TypeIcon({ icon, hue, size = "md" }: { icon: IconName; hue: Hue; size?: "md" | "lg" }) {
  return (
    <span className={`type-icon ${size} ${hueClass(hue)}`} aria-hidden>
      <Icon name={icon} size={size === "lg" ? 18 : 14} />
    </span>
  );
}
