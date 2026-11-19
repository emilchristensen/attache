import { useEffect, useRef, useState, type FormEvent } from "react";
import { post, type ApiError } from "../api.ts";
import { useLocation } from "../components/ui.tsx";
import { CompactScreen } from "../components/CompactScreen.tsx";
import { FieldError, fieldProps, focusField } from "../components/FieldError.tsx";
import { pairingCodeProblem } from "./form-checks.ts";

/** Pair this browser with the service using a one-time code; the installer opens it with the code in the address. */
export function Pair({ onPaired }: { onPaired: () => void }) {
  const loc = useLocation();
  const fromHash = new URLSearchParams(loc.hash.replace(/^#/, "")).get("code");
  const [code, setCode] = useState(fromHash ?? "");
  const [attempted, setAttempted] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLInputElement>(null);
  const message = refused ?? (attempted ? pairingCodeProblem(code) : null);
  const pair = async (c: string) => {
    setBusy(true);
    setRefused(null);
    try {
      await post("/pair", { code: c, clientName: `Browser (${navigator.platform || "web"})`, kind: "browser" });
      history.replaceState(null, "", "/");
      onPaired();
    } catch (e) {
      setRefused((e as ApiError).message);
      focusField(field.current);
    } finally {
      setBusy(false);
    }
  };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    setAttempted(true);
    if (pairingCodeProblem(code)) return focusField(field.current);
    void pair(code);
  };
  useEffect(() => {
    if (fromHash) void pair(fromHash);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <CompactScreen>
      <h1>Pair this browser</h1>
      <p className="compact-lead">Attache runs on this computer and only talks to paired browsers and apps. The installer opens this page with a code.</p>
      <form className="stack" onSubmit={submit} noValidate>
        <div className="field-group">
          <label className="field" htmlFor="pairing-code">
            Pairing code
          </label>
          <input
            id="pairing-code"
            ref={field}
            autoFocus
            value={code}
            onChange={(e) => {
              setCode(e.target.value);
              setRefused(null);
            }}
            placeholder="ABCD2345"
            autoComplete="one-time-code"
            autoCapitalize="characters"
            spellCheck={false}
            {...fieldProps("pairing-code-error", message, "pairing-code-help")}
          />
          <FieldError id="pairing-code-error" message={message} />
          <span className="help" id="pairing-code-help">
            Eight letters and digits. A code works once, for a short time.
          </span>
        </div>
        <button type="submit" className="primary wide" disabled={busy}>
          {busy ? "Pairing…" : "Pair"}
        </button>
      </form>
      <p className="compact-note">
        No code, or it expired? Run <code>attache pair --open</code> in a terminal, or create a code in Settings on a browser that is already paired.
      </p>
    </CompactScreen>
  );
}
