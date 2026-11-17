// Every line marked "avoided" shows the owner an avoided term.
const LABELS = { label: "Sync", hint: "Nothing to see" }; // avoided

export function Bad({ notify }: { notify: (message: string) => void }) {
  const message = `Attache will sync ${LABELS.label} now`; // avoided
  return (
    <section>
      <h3>Sync settings</h3> {/* avoided */}
      <p>
        Your second brain {/* avoided */}
        keeps everything.
      </p>
      <button title="Sync" onClick={() => notify("Coding agent connected")}> {/* avoided */}
        {"Polls"} {/* avoided */}
      </button>
      <input aria-label="Second brain folder" placeholder={message} /> {/* avoided */}
    </section>
  );
}
