import { WrapUpInput } from "@attache/contracts";
import type { Router } from "./router.ts";
import type { App } from "../app.ts";
import { recordWrapUp } from "../memory/wrap-up.ts";
import { requireFeature } from "./routes-data.ts";

/** `POST /memory/wrap-up`: the wrap-up prompt's points, stored as evidence. */
export function registerWrapUpRoutes(r: Router, app: App) {
  r.post("/memory/wrap-up", async (c) => {
    requireFeature(app, "capture");
    const input = await c.body(WrapUpInput);
    const out = recordWrapUp(app, input, c.client?.id ?? null);
    if (out.stored) app.bus.emit("event", { type: "memory.changed" });
    return out;
  });
}
