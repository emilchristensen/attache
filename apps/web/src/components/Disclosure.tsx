import type { ReactNode } from "react";
import { Icon } from "./icons.tsx";

/**
 * Something optional or secondary, closed until the owner opens it: a title at the card-heading scale, an optional
 * line saying what is inside, and a chevron that turns when open. `open` sets only how it starts.
 */
export function Disclosure({ title, meta, open = false, className, children }: { title: ReactNode; meta?: ReactNode; open?: boolean; className?: string; children: ReactNode }) {
  return (
    <details className={className ? `disclosure ${className}` : "disclosure"} open={open}>
      <summary>
        <Icon name="chevron" size={16} className="disclosure-chevron" />
        <span className="disclosure-title">{title}</span>
        {meta && <span className="disclosure-meta">{meta}</span>}
      </summary>
      <div className="disclosure-body">{children}</div>
    </details>
  );
}
