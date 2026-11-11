import type { Router } from "./router.ts";
import type { App } from "../app.ts";
import { requireFeature } from "./routes-data.ts";

export function registerMeaningRoutes(r: Router, app: App) {
  // Where meaning-based search stands on this Machine: the model, its download and the vectors.
  r.get("/memory/meaning", () => {
    requireFeature(app, "recall");
    return app.meaning.status();
  });
  // The owner starts the model's download from the Dashboard; it runs in the background.
  r.post("/memory/meaning/download", () => {
    requireFeature(app, "recall");
    return app.meaning.startDownload();
  });
}
