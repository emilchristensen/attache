#!/usr/bin/env node
/**
 * TEST-ONLY stand-in for libsecret's `secret-tool`, selected with
 * JARVIS_SECRET_TOOL_BIN. It answers `store`, `lookup` and `clear` like the
 * real tool and keeps items in `$FAKE_SECRET_SERVICE_DIR/items.json`.
 * Every call's arguments are appended to `calls.jsonl` there, so tests can
 * check that no secret ever reaches process arguments.
 * `FAKE_SECRET_SERVICE_DOWN=1` answers like a computer without a session bus;
 * `FAKE_SECRET_SERVICE_NO_COLLECTION=1` like GNOME Keyring started without a
 * login keyring and no way to ask for one: lookups work, storing fails.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_SECRET_SERVICE_DIR;
if (!dir) {
  process.stderr.write("secret-tool: FAKE_SECRET_SERVICE_DIR is not set\n");
  process.exit(2);
}
const itemsFile = join(dir, "items.json");
const [action, ...rest] = process.argv.slice(2);
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(process.argv.slice(2))}\n`);

if (process.env.FAKE_SECRET_SERVICE_DOWN === "1") {
  process.stderr.write("secret-tool: Cannot autolaunch D-Bus without X11 $DISPLAY\n");
  process.exit(1);
}

const items = () => (existsSync(itemsFile) ? JSON.parse(readFileSync(itemsFile, "utf8")) : []);
const save = (list) => writeFileSync(itemsFile, JSON.stringify(list, null, 2));
const attributesOf = (args) => {
  const out = {};
  for (let i = 0; i + 1 < args.length; i += 2) out[args[i]] = args[i + 1];
  return out;
};
const matches = (item, attrs) => Object.entries(attrs).every(([k, v]) => item.attributes[k] === v);
const readStdin = async () => {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString("utf8");
};

switch (action) {
  case "store": {
    if (process.env.FAKE_SECRET_SERVICE_NO_COLLECTION === "1") {
      process.stderr.write("secret-tool: Object does not exist at path “/org/freedesktop/secrets/collection/login”\n");
      process.exit(1);
    }
    const label = rest.find((a) => a.startsWith("--label="))?.slice("--label=".length) ?? "";
    const attrs = attributesOf(rest.filter((a) => !a.startsWith("--label=")));
    const secret = await readStdin();
    save([...items().filter((i) => !matches(i, attrs) || Object.keys(i.attributes).length !== Object.keys(attrs).length), { label, attributes: attrs, secret }]);
    process.exit(0);
  }
  case "lookup": {
    const found = items().find((i) => matches(i, attributesOf(rest)));
    if (!found) process.exit(1);
    process.stdout.write(found.secret);
    process.exit(0);
  }
  case "clear": {
    const attrs = attributesOf(rest);
    const all = items();
    const kept = all.filter((i) => !matches(i, attrs));
    save(kept);
    // Like libsecret: exit 1, silently, when nothing matched.
    process.exit(kept.length === all.length ? 1 : 0);
  }
  default:
    process.stderr.write(`usage: secret-tool store|lookup|clear (got ${action})\n`);
    process.exit(2);
}
