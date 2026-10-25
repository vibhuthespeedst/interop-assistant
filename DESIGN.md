# Design

How Interop Mapper looks, why, and how to change it. Every visual value lives in [`web/tokens.css`](web/tokens.css): colours, fonts, sizes, spacing, corners and timing. [`web/style.css`](web/style.css) uses only those token names, so most design changes are a one-line edit in `tokens.css`.

## The idea

**A printed medical dictionary, set like an anatomy atlas.** Navy ink on warm paper. Book type (Literata) for words people read, and hyperlegible type (Atkinson Hyperlegible) for the interface and code. Colour appears only where it means something:

| Colour | Means |
|---|---|
| Red, `--artery` | A reference this record makes. Arteries carry blood away. |
| Blue, `--vein` | A reference this record receives. Veins carry it back. |
| Yellow highlighter, `--marker` | Read this first: a modifier field, or the letter you're on in the thumb index. |
| Green, amber and red (`--add`, `--chg`, `--del`) | Added, changed and removed. Used only on Compare. |

Everything else is ink at three strengths (`--ink`, `--ink-2`, `--ink-3`) on paper.

The app borrows the conventions of a real dictionary, and each one carries real data:

- **Headword with syllable marks.** `Medication·Request` shows where a name's parts join. The marks are drawn by CSS, so copying the word copies `MedicationRequest`.
- **Part of speech.** "*resource*, maturity 3 of 5", followed by a chip where a pronunciation would go: how a server addresses the resource (`[base]/MedicationRequest/[id]`).
- **History, in place of etymology.** One dot per version, R4 → R4B → R5, marked baseline, unchanged, *N changes* (a link to the comparison), new, or removed.
- **Running heads.** Each letter shows its first and last entry ("Account – AuditEvent"), like the guide words at the top of a printed page.
- **Thumb index.** On wide screens, cut tabs run down the page edge and the letter you're reading is highlighted. On narrow screens it becomes a strip under the header.
- **Entry of the day.** One well-established resource per day, the same for everyone, set as a slip beside the search.
- **Colophon.** The footer says where the definitions come from and what the app is set in.

## Where the inspiration came from

- **[Claude Code Frontend Design Toolkit](https://github.com/wilwaldon/Claude-Code-Frontend-Design-Toolkit).**
  - From its "one number controls the whole palette" token approach, colours are built in OKLCH from a few `--hue-*` numbers.
  - From the Editorial preset: serif headlines, a muted palette, rules as structure.
  - From Anthropic's frontend-design skill:
    - Choose a direction from the subject's own world (here, dictionaries and anatomy atlases) rather than a template.
    - Keep to a small named palette.
    - Let one motion moment carry the page.
    - Avoid gradient heroes, identical card grids and all-caps labels.
- **[Awwwards](https://www.awwwards.com/).** The Site of the Day pages set display type at poster scale, put metadata in small chips ("Site of the Day · Oct 25 · 7.24"), and leave a lot of air. The home question and the resource headwords now use display sizes up to 136px, and the REST address chip follows that metadata pattern.
- **[Dribbble](https://dribbble.com/search/dictionary).** Its dictionary and reference-app shots share a few traits: oversized serif headwords, paper or warm-neutral grounds, a single saturated accent (often yellow), and definitions set apart in their own blocks. That shaped the warm paper, the highlighter as the only bright colour, and the entry-of-the-day slip.

## How to change the design

| To change | Edit, in `web/tokens.css` |
|---|---|
| The ink colour (navy → green, plum…) | `--hue-ink` (0–360). Text, rules, headwords and the dark theme's paper all follow. |
| How warm the paper is | `--paper-chroma`: `0` is neutral grey, `0.03` is an old book. Re-tint it with `--hue-paper`. |
| The highlighter | `--hue-marker`: `96` is yellow, `150` green, `330` pink. |
| Reference colours | `--hue-artery` (outgoing) and `--hue-vein` (incoming). Keep them clearly apart. |
| A single colour in one theme | The token itself. `light-dark(A, B)` holds the light value A and the dark value B. |
| Size of the big type | `--text-hero` (the home question) and `--text-display` (headwords) |
| Body and small text | `--text-m` (body), `--text-s` and `--text-xs` |
| Fonts | `--font-display`, `--font-text` and `--font-code`. See "Swapping a font" below. |
| Spacing | `--space-1` … `--space-9` (a 4px grid) |
| Corners | `--radius-s/m/l/pill` |
| Page width and margins | `--max` and `--gutter`. Drawer width: `--drawer-w`. Thumb tabs: `--rail-w`. |
| The syllable mark | `--syllable-mark`: `"\00B7"` is a middle dot, `""` turns it off |
| Animation speed | `--dur-quick` (hovers), `--dur-draw` and `--stagger` (the leader lines on the anatomy plate) |

**After any change**, run `python src/export_web.py data/fhir.db web/data`. It re-hashes the app, so installed copies pick up the new design. Then run `python src/build_offline.py web dist/interop-mapper.html` so the one-file offline copy gets it too.

**Check contrast when you change a lightness or a hue.** Every text colour is at least 4.5:1 on the backgrounds it sits on, in both themes:

| Pair | Light | Dark |
|---|---|---|
| `--ink` on `--paper` | 14.0 | 15.9 |
| `--ink-2` on `--paper` | 8.2 | 11.1 |
| `--ink-3` on `--paper` | 5.3 | 7.3 |
| `--ink-3` on `--tint` (code backgrounds) | 4.9 | 6.2 |
| `--artery` on `--paper` | 6.1 | 7.6 |
| `--vein` on `--paper` | 6.5 | 9.0 |
| `--add`, `--chg` on `--paper` | 6.0, 5.2 | 10.5, 10.6 |
| `--ink` on `--marker` | 11.3 | 5.6 |

`--ink-3` on `--tint` has the least headroom. Avoid lightening `--ink-3` or darkening `--tint` in the light theme.

**Swapping a font:**

1. Put the `.woff2` file in `web/fonts/`.
2. Update its `@font-face` rule at the top of `style.css` and the matching `--font-*` token.
3. Replace the file name in the offline lists: `SHELL` in `web/sw.js`, and `shell` in `src/export_web.py`.

Keep one serif for reading and one sans for the interface; a third family is only for code.

**Adding a colour:** give it a meaning first, then a `--hue-*` or a token, and write the meaning in the table at the top of this file. A colour without a meaning shouldn't be added.

## Tokens

### Colour

| Token | Used for |
|---|---|
| `--paper` | Page background |
| `--sheet` | Raised surfaces: the search box, the field drawer, code, the entry-of-the-day slip |
| `--tint`, `--tint-2` | Code and JSON backgrounds, hovers, empty thumb tabs |
| `--rule` | Hairlines between entries and table rows |
| `--ink`, `--ink-2`, `--ink-3` | Text at three strengths: headings, body, notes. Solid `--ink` also fills the active tab, selected buttons and thumb tabs. |
| `--on-ink` | Text on solid ink |
| `--marker`, `--marker-soft` | Read-first highlights, the current thumb letter, the selected search result |
| `--artery`, `--vein` | Outgoing and incoming references: plate labels, JSON references, diagram lines |
| `--add`, `--chg`, `--del` | Compare counts and old/new values |
| `--shadow-color` | The field drawer's shadow, on resource pages only |

### Type

| Role | Family | Size token |
|---|---|---|
| Home question | Literata 600 | `--text-hero`, 44–100px |
| Headword | Literata 600, tracking `--tracking-display` | `--text-display`, 54–136px |
| Page title (Compare, Extensions) | Literata 600 | `--text-h2`, 38–64px |
| Section title | Literata 600 | `--text-h3`, 25–34px |
| First sentence of an entry | Literata 400 | `--text-lead`, 19–23px |
| Definitions, notes, "why" quotes | Literata, line height `--leading-serif` | 16–17px |
| Interface and body | Atkinson Hyperlegible Next | `--text-m`, 15.5px |
| Paths, JSON, code | Atkinson Hyperlegible Mono | `--text-s`, 13.5px (`--text-m` for paths in result lists) |

Display type sits at `--leading-tight` (0.98), so anything set below a headword needs the extra top margin `style.css` gives it, to clear descenders. Reading text stays under `--measure` (68ch).

### Space, shape, layout, motion

- **Space:** 4, 8, 12, 16, 24, 32, 48, 64 and 96px (`--space-1` to `--space-9`). Sections are set apart by 56–96px and a 2px ink rule.
- **Shape:**
  - Buttons, tabs, the version switch and chips are pills.
  - The search box, code blocks and the plate use `--radius-l`.
  - Hairlines are 1px (`--stroke`). Section rules and the selected-row bar are 2px (`--stroke-strong`).
- **Breakpoints:**
  - 600px: the header stops being sticky.
  - 640px: the A–Z drops to one column.
  - 860px: the tabs wrap under the brand.
  - 1000px: the field drawer docks beside the page.
  - 1100px: the hero gets its second column and the thumb index becomes the edge rail.
- **Motion:** one orchestrated moment, the leader lines drawing onto the anatomy plate the first time it's shown. Elsewhere, motion is limited to 140ms colour changes and the thumb tabs sliding out. With `prefers-reduced-motion`, all of it is off.

## Rules that keep it looking like itself

- Colour is information. Don't use red, blue or yellow decoratively.
- No gradients, glows or drop shadows. The only shadow is the drawer's, which shows it sits above the page.
- Labels are sentence case. No all-caps labels or eyebrow text.
- Rules and borders separate real things (entries, sections, table rows); they aren't decoration.
- Big type is for words people look up: the question, headwords, page titles. Everything else is reading size.
- Every interactive thing has a visible focus ring (3px `--ink`). The search box adds a highlighter halo.

## Browser support

`oklch()`, `light-dark()` and `color-mix()` need Chrome or Edge 123+, Safari 17.5+ or Firefox 120+. Older browsers show unstyled colours.

The theme button cycles Auto → Light → Dark. Its choice is stored in the browser, and [`web/theme.js`](web/theme.js) applies it before the page draws, so the wrong theme never flashes.
