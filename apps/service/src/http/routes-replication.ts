import { ReplicationJoinInput, ReplicationSetupInput } from "@jarvis/contracts";
import type { Router } from "./router.ts";
import { HttpError } from "./router.ts";
import type { App } from "../app.ts";
import { dataFolderPreview } from "./routes-core.ts";
import { ReplicationSetupError } from "../replication/setup.ts";

async function asHttp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ReplicationSetupError) throw new HttpError(e.status, e.code, e.message);
    throw e;
  }
}

export function registerReplicationRoutes(r: Router, app: App) {
  r.get("/replication", () => app.replication.view());

  // Switch Replication on with this Machine's Brain, pushing it to a repository that holds none yet.
  r.post("/replication/setup", async (c) => {
    const { remote } = await c.body(ReplicationSetupInput);
    return asHttp(() => app.replication.setup(remote));
  });

  // Join the Brain another Machine set up, cloning it into an empty folder that becomes the data folder.
  r.post("/replication/join", async (c) => {
    const body = await c.body(ReplicationJoinInput);
    const path = body.path ?? app.config.get().dataFolder;
    if (!path) throw new HttpError(400, "invalid_path", "Name the empty folder to keep the Brain in.");
    const preview = dataFolderPreview(path);
    if (!preview.writable) throw new HttpError(400, "not_writable", `Jarvis cannot write to ${preview.path}`);
    return asHttp(() => app.replication.join(body.remote, preview.path, (p) => app.useDataFolder(p)));
  });

  // Commit, fetch, merge and push now instead of at the next check.
  r.post("/replication/check", () => app.replication.check());
}
