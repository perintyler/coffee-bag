# coffee

Keeps this Mac awake on demand, without draining the battery or stranding an
assertion nobody can account for.

```
barry coffee on | off | status
barry coffee autostart --on|--off      # turn on at login
barry coffee lid-awake --on|--off      # stay awake with the lid shut (needs root, see below)
```

## The one idea

**A held assertion is only ever appropriate on AC power.** `caffeinate` itself
costs nothing — it creates an IOKit assertion and blocks. The cost is the
display backlight, roughly 5–8 W against 2–3 W for an idle SoC, which turns a
~10 hour machine into ~3–4.

So a supervisor owns the assertion and gates it: held while **enabled AND on
AC**, released within one poll otherwise. Unplugging stands it down; plugging
back in resumes. Everything else here follows from that.

The second idea is that intent and reality are separate things. `status`
reports both, because the failure worth catching is when they disagree.

## Why a supervisor at all

Because launchd cannot express the gate. `KeepAlive` has no power-source
condition (the full set is `SuccessfulExit`, `NetworkState`, `PathState`,
`OtherJobEnabled`, `Crashed`), so something has to poll. That something is a
bash loop, and its three obligations are:

- **Never stack.** Acquire is idempotent.
- **Always release.** Every branch that isn't "enabled AND on AC" releases, and
  a trap covers EXIT/TERM/INT — so `launchctl bootout` cannot orphan anything.
- **Fail toward sleep.** Unreadable state reads as off. The failure mode of a
  power daemon should be a sleeping machine, not a flat battery.

Config lives in `~/.barry/coffee.json` (`enabled`, `autostart`, `lidAwake`).

**Autostart is config, not a plist property.** The daemon deliberately has no
`RunAtLoad`; the supervisor reads `autostart` at startup and seeds `enabled`
once. This is why toggling it doesn't regenerate launchd agents — that would
mean re-running the setup script, which prunes agents it doesn't re-declare.
Autostart decides how a session *starts*, not what it stays: a later
`coffee off` sticks.

## Lid-closed operation

Off by default, and the only part that needs root.

`caffeinate` **cannot** do this. `-d`/`-i` create *idle* assertions, which
suppress idle timers; lid-close is a *forced* sleep path. Only
`pmset disablesleep` blocks it — a persistent, system-wide, root-owned setting.

The danger is that it **outlives the process that set it**. A SIGKILL or power
loss leaves sleep disabled system-wide. That is the actual mechanism behind a
laptop cooking itself in a bag, so it sits behind five layers: AC-gated, opt-in,
cleared at login by a reconciler, granted by a sudoers rule naming two literal
commands, and reverted by the supervisor's trap.

```
scripts/install-sudoers        # validates before writing, rolls back a bad tree
barry coffee lid-awake --on
```

Without the rule the setting is inert but harmless — the normal assertion still
holds, and both `lid-awake` and `status` say so rather than failing quietly.
Residual risk after all that: a hard kill while on AC leaves sleep disabled
until you next log in.

Kill switches, escalating: `barry coffee off` → `launchctl bootout …` (fires the
trap) → `kill <pid>` → `sudo pmset -a disablesleep 0`.

## Reading `status`

It attributes every `caffeinate` on the machine, not just its own. Several
things spawn them — each Claude Code session renews a `-i -t 300`, the shell
`coffee()` function holds a `-d` — and `coffee off` will not stop any of those.
Before attribution, a busy machine showed ten unexplained assertions and buried
the only line that mattered.

## For the next person

Things that cost real time to discover and are invisible in the code:

- **Don't pipe into `grep -q` under `set -o pipefail`.** `grep -q` exits at the
  first match and closes the pipe; the writer takes SIGPIPE and pipefail reports
  the whole pipeline as failed. This silently misread power state 21 times out
  of 40 and made the supervisor thrash. Capture output, match with `case`.
- **`plutil` writes errors to stdout**, not stderr, with a nonzero status — so
  `plutil … 2>/dev/null || echo false` still emits the error text as the value.
- **Never add `-s` or `-u` to caffeinate.** `-s` blocks forced sleep, defeating
  the clamshell protection the AC gate is built around; `-u` turns the display
  on. A test enforces this.
- The shell and TypeScript halves must resolve the same config path. When they
  diverged, the CLI wrote a file the daemon never read and toggles silently
  no-opped.
- Bag executables go in `scripts/`, not `bin/` — a global `bin/` rule in the
  barry monorepo's .gitignore silently leaves them untracked.

Tests cover the shell, not just the TypeScript, because every bug above lived
in bash. Note that the SIGPIPE tests pad their stub's output on purpose: a stub
that prints one line and exits wins the race every time and passes against
known-broken code.
