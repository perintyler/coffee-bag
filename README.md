# coffee

Keeps this Mac awake on demand, without stranding an assertion nobody can
account for.

```
barry coffee on | off | status
barry coffee autostart --on|--off      # turn on at login
barry coffee lid-awake --on|--off      # stay awake with the lid shut (needs root, see below)
```

## The one idea

**On means on.** `caffeinate` itself costs nothing — it creates an IOKit
assertion and blocks. The cost is the display backlight, roughly 5–8 W against
2–3 W for an idle SoC, which turns a ~10 hour machine into ~3–4.

That cost is real, but it is the user's to accept: `coffee on` holds the
machine awake on battery exactly as it does on AC. The bag's job is to make the
cost **visible**, not to overrule you. So while it holds on battery it records
an event as the charge crosses 50 / 30 / 20 / 10 / 5%, and both `on` and
`status` say plainly that the battery is draining.

It stands down for exactly one reason: **the power state cannot be read at
all**. "On battery" and "pmset told me nothing" are different facts, and only
the second is a bug — collapsing them would let a broken probe pin the machine
awake forever with nothing in the log to explain why.

The second idea is that intent and reality are separate things. `status`
reports both, because the failure worth catching is when they disagree.

> Closing the lid still sleeps the machine. The assertion is deliberately an
> *idle* one (`-d -i`), so clamshell sleep is unaffected — that is what stops a
> laptop cooking itself in a bag, and it is unchanged by holding on battery.

## Why a supervisor at all

Because launchd cannot express the gate. `KeepAlive` has no power-source
condition (the full set is `SuccessfulExit`, `NetworkState`, `PathState`,
`OtherJobEnabled`, `Crashed`), so something has to poll. That something is a
bash loop, and its three obligations are:

- **Never stack.** Acquire is idempotent.
- **Always release.** Disabled, or an unreadable power state, releases within a
  poll, and a trap covers EXIT/TERM/INT — so `launchctl bootout` cannot orphan
  anything.
- **Fail toward sleep.** Unreadable state reads as off, never as "on battery".
  A power daemon that cannot tell where its power comes from should let the
  machine sleep.
- **Warn while draining.** Since nothing stands coffee down on battery any
  more, the threshold events are the only warning a draining machine gets.
  They are load-bearing. Emitting them is best-effort though — a failed
  `barry events emit` must never keep the Mac awake.

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
laptop cooking itself in a bag, so it sits behind four layers: opt-in, cleared
at login by a reconciler, granted by a sudoers rule naming two literal
commands, and reverted by the supervisor's trap.

```
scripts/install-sudoers        # validates before writing, rolls back a bad tree
barry coffee lid-awake --on
```

Without the rule the setting is inert but harmless — the normal assertion still
holds, and both `lid-awake` and `status` say so rather than failing quietly.
Residual risk after all that: a hard kill while asserting leaves sleep disabled
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
  the clamshell protection this bag relies on; `-u` turns the display
  on. A test enforces this.
- The shell and TypeScript halves must resolve the same config path. When they
  diverged, the CLI wrote a file the daemon never read and toggles silently
  no-opped. The same applies to the *gate*: `effectiveState()` in `tools.ts`
  mirrors `power_state()` here, and if they drift `status` describes a machine
  that does not exist.
- **A boolean cannot carry three facts.** `on_ac` returned false for both "on
  battery" and "pmset unreadable". That was fine while both released, but the
  moment battery became a hold state the two had to be told apart — hence
  `power_state` printing `ac|battery|unknown`.
- **Events go through the CLI, not the HTTP API.** `POST /api/v1/events`
  requires `BARRY_SECRET` even from localhost, and a bag's launchd plist is
  world-readable. `barry events emit` talks to Postgres directly and needs only
  `BARRY_DATABASE_URL`, sourced from the repo `.env` at runtime — the same
  trick `scripts/jobs/lib.sh` uses. Call it by absolute path: launchd resolves
  argv[0] against its own minimal PATH, where a bare `barry` exits 78.
- **`|| true` makes an exit code meaningless.** The smoke test for `emit_event`
  returned 0 whether or not the event was recorded; proving it worked meant
  reading the row back out of the event feed.
- Bag executables go in `scripts/`, not `bin/` — a global `bin/` rule in the
  barry monorepo's .gitignore silently leaves them untracked.

Tests cover the shell, not just the TypeScript, because every bug above lived
in bash. Note that the SIGPIPE tests pad their stub's output on purpose: a stub
that prints one line and exits wins the race every time and passes against
known-broken code.
