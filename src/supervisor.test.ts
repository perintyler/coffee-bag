const isMac = process.platform === "darwin";
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * These tests exercise the SHELL scripts, not the TypeScript.
 *
 * The two worst bugs found while building this bag both lived in bash and were
 * invisible to the TS unit tests: the AC gate misreading power state, and the
 * reconciler skipping its cleanup. Both came from the same root cause, so the
 * important test here is `on_ac` under repetition — a single call passes even
 * with the bug present.
 */

const SUPERVISOR = resolve(__dirname, "../scripts/coffee-supervisor");
const RECONCILE = resolve(__dirname, "../scripts/coffee-reconcile");

/**
 * Sources a script up to its main loop and runs `body` against its functions.
 *
 * The supervisor runs an infinite loop at the bottom, so it cannot simply be
 * sourced. Everything above `while true` is the function definitions, which is
 * exactly the part under test.
 */
function withScriptFunctions(
  scriptPath: string,
  body: string,
  env: Record<string, string> = {},
  /** Absolute binary paths to redirect, e.g. {"/usr/bin/pmset": "/tmp/x/pmset"}. */
  redirects: Record<string, string> = {},
): string {
  const raw = execFileSync("/bin/cat", [scriptPath], { encoding: "utf8" });
  // The scripts invoke system binaries by absolute path on purpose, so PATH
  // cannot be used to substitute a stub — rewrite the paths instead.
  const src = Object.entries(redirects).reduce(
    (acc, [from, to]) => acc.split(from).join(to),
    raw,
  );
  const upToLoop = src.split(/^while true; do$/m)[0];

  const dir = mkdtempSync(join(tmpdir(), "coffee-sh-"));
  try {
    const harness = join(dir, "harness.sh");
    // The prelude legitimately logs ("supervisor started") and may seed config
    // via autostart. Both are side effects we do not want mixed into the value
    // under test, so the prelude's stdout is redirected to stderr and the body
    // writes to a dedicated fd 3. Only fd 3 is captured.
    writeFileSync(
      harness,
      `exec 3>&1\n{\n${upToLoop}\n} 1>&2\n{\n${body}\n} 1>&3\n`,
    );
    return execFileSync("/bin/bash", [harness], {
      encoding: "utf8",
      env: { ...process.env, ...env, HOME: dir, BARRY_HOME: dir },
      timeout: 30_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A stub binary that prints `output`, then keeps writing padding lines.
 *
 * The padding is load-bearing. These tests guard a SIGPIPE race: `grep -q`
 * exits at the first match and closes the pipe, and the bug only manifests if
 * the writer is still writing when that happens. A stub that prints one line
 * and exits wins the race every time and reports a clean pass against code
 * that is definitely broken — verified: 0/60 failures padded vs 60/60 unpadded.
 *
 * Real pmset prints ~8 lines, enough to lose the race about half the time,
 * which is precisely why the production bug was intermittent. The padding
 * makes the test deterministic in the direction of catching it.
 */
function makeStubDir(name: string, output: string): string {
  const dir = mkdtempSync(join(tmpdir(), "coffee-stub-"));
  const bin = join(dir, name);
  writeFileSync(
    bin,
    `#!/bin/bash\ncat <<'STUB_EOF'\n${output}\nSTUB_EOF\nfor i in $(seq 1 500); do echo " padding line $i"; done\n`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

describe.skipIf(!isMac)("coffee-supervisor: on_ac", () => {
  /**
   * REGRESSION: `pmset ... | grep -q "'AC Power'"` under `set -o pipefail`.
   *
   * grep -q exits at the first match and closes the pipe, so pmset takes
   * SIGPIPE and pipefail surfaces that as a failed pipeline — i.e. "on
   * battery". It is a scheduling race: measured at 21/40 false readings.
   *
   * The consequence was severe. On AC with coffee on, the supervisor released
   * and re-acquired caffeinate on every single poll, forever.
   *
   * 40 iterations because a single call passes even with the bug present.
   */
  it("reports AC consistently across many calls (no SIGPIPE flapping)", () => {
    const stub = makeStubDir(
      "pmset",
      "Now drawing from 'AC Power'\n -InternalBattery-0 (id=1)\t100%; charged; 0:00 remaining present: true",
    );
    try {
      const out = withScriptFunctions(
        SUPERVISOR,
        `
        fails=0
        for i in $(seq 1 40); do on_ac || fails=$((fails+1)); done
        echo "false_battery=$fails"
        `,
        {},
        { "/usr/bin/pmset": `${stub}/pmset` },
      );
      expect(out).toContain("false_battery=0");
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  it("reports battery consistently across many calls", () => {
    const stub = makeStubDir(
      "pmset",
      "Now drawing from 'Battery Power'\n -InternalBattery-0 (id=1)\t72%; discharging; 4:11 remaining present: true",
    );
    try {
      const out = withScriptFunctions(
        SUPERVISOR,
        `
        acs=0
        for i in $(seq 1 40); do on_ac && acs=$((acs+1)); done
        echo "false_ac=$acs"
        `,
        {},
        { "/usr/bin/pmset": `${stub}/pmset` },
      );
      expect(out).toContain("false_ac=0");
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });

  /** Invariant 4: unknown state must fall through to "not on AC". */
  it("treats an unreadable pmset as battery, never as AC", () => {
    const dir = mkdtempSync(join(tmpdir(), "coffee-stub-"));
    const bin = join(dir, "pmset");
    writeFileSync(bin, `#!/bin/bash\nexit 1\n`);
    chmodSync(bin, 0o755);
    try {
      const out = withScriptFunctions(
        SUPERVISOR,
        `on_ac && echo "RESULT=ac" || echo "RESULT=battery"`,
        {},
        { "/usr/bin/pmset": `${dir}/pmset` },
      );
      expect(out).toContain("RESULT=battery");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!isMac)("coffee-supervisor: cfg", () => {
  it("returns false for a missing config rather than erroring", () => {
    const out = withScriptFunctions(
      SUPERVISOR,
      `echo "enabled=$(cfg enabled)"`,
      { COFFEE_CONFIG: "/nonexistent/coffee.json" },
    );
    expect(out).toContain("enabled=false");
  });

  it("returns false for malformed JSON rather than erroring", () => {
    const dir = mkdtempSync(join(tmpdir(), "coffee-cfg-"));
    const cfgPath = join(dir, "coffee.json");
    writeFileSync(cfgPath, "{not json");
    try {
      const out = withScriptFunctions(SUPERVISOR, `echo "enabled=$(cfg enabled)"`, {
        COFFEE_CONFIG: cfgPath,
      });
      expect(out).toContain("enabled=false");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a true value back as true", () => {
    const dir = mkdtempSync(join(tmpdir(), "coffee-cfg-"));
    const cfgPath = join(dir, "coffee.json");
    writeFileSync(cfgPath, JSON.stringify({ version: 1, enabled: true, autostart: false }));
    try {
      const out = withScriptFunctions(SUPERVISOR, `echo "enabled=$(cfg enabled)"`, {
        COFFEE_CONFIG: cfgPath,
      });
      expect(out).toContain("enabled=true");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!isMac)("coffee-reconcile: sleep_disabled", () => {
  /** Same SIGPIPE regression as on_ac; here it silently skipped the cleanup. */
  it("detects SleepDisabled=Yes consistently across many calls", () => {
    const stub = makeStubDir(
      "ioreg",
      '+-o Root  <class IORegistryEntry>\n    "SleepDisabled" = Yes',
    );
    try {
      const src = execFileSync("/bin/cat", [RECONCILE], { encoding: "utf8" });
      const prelude = src.split(/^if ! sleep_disabled; then$/m)[0];
      const dir = mkdtempSync(join(tmpdir(), "coffee-sh-"));
      const harness = join(dir, "h.sh");
      // The script calls ioreg by absolute path (hardening), so PATH alone
      // cannot redirect it — rewrite the path to the stub for this harness.
      const patched = prelude.replace(/\/usr\/sbin\/ioreg/g, join(stub, "ioreg"));
      writeFileSync(
        harness,
        `${patched}\nmisses=0\nfor i in $(seq 1 40); do sleep_disabled || misses=$((misses+1)); done\necho "missed=$misses"\n`,
      );
      const out = execFileSync("/bin/bash", [harness], {
        encoding: "utf8",
        env: { ...process.env },
        timeout: 30_000,
      }).trim();
      rmSync(dir, { recursive: true, force: true });
      expect(out).toContain("missed=0");
    } finally {
      rmSync(stub, { recursive: true, force: true });
    }
  });
});

describe.skipIf(!isMac)("coffee scripts: safety invariants", () => {
  const read = (p: string) => execFileSync("/bin/cat", [p], { encoding: "utf8" });

  /**
   * Executable lines only. These scripts document their invariants in prose
   * ("never `caffeinate -s`"), so scanning raw source makes the comments
   * themselves trip the checks.
   */
  const code = (p: string) =>
    read(p)
      .split("\n")
      .filter((l) => !/^\s*#/.test(l))
      .join("\n");

  /**
   * `-s` blocks FORCED sleep, which would defeat the clamshell protection the
   * AC gate is built around. `-u` turns the display on. Neither belongs here.
   */
  it("never passes -s or -u to caffeinate", () => {
    const invocations = (code(SUPERVISOR).match(/caffeinate(\s+-\S+)+/g) ?? []);
    expect(invocations.length).toBeGreaterThan(0);
    for (const call of invocations) {
      const flags = call.match(/-\S+/g) ?? [];
      expect(flags).not.toContain("-s");
      expect(flags).not.toContain("-u");
    }
  });

  /** pmset must be read-only except the two literal sudoers-allowed commands. */
  it("only ever mutates pmset via the two allowlisted disablesleep commands", () => {
    // Anchored on the `sudo -n /usr/bin/pmset` invocation prefix so that the
    // same command quoted inside a user-facing log message ("run: sudo pmset
    // -a disablesleep 0") is not mistaken for a call site.
    const src = code(SUPERVISOR) + "\n" + code(RECONCILE);
    const invocations = (src.match(/sudo -n \/usr\/bin\/pmset[^\n;]*/g) ?? []).map((m) =>
      m.replace(/\s*2>\/dev\/null.*$/, "").trim(),
    );
    expect(invocations.length).toBeGreaterThan(0);
    for (const m of invocations) {
      expect(m).toMatch(/^sudo -n \/usr\/bin\/pmset -a disablesleep [01]$/);
    }

    // And pmset must never be invoked with any other mutating flag.
    expect(src).not.toMatch(/pmset\s+-a\s+(?!disablesleep)/);
  });

  /** The trap is what makes `launchctl bootout` unable to orphan anything. */
  it("traps EXIT, TERM and INT so no exit path strands an assertion", () => {
    expect(code(SUPERVISOR)).toMatch(/trap\s+'[^']*release[^']*'\s+EXIT\s+TERM\s+INT/);
  });

  /** Guards the divergence that made the CLI and daemon read different files. */
  it("resolves its config path the same way defaultConfigPath() does", () => {
    expect(code(SUPERVISOR)).toContain('BARRY_DIR="${BARRY_HOME:-${HOME}/.barry}"');
  });
});

describe("coffee-supervisor: autostart seeding", () => {
  /**
   * Autostart is verified here rather than by logging out: what launchd
   * actually does at login is start this script with `enabled` false and
   * `autostart` true, which is exactly what the prelude sees.
   */
  function runPrelude(config: object, stubOutput: string): { out: string; config: Record<string, unknown> } {
    const stub = makeStubDir("pmset", stubOutput);
    const dir = mkdtempSync(join(tmpdir(), "coffee-auto-"));
    const cfgPath = join(dir, "coffee.json");
    writeFileSync(cfgPath, JSON.stringify(config));
    try {
      const raw = execFileSync("/bin/cat", [SUPERVISOR], { encoding: "utf8" });
      const patched = raw.split("/usr/bin/pmset").join(join(stub, "pmset"));
      const prelude = patched.split(/^while true; do$/m)[0];
      const harness = join(dir, "h.sh");
      writeFileSync(harness, prelude);
      const out = execFileSync("/bin/bash", [harness], {
        encoding: "utf8",
        env: { ...process.env, COFFEE_CONFIG: cfgPath },
        timeout: 30_000,
        stdio: ["ignore", "pipe", "ignore"],
      });
      return { out, config: JSON.parse(readFileSync(cfgPath, "utf8")) };
    } finally {
      rmSync(stub, { recursive: true, force: true });
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const AC = "Now drawing from 'AC Power'";

  it("seeds enabled=true at startup when autostart is on", () => {
    const { out, config } = runPrelude(
      { version: 1, enabled: false, autostart: true, lidAwake: false },
      AC,
    );
    expect(out).toContain("autostart enabled");
    expect(config.enabled).toBe(true);
  });

  it("leaves the other config keys intact when seeding", () => {
    const { config } = runPrelude(
      { version: 1, enabled: false, autostart: true, lidAwake: false },
      AC,
    );
    expect(config.version).toBe(1);
    expect(config.autostart).toBe(true);
    expect(config.lidAwake).toBe(false);
  });

  it("does not seed when autostart is off", () => {
    const { out, config } = runPrelude(
      { version: 1, enabled: false, autostart: false, lidAwake: false },
      AC,
    );
    expect(out).not.toContain("autostart enabled");
    expect(config.enabled).toBe(false);
  });

  /**
   * Autostart decides how the session STARTS, not what it stays. Re-seeding on
   * every poll would make `coffee off` impossible to make stick.
   */
  it("does not re-seed when enabled is already true", () => {
    const { out } = runPrelude(
      { version: 1, enabled: true, autostart: true, lidAwake: false },
      AC,
    );
    expect(out).not.toContain("autostart enabled");
  });
});

describe("power: caffeinate attribution", () => {
  /**
   * This machine regularly has several caffeinate processes from unrelated
   * tools (Claude Code renews a `-i -t 300` per session; the shell `coffee()`
   * holds a `-d`). Status has to say which one is coffee's, or the question it
   * exists to answer gets buried.
   */
  it("labels a supervisor-parented caffeinate as ours", async () => {
    const { readPowerState } = await import("./power.js");
    const dir = mkdtempSync(join(tmpdir(), "coffee-attr-"));
    try {
      // Named coffee-supervisor on purpose: attribution keys off the parent's
      // command line, so a renamed copy would not be recognised.
      const script = join(dir, "coffee-supervisor");
      writeFileSync(script, "#!/bin/bash\ncaffeinate -d -i &\nsleep 6\n");
      chmodSync(script, 0o755);
      const child = execFileSync("/bin/bash", ["-c", `"${script}" >/dev/null 2>&1 & echo $!`], {
        encoding: "utf8",
      }).trim();
      await new Promise((r) => setTimeout(r, 1500));

      const ours = readPowerState().caffeinateOwners.filter((o) => o.isOurs);
      expect(ours.length).toBeGreaterThan(0);
      expect(ours[0].owner).toBe("coffee");

      try {
        execFileSync("/bin/kill", [child], { stdio: "ignore" });
      } catch {
        // already gone
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("never claims a foreign caffeinate as ours", async () => {
    const { readPowerState } = await import("./power.js");
    const proc = execFileSync("/bin/bash", ["-c", "caffeinate -i -t 5 >/dev/null 2>&1 & echo $!"], {
      encoding: "utf8",
    }).trim();
    await new Promise((r) => setTimeout(r, 1000));
    const found = readPowerState().caffeinateOwners.find((o) => String(o.pid) === proc);
    if (found) expect(found.isOurs).toBe(false);
    try {
      execFileSync("/bin/kill", [proc], { stdio: "ignore" });
    } catch {
      // already expired
    }
  });
});
