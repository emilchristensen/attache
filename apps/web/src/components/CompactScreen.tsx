import type { ReactNode } from "react";
import { Logo } from "./Logo.tsx";

/**
 * The screens before the Dashboard opens, pairing and service recovery: the large dotless logo over one compact form,
 * centred in the window. The logo has no dot here: nothing can wait for the owner before the Dashboard opens.
 */
export function CompactScreen({ children, busy = false }: { children: ReactNode; busy?: boolean }) {
  return (
    <main className="compact-screen" aria-busy={busy || undefined}>
      <div className="compact-brand">
        <Logo size={56} attention={false} />
        <span>Attache</span>
      </div>
      <div className="compact-form">{children}</div>
    </main>
  );
}
