#!/usr/bin/env node
/**
 * TEST-ONLY stand-in for Windows PowerShell as the Task Scheduler service
 * manager calls it, selected with ATTACHE_POWERSHELL_BIN. It ignores the
 * script, reads the request (`op`, `name`, `xml`) from stdin as the real
 * runner does, and answers with the task's state, keeping Task Scheduler's
 * tasks in `$FAKE_TASK_SCHEDULER_DIR/tasks.json`. Like the real script,
 * `install` puts the owner's account id (here `S-1-5-21-1000`) where the task
 * definition says `{{owner}}`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const reply = (r) => process.stdout.write(JSON.stringify(r));
const dir = process.env.FAKE_TASK_SCHEDULER_DIR;
if (!dir) {
  reply({ ok: false, error: "FAKE_TASK_SCHEDULER_DIR is not set" });
  process.exit(0);
}
const file = join(dir, "tasks.json");
const tasks = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const req = JSON.parse(readFileSync(0, "utf8"));
const task = tasks[req.name];

switch (req.op) {
  case "install":
    tasks[req.name] = { xml: req.xml.replaceAll("{{owner}}", "S-1-5-21-1000"), state: task?.state ?? "Ready" };
    break;
  case "start":
    if (!task) {
      reply({ ok: false, error: `The system cannot find the file specified. (task ${req.name})` });
      process.exit(0);
    }
    task.state = "Running";
    break;
  case "stop":
    if (task) task.state = "Ready";
    break;
  case "uninstall":
    delete tasks[req.name];
    break;
  case "state":
    break;
  default:
    reply({ ok: false, error: `unfaked operation ${req.op}` });
    process.exit(0);
}
writeFileSync(file, JSON.stringify(tasks, null, 2));
reply({ ok: true, state: tasks[req.name]?.state ?? "Missing" });
