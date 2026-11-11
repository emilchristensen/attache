#!/usr/bin/env node
/**
 * TEST-ONLY stand-in for Windows PowerShell as the Task Scheduler service
 * manager calls it, selected with JARVIS_POWERSHELL_BIN. It ignores the
 * script and answers the operation in JARVIS_TASK_OP for the task named in
 * JARVIS_TASK_NAME, keeping Task Scheduler's tasks in
 * `$FAKE_TASK_SCHEDULER_DIR/tasks.json`. Like the real script, `install`
 * puts the owner's account id (here `S-1-5-21-1000`) where the task
 * definition says `{{owner}}`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.env.FAKE_TASK_SCHEDULER_DIR;
if (!dir) {
  process.stderr.write("FAKE_TASK_SCHEDULER_DIR is not set\n");
  process.exit(2);
}
const file = join(dir, "tasks.json");
const tasks = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
const name = process.env.JARVIS_TASK_NAME;
const task = tasks[name];
const save = () => writeFileSync(file, JSON.stringify(tasks, null, 2));

switch (process.env.JARVIS_TASK_OP) {
  case "install":
    tasks[name] = { xml: process.env.JARVIS_TASK_XML.replaceAll("{{owner}}", "S-1-5-21-1000"), state: task?.state ?? "Ready" };
    save();
    break;
  case "start":
    if (!task) {
      process.stderr.write(`The system cannot find the file specified. (task ${name})\n`);
      process.exit(1);
    }
    task.state = "Running";
    save();
    break;
  case "stop":
    if (task) task.state = "Ready";
    save();
    break;
  case "state":
    process.stdout.write(`${task?.state ?? "Missing"}\r\n`);
    break;
  case "uninstall":
    delete tasks[name];
    save();
    break;
  default:
    process.stderr.write(`unfaked operation ${process.env.JARVIS_TASK_OP}\n`);
    process.exit(2);
}
