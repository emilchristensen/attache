import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { useLiveConnection, useResource } from "../live.ts";
import { ReaderLine } from "../views/ReaderLine.tsx";
import { Icon } from "./icons.tsx";
import { Link } from "./ui.tsx";

/** GET /machine: this Machine's identity. */
interface MachineIdentity {
  id: string;
  name: string;
}

const MACHINE_EVENTS = ["config.changed", "replication.changed"];

/** This Machine's name, as the masthead and More show it; empty until it arrives. */
function useMachineName(): string {
  return useResource<MachineIdentity>("/machine", MACHINE_EVENTS).data?.name ?? "";
}

const LIVE_TEXT: Record<ReturnType<typeof useLiveConnection>["status"], string> = {
  connecting: "Connecting to live updates…",
  open: "Live updates are connected.",
  reconnecting: "Reconnecting to the Attache service… Work in progress continues in the service.",
  closed: "Disconnected from the Attache service. Retrying.",
};

/** The live connection in a sentence: what the owner needs to know when it drops. */
function LiveLine() {
  const { status, lost } = useLiveConnection();
  const text = LIVE_TEXT[status];
  return (
    <p className={`live-line small${lost ? " lost" : ""}`} data-live={status}>
      {text}
    </p>
  );
}

/**
 * This Machine, its Reader and the live connection: the masthead disclosure and the More sheet show the same lines.
 * Its link goes to Settings until Settings has a Machines and Replication section of its own (#32 of spec #14).
 */
export function MachinePanel() {
  const name = useMachineName();
  return (
    <div className="machine-panel-body stack-sm">
      <p className="machine-panel-name">
        <Icon name="machine" size={19} />
        <span>
          <strong>{name}</strong> <span className="muted">· this Machine</span>
        </span>
      </p>
      <ReaderLine />
      <LiveLine />
      <Link to="/settings">Machines and Replication</Link>
    </div>
  );
}

/** The masthead's disclosure: this Machine's name on the button, and a lost live connection right on it. */
export function MachineDisclosure() {
  const [open, setOpen] = useState(false);
  const name = useMachineName();
  const { status, lost } = useLiveConnection();
  const panelId = useId();
  const root = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLElement>(null);
  // The popover is fixed so the masthead's clipping cannot cut it: it hangs under the button, right edges aligned.
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const b = button.current?.getBoundingClientRect();
      const p = popover.current;
      if (!b || !p) return;
      p.style.top = `${Math.round(b.bottom + 8)}px`;
      p.style.right = `${Math.max(0, Math.round(document.documentElement.clientWidth - b.right))}px`;
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    // Escape belongs to the topmost layer: a dialog opened over the disclosure (the shortcut sheet) closes first.
    const escape = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || document.querySelector("dialog[open]")) return;
      setOpen(false);
      button.current?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  // A link inside, followed: the disclosure has done its job, and focus goes back to its button, not to the page's
  // start. A React handler, so it runs after the link's own (which navigates) and the link is still there for it.
  const followed = (e: ReactMouseEvent) => {
    if (!(e.target as Element).closest("a")) return;
    setOpen(false);
    button.current?.focus();
  };
  return (
    <div className="machine" ref={root} data-lost={lost || undefined}>
      <button ref={button} className="machine-trigger" aria-expanded={open} aria-controls={panelId} onClick={() => setOpen(!open)}>
        <span className="sr-only">This Machine: </span>
        <Icon name={lost ? "warning" : "machine"} />
        <span className="machine-trigger-name">{name}</span>
        {lost && <span className="machine-trigger-live">{status === "closed" ? "Disconnected" : "Reconnecting"}</span>}
        <Icon name="chevron" className="machine-trigger-chevron" />
      </button>
      {open && (
        <section ref={popover} id={panelId} className="machine-popover" aria-label="This Machine" onClick={followed}>
          <MachinePanel />
        </section>
      )}
    </div>
  );
}
