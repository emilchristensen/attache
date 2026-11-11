#!/usr/bin/env node
/**
 * TEST-ONLY stand-in for Windows PowerShell, selected with
 * JARVIS_POWERSHELL_BIN. It ignores the script and answers the request Jarvis
 * writes on stdin the way Jarvis's Credential Manager and notification
 * scripts do, keeping its state in `$FAKE_WINDOWS_DIR`:
 * `credentials.json` (generic credentials), `toasts.jsonl` (notifications
 * shown) and `calls.jsonl` (every call's process arguments, so tests can check
 * that no secret ever reaches them).
 *
 * `FAKE_CREDENTIAL_MANAGER_DOWN=1` answers like a logon without a credential
 * vault; `FAKE_TOAST_SETTING=<setting>` like Windows with notifications turned
 * off; while a file `$FAKE_WINDOWS_DIR/toasts.down` exists, showing fails.
 */
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_WINDOWS_DIR;
if (!dir) {
  process.stderr.write("powershell: FAKE_WINDOWS_DIR is not set\n");
  process.exit(2);
}
appendFileSync(join(dir, "calls.jsonl"), `${JSON.stringify(process.argv.slice(2))}\n`);

const chunks = [];
for await (const c of process.stdin) chunks.push(c);
const input = Buffer.concat(chunks).toString("utf8");
if (/[^\x00-\x7f]/.test(input)) {
  process.stderr.write("powershell: the request is not ASCII, so a console code page could garble it\n");
  process.exit(2);
}
const req = JSON.parse(input);
const reply = (r) => process.stdout.write(JSON.stringify(r));

const credentialsFile = join(dir, "credentials.json");
const credentials = () => (existsSync(credentialsFile) ? JSON.parse(readFileSync(credentialsFile, "utf8")) : []);
const save = (list) => writeFileSync(credentialsFile, JSON.stringify(list, null, 2));
const vaultDown = { ok: false, error: "A specified logon session does not exist. It may already have been terminated. (Windows error 1312)" };

switch (req.op) {
  case "probe":
    reply(process.env.FAKE_CREDENTIAL_MANAGER_DOWN === "1" ? vaultDown : { ok: true });
    break;
  case "read": {
    if (process.env.FAKE_CREDENTIAL_MANAGER_DOWN === "1") reply(vaultDown);
    else {
      const found = credentials().find((c) => c.target === req.target);
      reply(found ? { ok: true, found: true, secret: Buffer.from(found.secret, "utf8").toString("base64") } : { ok: true, found: false });
    }
    break;
  }
  case "write": {
    if (process.env.FAKE_CREDENTIAL_MANAGER_DOWN === "1") reply(vaultDown);
    else {
      save([...credentials().filter((c) => c.target !== req.target), { target: req.target, user: req.user, secret: Buffer.from(req.secret, "base64").toString("utf8") }]);
      reply({ ok: true });
    }
    break;
  }
  case "delete": {
    const all = credentials();
    save(all.filter((c) => c.target !== req.target));
    reply({ ok: true, found: all.some((c) => c.target === req.target) });
    break;
  }
  case "check":
  case "show": {
    const setting = process.env.FAKE_TOAST_SETTING;
    if (setting) reply({ ok: true, enabled: false, setting });
    else if (req.op === "show" && existsSync(join(dir, "toasts.down"))) reply({ ok: false, error: "The notification platform is unavailable. (0x803E0105)" });
    else {
      if (req.op === "show") appendFileSync(join(dir, "toasts.jsonl"), `${JSON.stringify({ app: req.app, name: req.name, title: req.title, body: req.body })}\n`);
      reply({ ok: true, enabled: true });
    }
    break;
  }
  case "forget":
    appendFileSync(join(dir, "toasts.jsonl"), `${JSON.stringify({ forgot: req.app })}\n`);
    reply({ ok: true });
    break;
  default:
    reply({ ok: false, error: `unknown request ${req.op}` });
}
