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
| **Wings** | Two black chips flanking the notch at its full height — flush with the top edge, the notch's own rounded corners, so the trio reads as one split surface. Each names its number: `5h ◔ 73%` for the rolling session on the left, and on the right the binding limit (`7d` for the all-models week, or the model by name: `Fable ◔ 52%`). Hovering a chip shows the full sentence. | Opt-in (`wings: true`, tray, or `⌘⇧I`) |
| **Peek** | One line that drops below the notch for 4 seconds, then retracts. | A quota crosses an alert mark (80, 95) |
| **Expanded** | Every gauge: session, weekly, per-model, with reset times and the **active limit** badge. | Hover the notch for 120 ms |

Colors follow headroom, not model: green below 35%, yellow to 69%, orange
to 89%, red beyond. A failed fetch never blanks the display — the last real
numbers stay, dimmed, with the reason and the retry time
(`stale · rate-limited · next try in 8 min`).

## Running it

Requires Node 18+ and Claude Code signed in (macOS Keychain), or a
`CLAUDE_CODE_OAUTH_TOKEN` environment variable.

```bash
npm install
npm test        # 78 tests, no Electron needed
npm start       # the island, on your notch (or top-center of a flat display)
```

Useful commands:

```bash
npm run usage   # raw quotas as JSON, no interface
npm run demo    # stays open with fixture data (ISLAND_SCENE=expanded|peek|wings|full|stale|empty)
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
  ignores the mouse except while the cursor is on the island's own visible
  surface — and that surface deliberately starts below the menu bar strip,
  so a menu title or status item is never intercepted. On its own pixels the
  island is clickable: the sign-in button, the refresh control, and a peek
  that expands on click. Hover still comes from cursor sampling in the main
  process and pure hit-testing (`src/notch.js`), not DOM events.
- **Never shadows a menu.** The window sits at the `status` level: above
  the menu bar, *below* open menus, Spotlight, and dialogs.
- **A graze across the top edge does not open it** (120 ms dwell), and the
  keep-alive area always contains the trigger strip (the no-flicker
  invariant — a test, not a hope).
- **It cannot earn you an HTTP 429.** 120 s polling, exponential backoff to
  a 15-minute cap, `Retry-After` honored, no fetch on hover during backoff.
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
  "externalDisplays": "island",
  "displayId": "primary",
  "notchWidth": null,
  "timeFormat": "auto",
  "osNotifications": false,
  "shortcut": "CommandOrControl+Shift+I"
}
```

`alertAt: []` silences peeks. `osNotifications: true` raises a system
notification alongside the peek (same ledger, so still once).
Config changes are read at launch in v1.

## What is verified

`npm test` runs 78 tests across the places where a mistake shows up
immediately:

- **Notch geometry, 18 tests** — the aspect rule against nine real display
  fixtures (14"/16" MBP at three scalings, Air, flat panels, externals,
  16:9 iMac shape), auto-hidden menu bars, negative display coordinates,
  clamshell fallback, and the keep-alive ⊇ hot-zone invariant.
- **The state machine, 17 tests** — dwell, grace, peek timing, promotion,
  alert-never-demotes, mouse-down collapse, wings orthogonality,
  input immutability.
- **Wording and tones, 12 tests** — tone thresholds, reset labels,
  stale strip, wings selection.
- **The data layer, 31 tests** — ported with the code they test:
  normalization (a missing quota never becomes a displayed zero), backoff,
  the alert ledger, persisted state.

Two runtime checks complement them: `npm run spike` proves window placement
over the menu bar strip on the actual machine, and the `ISLAND_CAPTURE`
harness renders each visual state to a PNG for eyeballing or CI.

## Known limits of v1

- English only (the i18n structure from the ancestor project ports cleanly;
  it just hasn't been).
- No settings window yet — the config file and the tray menu are it.
- Mouse-down collapse is approximated by the window level (open menus
  outrank the island) rather than a global event tap.
- Fullscreen behavior beyond the spike (level survival across Space
  round-trips) hasn't been long-run soak-tested yet.

## License

MIT. An unofficial personal project, not affiliated with, endorsed by, or
supported by Anthropic. "Claude" is a trademark of Anthropic. Data layer
derived from [Claude-Marge-Widget](https://github.com/Ulrichfr/Claude-Marge-Widget)
(MIT, Ulrich Rozier) — see LICENSE.
