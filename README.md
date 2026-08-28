# Claude Island

**Your Claude usage limits in the MacBook notch.** A Dynamic Island for
macOS: invisible when idle, one ambient glance when something is worth
knowing, the full picture when you hover the notch.

Born from an analysis of
[Claude-Marge-Widget](https://github.com/Ulrichfr/Claude-Marge-Widget)
(MIT, Ulrich Rozier), whose data layer this project ports verbatim — the
same real limits, read the same honest way — with the interface rebuilt
around the notch instead of the screen edge.

## The four states

| State | What you see | When |
|---|---|---|
| **Dormant** | Nothing. The notch is just the notch. | 95% of the day |
| **Wings** | Two black chips flanking the notch at its full height — flush with the top edge, the notch's own rounded corners, so the trio reads as one split surface. Each names its number in words: `Session 73%  51m left`, `Week 21%`, `Fable 52%`. You choose which limits appear — **Show** in the panel: `Session`, `Week`, and `Model`, whichever model is busiest. Three is the most the band holds, and the third rides beside the second in the right-hand chip, which then drops its reset note. The band never draws narrower than the panel that unfolds from it, so their edges meet whatever you have asked for. | Opt-in (`wings: true`, tray, or `⌘⇧I`) |
| **Peek** | One line that drops below the notch for 4 seconds, then retracts. | A quota crosses an alert mark (80, 95) |
| **Expanded** | Every gauge, led by its number: session, weekly, per-model, with reset times, the **active limit** badge, and — when the pace would exhaust a quota before its window resets — `full in ~44 min`. | Park on the notch, the tray, or `⌘⇧U` |

Colors follow headroom, not model: green below 50%, amber to 74%, orange to
89%, red beyond — a ramp that steps down in luminance as well as hue, so it
survives greyscale and colour blindness. Marks on each track show where your
alert thresholds sit and which you have crossed. A failed fetch never blanks
the display — the last real numbers stay, with the reason and the retry time
(`Anthropic throttled the check — retrying in 8 min`).

## Running it

Requires Node 18+ and Claude Code signed in (macOS Keychain), or a
`CLAUDE_CODE_OAUTH_TOKEN` environment variable.

```bash
npm install
npm test        # 170 tests, no Electron needed
npm start       # the island, on your notch (or top-center of a flat display)
```

Useful commands:

```bash
npm run usage   # raw quotas as JSON, no interface
npm run demo    # stays open with fixture data (ISLAND_SCENE=expanded|peek|wings|wings-week|wings-three|full|stale|empty)
npm run spike   # placement proof: can a window sit over the menu bar strip? (exit 0 = yes)
ISLAND_CAPTURE=/tmp/island.png ISLAND_SCENE=stale npm start   # screenshot a state, then exit

# Freeze a frame mid-animation — the settled state says nothing about how the
# island got there, and motion bugs only live in the frames between.
ISLAND_CAPTURE=/tmp/f.png ISLAND_CAPTURE_DELAY=130 ISLAND_SCENE=full npm start
ISLAND_CAPTURE=/tmp/x.png ISLAND_CAPTURE_DELAY=860 ISLAND_SCENE=collapse npm start
```

## The motion

The expand is a real damped spring (ζ≈0.68, ~5% overshoot), sampled as CSS
`linear()` stops rather than approximated with an ease curve, so the island
arrives with mass. It scales from its top edge — `scaleY` leading `scaleX` —
so it unfurls out of the notch instead of zooming toward the viewer, and its
shadow deepens with the morph.

Three rules keep it from feeling like a web page:

- **The exit is a different motion.** 190 ms, fully damped, no overshoot —
  bouncing on the way out reads as indecision. Only the entrance springs.
- **The surface arrives, then the content resolves.** Rows cascade in on a
  calm curve (55 ms apart) while the container springs; one spring per
  moment. Bars grow into place rather than appearing filled.
- **A bar glides between values.** Rows are reconciled in place, so a refresh
  that moves a quota animates the change instead of jumping — and the 30-second
  label tick never disturbs a running animation.

`prefers-reduced-motion` drops all of it to a 100 ms cross-fade.

## Session priming (off by default)

The five-hour window starts at your **first message**, so where its boundary
falls is decided by when you happen to start work. Start at 11:00 and the
boundaries land at 16:00 and 21:00 — so a cap you hit at 15:00 blocks you for
an hour of the working day. Prime at 08:00 instead and they land at 13:00 and
18:00, where a pause costs you a coffee break.

### The controls

**In the panel**, a `Show` row and a `Detail` row for the chips, then an
`Auto-open` row: `Off · At · Chain`, with a time stepper and a row of day
letters that appear only for `At`. Chips toggle in place — a native macOS menu dismisses itself on every click,
so choosing a time there means reopening it to see the result. When no window
is running the panel also shows **Open a session window**, which is the one
moment that button would do anything.

**In the tray**, the same under **Session window**, plus *Weekdays only* and
an *Open one now* item that disables itself while a window runs — it reads
*Open until 10:50 PM* rather than just going grey.

`Chain` is the blunt option: open a new window the moment the current one
ends, around the clock. It gives you continuous windows, at the cost of
boundaries that drift about five hours a day and land wherever they land.
Scheduled times are the better default; Chain is there because sometimes you
just want the thing to be always-on.

Any other time is available by hand:

```json
{ "primeAt": ["07:30"], "primeDays": [1, 2, 3, 4, 5], "primeChain": false }
```

### What it actually sends

```
claude -p "ok" --model haiku --output-format text \
       --no-session-persistence --strict-mcp-config
```

One word, on **Haiku** — the cheapest model, chosen deliberately. Priming
with your *default* model would spend the weekly quota of whatever that is,
so a widget meant to protect an Opus budget would quietly eat it several
times a day. The session window is account-wide, so a Haiku message opens it
just as well as an expensive one. `--no-session-persistence` keeps it out of
your Claude Code history, and `--strict-mcp-config` avoids loading your MCP
servers to say one word. Override with `"primeModel"` if you want.

Three rules keep it honest:

- **It only acts when acting would do something.** A message cannot restart a
  window that is already running — that window still ends five hours after
  its own first message. So if a window is open, priming is skipped rather
  than spending quota for nothing.
- **Once per slot, and not made up later.** A missed 08:00 is not primed at
  14:00; that would put the boundary exactly where you didn't want it. There
  is a 15-minute grace for a laptop that woke up late.
- **It says it is armed.** The panel footer and the tray both show when the
  next window will be opened. Silent automation on your account is a
  surprise, not a feature.

**What this is not.** It does not give you extra quota, and you are not
losing session time while away — the window is a rate-limit clock, not a
bucket that fills up. All it does is let you choose where the boundaries sit.
A continuous 24/7 chain was deliberately not built: the boundaries would
drift five hours a day and land at arbitrary times, which is the problem
rather than the fix.

**Worth knowing before you switch it on.** This sends messages on your
account on a timer, and it exists to influence when a rate-limit window
begins. That is a reasonable thing to do by hand and this only automates the
timing — but it is worth a look at Anthropic's usage policy to be comfortable
with it. It is off unless you list a time, and it is one line to turn off
again.

## How it decides where the notch is

No per-model table, no hardcoded menu-bar height — both break under display
scaling. Flat Retina MacBook panels are exactly 16:10; notched panels are
16:10 plus the camera band. So on the internal display:

```
bounds.height − bounds.width / 1.6 > 2  ⇒  notched
```

…and that difference *is* the notch-band height in points, at any scaling.
Width is estimated at 12.5% of the logical width (override with
`notchWidth` in the config). Displays without a notch get a drawn one,
top-center, that appears only while the island has something to say
(`externalDisplays: "off"` disables that).

## Behavior guarantees, and where they are enforced

- **Never steals a click aimed elsewhere, never takes focus.** The window
  ignores the mouse except while the cursor is over the island's own drawn
  pixels — a rect the *renderer measures and reports*, not one computed from
  constants, because a constant drifts from what is painted and the gap
  becomes an invisible window that eats clicks. The wings are deliberately
  excluded: they sit in the menu-bar strip, where a click belongs to a menu.
- **Reachable without a mouse.** `⌘⇧U` opens the panel, `⌘⇧I` toggles the
  chips, and every action is in the tray menu — hover-only disclosure left
  keyboard and VoiceOver users with no route to their own quota.
- **Never shadows a menu.** The window sits at the `status` level: above
  the menu bar, *below* open menus, Spotlight, and dialogs.
- **A graze across the top edge does not open it.** The dwell gates on
  *stillness*, not presence: the strip is the route from the app menus to
  Control Center, and a cursor crossing it at a normal pace is inside for
  most of a second. The keep-alive area always contains the trigger strip
  (the no-flicker invariant — a test, not a hope).
- **It cannot earn you an HTTP 429.** Every one of the six things that can
  request a refresh — the timer, a hover, the tray, the button, waking from
  sleep, signing in — passes one gate with a wall-clock floor. A person may
  waive the app's own 120 s pacing; nobody waives a backoff the server
  imposed. The remaining wait is persisted, so a restart serves it out
  rather than starting over.
- **Alerts speak once** per level, per quota, per reset window, from a
  ledger that survives restarts.
- **Your token is never copied, cached, or refreshed.** One network call,
  to `api.anthropic.com`, with your own token. An expired token renders as
  "open Claude Code once".
- **Sign-in is one click away.** When the token expires, the panel shows a
  **Sign in with Claude Code** button (the tray menu gets one too, and the
  menu bar item reads **sign in**): it nudges Claude Code headlessly
  (Claude Code refreshes its own token before any call), and only if the
  account is truly signed out does it open Terminal running `claude` for a
  real `/login`. Local credential states never feed the backoff — the
  island keeps checking at the normal pace and on every hover, since no
  API call is involved.

## Configuration

`~/.config/claude-island/config.json` (Reveal it from the tray menu):

```json
{
  "refreshSeconds": 120,
  "alertAt": [80, 95],
  "wings": false,
  "wingSources": ["auto"],
  "wingInfo": "remaining",
  "externalDisplays": "island",
  "displayId": "primary",
  "notchWidth": null,
  "timeFormat": "auto",
  "osNotifications": false,
  "contentProtection": true,
  "shortcut": "CommandOrControl+Shift+I",
  "showShortcut": "CommandOrControl+Shift+U"
}
```

`wingSources` names the limits the chips show, in the order the band draws
them: `session`, `weekly`, and `model` (whichever model is busiest). At most
three, since the notch has two sides; turning off the last one standing is
refused rather than leaving an empty band, and a limit the account does not
expose is offered as a spent chip rather than a click that would draw
nothing. `wingInfo` is what each chip adds after its number: `off`,
`remaining` (`51m left`) or `ends` (`resets 22:50`) — a chip holding two
limits drops it either way. A file naming the retired `auto` source, or the
older `wingCount`, is migrated on first read and rewritten.

`alertAt: []` silences peeks. `osNotifications: true` raises a system
notification alongside the peek (same ledger, so still once).
`contentProtection` keeps the island out of screenshots, recordings and
screen shares. Every value is sanitized on load — a wrong type degrades one
setting rather than taking the app down. **Reload settings** in the tray menu
applies changes without a restart.

## What is verified

`npm test` runs 170 tests across the places where a mistake shows up
immediately:

- **Notch geometry, 24 tests** — the aspect rule against nine real display
  fixtures (14"/16" MBP at three scalings, Air, flat panels, externals,
  16:9 iMac shape), auto-hidden menu bars, negative display coordinates,
  clamshell fallback, and the keep-alive ⊇ hot-zone invariant.
- **The state machine, 28 tests** — stillness-gated dwell, grace, re-entry,
  the busy hold, peek timing, promotion, alert-never-demotes, mouse-down
  collapse, wings orthogonality, input immutability.
- **Burn rate, 12 tests** — mostly about staying quiet: two samples are a
  coincidence, quantisation noise is not a trend, and a rolling-window reset
  voids a rate rather than reporting a negative one.
- **Wording and tones, 25 tests** — the luminance-ordered ramp, server-graded
  severity outranking it, reset and pace labels, the status strip.
- **The data layer, 47 tests** — normalization (a missing quota never becomes
  a displayed zero), the one gate every fetch passes, the alert ledger —
  once per level per window, pace warnings included, and a pause that skips
  rather than holds — and persisted state.
- **Settings and priming, 33 tests** — a hand-edited file that cannot break
  the app, the wingCount migration, the band's source rules (canonical order,
  a cap of three, never empty), and the auto-open schedule.

## What is verified, and how

`npm test` runs **170 tests** over the pure modules — notch geometry, the
state machine, burn rate, wording and tones, quota normalization, backoff,
alerts, persisted state. Three runtime checks complement them, because unit
tests cannot see pixels:

```bash
npm run spike        # can a window sit over the menu bar strip? exit 0 = yes
ISLAND_CAPTURE=/tmp/a.png ISLAND_SCENE=full npm start          # a state, as PNG
ISLAND_CAPTURE=/tmp/b.png ISLAND_CAPTURE_DELAY=130 ... npm start   # mid-animation
```

Captures are hermetic — scenes state their own wings and never inherit your
config, so the same scene renders identically on any machine.

## Known limits of v1

- English only (the ancestor's i18n structure ports cleanly; deferred until
  the wording settles).
- No settings window — the config file, the tray menu, and **Reload
  settings** are it.
- Mouse-down collapse is approximated by the window level (open menus
  outrank the island) rather than a global event tap.
- Fullscreen behavior beyond the spike (level survival across Space
  round-trips) hasn't been long-run soak-tested yet.
- No signed build or auto-updater yet: `git pull && npm install && npm test`.
- Burn rate needs ~10 minutes of samples before it will say anything, and
  says nothing at all unless a quota would run out before its window resets.

## About

Made by [@billybowss](https://x.com/billybowss). The tray menu carries an
**About Claude Island** item — the standard macOS panel, with the version
and the credits — and a link to the same handle.

## License

MIT. An unofficial personal project, not affiliated with, endorsed by, or
supported by Anthropic. "Claude" is a trademark of Anthropic. Data layer
derived from [Claude-Marge-Widget](https://github.com/Ulrichfr/Claude-Marge-Widget)
(MIT, Ulrich Rozier) — see LICENSE.
