# ubercal design

**Pop.** Fresh, young, loud colors on white. ubercal looks like a sticker sheet of calendars: chunky rounded type, saturated color blocks, crisp black outlines and hard offset shadows, with a dotted planner grid under everything. It is a Fluxkit tool by name only: it does not borrow Fluxkit's console look.

The idea is the merge: calendars run down their conduits into one point and come out as one share link. The three ways a link shows a calendar are the signature and look the same everywhere.

Two pages share one stylesheet, `web/static/site.css`: the public landing (`web/index.html`) and the signed-in app (`web/app.html` + `web/static/app.js`). Plain HTML, CSS and JavaScript, no build, no framework, nothing loaded from another origin except Google profile pictures.

## Themes

White first. Dark follows the system (`prefers-color-scheme`) unless the person picks one with the sun/moon switch in the bar, which is remembered in `localStorage` (`ubercal.theme`) and set as `data-theme` on `<html>` before the page paints.

| Token | Light | Dark | Use |
| --- | --- | --- | --- |
| `--ground` | `#fffaf0` | `#121117` | Page, with a dot grid in `--dots` |
| `--dots` | `#e9e1cf` | `#26242e` | The planner dots |
| `--surface` | `#ffffff` | `#1c1b23` | Cards, panels, inputs |
| `--surface-2` | `#fff4dc` | `#25232d` | Rows inside a card, the picker |
| `--ink` | `#121117` | `#f7f3ea` | Text, outlines, hard shadows |
| `--ink-2` | `#4a4752` | `#c9c4d6` | Sentences |
| `--ink-3` | `#7d7887` | `#8f899d` | Meta, placeholders |
| `--line` | `#121117` | `#f7f3ea` | Every outline (2px) |
| `--shadow` | `#121117` | `#f7f3ea` | Hard offset shadows |

The pop colors are the same in both themes:

| Token | Value | Use |
| --- | --- | --- |
| `--blue` | `#3a5bff` | Primary actions, links, the brand block of the wordmark |
| `--yellow` | `#ffd23f` | Highlights, the junction, the countdown block, Sign in |
| `--pink` | `#ff5ca8` | Second readout, "how it works" accents, warnings that are not errors |
| `--green` | `#19c27a` | Third readout, `ok`, copied |
| `--orange` | `#ff7a2f` | Calendar color |
| `--lilac` | `#a98bff` | Calendar color |
| `--red` | `#ff3b3b` | Errors and destructive hover only |

Text on a pop block is always `#121117`, in both themes. Calendar colors are data: a Google calendar keeps Google's color, a link takes `--cal-1`…`--cal-6` (blue, green, yellow, pink, orange, lilac) by its order.

The three ways a link shows a calendar:
- **full**: a solid block in the calendar's color, with an outline;
- **busy**: black 45° hatching on the surface (`--hatch`), labelled `busy`;
- **off**: a dashed outline and nothing inside.

## Type

Self-hosted in `web/static/fonts/` (OFL, licenses next to the files), Latin subset.

| Role | Face |
| --- | --- |
| Display: wordmark, headings, names, numbers, countdown | Unbounded, variable 400–900 |
| Text: sentences, buttons, inputs, meta | Figtree, variable 400–800 |

- Wordmark `ubercal`: Unbounded 900, lowercase, tight tracking; `cal` sits in a tilted blue block.
- Headings: Unbounded 800. Labels: Figtree 800, 12px, uppercase, letter-spacing .08em, inside a colored pill with an outline.
- Numbers (readouts, countdown): Unbounded 800, tabular.
- Body: Figtree 16px (15px in the app), weight 500 for sentences.

## Shape

- Outline 2px `--line` on every card, button, input and switch.
- Radius 14px for cards and panels, 12px for buttons and inputs, 999px for pills and chips.
- Hard shadow `4px 4px 0 var(--shadow)` (6px on big cards). A button lifts on hover (`translate(-2px, -2px)`, shadow 6px) and presses on click (`translate(2px, 2px)`, shadow 0).
- Nothing scrolls sideways at 1440, 1280, 1024, 768, 390 or 320. Touch targets at least 44px.

## Layout

**Landing.** Bar (`fluxkit / ubercal` left; how it works, Sign in, and the theme switch last, at the far right; on a phone the bar is one row and Sign in leaves it, since the hero has its own) → hero (left: `$ ubercal`, the wordmark, “Every calendar. One link.” with a yellow marker under “One link.”, the lede, Sign in with Google, the read-only line; right: the merge, three calendar cards running down black conduits into a yellow junction and out to the share-link card with its countdown) → three readout blocks (yellow `sync · min 05`, pink `calendars 25`, green `trackers 00`) → `01 how it works` (three cards with a colored top band) → `02 what it keeps` (rows with a colored tag each) → footer.

**App.** Bar (crumb, theme switch, the person's picture and email, sign out) → readout strip (blue next-read countdown, pink calendars, green share links) → two columns above 960px, one below: **calendars in** and **share links**, as in the content spec in README.

## Motion

- Landing: on load the hero rises in, staggered; light runs down each conduit into the junction and out along the share link; the junction breathes; the readouts count up once; the countdown ticks.
- Buttons lift and press. Calendar blocks in the merge wobble once on load.
- App: the countdown ticks every second; a calendar being read pulses its swatch; a copied link turns its button green for two seconds.
- `prefers-reduced-motion: reduce` turns all of it off.

## Words

English. Short sentences that say what happens. A calendar's state is `full`, `busy`, or `off`. The product never says "sync engine" or "integration"; it says reads, merges, shows.
