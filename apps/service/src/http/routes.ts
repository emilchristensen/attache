import type { Router } from "./router.ts";
import type { App } from "../app.ts";
import { registerCoreRoutes } from "./routes-core.ts";
import { registerDataRoutes } from "./routes-data.ts";
import { registerMeaningRoutes } from "./routes-meaning.ts";
import { registerRecallRoutes } from "./routes-recall.ts";
import { registerWorkRoutes } from "./routes-work.ts";

export function registerRoutes(router: Router, app: App, port: () => number) {
  registerCoreRoutes(router, app, port);
  registerDataRoutes(router, app);
  registerRecallRoutes(router, app);
  registerMeaningRoutes(router, app);
  registerWorkRoutes(router, app, port);
}
