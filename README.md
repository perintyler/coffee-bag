# coffee

Keep this Mac awake, without the two failure modes the old approach had:
draining the battery, and stranding an assertion nobody can account for.

```
barry coffee on          # stay awake (AC only)
barry coffee off         # let it sleep
barry coffee status      # what is actually true right now
```

## What it does

A launchd-managed supervisor owns a single `caffeinate -d -i` child — display
and system. It holds that child only while **enabled AND on AC power**, and
polls every 15s, so unplugging releases the assertion within 15s and plugging
back in restores it.

`caffeinate` itself is free (measured: 1.4–2.3 MB RSS, 0.0% CPU — it creates an
IOKit assertion and blocks in a runloop). The cost that matters is the display
backlight, ~5–8 W against ~2–3 W for an idle SoC. Held on battery, that turns a
~10 hour machine into ~3–4. Hence the AC gate.

## Settings

Config lives in `~/.barry/coffee.json`. All three default to off.

| Setting | Meaning |
|---|---|
| `enabled` | Assert now. This is what `on` / `off` flip. |
| `autostart` | Turn on at login. Still respects the AC gate. |
| `lidAwake` | Stay awake with the lid **closed**. Needs sudo — see below. |

```
barry coffee autostart --on
barry coffee lid-awake --off
```

Both accept `--on` / `--off`, or `--state on|off`. Bare `barry coffee autostart`
reports the current setting without changing it.

Autostart decides how a session *starts*, not what it stays: it seeds `enabled`
once when the supervisor launches, so a later `coffee off` sticks for the rest
of the session.

## Lid-closed operation (optional, needs root)

`caffeinate` **cannot** keep a Mac awake with the lid shut. `-d`/`-i` create
*idle* assertions, which suppress idle timers; lid-close is a *forced* sleep
path. The only mechanism that blocks it is `pmset disablesleep`, a persistent,
system-wide, root-owned setting.

The danger is that it **outlives the process that set it**. If the daemon is
SIGKILLed or the machine loses power, sleep stays disabled system-wide until
something clears it. That is the real "laptop cooks itself in a backpack"
mechanism, so it is off by default and layered behind:

1. **AC-gated** — only ever set on AC, released within 15s of unplugging. A
   machine in a bag is on battery, so it sleeps.
2. **Opt-in** — its own setting; the bag is fully useful without it.
3. **Boot-time reconciler** — a `run-at-load` job clears an orphaned
   `disablesleep` at login, so a dirty death self-heals.
4. **Narrow sudoers rule** — two literal commands, no wildcards, no
   caller-controlled arguments.
5. **`trap` on EXIT/TERM/INT** — reverts on every clean shutdown path,
   including `launchctl bootout`.

To enable it:

```
scripts/install-sudoers   # validates before writing; asks for your password
barry coffee lid-awake --on
```

Without the rule, `lid-awake on` is inert but harmless — the normal assertion
still holds, and both `lid-awake` and `status` say so explicitly.

To remove: `scripts/install-sudoers --remove`.

## Reading `status`

`status` deliberately reports **intended state next to real IOKit state**, so
the two can't silently disagree — that disagreement is the failure this bag
exists to surface.

It also attributes every `caffeinate` on the machine. Several things spawn
them (each Claude Code session renews a `-i -t 300`; the shell `coffee()`
function holds a `-d`), and `coffee off` will not stop any of those:

```
  assertions  6 caffeinate process(es)
              ✓ coffee — pid 52101 (caffeinate -d -i)
                not coffee — 5×claude code session (pid 39232, ...)
```

## Kill switches

In increasing severity:

```
barry coffee off
launchctl bootout gui/$(id -u)/com.barry.bag.coffee.daemon   # fires the trap
kill <caffeinate-pid>
sudo pmset -a disablesleep 0                                  # only if lid-awake was on
```

## Notes for maintainers

- **Autostart is config, not a plist property.** The daemon deliberately has
  **no `RunAtLoad`** (`run-at-load: false` renders as an omitted key); the
  reconciler has one. Flipping autostart therefore needs no launchd
  regeneration — `runLaunchdSetup()` prunes agents it does not re-declare and
  is far too blunt for a toggle.
- **launchd cannot do the AC gating.** `KeepAlive` has no power-source
  sub-key (`SuccessfulExit`, `NetworkState`, `PathState`, `OtherJobEnabled`,
  `Crashed` is the complete set). Hence the polling supervisor.
- **Never add `-s` or `-u`** to the caffeinate invocation. `-s` blocks forced
  sleep, defeating the clamshell protection the AC gate is built around; `-u`
  turns the display on. A test enforces this.
- **Do not pipe into `grep -q` under `pipefail`.** `grep -q` exits at the first
  match and closes the pipe, the writer takes SIGPIPE, and pipefail reports the
  pipeline as failed. This produced a *silent, intermittent* misreading of
  power state (21/40 false "on battery" readings) that made the supervisor
  thrash. Capture output and match with `case` instead.
- **`plutil` writes errors to stdout**, not stderr, with a nonzero status — so
  `plutil ... 2>/dev/null || echo false` still emits the error text as the
  value. `cfg()` normalises anything that is not `true` to `false`.
- The shell config path must resolve identically to `defaultConfigPath()` in
  `src/config.ts`. When they diverged, the CLI wrote a file the daemon never
  read and toggles silently no-opped.
- Scripts live in `scripts/`, not `bin/` — a global `bin/` rule in the repo
  `.gitignore` silently leaves `bin/` contents untracked.
