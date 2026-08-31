# How Limen works

Design notes for the curious and for anyone changing it. The
[README](README.md) covers installing and using it; this is the reasoning
underneath.

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
bucket that fills up. All it does is let you choose where the boundaries
sit; Chain trades that choice away for always-on, which is why it is not
the default.

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
Width is estimated at 12.23% of the logical width — the ratio measured on
real 14" and 16" hardware, constant across models and scalings (override
with `notchWidth` in the config; `notched: true/false` forces the whole
detection, for third-party scalers that break the native aspect — or the
day a new panel stops being 16:10 plus a band). Displays without a notch
get a drawn one, top-center, that appears only while the island has
something to say — and the band only counts as something to say by the
chips' own rule, so a signed-out account never leaves a bare anchor
wearing yesterday's plan label (`externalDisplays: "off"` disables the
drawn notch entirely).

## Behavior guarantees, and where they are enforced

- **Never steals a click aimed elsewhere, never takes focus.** The window
  ignores the mouse except while the cursor is over the island's own drawn
  pixels — a rect the *renderer measures and reports*, not one computed from
  constants, because a constant drifts from what is painted and the gap
  becomes an invisible window that eats clicks. The wings are included —
  they are drawn pixels of ours, and a click on a chip toggles the panel.
  The empty menu-bar strip beside them is not, which is why the surface is
  a *list* of rectangles rather than one bounding box.
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
  account is truly signed out does it open Terminal running
  `claude auth login`. On a machine with no `claude` binary at all, the
  button says so and opens the install page instead — Terminal ending in
  "command not found" is a dead end wearing our name. Local credential
  states never feed the backoff — the island keeps checking at the normal
  pace, and a hover, a deliberate open or a wake re-reads the credentials
  immediately, since no API call is involved in looking.
- **A sign-in is noticed in seconds, not at the next timer.** While the
  account is unreadable, the credentials file is watched directly and the
  Keychain re-read on a heartbeat — fast for a few minutes after Terminal
  was opened, when a login is actually expected. Every check is a local
  read; only a credential that has *changed and looks usable* earns the one
  verifying fetch, so a revoked token that keeps failing is probed once,
  not once per beat. The widget lights up the moment the login lands
  instead of leaving the person hovering at "sign in".
- **The stores are weighed, not raced.** Claude Code has written both the
  Keychain and `~/.claude/.credentials.json` on the same Mac, hours apart,
  and a failed refresh can leave a blob that parses but holds no token.
  Every store is read and the best candidate wins — valid over undated
  over expired, freshest expiry first — so an expired entry in one store
  can no longer report "sign in" while a working token sits in another.

## The renderer's shape

One direction: IPC messages land in a small store, a single subscriber
repaints, and the paint order is a guarantee rather than a habit — wings
before panel, because the panel's edges are measured from the chips' drawn
pixels, and the clickable surface last, so the reported rects describe what
is actually on screen.

Each drawn thing has one painter (`anchor`, `wings`, `peek`, `panel`,
`primebar`, `surface`), written as a factory handed the document, the
viewmodel and its own root element. The files are UMD, so the very code that
ships loads in the page with `<script>` tags and in Node with `require()` —
`test/renderer.test.js` exercises the real modules rather than a
transcription. Decisions — wording, tones, which button shows, which
settings chip is spent — live in `src/viewmodel.js` and are tested there;
painters only apply them. `src/renderer/band.js` holds the one contract two
painters share: the band's measured extent, and the 300 pt floor below which
neither band nor panel may shrink.

## What the tests cover

`npm test` runs the pure-module suites — a couple of hundred tests, no
Electron needed:

- **Notch geometry** — the aspect rule against nine real display
  fixtures (14"/16" MBP at three scalings, Air, flat panels, externals,
  16:9 iMac shape), auto-hidden menu bars, negative display coordinates,
  clamshell fallback, and the keep-alive ⊇ hot-zone invariant.
- **The state machine** — stillness-gated dwell, grace, re-entry,
  the busy hold, peek timing, promotion, alert-never-demotes, wings
  orthogonality, input immutability, and a cursor merely crossing the strip
  after a collapse staying shut.
- **Burn rate** — mostly about staying quiet: two samples are a
  coincidence, quantisation noise is not a trend, and a rolling-window reset
  voids a rate rather than reporting a negative one.
- **Wording and tones** — the luminance-ordered ramp, server-graded
  severity outranking it, reset and pace labels, the status strip.
- **The data layer** — normalization (a missing quota never becomes
  a displayed zero), the choice between credential stores that disagree,
  the one gate every fetch passes, the alert ledger — once per level per
  window, pace warnings included, and a pause that skips rather than
  holds — and persisted state.
- **The sign-in watcher** — driven with fake reads and a fake watcher:
  it notices a landing once per credential rather than once per beat,
  costs nothing while the account is healthy, coalesces file-event
  bursts, and degrades to the heartbeat when the directory cannot be
  watched.
- **Settings and priming** — a hand-edited file that cannot break
  the app, the wingCount migration, the band's source rules (canonical order,
  a cap of three, never empty), and the auto-open schedule.
- **The two panel buttons and the login item** — that sign-in and
  prime never delete each other, that the settings directory moves once and
  never merges, and that `launchctl print-disabled` is read the right way
  round on both output formats.

Three runtime checks complement them, because unit tests cannot see pixels:

```bash
npm run spike        # can a window sit over the menu bar strip? exit 0 = yes
ISLAND_CAPTURE=/tmp/a.png ISLAND_SCENE=full npm start          # a state, as PNG
ISLAND_CAPTURE=/tmp/b.png ISLAND_CAPTURE_DELAY=130 ... npm start   # mid-animation
```

Captures are hermetic — scenes state their own wings and never inherit your
config, so the same scene renders identically on any machine.
