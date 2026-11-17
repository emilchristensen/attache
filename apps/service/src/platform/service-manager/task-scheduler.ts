import { win32 } from "node:path";
import { serviceName, windowsAppData, type Env, type PlatformLocations } from "../locations.ts";
import { runPowerShell } from "../powershell.ts";
import type { ServiceManager, ServiceSpec } from "./types.ts";
import { waitUntil } from "../wait.ts";
import { escapeXml as xml } from "../xml.ts";

const { join } = win32;
/** How long the task may take to show it started or stopped. */
const WAIT_MS = 15_000;
/** How long a stopped task's supervisor gets to stop the service cleanly before it is ended outright. */
const SUPERVISOR_EXIT_MS = 15_000;
/** Windows PowerShell and its ScheduledTasks module can take seconds to load on a busy computer. */
const TASK_TIMEOUT_MS = 60_000;
/** Task states in which the service is running or about to. */
const RUNNING = new Set(["Running", "Queued"]);
/** Where the task definition names its owner; the script below puts the owner's account id there. */
const OWNER = "{{owner}}";


/** One argument of a Windows command line, quoted the way programs split it (CommandLineToArgvW). */
function windowsArgument(s: string): string {
  if (/[\r\n]/.test(s)) throw new Error(`An Attache path cannot contain a line break: ${JSON.stringify(s)}`);
  if (s && !/[\s"]/.test(s)) return s;
  // Backslashes are literal except before a quote, so those (and the ones before the closing quote) are doubled.
  return `"${s.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, "$1$1")}"`;
}

/**
 * The logon task: started by the owner's own logon, as the owner, without
 * raised rights, through a headless console host so no window opens. It runs
 * `attache service run`, which keeps the service running (Task Scheduler does
 * not restart a program that exits) and gives it the environment launchd and
 * systemd set on macOS and Linux, which a task cannot set.
 */
export function logonTaskXml(loc: PlatformLocations, spec: ServiceSpec, env: Env): string {
  const current = join(spec.installPrefix, "current");
  const { localAppData, appData } = windowsAppData(env);
  const args = [
    "--headless",
    join(current, "runtime", "node.exe"),
    join(current, "service", "attache-service.mjs"),
    ...["service", "run", "--port", String(spec.port), "--state-dir", spec.stateDir, "--instance", spec.instance],
    ...["--home", loc.home, "--local-app-data", localAppData, "--app-data", appData],
  ];
  return `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>${xml(`Attache (${spec.instance}): starts at logon and keeps the Attache service running.`)}</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${OWNER}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Owner">
      <UserId>${OWNER}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>false</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>5</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>3</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Owner">
    <Exec>
      <Command>%SystemRoot%\\System32\\conhost.exe</Command>
      <Arguments>${xml(args.map(windowsArgument).join(" "))}</Arguments>
    </Exec>
  </Actions>
</Task>
`;
}

/**
 * Every operation on the task, in one script; the request's `op` picks it and
 * the reply carries the task's state. Task states are enum names, the same in
 * every display language, unlike what schtasks.exe prints.
 */
const TASK_SCRIPT = String.raw`
function Invoke-Request($req) {
  $task = Get-ScheduledTask -TaskPath '\' -TaskName $req.name -ErrorAction SilentlyContinue
  switch ($req.op) {
    'install' {
      $owner = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
      Register-ScheduledTask -TaskName $req.name -Xml $req.xml.Replace('${OWNER}', $owner) -Force | Out-Null
    }
    'start' { Start-ScheduledTask -TaskPath '\' -TaskName $req.name }
    'stop' {
      if ($task) { Stop-ScheduledTask -TaskPath '\' -TaskName $req.name }
      # Ending the task ends the console host, not the supervisor it started: that one notices and
      # stops the service cleanly. Wait for it, and end it outright if it is still there after a while.
      $mark = " --instance $($req.instance) "
      $deadline = (Get-Date).AddMilliseconds([int]$req.supervisorExitMs)
      while ($true) {
        $left = @(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains(' service run ') -and $_.CommandLine.Contains($mark) })
        if ($left.Count -eq 0) { break }
        if ((Get-Date) -gt $deadline) {
          foreach ($p in $left) { Stop-Process -Id $p.ProcessId -Force -ErrorAction SilentlyContinue }
          break
        }
        Start-Sleep -Milliseconds 250
      }
    }
    'uninstall' { if ($task) { Unregister-ScheduledTask -TaskPath '\' -TaskName $req.name -Confirm:$false } }
  }
  $now = Get-ScheduledTask -TaskPath '\' -TaskName $req.name -ErrorAction SilentlyContinue
  return @{ ok = $true; state = $(if ($now) { [string]$now.State } else { 'Missing' }) }
}
`;

/** A per-user task in Task Scheduler that starts at the owner's logon. */
export class TaskSchedulerServiceManager implements ServiceManager {
  readonly name: string;
  readonly definition = null;
  private readonly loc: PlatformLocations;
  private readonly instance: string;
  private readonly env: Env;

  constructor(loc: PlatformLocations, instance: string, env: Env = process.env) {
    this.loc = loc;
    this.instance = instance;
    this.name = serviceName("windows", instance);
    this.env = env;
  }

  /** Run one operation on the task; returns the task's state afterwards (`Missing` when there is none). */
  private async task(op: string, extra: Record<string, string> = {}): Promise<string> {
    const r = await runPowerShell(TASK_SCRIPT, { op, name: this.name, instance: this.instance, ...extra }, { env: this.env, timeoutMs: TASK_TIMEOUT_MS });
    if (!r.ok) throw new Error(op === "state" ? `Task Scheduler could not say how the logon task ${this.name} is: ${r.why}` : `Task Scheduler could not ${op} the logon task ${this.name}: ${r.why}`);
    return String(r.reply.state);
  }

  private state(): Promise<string> {
    return this.task("state");
  }

  private async waitFor(want: boolean, failure: string): Promise<void> {
    if (!(await waitUntil(async () => (await this.loaded()) === want, WAIT_MS))) throw new Error(failure);
  }

  async install(spec: ServiceSpec): Promise<void> {
    await this.task("install", { xml: logonTaskXml(this.loc, spec, this.env) });
  }

  async loaded(): Promise<boolean> {
    return RUNNING.has(await this.state());
  }

  async start(): Promise<void> {
    const state = await this.state();
    if (state === "Missing") throw new Error(`Attache is not set up as a background service here: the logon task ${this.name} is missing. Run the Attache installer again.`);
    if (RUNNING.has(state)) await this.stop();
    await this.task("start");
    await this.waitFor(true, `Task Scheduler did not start the logon task ${this.name}`);
  }

  async stop(): Promise<void> {
    await this.task("stop", { supervisorExitMs: String(SUPERVISOR_EXIT_MS) });
    await this.waitFor(false, `Task Scheduler did not stop the logon task ${this.name}`);
  }

  async uninstall(): Promise<void> {
    await this.stop();
    await this.task("uninstall");
  }
}
