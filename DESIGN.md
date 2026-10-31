# ubercal design

ubercal is a Fluxkit tool, so it looks like one: the flux capacitor console of fluxkit.dev (black ground, Martian Mono everywhere, a white mark that carries light, segment-display readouts). Its own idea is the merge. The Fluxkit mark is three conduits meeting at one point; on ubercal the conduits are calendars and the point is where they become one link.

Two pages share one stylesheet, `web/static/site.css`: the public landing (`web/index.html`) and the signed-in app (`web/app.html` + `web/static/app.js`). Plain HTML, CSS and JavaScript, no build, no framework, nothing loaded from another origin except Google profile pictures.

## Color

| Token | Value | Use |
| --- | --- | --- |
| `--void` | `#000` | Page ground |
| `--panel` | `#07080a` | Cells, cards, the app's panels |
| `--panel-2` | `#0c0d10` | Inputs, rows inside a card |
| `--ink` | `#ececec` | Names, headings |
| `--ink-2` | `#a8a8a8` | Sentences |
| `--ink-3` | `#6b6b6b` | Labels, meta, placeholders |
| `--rule` | `#1d1f22` | Dividers, borders |
| `--rule-hi` | `#34373c` | Hover border, buttons |
| `--flux` | `#fff` | The mark, primary buttons, focus |
| `--tc-red` | `#ff3b2f` | Readouts; errors |
| `--tc-green` | `#2bff88` | Readouts; `ok`, copied |
| `--tc-amber` | `#ffb21e` | Readouts; the sync countdown; "syncing" |
| `--uber` | `#6fe3ff` | ubercal's own accent: the junction of the mark, the live link, the selected state of a calendar's switch |

Calendar colors are data, not decoration: a Google calendar keeps the color Google gives it; a link gets one from `--cal-1`…`--cal-6` (`#7aa2ff`, `#2bd9a6`, `#ffb21e`, `#ff7ab6`, `#b18cff`, `#ff8a4c`) by its order. They appear only on calendar blocks and the small swatch next to a calendar's name.

The three ways a link shows a calendar are the signature of the product and look the same everywhere:
- **full**: a solid block in the calendar's color;
- **busy**: the same block drawn as 45° hatching in `--ink-3` on `--panel-2`, labelled `busy`;
- **off**: only a dashed `--rule-hi` outline.

The ground is black with a faint radial bloom and the fixed grain overlay from fluxkit.dev (opacity .045, no pointer events).

## Type

Self-hosted in `web/static/fonts/` (OFL, licenses next to the files), the same files as fluxkit.dev.

| Role | Face |
| --- | --- |
| Everything | Martian Mono, variable width 75–112.5 and weight 100–800 |
| Readout digits (the countdown, counts) | DSEG7 Classic Bold, always over a ghost `88` |

- Wordmark `ubercal`: Martian Mono width 112.5, weight 800, lowercase, tight tracking.
- Section labels: 11px, uppercase, width 100, letter-spacing .14em, `--ink-3`, prefixed by an index (`01`).
- Names: width 112.5, weight 700. Sentences: width 87.5, weight 400, `--ink-2`. Body 14px.

## Layout

Measure `min(72rem, 100% - 2rem)`. Nothing scrolls sideways at 1440, 1280, 1024, 768, 390 or 320.

**Landing.** Bar (`fluxkit / ubercal` left, sign-in right) → hero (left: `$ ubercal`, the wordmark, “Every calendar. One link.”, the lede, Sign in with Google, the read-only line; right: the merge, a drawing of three calendars running down their conduits into the junction and out as one share link, with its countdown) → three readouts (`SYNC MIN 10` amber, `CALENDARS 25` red, `TRACKERS 00` green) → `01 how it works` (three cells: connect, choose, subscribe) → `02 what it keeps` (the privacy facts) → footer (fluxkit, privacy, terms, meaningtech).

**App.** Bar (crumb, the person's picture and email, sign out) → readout strip (next sync countdown, calendars, links) → two columns above 960px, one below: **calendars in** (each calendar: swatch, name, its kind and where it comes from, how the last read went, actions; then connect Google and paste a link) and **share links** (each link a card: name, the link with copy and subscribe, one row per calendar with its three-way switch, calendars added later, how far back, the last time a calendar app read it, new link, delete).

Cells and cards are square, 1px `--rule` border, `--panel` fill. Hover lifts a border to `--rule-hi`. No radius except avatars (round) and switches' focus ring. Buttons are 44px tall at least.

## Motion

- Landing: light runs down each conduit into the junction and out along the share link, staggered; the junction breathes; the readouts count up once; the hero rises in.
- App: the countdown ticks every second; a calendar being read shows an amber pulse on its swatch; a copied link turns its button green for two seconds.
- `prefers-reduced-motion: reduce` turns all of it off.

## Words

English. Short sentences that say what happens. A calendar's state is `full`, `busy`, or `off`. The product never says "sync engine" or "integration"; it says reads, merges, shows.
