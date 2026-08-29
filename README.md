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
  10ml = 34 cm³`. A unit typed after a reference converts it (`[15 cm] mm → 150 mm`);
  incompatible dimensions (`kg + cm`) show a unit error. Supported: length (mm cm m km
  in ft yd mi), mass (mg g kg oz lb t), time (ms s min h d), volume (ml cl dl l gal).
- **Continue from the last answer.** Press an operator on an empty line and the previous
  result is pulled in automatically.
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

Each line is a token list (`number | operator | paren | reference`). References form a
cycle-free graph: an insertion that would close a loop is refused up front, and evaluation
resolves references recursively with memoization, so results are independent of document
order and lines can be reordered freely. Incomplete input is handled by evaluating the
longest valid prefix, so half-typed lines still show a live result.

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
coalescing, line deletion freezing/restoring references, and number formatting.
