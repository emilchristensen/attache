import type { ReactNode } from "react";
import type { Painting } from "../paintings.ts";

/**
 * A painting with words over it: the words sit on a dark scrim (`--painting-scrim`) that fades out above them, and
 * the credit names the painting and its painter. `className` places it: the card's left part or the page's hero.
 */
export function BriefingPainting({ painting, className, children }: { painting: Painting; className: string; children: ReactNode }) {
  return (
    <div className={`briefing-painting ${className}`} style={{ backgroundImage: `url(${painting.src})`, backgroundPosition: painting.focal }}>
      <div className="briefing-painting-words">
        {children}
        <p className="briefing-painting-credit">
          {painting.title} · {painting.painter}, {painting.year}
        </p>
      </div>
    </div>
  );
}
