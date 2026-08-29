# BioniCalc

A reactive calculator that runs entirely in the browser —
plain HTML/CSS/JS, no build step, no backend.

Open `index.html` directly, or serve the folder with any static server:

```sh
python3 -m http.server 8000
```

## How it works

Calculations form a flowing document instead of a single display:

- **Every line is live.** Type with your keyboard or the pad; the result updates as you type.
- **Results are values.** Tap any result to insert it into the line you're editing as a live
  reference (a colored chip). When the source changes, everything using it recalculates.
- **Everything is editable.** Tap any number anywhere in the history and retype it — all
  dependent results update on the fly.
- **Hover to trace.** Hovering a result highlights every reference to it across the
  document (and hovering a reference chip lights up its source), in the line's color.
- **Projects and sheets.** Tabs above the keypad are projects; tabs above the
  calculations are sheets within the current project ("drawers", "carcase", …). Every
  sheet is its own page with its own undo history. Both tab bars work the same way: tap
  to switch, tap the active tab to rename it, `+` to create, and the active tab's `×`
  (tap twice) to delete. Older storage formats migrate automatically.
- **Cross-sheet references.** Keep top-level parameters on a master sheet (label them:
  "width", "height"), then use the `ref` key next to "new line" on any other sheet — it
  lists every labeled result from the project's other sheets; tap one to insert it as a
  live chip (dashed outline). Editing the master updates every sheet that uses it. The
  whole project evaluates as one dependency graph, cycles are refused across sheets,
  and deleting a referenced line or sheet freezes its values into its dependents.
- **Summary rail.** On wide screens, the space under the project tabs shows every
  labeled result in the project, grouped by sheet, with live values in their chip
  colors — tap a row to insert that reference, hover to trace where it's used.
- **Export / import.** Export downloads every project as a JSON file (backup, or moving
  work between devices); import adds a file's projects as new tabs and never overwrites
  what's already there.
- **Units.** Add a unit after a value — type it, or tap it on the keypad's quick-unit
  row (the four most recently used units; "…" opens the full grouped list):
  `12cm + 30mm = 15 cm`. Mixed
  units of one dimension convert automatically (the left unit wins), unitless operands
  adopt the other side's unit, and `×`/`÷` compose and cancel: `2cm × 3cm = 6 cm²`,
  `100km / 2h = 50 km/h`, `1m / 50cm = 2`. Volumes are length³, so `2cm × 3cm × 4cm +
  10ml = 34 cm³`. Powers work as suffixes — `5m2` is five square meters, and tapping the
  same unit key again cycles cm → cm² → cm³. A unit typed after a reference converts it
  (`[15 cm] mm → 150 mm`, `[4,224 mm²] cm2 → 42.24 cm²`);
  incompatible dimensions (`kg + cm`) show a unit error. Supported: length (mm cm m km
  in ft yd mi), mass (mg g kg oz lb t), time (ms s min h d), volume (ml cl dl l gal).
- **Component blanks.** Tap `blank` (or type `b`) to turn the current empty line into a
  component: width × height × thickness × qty, each box a full calculation of its own.
  Boxes can reference other lines (`[carcase width] − 2 × 18mm`), so a parts list stays
  live as the design changes. Unitless dimensions adopt a sibling's unit (`600mm × 45 ×
  19` means mm throughout), quantity must be a bare number, and ⏎/Tab hop to the next
  box — landing on a box with a single value pre-selects it for overwriting, and ⏎ from
  qty starts the next blank. A blank's own value is its total volume (w·h·t·qty), so
  referencing or summing blanks gives material estimates; the resolved dimensions show
  in the result column.
- **The Cuts page.** Every project carries a pinned **🪚 Cuts** tab at the end of its
  sheet bar — the cut-planning page. Its lines are your **stock** on hand (materials use
  the same width × height × thickness × qty boxes as blanks, references included), and
  every blank on the project's other sheets queues up below as **parts to cut**, grouped
  by thickness — thinnest first, `1.9cm` folds into the 19 mm group — with each group
  matched against the stock: `✓ birch ply`, or a red `✗ no stock this thickness`. Volume
  totals and a parts/stock percentage sit at the bottom. Drag material lines to set which
  stock gets used first.
- **Grain direction.** Every blank and material has a small `grain` chip: tap to cycle
  don't care → **↔ along width** → **↕ along height**. A grain-set part is only ever
  rotated to *align* with grain-set stock; on stock without grain it keeps its authored
  orientation, and only don't-care parts rotate freely. Grain shows as faint strokes in
  the layout diagrams.
- **Cut layouts.** Each matched thickness group is planned onto its stock: a shelf-based
  guillotine layout (rip strips, then crosscut) with the **saw kerf** — settable on the
  panel, per project, default 3 mm — consumed between neighbouring pieces as real
  geometry. The planner searches candidate layouts (each part type facing either way,
  same-height-only strips vs. mixed) and keeps the winner by fewest unplaced pieces,
  fewest sheets, **fewest saw cuts**, shortest packed height — so identical parts end up
  side by side in uniform strips. Layouts render as to-scale SVG diagrams per stock
  sheet with utilization and cut count; pieces that fit nowhere are called out in red.
- **Cut list.** Under each diagram, a collapsible numbered list of the actual saw work:
  rip the strips off top to bottom, crosscut each strip left to right (identical cuts
  grouped into one step: `crosscut 900 mm × 2`), then any trims. Every printed dimension
  is a finished dimension — set the fence to the number and the kerf falls on the waste
  side. The list ends with the yield: the finished parts, and every keepable offcut with
  its dimensions (strip tails, trim cutoffs, and the remainder below the last strip,
  each less the kerf; slivers under 1 mm are dropped).
- **Labels.** Hover a line and click "label" to name it ("subtotal", "VAT"). The label is
  shown next to the result and inside every reference chip that uses it, so downstream
  lines read like `[subtotal] × 0.25`. Click a label to edit it; clear it to remove it.
- **Undo/redo.** ⌘Z / Ctrl+Z and ⇧⌘Z / Ctrl+Y (also buttons in the header). Typing runs
  coalesce into single steps; deleting lines and "Clear all" are fully undoable.
- **Reordering.** Drag the ⠿ handle (hover the left edge of a line) or press ⌥↑ / ⌥↓ to
  move the active line. References stay live wherever lines sit — results can be
  referenced upward or downward; only circular references are refused.
- ⏎ starts a new calculation. `%` divides by 100 (postfix). Deleting a line freezes any
  references to it into plain numbers so nothing downstream breaks (undo restores the
  live reference).
- State is saved in `localStorage`, so your document survives reloads.

## Architecture

Each line is a token list (`number | operator | paren | unit | reference`). References
form a cycle-free graph: an insertion that would close a loop is refused up front, and
evaluation resolves references recursively with memoization, so results are independent
of document order and lines can be reordered freely. Incomplete input is handled by
evaluating the longest valid prefix, so half-typed lines still show a live result.
A component line carries four small token lists instead of one (width, height,
thickness, quantity), each evaluated the same way; its own value is the product.

The Cuts page is a pinned sheet (`kind: 'cuts'`) whose lines are materials. Planning is
two pure functions: `planCuts` searches shelf-guillotine layouts (orientation
assignments × strip disciplines, scored by unplaced / sheets / cut count / packed
height) and `cutList` turns a placed sheet into ordered saw steps whose counts sum to
the sheet's cut count. Both run live on every edit.

| File | Role |
| --- | --- |
| `index.html` | Layout and keypad |
| `style.css` | Theming (light/dark via `prefers-color-scheme`), responsive layout |
| `app.js` | Token model, evaluator, editing/caret logic, rendering, persistence |
| `test.js` | Headless test suite (see below) |

## Tests

```sh
node test.js
```

No dependencies — the suite stubs the DOM, loads the real `app.js`, and drives the actual
input handlers: arithmetic and precedence, live reference propagation, reordering with
forward references, cycle rejection (and non-termination defense), labels, undo/redo
coalescing, line deletion freezing/restoring references, units and powered suffixes,
component blanks (entry flow, unit adoption, volume references, freezing, import),
projects/sheets/cross-sheet references, storage migration, number formatting, and the
Cuts page: thickness grouping and stock matching, kerf, grain rules, layout
optimization (uniform strips, forced rotation, overflow, stock order), and cut-list
generation.

## License & author

© 2026 [@bionicbeagle](https://github.com/bionicbeagle)
