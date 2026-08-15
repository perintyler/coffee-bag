import { execFileSync } from "node:child_process";

/** Everything `coffee status` needs to know about the machine's real state. */
export interface PowerState {
  /** True when drawing from AC. The gate that decides whether coffee asserts. */
  onAc: boolean;
  /** Battery percentage, when a battery is present. */
  percent: number | null;
  /** True when the lid is shut. Null when it cannot be determined. */
  lidClosed: boolean | null;
  /** True when `pmset disablesleep` is currently in effect, system-wide. */
  sleepDisabled: boolean;
  /** PIDs of every caffeinate on the machine, not just ours. */
  caffeinatePids: number[];
  /** Every caffeinate with who spawned it, so foreign ones can be named. */
  caffeinateOwners: CaffeinateOwner[];
  /** Raw `pmset -g assertions` lines mentioning caffeinate. */
  assertions: string[];
}

/** A caffeinate process attributed to whatever spawned it. */
export interface CaffeinateOwner {
  pid: number;
  /** The caffeinate invocation itself, e.g. "caffeinate -i -t 300". */
  args: string;
  /** Short description of the parent process, e.g. "claude" or "zsh". */
  owner: string;
  /** True when the parent is this bag's supervisor. */
  isOurs: boolean;
}

function run(cmd: string, args: string[]): string {
  try {
    // stderr is explicitly discarded rather than inherited. A probe failing is
    // a normal, expected state here — `launchctl print` on an unloaded job
    // prints "Could not find service ... in domain for user" — and that is
    // reported as "daemon: not loaded", not dumped raw above the status table.
    return execFileSync(cmd, args, {
      encoding: "utf8",
      timeout: 5000,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // Every caller treats an empty string as "unknown". Status must never
    // throw just because one probe failed.
    return "";
  }
}

export function readPowerState(): PowerState {
  const batt = run("/usr/bin/pmset", ["-g", "batt"]);
  const percentMatch = /(\d+)%/.exec(batt);

  const clamshell = run("/usr/sbin/ioreg", ["-r", "-k", "AppleClamshellState", "-d", "4"]);
  const lidClosed = clamshell.includes("AppleClamshellState")
    ? /"AppleClamshellState"\s*=\s*Yes/.test(clamshell)
    : null;

  const sleepDisabled = /"SleepDisabled"\s*=\s*Yes/.test(
    run("/usr/sbin/ioreg", ["-r", "-k", "SleepDisabled", "-d", "1"]),
  );

  const pids = run("/usr/bin/pgrep", ["-x", "caffeinate"])
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((n) => Number.isInteger(n));

  // Attribution matters because this machine routinely runs caffeinate from
  // several places at once (Claude Code sessions renew a `-i -t 300` while
  // they work; the shell `coffee()` function holds a `-d`). Without naming
  // them, `coffee status` shows a pile of unexplained assertions and the one
  // question it exists to answer — "is COFFEE holding this?" — gets muddier
  // the busier the machine is.
  const caffeinateOwners: CaffeinateOwner[] = pids.map((pid) => {
    const args = run("/bin/ps", ["-o", "command=", "-p", String(pid)]).trim();
    const ppid = Number.parseInt(
      run("/bin/ps", ["-o", "ppid=", "-p", String(pid)]).trim(),
      10,
    );
    const parentCmd = Number.isInteger(ppid)
      ? run("/bin/ps", ["-o", "command=", "-p", String(ppid)]).trim()
      : "";
    const isOurs = parentCmd.includes("coffee-supervisor");
    return { pid, args, owner: describeOwner(parentCmd, isOurs), isOurs };
  });

  const assertions = run("/usr/bin/pmset", ["-g", "assertions"])
    .split("\n")
    .filter((line) => line.toLowerCase().includes("caffeinate"))
    .map((line) => line.trim());

  return {
    onAc: batt.includes("'AC Power'"),
    percent: percentMatch ? Number.parseInt(percentMatch[1], 10) : null,
    lidClosed,
    sleepDisabled,
    caffeinatePids: pids,
    caffeinateOwners,
    assertions,
  };
}

/** True when the launchd job for a bag service is currently loaded. */
export function isServiceLoaded(label: string): boolean {
  const out = run("/bin/launchctl", ["print", `gui/${process.getuid?.() ?? 501}/${label}`]);
  return out.length > 0;
}

/** Turns a parent command line into something short enough for a status line. */
function describeOwner(parentCmd: string, isOurs: boolean): string {
  if (isOurs) return "coffee";
  if (!parentCmd) return "unknown";
  if (parentCmd.includes("claude")) return "claude code session";
  // Login shells arrive as "-zsh"/"-bash"; that leading dash is not a flag.
  const base = parentCmd.trim().split(/\s+/)[0].replace(/^-/, "");
  const name = base.split("/").pop() || base;
  if (["zsh", "bash", "sh", "fish"].includes(name)) return `shell (${name})`;
  return name;
}
