import { UpdateCheckInput, UpdateSettingsInput } from "@attache/contracts";
import type { Router } from "./router.ts";
import type { App } from "../app.ts";

/**
 * Updates on this Machine (spec #130): `GET /updates` reads the status,
 * `PUT /updates/settings` sets the Update channel, `POST /updates/check`
 * checks now, `POST /updates/install` installs an Update now (it answers once
 * the installer runs; the service restarts after). Every answer is the status
 * after the request.
 */
export function registerUpdatesRoutes(r: Router, app: App) {
  r.get("/updates", () => app.updater.view());
  r.put("/updates/settings", async (c) => {
    const view = app.updater.setSettings(await c.body(UpdateSettingsInput));
    app.bus.emit("event", { type: "config.changed" });
    return view;
  });
  r.post("/updates/check", async (c) => app.updater.check(await c.body(UpdateCheckInput)));
  r.post("/updates/install", () => app.updater.install());
}
