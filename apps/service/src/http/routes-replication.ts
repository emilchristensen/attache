import { PreferredReaderInput, ReplicationJoinInput, ReplicationSetupInput, ReplicationStandbyInput } from "@attache/contracts";
import type { Router } from "./router.ts";
import { HttpError } from "./router.ts";
import type { App } from "../app.ts";
import { dataFolderPreview } from "./routes-core.ts";
import { ReplicationSetupError } from "../replication/setup.ts";

async function asHttp<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (e) {
    if (e instanceof ReplicationSetupError) throw new HttpError(e.status, e.code, e.message, e.details);
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
    if (!preview.writable) throw new HttpError(400, "not_writable", `Attache cannot write to ${preview.path}`);
    return asHttp(() => app.replication.join(body.remote, preview.path, (p) => app.useDataFolder(p)));
  });

  // The Machines sharing the Brain, with standby and the Preferred Reader, as recorded in the Brain.
  r.get("/replication/machines", () => app.replication.machines.view());
  r.put("/replication/standby", async (c) => {
    const { standby } = await c.body(ReplicationStandbyInput);
    return asHttp(async () => app.replication.machines.setStandby(standby));
  });
  r.put("/replication/preferred-reader", async (c) => {
    const { machine } = await c.body(PreferredReaderInput);
    return asHttp(async () => app.replication.machines.setPreferredReader(machine));
  });

  // Stop replicating from this Machine. The Brain in its data folder is left as it is.
  r.post("/replication/off", () => asHttp(() => app.replication.switchOff()));

  // Commit, fetch, merge and push now instead of at the next check.
  r.post("/replication/check", () => app.replication.check());
}
