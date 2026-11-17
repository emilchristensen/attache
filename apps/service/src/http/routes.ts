import type { Router } from "./router.ts";
import type { App } from "../app.ts";
import { registerConsolidationRoutes } from "./routes-consolidation.ts";
import { registerCoreRoutes } from "./routes-core.ts";
import { registerDataRoutes } from "./routes-data.ts";
import { registerHarnessRoutes } from "./routes-harnesses.ts";
import { registerMeaningRoutes } from "./routes-meaning.ts";
import { registerRecallRoutes } from "./routes-recall.ts";
import { registerReplicationRoutes } from "./routes-replication.ts";
import { registerWorkRoutes } from "./routes-work.ts";
import { registerWrapUpRoutes } from "./routes-wrap-up.ts";

export function registerRoutes(router: Router, app: App, port: () => number) {
  registerCoreRoutes(router, app, port);
  registerDataRoutes(router, app);
  registerRecallRoutes(router, app);
  registerReplicationRoutes(router, app);
  registerMeaningRoutes(router, app);
  registerWorkRoutes(router, app, port);
  registerWrapUpRoutes(router, app);
  registerHarnessRoutes(router, app);
  registerConsolidationRoutes(router, app);
}
