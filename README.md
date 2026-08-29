# Limen

**Your Claude Code usage limits, in the notch.** A Dynamic Island for
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
| **Wings** | Two black chips flanking the notch at its full height, so the trio reads as one split surface: `Session 73%  51m left`, `Week 21%`, `Fable 52%`. You pick which limits appear, up to three. | Opt-in (`wings: true`, tray, or `⌘⇧I`) |
| **Peek** | One line that drops below the notch for four seconds, then retracts. | A quota crosses an alert mark (80, 95) |
| **Expanded** | Every gauge led by its number, with reset times, the plan the account is on, the **active limit** badge, and `full in ~44 min` when the pace would exhaust a quota before it resets. | Park on the notch, the tray, or `⌘⇧U` |

On a display with no notch of its own, Limen draws one — and since that
rectangle is ours rather than a camera housing, it carries the plan
(`Max 20x`) between the two chips.

Colors follow headroom, not model: green below 50%, amber to 74%, orange to
89%, red beyond — a ramp that steps down in luminance as well as hue, so it
survives greyscale and colour blindness. Marks on each track show where your
alert thresholds sit and which you have crossed. A failed fetch never blanks
the display — the last real numbers stay, with the reason and the retry time
(`Anthropic throttled the check — retrying in 8 min`).

## Installing

Download the latest [release](https://github.com/bilalmbt/limen/releases/latest)
&mdash; `-arm64` for Apple Silicon, `-x64` for Intel &mdash; drag Limen to
Applications, and open it from there. Signed and notarized, so it opens
without a Gatekeeper detour.

**Open it from Applications, not from the disk image.** macOS runs a
quarantined app straight out of a `.dmg` from a randomized read-only path,
and from there Limen cannot reach your Keychain &mdash; it will report that
Claude Code is not signed in when it plainly is.

**The first read raises a Keychain prompt naming `security`, not Limen.**
That is Apple's own `/usr/bin/security`, which is how the token is read; the
prompt is asking on its behalf. Allow it once and it stays quiet. Limen sends
your token nowhere but `api.anthropic.com`, keeps no copy of it, and has no
analytics of any kind.

Requires Claude Code signed in, on macOS 11 or later.

An installed copy writes to `~/Library/Logs/Limen.log` &mdash; one line per
state change, which is the first thing to read when it does something
surprising. (`log show` will not have it: a Finder-launched app's stdout
reaches neither a terminal nor the unified log.)

## Configuration

`~/.config/limen/config.json` (Reveal it from the tray menu). A settings
directory left by the old name is moved here the first time the app runs:

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

## Building it yourself

Requires Node 18+ and Claude Code signed in (macOS Keychain), or a
`CLAUDE_CODE_OAUTH_TOKEN` environment variable.

```bash
npm install
npm test        # 202 tests, no Electron needed
npm start       # the island, on your notch (or top-center of a flat display)
npm run dist    # signed .dmg for both architectures (needs a Developer ID cert)
```

`npm run demo` opens it with fixture data, and `ISLAND_CAPTURE` renders one
state to a PNG. [DESIGN.md](DESIGN.md) has the rest: the motion, the notch
geometry, session priming, what the app sends, and what the tests cover.

## Known limits

- English only, and no settings window — the config file and the tray menu
  are it.
- Mouse-down collapse is approximated by the window level rather than a
  global event tap.
- No auto-updater yet.
- Burn rate needs ~10 minutes of samples before it says anything, and says
  nothing unless a quota would run out before its window resets.

## About

Made by [@billybowss](https://x.com/billybowss). The tray menu carries an
**About Limen** item — the standard macOS panel, with the version
and the credits — and a link to the same handle.

## License

MIT. An unofficial personal project, not affiliated with, endorsed by, or
supported by Anthropic. "Claude" is a trademark of Anthropic. Data layer
derived from [Claude-Marge-Widget](https://github.com/Ulrichfr/Claude-Marge-Widget)
(MIT, Ulrich Rozier) — see LICENSE.
