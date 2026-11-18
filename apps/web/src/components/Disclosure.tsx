import { useState, type ReactNode } from "react";
import { Icon } from "./icons.tsx";

/**
 * Something optional or secondary, closed until the owner opens it: a title at the card-heading scale, an optional
 * line saying what is inside, and a chevron that turns when open. `open` sets only how it starts. `lazy` renders the
 * body only once it has been opened, for a body that is large (a whole file) and should not be in the page unread.
 */
export function Disclosure({ title, meta, open = false, lazy = false, className, children }: { title: ReactNode; meta?: ReactNode; open?: boolean; lazy?: boolean; className?: string; children: ReactNode }) {
  const [opened, setOpened] = useState(open);
  return (
    <details className={className ? `disclosure ${className}` : "disclosure"} open={open} onToggle={(e) => setOpened(opened || e.currentTarget.open)}>
      <summary>
        <Icon name="chevron" size={16} className="disclosure-chevron" />
        <span className="disclosure-title">{title}</span>
        {meta && <span className="disclosure-meta">{meta}</span>}
      </summary>
      <div className="disclosure-body">{!lazy || opened ? children : null}</div>
    </details>
  );
}
