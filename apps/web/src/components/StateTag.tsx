import { stateTone } from "./state-tone.ts";
import { Tag } from "./Tag.tsx";

/**
 * A status from the service, in words: plain text when healthy, a tag otherwise (see `stateTone`).
 * `label` replaces the status's own words, which are the status with underscores as spaces.
 */
export function StateTag({ state, label }: { state: string; label?: string }) {
  const words = label ?? state.replace(/_/g, " ");
  const tone = stateTone(state);
  if (tone === "plain") return <span className="state-text">{words}</span>;
  if (tone === "warning") return <Tag hue="amber">{words}</Tag>;
  return <Tag tone={tone}>{words}</Tag>;
}
