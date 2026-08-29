'use strict';

/*
 * BioniCalc — a reactive calculator.
 *
 * Every calculation is a line of tokens:
 *   { t:'n', v:'12.5' }   number (kept as the typed string)
 *   { t:'o', v:'+' }      operator: + - * / %  (% is postfix "divide by 100")
 *   { t:'p', v:'(' }      parenthesis
 *   { t:'r', ref:id }     live reference to another line's result
 *
 * References form a cycle-free graph: inserting one that would close a loop
 * is rejected up front (see dependsOn), so lines may reference results above
 * OR below and can be freely reordered. Evaluation resolves references
 * recursively with memoization; any edit re-evaluates everything, which is
 * what makes dependent results update on the fly.
 */

const PALETTE = [
  '#e0533d', '#3d7de0', '#2ba24c', '#a63de0',
  '#e0913d', '#12a5b5', '#d63d8e', '#7a6bf0',
];
const STORE_KEY = 'bionicalc.v1';
const MAX_DIGITS = 15;

/*
 * Units. Values are evaluated as { si, dim, unit }: the magnitude in SI base
 * units, a dimension exponent map (L = length, M = mass, T = time), and the
 * display unit as a symbol→exponent map. A unit token acts as a postfix
 * operator: it stamps a unitless value, or converts a value of the same
 * dimension. Volumes carry dimension L³, so cm×cm×cm and ml are compatible.
 */
const UNITS = {
  // length (SI metre)
  mm: { dim: { L: 1 }, factor: 0.001 },
  cm: { dim: { L: 1 }, factor: 0.01 },
  m:  { dim: { L: 1 }, factor: 1 },
  km: { dim: { L: 1 }, factor: 1000 },
  in: { dim: { L: 1 }, factor: 0.0254 },
  ft: { dim: { L: 1 }, factor: 0.3048 },
  yd: { dim: { L: 1 }, factor: 0.9144 },
  mi: { dim: { L: 1 }, factor: 1609.344 },
  // mass (SI kilogram)
  mg: { dim: { M: 1 }, factor: 1e-6 },
  g:  { dim: { M: 1 }, factor: 0.001 },
  kg: { dim: { M: 1 }, factor: 1 },
  oz: { dim: { M: 1 }, factor: 0.028349523125 },
  lb: { dim: { M: 1 }, factor: 0.45359237 },
  t:  { dim: { M: 1 }, factor: 1000 },
  // time (SI second)
  ms: { dim: { T: 1 }, factor: 0.001 },
  s:  { dim: { T: 1 }, factor: 1 },
  min: { dim: { T: 1 }, factor: 60 },
  h:  { dim: { T: 1 }, factor: 3600 },
  d:  { dim: { T: 1 }, factor: 86400 },
  // volume (L³)
  ml: { dim: { L: 3 }, factor: 1e-6 },
  cl: { dim: { L: 3 }, factor: 1e-5 },
  dl: { dim: { L: 3 }, factor: 1e-4 },
  l:  { dim: { L: 3 }, factor: 1e-3 },
  gal: { dim: { L: 3 }, factor: 0.003785411784 },
};
const UNIT_NAMES = Object.keys(UNITS);
const isUnitPrefix = (s) => UNIT_NAMES.some((n) => n.startsWith(s));

// A unit token's text may carry a power: "cm2" is cm², "mm3" is mm³.
function parseUnitTok(v) {
  const m = /^([a-z]+)([23])?$/.exec(v);
  return m ? { sym: m[1], e: m[2] ? Number(m[2]) : 1 } : { sym: v, e: 1 };
}

const fmtUnitTok = (v) => v.replace(/2$/, '²').replace(/3$/, '³');

function scaleDim(dim, e) {
  if (e === 1) return { ...dim };
  const out = {};
  for (const [k, x] of Object.entries(dim)) out[k] = x * e;
  return out;
}

const state = {
  lines: [],      // [{ id, tokens: [...] }]
  activeId: null,
  caret: 0,       // token index within the active line (between tokens)
  sel: null,      // { idx } — number/ref token in the active line, selected for retyping
  colors: {},     // lineId -> palette index, assigned when a line is first referenced
  nextId: 1,
  nextColor: 0,
};

let results = new Map();     // current sheet: lineId -> { v } | { err } | null
let projResults = new Map(); // whole project: "sheetId:lineId" -> same entries
let prevFmt = new Map();     // lineId -> last displayed result, to flash changes

/*
 * Projects and sheets: a project (tabs above the keypad) holds one or more
 * sheets (tabs above the calculations) — e.g. "drawers" and "carcase" inside
 * a "Bench" project. A SHEET is the document: `state` always holds the
 * current sheet of the current project (adoptSheet swaps it in by
 * reference), and each sheet keeps its own undo/redo stacks, rebound on
 * switch. References never cross sheets.
 */
let projects = [];          // [{id, name, sheets, currentSheetId, nextSheetId}]
let currentProjectId = null;
let nextProjectId = 1;
const histories = new Map(); // "projectId:sheetId" -> {undo, redo}

let undoStack = [];         // the CURRENT sheet's stacks (see adoptSheet)
let redoStack = [];
const HISTORY_MAX = 200;
let lastKind = null;      // 'digit' | 'backspace' | null — for coalescing typing runs
let lastKindLine = null;

let labelEditId = null;   // line whose label is being edited (transient)
let labelEditSnap = null; // snapshot from when that edit started

// Most-recently-used units shown on the keypad's quick row. A preference,
// not document state: persisted, but deliberately outside undo snapshots.
let quickUnits = ['mm', 'cm', 'm', 'in'];

function promoteQuickUnit(sym) {
  quickUnits = [sym, ...quickUnits.filter((s) => s !== sym)].slice(0, 4);
}

const activeLine = () => state.lines.find((l) => l.id === state.activeId);
const activeIndex = () => state.lines.findIndex((l) => l.id === state.activeId);

// Tokens that can end an operand — a binary operator may follow these.
const isValue = (t) =>
  !!t && (t.t === 'n' || t.t === 'r' || t.t === 'u' ||
    (t.t === 'p' && t.v === ')') || (t.t === 'o' && t.v === '%'));

/* ================= evaluation ================= */

// While a line is being typed it is usually incomplete ("12 +", "(5 * 3").
// Strip dangling operators / open parens and close unbalanced parens so the
// longest meaningful prefix still shows a live result.
function cleanTokens(tokens) {
  const t = tokens.slice();
  for (;;) {
    const last = t[t.length - 1];
    if (last && ((last.t === 'o' && last.v !== '%') || (last.t === 'p' && last.v === '('))) t.pop();
    else break;
  }
  let depth = 0;
  for (const tok of t) if (tok.t === 'p') depth += tok.v === '(' ? 1 : -1;
  while (depth-- > 0) t.push({ t: 'p', v: ')' });
  return t;
}

/* ---- unit algebra ---- */

const UNIT_ERR = new Error('unit-mismatch');
const dimless = (d) => Object.keys(d).length === 0;

function sameDim(a, b) {
  for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if ((a[k] || 0) !== (b[k] || 0)) return false;
  }
  return true;
}

function addDims(a, b, s) {
  const out = { ...a };
  for (const [k, e] of Object.entries(b)) {
    out[k] = (out[k] || 0) + s * e;
    if (!out[k]) delete out[k];
  }
  return out;
}

// Combined SI factor of a display unit, e.g. { km:1, h:-1 } -> 1000/3600.
function unitFactor(unit) {
  let f = 1;
  for (const [sym, e] of Object.entries(unit)) f *= UNITS[sym].factor ** e;
  return f;
}

// Merge display units for × and ÷. A symbol of a dimension the left side
// already shows folds onto the left symbol (m × cm stays in m), so same-
// dimension units cancel: 1m / 50cm -> plain 2.
function composeUnits(a, b, s) {
  const out = { ...a };
  for (const [sym, e] of Object.entries(b)) {
    let key = sym;
    if (!(key in out)) {
      key = Object.keys(out).find((k) => sameDim(UNITS[k].dim, UNITS[sym].dim)) || sym;
    }
    out[key] = (out[key] || 0) + s * e;
    if (!out[key]) delete out[key];
  }
  return out;
}

// Postfix unit: stamp a unitless value, or re-express a same-dimension one.
// Handles powered tokens ("cm2", "mm3") — so 44mm × 96mm followed by cm2
// converts the area, and 5 m2 enters five square meters.
function applyUnit(v, tokV) {
  const { sym, e } = parseUnitTok(tokV);
  const u = UNITS[sym];
  if (!u) return v; // half-typed unit ("c" on the way to "cm") — ignore for now
  const dim = scaleDim(u.dim, e);
  if (dimless(v.dim)) return { si: v.si * u.factor ** e, dim, unit: { [sym]: e } };
  if (sameDim(v.dim, dim)) return { ...v, unit: { [sym]: e } };
  throw UNIT_ERR;
}

function parseTokens(tokens, resolve) {
  let i = 0;
  const fail = () => { throw new Error('parse'); };

  function expr() {
    let v = term();
    while (i < tokens.length && tokens[i].t === 'o' && (tokens[i].v === '+' || tokens[i].v === '-')) {
      const op = tokens[i++].v;
      v = addSub(v, term(), op === '+' ? 1 : -1);
    }
    return v;
  }

  // A unitless operand adopts the other side's unit (10cm + 5 = 15 cm);
  // otherwise dimensions must match, and the left display unit wins.
  function addSub(a, b, sign) {
    if (dimless(a.dim) && !dimless(b.dim)) {
      a = { si: a.si * unitFactor(b.unit), dim: b.dim, unit: b.unit };
    } else if (!dimless(a.dim) && dimless(b.dim)) {
      b = { si: b.si * unitFactor(a.unit), dim: a.dim, unit: a.unit };
    }
    if (!sameDim(a.dim, b.dim)) throw UNIT_ERR;
    return { si: a.si + sign * b.si, dim: a.dim, unit: Object.keys(a.unit).length ? a.unit : b.unit };
  }

  function term() {
    let v = factor();
    while (i < tokens.length && tokens[i].t === 'o' && (tokens[i].v === '*' || tokens[i].v === '/')) {
      const op = tokens[i++].v;
      const r = factor();
      const s = op === '*' ? 1 : -1;
      v = {
        si: op === '*' ? v.si * r.si : v.si / r.si,
        dim: addDims(v.dim, r.dim, s),
        unit: composeUnits(v.unit, r.unit, s),
      };
    }
    return v;
  }

  function factor() {
    let neg = false;
    while (i < tokens.length && tokens[i].t === 'o' && tokens[i].v === '-') { neg = !neg; i++; }
    let v = primary();
    for (;;) {
      const tk = tokens[i];
      if (tk && tk.t === 'o' && tk.v === '%') { v = { ...v, si: v.si / 100 }; i++; }
      else if (tk && tk.t === 'u') { v = applyUnit(v, tk.v); i++; }
      else break;
    }
    return neg ? { ...v, si: -v.si } : v;
  }

  function primary() {
    const tok = tokens[i];
    if (!tok) fail();
    if (tok.t === 'n') {
      i++;
      const n = parseFloat(tok.v);
      return { si: isNaN(n) ? 0 : n, dim: {}, unit: {} };
    }
    if (tok.t === 'r') {
      i++;
      const r = resolve(tok);
      if (!r || r.err) fail();
      return { si: r.si, dim: r.dim, unit: r.unit };
    }
    if (tok.t === 'p' && tok.v === '(') {
      i++;
      const v = expr();
      if (i < tokens.length && tokens[i].t === 'p' && tokens[i].v === ')') i++;
      else fail();
      return v;
    }
    fail();
  }

  const v = expr();
  if (i < tokens.length) fail();
  return v;
}

// The whole PROJECT is evaluated as one dependency graph, not in document
// order: references resolve recursively (memoized), within a sheet by line
// id and across sheets via {sheet, ref} tokens. Reordering lines or sheets
// never changes any result, and editing a "master" sheet's parameter updates
// every sheet that references it. A cycle — impossible through the UI, but
// possible via hand-edited storage — bottoms out as an error.
function evaluateAll() {
  syncCurrentSheet();
  const p = currentProject();
  const sheets = p ? p.sheets : [];
  projResults = new Map();
  const visiting = new Set();

  const lineOf = (sid, lid) => {
    const s = sheets.find((x) => x.id === sid);
    return s && s.lines.find((l) => l.id === lid);
  };

  function evalLine(sid, lid) {
    const key = sid + ':' + lid;
    if (projResults.has(key)) return projResults.get(key);
    if (visiting.has(key)) return { err: '—' };
    const line = lineOf(sid, lid);
    if (!line) return { err: '—' };
    visiting.add(key);
    let r;
    const t = cleanTokens(line.tokens);
    if (!t.length) r = null;
    else {
      try {
        const V = parseTokens(t, (tok) =>
          evalLine(tok.sheet !== undefined ? tok.sheet : sid, tok.ref));
        // r.v is the magnitude in the display unit (equals si when unitless).
        r = isFinite(V.si)
          ? { v: V.si / unitFactor(V.unit), si: V.si, dim: V.dim, unit: V.unit }
          : { err: 'Error' };
      } catch (e) {
        r = { err: e === UNIT_ERR ? 'unit error' : '—' };
      }
    }
    visiting.delete(key);
    projResults.set(key, r);
    return r;
  }

  for (const s of sheets) for (const l of s.lines) evalLine(s.id, l.id);

  // The current sheet's view, keyed by plain line id — what render, tests,
  // and same-sheet operations consume.
  const view = new Map();
  const csId = p ? p.currentSheetId : null;
  for (const l of state.lines) {
    const r = projResults.get(csId + ':' + l.id);
    view.set(l.id, r === undefined ? null : r);
  }
  return view;
}

// Does line (aSheetId, aLineId) transitively depend on line (bSheetId,
// bLineId)? Used to refuse reference insertions that would close a cycle,
// across sheets included.
function dependsOn(aSheetId, aLineId, bSheetId, bLineId) {
  const p = currentProject();
  if (!p) return false;
  const seen = new Set();
  const walk = (sid, lid) => {
    if (sid === bSheetId && lid === bLineId) return true;
    const key = sid + ':' + lid;
    if (seen.has(key)) return false;
    seen.add(key);
    const s = p.sheets.find((x) => x.id === sid);
    const line = s && s.lines.find((l) => l.id === lid);
    return !!line && line.tokens.some((t) =>
      t.t === 'r' && walk(t.sheet !== undefined ? t.sheet : sid, t.ref));
  };
  return walk(aSheetId, aLineId);
}

/* ================= formatting ================= */

function fmt(v) {
  if (!isFinite(v)) return 'Error';
  const n = Number(v.toPrecision(12));
  const a = Math.abs(n);
  let s;
  if (a !== 0 && (a >= 1e15 || a < 1e-9)) s = n.toExponential(6).replace(/\.?0+e/, 'e');
  else s = n.toLocaleString('en-US', { maximumFractionDigits: 10 });
  return s.replace('-', '−');
}

// "km/h", "cm²", "kg·m/s²" — positive exponents, then a slash for negatives.
function fmtUnit(unit) {
  const sup = (e) => (e === 1 ? '' : e === 2 ? '²' : e === 3 ? '³' : '^' + e);
  const pos = [];
  const neg = [];
  for (const [sym, e] of Object.entries(unit)) {
    (e > 0 ? pos : neg).push(sym + sup(Math.abs(e)));
  }
  let s = pos.join('·');
  if (neg.length) s = (s || '1') + '/' + neg.join('·');
  return s;
}

// Full display of a result entry: magnitude plus unit ("15 cm").
function fmtVal(r) {
  const u = fmtUnit(r.unit);
  return fmt(r.v) + (u ? ' ' + u : '');
}

// Display a number token as typed, with thousands grouping.
function fmtNum(raw) {
  const neg = raw.startsWith('-');
  const s = neg ? raw.slice(1) : raw;
  const [int, dec] = s.split('.');
  const gi = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (neg ? '−' : '') + gi + (s.includes('.') ? '.' + (dec || '') : '');
}

/* ================= editing ================= */

function insertToken(tok) {
  activeLine().tokens.splice(state.caret++, 0, tok);
}

function deselect() {
  if (state.sel) { state.caret = state.sel.idx + 1; state.sel = null; }
}

// Merge two adjacent number tokens (arises after deleting the operator between them).
function mergeAt(line, i) {
  const a = line.tokens[i - 1];
  const b = line.tokens[i];
  if (a && b && a.t === 'n' && b.t === 'n') {
    a.v += a.v.includes('.') ? b.v.replace('.', '') : b.v;
    line.tokens.splice(i, 1);
  }
}

function inputDigit(d) {
  const line = activeLine();
  if (state.sel) {
    // A selected number/ref is replaced wholesale, like selected text.
    line.tokens[state.sel.idx] = { t: 'n', v: d === '.' ? '0.' : d };
    state.caret = state.sel.idx + 1;
    state.sel = null;
    return;
  }
  const prev = line.tokens[state.caret - 1];
  // A 2 or 3 right after a complete unit binds as its power: "cm2" is cm².
  if (prev && prev.t === 'u' && (d === '2' || d === '3') && UNITS[prev.v]) {
    prev.v += d;
    return;
  }
  if (prev && prev.t === 'n') {
    if (d === '.') { if (!prev.v.includes('.')) prev.v += '.'; }
    else if (prev.v === '0') prev.v = d;
    else if (prev.v.replace(/\D/g, '').length < MAX_DIGITS) prev.v += d;
    return;
  }
  if (isValue(prev)) insertToken({ t: 'o', v: '*' });
  const next = line.tokens[state.caret];
  if (next && next.t === 'n' && !(d === '.' && next.v.includes('.'))) {
    next.v = (d === '.' ? '0.' : d) + next.v;
    state.caret++;
    return;
  }
  insertToken({ t: 'n', v: d === '.' ? '0.' : d });
}

function inputOp(op) {
  deselect();
  const line = activeLine();
  const prev = line.tokens[state.caret - 1];
  if (!prev) {
    if (op === '-') { insertToken({ t: 'o', v: '-' }); return; }
    // Operator on an empty line continues from the nearest result above.
    if (line.tokens.length === 0 && autoRef()) insertToken({ t: 'o', v: op });
    return;
  }
  if (prev.t === 'o' && prev.v !== '%') {
    if (op === '-' && (prev.v === '*' || prev.v === '/')) insertToken({ t: 'o', v: '-' });
    else prev.v = op;
    return;
  }
  if (prev.t === 'p' && prev.v === '(') {
    if (op === '-') insertToken({ t: 'o', v: '-' });
    return;
  }
  insertToken({ t: 'o', v: op });
}

// Tap a unit key: insert a whole unit token, or swap the one already there
// (tapping cm then mm should correct the unit, not concatenate letters).
// Tapping the SAME unit again cycles its power: cm → cm² → cm³ → cm.
function inputUnit(sym) {
  const line = activeLine();
  if (state.sel) { state.caret = state.sel.idx + 1; state.sel = null; }
  const prev = line.tokens[state.caret - 1];
  if (prev && prev.t === 'u') {
    const cur = parseUnitTok(prev.v);
    if (cur.sym === sym) prev.v = sym + (cur.e === 1 ? '2' : cur.e === 2 ? '3' : '');
    else prev.v = sym;
    return;
  }
  if (isValue(prev)) insertToken({ t: 'u', v: sym });
}

// Letters typed after a value build a unit token, validated live: a letter
// is accepted only while the string remains a prefix of some known unit.
function inputUnitLetter(ch) {
  const line = activeLine();
  if (state.sel) { state.caret = state.sel.idx + 1; state.sel = null; }
  const prev = line.tokens[state.caret - 1];
  if (prev && prev.t === 'u') {
    const nv = prev.v + ch;
    if (isUnitPrefix(nv)) prev.v = nv;
    return;
  }
  if (isValue(prev) && isUnitPrefix(ch)) insertToken({ t: 'u', v: ch });
}

function inputPercent() {
  deselect();
  if (isValue(activeLine().tokens[state.caret - 1])) insertToken({ t: 'o', v: '%' });
}

function inputParen(p) {
  deselect();
  const line = activeLine();
  const prev = line.tokens[state.caret - 1];
  if (p === '(') {
    if (isValue(prev)) insertToken({ t: 'o', v: '*' });
    insertToken({ t: 'p', v: '(' });
  } else {
    let depth = 0;
    for (let i = 0; i < state.caret; i++) {
      const t = line.tokens[i];
      if (t.t === 'p') depth += t.v === '(' ? 1 : -1;
    }
    if (depth > 0 && isValue(prev)) insertToken({ t: 'p', v: ')' });
  }
}

function backspace() {
  const line = activeLine();
  if (state.sel) {
    line.tokens.splice(state.sel.idx, 1);
    state.caret = state.sel.idx;
    state.sel = null;
    mergeAt(line, state.caret);
    return;
  }
  if (state.caret === 0) {
    const idx = activeIndex();
    if (idx > 0) {
      if (line.tokens.length === 0) removeLine(line.id);
      else {
        state.activeId = state.lines[idx - 1].id;
        state.caret = state.lines[idx - 1].tokens.length;
      }
    }
    return;
  }
  const prev = line.tokens[state.caret - 1];
  if ((prev.t === 'n' || prev.t === 'u') && prev.v.length > 1) prev.v = prev.v.slice(0, -1);
  else {
    line.tokens.splice(--state.caret, 1);
    mergeAt(line, state.caret);
  }
}

function newLine() {
  const line = activeLine();
  if (line.tokens.length === 0) return;
  const nl = { id: state.nextId++, tokens: [] };
  state.lines.splice(activeIndex() + 1, 0, nl);
  state.activeId = nl.id;
  state.caret = 0;
  state.sel = null;
}

function ensureColor(id) {
  if (state.colors[id] === undefined) {
    state.colors[id] = state.nextColor++ % PALETTE.length;
  }
}

function autoRef() {
  const idx = activeIndex();
  for (let i = idx - 1; i >= 0; i--) {
    const r = results.get(state.lines[i].id);
    if (r && !r.err) {
      ensureColor(state.lines[i].id);
      insertToken({ t: 'r', ref: state.lines[i].id });
      return true;
    }
  }
  return false;
}

function insertRefFrom(srcId) {
  const csId = currentProject().currentSheetId;
  if (srcId === state.activeId) { toast("A calculation can't use its own result"); return; }
  if (dependsOn(csId, srcId, csId, state.activeId)) { toast('That would create a circular reference'); return; }
  const r = results.get(srcId);
  if (!r || r.err) { toast('That line has no result yet'); return; }

  const before = snapshot();
  const line = activeLine();
  ensureColor(srcId);
  if (state.sel) {
    line.tokens[state.sel.idx] = { t: 'r', ref: srcId };
    state.caret = state.sel.idx + 1;
    state.sel = null;
  } else {
    if (isValue(line.tokens[state.caret - 1])) insertToken({ t: 'o', v: '*' });
    insertToken({ t: 'r', ref: srcId });
  }
  commitHistory(before, null);
  update();
}

function plainNum(v) {
  return String(Number(v.toPrecision(12)));
}

function ensureColorOn(sheet, lineId) {
  const cs = currentSheet();
  if (cs && sheet.id === cs.id) {
    ensureColor(lineId);
    return;
  }
  if (sheet.colors[lineId] === undefined) {
    sheet.colors[lineId] = sheet.nextColor++ % PALETTE.length;
  }
}

// Insert a live reference to a line on ANOTHER sheet of this project.
function insertCrossRef(sheetId, lineId) {
  const p = currentProject();
  const src = p && p.sheets.find((s) => s.id === sheetId);
  if (!src) return;
  if (sheetId === p.currentSheetId) { insertRefFrom(lineId); return; }
  const entry = projResults.get(sheetId + ':' + lineId);
  if (!entry || entry.err) { toast('That line has no result yet'); return; }
  if (dependsOn(sheetId, lineId, p.currentSheetId, state.activeId)) {
    toast('That would create a circular reference');
    return;
  }
  const before = snapshot();
  const line = activeLine();
  ensureColorOn(src, lineId);
  const tok = { t: 'r', ref: lineId, sheet: sheetId };
  if (state.sel) {
    line.tokens[state.sel.idx] = tok;
    state.caret = state.sel.idx + 1;
    state.sel = null;
  } else {
    if (isValue(line.tokens[state.caret - 1])) insertToken({ t: 'o', v: '*' });
    insertToken(tok);
  }
  commitHistory(before, null);
  update();
}

// Literal tokens standing in for a result: number + unit token for a simple
// unit, the SI magnitude for a compound one (no single unit token exists).
function frozenTokensFor(r) {
  if (!r || r.err) return [{ t: 'n', v: '0' }];
  const syms = Object.entries(r.unit);
  if (!syms.length) return [{ t: 'n', v: plainNum(r.v) }];
  if (syms.length === 1 && syms[0][1] >= 1 && syms[0][1] <= 3) {
    const [sym, e] = syms[0];
    return [{ t: 'n', v: plainNum(r.v) }, { t: 'u', v: sym + (e === 1 ? '' : e) }];
  }
  return [{ t: 'n', v: plainNum(r.si) }];
}

function removeLine(id) {
  const idx = state.lines.findIndex((l) => l.id === id);
  if (idx < 0) return;
  // Freeze references to this line — in this sheet and in any other sheet of
  // the project that references it — so dependents keep working.
  const p = currentProject();
  const cs = currentSheet();
  const frozen = frozenTokensFor(results.get(id));
  for (const s of (p ? p.sheets : [])) {
    for (const line of s.lines) {
      line.tokens = line.tokens.flatMap((t) =>
        t.t === 'r' && t.ref === id
          && ((t.sheet === undefined && s.id === cs.id) || t.sheet === cs.id)
          ? frozen.map((f) => ({ ...f }))
          : t);
    }
  }
  state.lines.splice(idx, 1);
  delete state.colors[id];
  if (!state.lines.length) state.lines.push({ id: state.nextId++, tokens: [] });
  if (state.activeId === id) {
    const n = state.lines[Math.max(0, idx - 1)];
    state.activeId = n.id;
    state.caret = n.tokens.length;
  } else {
    state.caret = Math.min(state.caret, activeLine().tokens.length);
  }
  state.sel = null;
}

function moveLR(d) {
  if (state.sel) {
    state.caret = d < 0 ? state.sel.idx : state.sel.idx + 1;
    state.sel = null;
    return;
  }
  const len = activeLine().tokens.length;
  state.caret = Math.max(0, Math.min(len, state.caret + d));
}

function moveUD(d) {
  const ni = activeIndex() + d;
  if (ni < 0 || ni >= state.lines.length) return;
  state.activeId = state.lines[ni].id;
  state.caret = state.lines[ni].tokens.length;
  state.sel = null;
}

// Move the active line up/down one slot. Results never change — evaluation
// is order-independent. Consecutive moves coalesce into one undo step.
function moveLine(d) {
  const idx = activeIndex();
  const ni = idx + d;
  if (ni < 0 || ni >= state.lines.length) return;
  commitLabelEditFromDom();
  const before = snapshot();
  const [line] = state.lines.splice(idx, 1);
  state.lines.splice(ni, 0, line);
  commitHistory(before, 'move');
  update();
}

/* ================= undo / redo ================= */

const clone = (x) => JSON.parse(JSON.stringify(x));

function snapshot() {
  return {
    lines: clone(state.lines),
    colors: clone(state.colors),
    nextId: state.nextId,
    nextColor: state.nextColor,
    activeId: state.activeId,
    caret: state.caret,
  };
}

// Signature of the parts of a snapshot that count as "the document" —
// caret/selection moves alone are not undoable steps.
function docSig(s) {
  return JSON.stringify([s.lines, s.colors]);
}

function restore(s) {
  state.lines = clone(s.lines);
  state.colors = clone(s.colors);
  state.nextId = s.nextId;
  state.nextColor = s.nextColor;
  state.activeId = state.lines.some((l) => l.id === s.activeId)
    ? s.activeId
    : state.lines[state.lines.length - 1].id;
  state.caret = Math.min(s.caret, activeLine().tokens.length);
  state.sel = null;
  labelEditId = null;
  labelEditSnap = null;
}

// Record `before` as an undo point. Runs of digit typing (and of backspaces)
// on the same line coalesce into a single step.
function commitHistory(before, kind) {
  if (kind && kind === lastKind && before.activeId === lastKindLine) return;
  undoStack.push(before);
  if (undoStack.length > HISTORY_MAX) undoStack.shift();
  redoStack.length = 0;
  lastKind = kind;
  lastKindLine = before.activeId;
}

function breakCoalescing() {
  lastKind = null;
  lastKindLine = null;
}

function undo() {
  commitLabelEditFromDom();
  if (!undoStack.length) return;
  redoStack.push(snapshot());
  restore(undoStack.pop());
  breakCoalescing();
  update();
}

function redo() {
  commitLabelEditFromDom();
  if (!redoStack.length) return;
  undoStack.push(snapshot());
  restore(redoStack.pop());
  breakCoalescing();
  update();
}

/* ================= labels ================= */

function startLabelEdit(id) {
  commitLabelEditFromDom();
  labelEditSnap = snapshot();
  labelEditId = id;
  render();
}

function commitLabel(id, raw) {
  if (labelEditId !== id) return;
  labelEditId = null;
  const snap = labelEditSnap;
  labelEditSnap = null;
  const line = state.lines.find((l) => l.id === id);
  if (!line) { render(); return; }
  const label = raw.trim().slice(0, 24);
  if (label === (line.label || '')) { render(); return; }
  if (label) line.label = label;
  else delete line.label;
  if (snap) commitHistory(snap, null);
  update();
}

// The label input normally commits on blur, but keypad buttons prevent
// focus changes — so mutating actions flush any open label edit first.
function commitLabelEditFromDom() {
  if (labelEditId === null) return;
  const inp = linesEl.querySelector('.label-input');
  commitLabel(labelEditId, inp ? inp.value : '');
}

function sizeLabelInput(inp) {
  inp.style.width = Math.max(inp.value.length, 5) + 1 + 'ch';
}

/* ================= projects & sheets ================= */

const currentProject = () => projects.find((p) => p.id === currentProjectId);
const currentSheet = () => {
  const p = currentProject();
  return p && p.sheets.find((s) => s.id === p.currentSheetId);
};
const historyKey = (pid, sid) => pid + ':' + sid;

function freshSheet(p) {
  const id = p.nextSheetId++;
  return {
    id,
    name: 'Sheet ' + id,
    lines: [{ id: 1, tokens: [] }],
    activeId: 1,
    colors: {},
    nextId: 2,
    nextColor: 0,
  };
}

function freshProject() {
  const id = nextProjectId++;
  const p = { id, name: 'Project ' + id, sheets: [], currentSheetId: 1, nextSheetId: 1 };
  const s = freshSheet(p);
  p.sheets.push(s);
  p.currentSheetId = s.id;
  return p;
}

// state and the current sheet's record share the same arrays, but undo's
// restore() and "Clear all" rebind state fields — re-point the record.
function syncCurrentSheet() {
  const s = currentSheet();
  if (!s) return;
  s.lines = state.lines;
  s.activeId = state.activeId;
  s.colors = state.colors;
  s.nextId = state.nextId;
  s.nextColor = state.nextColor;
}

// Make a sheet the working document: swap its fields into `state` and
// rebind the undo/redo stacks to its own history.
function adoptSheet(p, sheetId) {
  const s = p.sheets.find((x) => x.id === sheetId) || p.sheets[0];
  currentProjectId = p.id;
  p.currentSheetId = s.id;
  state.lines = s.lines;
  state.colors = s.colors;
  state.nextId = s.nextId;
  state.nextColor = s.nextColor;
  state.activeId = s.lines.some((l) => l.id === s.activeId)
    ? s.activeId
    : s.lines[s.lines.length - 1].id;
  state.caret = activeLine().tokens.length;
  state.sel = null;
  const key = historyKey(p.id, s.id);
  let h = histories.get(key);
  if (!h) {
    h = { undo: [], redo: [] };
    histories.set(key, h);
  }
  undoStack = h.undo;
  redoStack = h.redo;
  breakCoalescing();
  prevFmt = new Map();
  hoverRefId = null;
  labelEditId = null;
  labelEditSnap = null;
  projectBar.cancelRename();
  sheetBar.cancelRename();
  closeRefPop();
}

function adoptProject(id) {
  const p = projects.find((x) => x.id === id);
  if (!p) return;
  adoptSheet(p, p.currentSheetId);
}

function switchProject(id) {
  if (id === currentProjectId || !projects.some((p) => p.id === id)) return;
  commitLabelEditFromDom();
  closeUnitPop();
  syncCurrentSheet();
  adoptProject(id);
  update();
}

function newProject() {
  commitLabelEditFromDom();
  syncCurrentSheet();
  const p = freshProject();
  projects.push(p);
  adoptProject(p.id);
  update();
}

function deleteProject(id) {
  const idx = projects.findIndex((p) => p.id === id);
  if (idx < 0) return;
  for (const s of projects[idx].sheets) histories.delete(historyKey(id, s.id));
  projects.splice(idx, 1);
  if (!projects.length) projects.push(freshProject());
  if (currentProjectId === id) {
    adoptProject(projects[Math.min(Math.max(0, idx - 1), projects.length - 1)].id);
  }
  update();
}

function renameProject(id, raw) {
  const p = projects.find((x) => x.id === id);
  if (p) {
    const name = raw.trim().slice(0, 24);
    if (name) p.name = name;
  }
  update();
}

function switchSheet(sheetId) {
  const p = currentProject();
  if (!p || sheetId === p.currentSheetId || !p.sheets.some((s) => s.id === sheetId)) return;
  commitLabelEditFromDom();
  closeUnitPop();
  syncCurrentSheet();
  adoptSheet(p, sheetId);
  update();
}

function newSheet() {
  const p = currentProject();
  if (!p) return;
  commitLabelEditFromDom();
  syncCurrentSheet();
  const s = freshSheet(p);
  p.sheets.push(s);
  adoptSheet(p, s.id);
  update();
}

function deleteSheet(sheetId) {
  const p = currentProject();
  if (!p) return;
  const idx = p.sheets.findIndex((s) => s.id === sheetId);
  if (idx < 0) return;
  // Freeze every cross-sheet reference into the doomed sheet.
  syncCurrentSheet();
  for (const s of p.sheets) {
    if (s.id === sheetId) continue;
    for (const line of s.lines) {
      line.tokens = line.tokens.flatMap((t) =>
        t.t === 'r' && t.sheet === sheetId
          ? frozenTokensFor(projResults.get(sheetId + ':' + t.ref)).map((f) => ({ ...f }))
          : t);
    }
  }
  p.sheets.splice(idx, 1);
  histories.delete(historyKey(p.id, sheetId));
  if (!p.sheets.length) p.sheets.push(freshSheet(p));
  if (p.currentSheetId === sheetId) {
    adoptSheet(p, p.sheets[Math.min(Math.max(0, idx - 1), p.sheets.length - 1)].id);
  }
  update();
}

function renameSheet(sheetId, raw) {
  const p = currentProject();
  const s = p && p.sheets.find((x) => x.id === sheetId);
  if (s) {
    const name = raw.trim().slice(0, 24);
    if (name) s.name = name;
  }
  update();
}

/* ---- export / import ---- */

function exportProjects() {
  commitLabelEditFromDom();
  syncCurrentSheet();
  const payload = {
    app: 'bionicalc',
    version: 1,
    exported: new Date().toISOString(),
    projects,
    quickUnits,
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bionicalc-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  toast(`Exported ${projects.length} project${projects.length === 1 ? '' : 's'}`);
}

// Imported projects are APPENDED as new tabs — an import can never overwrite
// or delete what's already on the device. Accepts the current format
// (projects with sheets), the previous one (documents at the project level),
// and the original single-document files. Returns how many were added.
function importProjectsFromData(d) {
  const okTok = (t) => !!t && (
    ((t.t === 'n' || t.t === 'u') && typeof t.v === 'string') ||
    (t.t === 'o' && ['+', '-', '*', '/', '%'].includes(t.v)) ||
    (t.t === 'p' && (t.v === '(' || t.v === ')')) ||
    (t.t === 'r' && typeof t.ref === 'number'));
  const cleanName = (raw, fallback) => String(raw || '').trim().slice(0, 24) || fallback;

  const sanitizeDoc = (src) => {
    if (!src || !Array.isArray(src.lines)) return null;
    const lines = src.lines
      .filter((l) => l && typeof l.id === 'number' && Array.isArray(l.tokens))
      .map((l) => ({
        id: l.id,
        tokens: l.tokens.filter(okTok).map((t) => ({ ...t })),
        ...(l.label ? { label: String(l.label).slice(0, 24) } : {}),
      }));
    if (!lines.length) return null;
    const colors = {};
    for (const [k, v] of Object.entries(src.colors || {})) {
      if (Number.isInteger(v)) colors[k] = ((v % PALETTE.length) + PALETTE.length) % PALETTE.length;
    }
    return {
      lines,
      activeId: src.activeId,
      colors,
      nextId: Number(src.nextId) || Math.max(...lines.map((l) => l.id)) + 1,
      nextColor: Number(src.nextColor) || 0,
    };
  };

  let incoming = [];
  if (d && Array.isArray(d.projects)) incoming = d.projects;
  else if (d && Array.isArray(d.lines)) incoming = [{ name: 'Imported', ...d }];

  const added = [];
  for (const p of incoming) {
    if (!p) continue;
    const srcSheets = Array.isArray(p.sheets)
      ? p.sheets
      : [{ lines: p.lines, activeId: p.activeId, colors: p.colors, nextId: p.nextId, nextColor: p.nextColor }];
    const sheets = [];
    const sheetIdMap = new Map(); // original sheet id -> renumbered id
    let sheetId = 1;
    for (const s of srcSheets) {
      const doc = sanitizeDoc(s);
      if (!doc) continue;
      const sid = sheetId++;
      if (s && s.id !== undefined) sheetIdMap.set(s.id, sid);
      sheets.push({ id: sid, name: cleanName(s && s.name, 'Sheet ' + sid), ...doc });
    }
    if (!sheets.length) continue;
    // Re-point cross-sheet references at the renumbered sheet ids; a ref into
    // a sheet that didn't survive sanitization dangles (renders as "…").
    for (const sh of sheets) {
      for (const l of sh.lines) {
        for (const t of l.tokens) {
          if (t.t === 'r' && t.sheet !== undefined) {
            t.sheet = sheetIdMap.has(t.sheet) ? sheetIdMap.get(t.sheet) : -1;
          }
        }
      }
    }
    added.push({
      id: nextProjectId++,
      name: cleanName(p.name, 'Imported'),
      sheets,
      currentSheetId: sheets[0].id,
      nextSheetId: sheetId,
    });
  }
  if (!added.length) return 0;
  commitLabelEditFromDom();
  syncCurrentSheet();
  projects.push(...added);
  adoptProject(added[0].id);
  update();
  return added.length;
}


function press(key) {
  if (!activeLine()) {
    state.activeId = state.lines[state.lines.length - 1].id;
    state.caret = activeLine().tokens.length;
  }
  if (key === 'left' || key === 'right' || key === 'up' || key === 'down' || key === 'escape') {
    if (key === 'left') moveLR(-1);
    else if (key === 'right') moveLR(1);
    else if (key === 'up') moveUD(-1);
    else if (key === 'down') moveUD(1);
    else { deselect(); closeUnitPop(); closeRefPop(); }
    breakCoalescing();
    update();
    return;
  }
  commitLabelEditFromDom();
  const before = snapshot();
  let kind = null;
  if (key.startsWith('unit:')) {
    const sym = key.slice(5);
    inputUnit(sym);
    promoteQuickUnit(sym);
    kind = 'digit';
  }
  else if (/^[0-9.]$/.test(key)) { inputDigit(key); kind = 'digit'; }
  else if (/^[a-z]$/.test(key)) { inputUnitLetter(key); kind = 'digit'; }
  else if (key === '+' || key === '-' || key === '*' || key === '/') inputOp(key);
  else if (key === '%') inputPercent();
  else if (key === '(' || key === ')') inputParen(key);
  else if (key === 'backspace') { backspace(); kind = 'backspace'; }
  else if (key === 'enter') newLine();
  else if (key === 'clear') {
    const l = activeLine();
    l.tokens = [];
    state.caret = 0;
    state.sel = null;
  }
  else return;
  if (docSig(before) !== docSig(snapshot())) commitHistory(before, kind);
  update();
}

/* ================= rendering ================= */

const linesEl = document.getElementById('lines');
const hintEl = document.getElementById('hint');

function caretEl() {
  const s = document.createElement('span');
  s.className = 'caret';
  return s;
}

const OP_GLYPH = { '*': '×', '/': '÷', '-': '−', '+': '+', '%': '%' };

function tokenEl(line, tok, i) {
  const s = document.createElement('span');
  s.dataset.idx = i;
  const selected = state.sel && line.id === state.activeId && state.sel.idx === i;
  if (tok.t === 'n') {
    s.className = 'tok num' + (selected ? ' selected' : '');
    s.textContent = fmtNum(tok.v);
    s.title = 'Tap to retype this number';
  } else if (tok.t === 'o') {
    s.className = 'tok op';
    s.textContent = OP_GLYPH[tok.v];
  } else if (tok.t === 'p') {
    s.className = 'tok paren';
    s.textContent = tok.v;
  } else if (tok.t === 'u') {
    s.className = 'tok unit';
    s.textContent = fmtUnitTok(tok.v);
  } else if (tok.t === 'r') {
    const cross = tok.sheet !== undefined;
    s.className = 'tok ref' + (cross ? ' xchip' : '') + (selected ? ' selected' : '');
    s.dataset.ref = refKeyOf(tok);
    const p = currentProject();
    const srcSheet = cross
      ? (p && p.sheets.find((x) => x.id === tok.sheet))
      : currentSheet();
    const r = projResults.get(refKeyOf(tok));
    const valText = r && !r.err ? fmtVal(r) : '…';
    const srcLine = srcSheet && srcSheet.lines.find((l) => l.id === tok.ref);
    if (srcLine && srcLine.label) {
      const rl = document.createElement('span');
      rl.className = 'rl';
      rl.textContent = srcLine.label;
      const rv = document.createElement('span');
      rv.className = 'rv';
      rv.textContent = valText;
      s.append(rl, rv);
      s.title = cross && srcSheet
        ? `${srcLine.label} on ${srcSheet.name} = ${valText}`
        : `${srcLine.label} = ${valText}`;
    } else {
      s.textContent = valText;
      s.title = cross && srcSheet
        ? `Live value from ${srcSheet.name}`
        : 'Live value from another line';
    }
    const colors = srcSheet ? srcSheet.colors : state.colors;
    const ci = colors ? colors[tok.ref] : undefined;
    if (ci !== undefined) s.style.setProperty('--c', PALETTE[ci]);
  }
  return s;
}

function render() {
  results = evaluateAll();
  linesEl.textContent = '';

  for (const line of state.lines) {
    const isActive = line.id === state.activeId;
    const el = document.createElement('div');
    el.className = 'line' + (isActive ? ' active' : '');
    el.dataset.id = line.id;

    const grip = document.createElement('button');
    grip.className = 'grip';
    grip.title = 'Drag to reorder (⌥↑ / ⌥↓)';
    grip.textContent = '⠿';
    el.appendChild(grip);

    const toks = document.createElement('div');
    toks.className = 'tokens';
    line.tokens.forEach((tok, i) => {
      if (isActive && !state.sel && state.caret === i) toks.appendChild(caretEl());
      toks.appendChild(tokenEl(line, tok, i));
    });
    if (isActive && !state.sel && state.caret === line.tokens.length) {
      toks.appendChild(caretEl());
    }
    el.appendChild(toks);

    const r = results.get(line.id);
    const resEl = document.createElement('div');
    resEl.className = 'result';
    const editingLabel = labelEditId === line.id;
    if (editingLabel) {
      const inp = document.createElement('input');
      inp.className = 'label-input';
      inp.value = line.label || '';
      inp.maxLength = 24;
      inp.spellcheck = false;
      inp.placeholder = 'label';
      resEl.appendChild(inp);
    } else if (line.label) {
      const lb = document.createElement('span');
      lb.className = 'label';
      lb.textContent = line.label;
      lb.title = 'Edit label';
      resEl.appendChild(lb);
    }
    if (!r) {
      if (!line.label && !editingLabel) resEl.style.visibility = 'hidden';
      prevFmt.delete(line.id);
    } else if (r.err) {
      resEl.classList.add('err');
      const es = document.createElement('span');
      es.textContent = r.err;
      resEl.appendChild(es);
      prevFmt.delete(line.id);
    } else {
      const s = fmtVal(r);
      const ci = state.colors[line.id];
      if (ci !== undefined) {
        resEl.classList.add('tinted');
        resEl.style.setProperty('--c', PALETTE[ci]);
      }
      const eq = document.createElement('span');
      eq.className = 'eq';
      eq.textContent = '=';
      const val = document.createElement('span');
      val.className = 'val';
      val.textContent = fmt(r.v);
      resEl.append(eq, val);
      const uStr = fmtUnit(r.unit);
      if (uStr) {
        const un = document.createElement('span');
        un.className = 'runit';
        un.textContent = uStr;
        resEl.appendChild(un);
      }
      resEl.title = 'Use this result';
      const pf = prevFmt.get(line.id);
      if (pf !== undefined && pf !== s && line.id !== state.activeId) {
        resEl.classList.add('flash');
      }
      prevFmt.set(line.id, s);
    }
    el.appendChild(resEl);

    if (!line.label && !editingLabel) {
      const al = document.createElement('button');
      al.className = 'addlabel';
      al.textContent = 'label';
      al.title = 'Name this line';
      el.appendChild(al);
    }

    const del = document.createElement('button');
    del.className = 'del';
    del.title = 'Delete this line';
    del.textContent = '×';
    el.appendChild(del);

    linesEl.appendChild(el);
  }

  hintEl.style.display =
    state.lines.length === 1 && state.lines[0].tokens.length === 0 ? '' : 'none';

  undoBtn.disabled = !undoStack.length;
  redoBtn.disabled = !redoStack.length;

  document.getElementById('unitbar').querySelectorAll('.ukey[data-key]').forEach((b, i) => {
    const sym = quickUnits[i];
    if (sym) {
      b.dataset.key = 'unit:' + sym;
      b.textContent = sym;
      b.title = `${sym} — tap again for ${sym}², ${sym}³`;
    }
  });

  projectBar.render();
  sheetBar.render();
  renderSummary();

  if (labelEditId !== null) {
    const inp = linesEl.querySelector('.label-input');
    if (inp) {
      const id = labelEditId;
      sizeLabelInput(inp);
      inp.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') commitLabel(id, inp.value);
        else if (e.key === 'Escape') {
          labelEditId = null;
          labelEditSnap = null;
          render();
        }
      });
      inp.addEventListener('input', () => sizeLabelInput(inp));
      inp.addEventListener('blur', () => commitLabel(id, inp.value));
      inp.focus();
      inp.setSelectionRange(inp.value.length, inp.value.length);
    }
  }

  const act = linesEl.querySelector('.line.active');
  if (act) act.scrollIntoView({ block: 'nearest' });

  applyRefHighlight();
}

/* ---- tab bars: projects above the keypad, sheets above the canvas ---- */

// Both bars share one behavior: tap to switch, tap the active tab to rename
// it inline, + to create, and the active tab's × to delete (two-tap confirm).
function makeTabBar(container, cfg) {
  let renameId = null;
  let delArm = null;
  let delTimer;

  function commitRename(id, value) {
    if (renameId !== id) return;
    renameId = null;
    cfg.rename(id, value);
  }

  function renderBar() {
    const items = cfg.items();
    if (renameId !== null && !items.some((it) => it.id === renameId)) renameId = null;
    container.textContent = '';
    for (const it of items) {
      const active = it.id === cfg.currentId();
      const tab = document.createElement('div');
      tab.className = 'ptab' + (active ? ' active' : '');
      tab.dataset.tid = it.id;
      if (renameId === it.id) {
        const inp = document.createElement('input');
        inp.value = it.name;
        inp.maxLength = 24;
        inp.spellcheck = false;
        tab.appendChild(inp);
      } else {
        const nm = document.createElement('span');
        nm.className = 'pname';
        nm.textContent = it.name;
        tab.appendChild(nm);
        if (active) {
          tab.title = 'Tap again to rename';
          const del = document.createElement('button');
          del.className = 'pdel' + (delArm === it.id ? ' armed' : '');
          del.textContent = delArm === it.id ? 'sure?' : '×';
          del.title = cfg.deleteTitle;
          tab.appendChild(del);
        } else {
          tab.title = 'Switch to ' + it.name;
        }
      }
      container.appendChild(tab);
    }
    const add = document.createElement('button');
    add.className = 'padd';
    add.textContent = '+';
    add.title = cfg.addTitle;
    container.appendChild(add);

    if (renameId !== null) {
      const inp = container.querySelector('.ptab input');
      if (inp) {
        const id = renameId;
        const size = () => { inp.style.width = Math.max(inp.value.length, 4) + 2 + 'ch'; };
        size();
        inp.addEventListener('input', size);
        inp.addEventListener('keydown', (e) => {
          e.stopPropagation();
          if (e.key === 'Enter') commitRename(id, inp.value);
          else if (e.key === 'Escape') {
            renameId = null;
            renderBar();
          }
        });
        inp.addEventListener('blur', () => commitRename(id, inp.value));
        inp.focus();
        inp.select();
      }
    }
  }

  container.addEventListener('click', (e) => {
    if (e.target.closest('input')) return;
    if (e.target.closest('.padd')) {
      cfg.create();
      return;
    }
    const tab = e.target.closest('.ptab');
    if (!tab) return;
    const tid = Number(tab.dataset.tid);
    if (e.target.closest('.pdel')) {
      if (delArm === tid) {
        clearTimeout(delTimer);
        delArm = null;
        cfg.remove(tid);
      } else {
        delArm = tid;
        clearTimeout(delTimer);
        delTimer = setTimeout(() => {
          delArm = null;
          renderBar();
        }, 2500);
        renderBar();
      }
      return;
    }
    if (tid === cfg.currentId()) {
      commitLabelEditFromDom();
      renameId = tid;
      renderBar();
    } else {
      cfg.switchTo(tid);
    }
  });

  return {
    render: renderBar,
    cancelRename() { renameId = null; },
  };
}

const projectBar = makeTabBar(document.getElementById('projtabs'), {
  items: () => projects,
  currentId: () => currentProjectId,
  switchTo: switchProject,
  create: newProject,
  remove: deleteProject,
  rename: renameProject,
  addTitle: 'New project',
  deleteTitle: 'Delete this project',
});

const sheetBar = makeTabBar(document.getElementById('sheettabs'), {
  items: () => (currentProject() ? currentProject().sheets : []),
  currentId: () => (currentProject() ? currentProject().currentSheetId : null),
  switchTo: switchSheet,
  create: newSheet,
  remove: deleteSheet,
  rename: renameSheet,
  addTitle: 'New sheet',
  deleteTitle: 'Delete this sheet',
});

/* ---- summary: every labeled result in the project, under the tabs ---- */

function renderSummary() {
  const cont = document.getElementById('summary');
  cont.textContent = '';
  const p = currentProject();
  if (!p) return;
  for (const s of p.sheets) {
    const labeled = s.lines.filter((l) => l.label);
    if (!labeled.length) continue;
    const h = document.createElement('h4');
    h.textContent = s.name + (s.id === p.currentSheetId ? ' · this sheet' : '');
    cont.appendChild(h);
    for (const l of labeled) {
      const entry = projResults.get(s.id + ':' + l.id);
      const b = document.createElement('button');
      b.className = 'srow';
      b.dataset.sheet = s.id;
      b.dataset.line = l.id;
      b.title = `Insert ${l.label} into the current line`;
      const sl = document.createElement('span');
      sl.className = 'sl';
      sl.textContent = l.label;
      const sv = document.createElement('span');
      sv.className = 'sv';
      sv.textContent = entry ? (entry.err || fmtVal(entry)) : '…';
      const ci = s.colors[l.id];
      if (ci !== undefined && entry && !entry.err) {
        sv.style.color = PALETTE[ci];
        sv.style.fontWeight = '600';
      }
      b.append(sl, sv);
      cont.appendChild(b);
    }
  }
}

/* ---- hover: light up a result and every reference to it ---- */

let hoverRefId = null; // "sheetId:lineId", matching chips' data-ref

function refKeyOf(tok) {
  const p = currentProject();
  const sid = tok.sheet !== undefined ? tok.sheet : (p ? p.currentSheetId : 0);
  return sid + ':' + tok.ref;
}

// Re-applied after every render so the highlight survives re-renders while
// the pointer rests on a chip or result. Without a hover (touch devices),
// a selected reference chip highlights its family instead — tracing works
// by tapping the chip, the same gesture that selects it.
function applyRefHighlight() {
  linesEl.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl'));
  let key = hoverRefId;
  if (key === null && state.sel) {
    const tok = activeLine()?.tokens[state.sel.idx];
    if (tok && tok.t === 'r') key = refKeyOf(tok);
  }
  if (key === null) return;
  const chips = linesEl.querySelectorAll(`.tok.ref[data-ref="${key}"]`);
  if (!chips.length) return; // an unreferenced result has nothing to connect
  chips.forEach((el) => el.classList.add('hl'));
  const p = currentProject();
  const [sid, lid] = key.split(':');
  if (p && Number(sid) === p.currentSheetId) {
    const src = linesEl.querySelector(`.line[data-id="${lid}"] .result`);
    if (src) src.classList.add('hl');
  }
}

function setRefHighlight(id) {
  if (id === hoverRefId) return;
  hoverRefId = id;
  applyRefHighlight();
}

/* ================= persistence ================= */

function save() {
  syncCurrentSheet();
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      projects,
      currentId: currentProjectId,
      nextProjectId,
      quickUnits,
    }));
  } catch { /* storage unavailable — run without persistence */ }
}

const validSheet = (s) => s && Array.isArray(s.lines) && s.lines.length;

// Bring any older stored project record up to the current shape: a document
// stored at the project level moves into that project's single sheet.
function migrateProject(p) {
  if (!p) return null;
  if (Array.isArray(p.sheets)) {
    const sheets = p.sheets.filter(validSheet);
    if (!sheets.length) return null;
    return {
      id: p.id,
      name: p.name,
      sheets,
      currentSheetId: sheets.some((s) => s.id === p.currentSheetId) ? p.currentSheetId : sheets[0].id,
      nextSheetId: Number(p.nextSheetId) || Math.max(...sheets.map((s) => s.id)) + 1,
    };
  }
  if (!Array.isArray(p.lines) || !p.lines.length) return null;
  return {
    id: p.id,
    name: p.name,
    sheets: [{
      id: 1,
      name: 'Sheet 1',
      lines: p.lines,
      activeId: p.activeId,
      colors: p.colors || {},
      nextId: p.nextId || Math.max(...p.lines.map((l) => l.id)) + 1,
      nextColor: p.nextColor || 0,
    }],
    currentSheetId: 1,
    nextSheetId: 2,
  };
}

function load() {
  let currentId = null;
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && Array.isArray(d.quickUnits)) {
      const valid = d.quickUnits.filter((s) => UNITS[s]);
      if (valid.length) quickUnits = valid.slice(0, 4);
    }
    if (d && Array.isArray(d.projects) && d.projects.length) {
      projects = d.projects.map(migrateProject).filter(Boolean);
      nextProjectId = d.nextProjectId
        || (projects.length ? Math.max(...projects.map((p) => p.id)) + 1 : 1);
      currentId = d.currentId;
    } else if (d && Array.isArray(d.lines) && d.lines.length) {
      // the original single-document storage
      const p = migrateProject({ id: 1, name: 'Project 1', ...d });
      if (p) {
        projects = [p];
        nextProjectId = 2;
      }
    }
  } catch { /* corrupt state — start fresh */ }
  if (!projects.length) projects = [freshProject()];
  adoptProject(projects.some((p) => p.id === currentId) ? currentId : projects[0].id);
}

function update() {
  save();
  render();
}

/* ================= wiring ================= */

let toastTimer;
function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
}

linesEl.addEventListener('click', (e) => {
  if (performance.now() < suppressClickUntil) return;
  const lineEl = e.target.closest('.line');
  if (!lineEl) return;
  const id = Number(lineEl.dataset.id);
  const line = state.lines.find((l) => l.id === id);
  if (!line) return;

  if (e.target.closest('.label-input')) return;
  if (e.target.closest('.del')) {
    const before = snapshot();
    removeLine(id);
    commitHistory(before, null);
    update();
    return;
  }
  if (e.target.closest('.addlabel') || e.target.closest('.label')) {
    startLabelEdit(id);
    return;
  }
  if (e.target.closest('.result')) {
    insertRefFrom(id);
    return;
  }

  breakCoalescing();
  state.activeId = id;
  state.sel = null;
  const tokEl = e.target.closest('.tok');
  if (tokEl) {
    const i = Number(tokEl.dataset.idx);
    const tok = line.tokens[i];
    if (tok && (tok.t === 'n' || tok.t === 'r')) state.sel = { idx: i };
    state.caret = i + 1;
  } else {
    state.caret = line.tokens.length;
  }
  update();
});

linesEl.addEventListener('mouseover', (e) => {
  const chip = e.target.closest('.tok.ref');
  if (chip) { setRefHighlight(chip.dataset.ref); return; }
  const resEl = e.target.closest('.result');
  if (resEl) {
    const p = currentProject();
    setRefHighlight(p ? p.currentSheetId + ':' + resEl.closest('.line').dataset.id : null);
    return;
  }
  setRefHighlight(null);
});
linesEl.addEventListener('mouseleave', () => setRefHighlight(null));

/* ---- row reordering: drag the ⠿ grip ---- */

let drag = null;
// A completed drag generates a click on release; ignore clicks briefly after
// a drag ends (a sticky flag would swallow the next real click whenever the
// browser doesn't dispatch one).
let suppressClickUntil = 0;

linesEl.addEventListener('pointerdown', (e) => {
  const grip = e.target.closest('.grip');
  if (!grip || drag) return;
  const lineEl = grip.closest('.line');
  if (!lineEl) return;
  e.preventDefault();          // keeps focus (and any label edit) intact
  commitLabelEditFromDom();
  const els = [...linesEl.querySelectorAll('.line')];
  drag = {
    pointerId: e.pointerId,
    startY: e.clientY,
    els,
    index: els.indexOf(lineEl),
    target: els.indexOf(lineEl),
    rects: els.map((el) => {
      const r = el.getBoundingClientRect();
      return { mid: r.top + r.height / 2, h: r.height };
    }),
    moved: false,
  };
  try { linesEl.setPointerCapture(e.pointerId); } catch { /* capture is best-effort */ }
});

linesEl.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  const dy = e.clientY - drag.startY;
  if (!drag.moved) {
    if (Math.abs(dy) < 4) return;
    drag.moved = true;
    linesEl.classList.add('reordering');
    drag.els[drag.index].classList.add('dragging');
  }
  drag.els[drag.index].style.transform = `translateY(${dy}px)`;
  const center = drag.rects[drag.index].mid + dy;
  let target = 0;
  drag.rects.forEach((r, i) => {
    if (i !== drag.index && r.mid < center) target++;
  });
  drag.target = target;
  // Open a gap at the drop position: lines between old and new slot shift
  // by the dragged line's height.
  const h = drag.rects[drag.index].h;
  drag.els.forEach((el, i) => {
    if (i === drag.index) return;
    let shift = 0;
    if (i > drag.index && i - 1 < target) shift = -h;
    else if (i < drag.index && i >= target) shift = h;
    el.style.transform = shift ? `translateY(${shift}px)` : '';
  });
});

function endDrag(commit) {
  if (!drag) return;
  const d = drag;
  drag = null;
  linesEl.classList.remove('reordering');
  d.els.forEach((el) => {
    el.style.transform = '';
    el.classList.remove('dragging');
  });
  if (!d.moved) return;
  suppressClickUntil = performance.now() + 400;
  if (commit && d.target !== d.index) {
    const before = snapshot();
    const [line] = state.lines.splice(d.index, 1);
    state.lines.splice(d.target, 0, line);
    state.activeId = line.id;
    state.caret = line.tokens.length;
    state.sel = null;
    commitHistory(before, null);
    update();
  }
}

linesEl.addEventListener('pointerup', (e) => {
  if (drag && e.pointerId === drag.pointerId) endDrag(true);
});
linesEl.addEventListener('pointercancel', (e) => {
  if (drag && e.pointerId === drag.pointerId) endDrag(false);
});

window.addEventListener('keydown', (e) => {
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (e.altKey && !e.metaKey && !e.ctrlKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault();
    moveLine(e.key === 'ArrowUp' ? -1 : 1);
    return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'z' || e.key === 'Z')) {
    e.preventDefault();
    if (e.shiftKey) redo();
    else undo();
    return;
  }
  if ((e.metaKey || e.ctrlKey) && !e.altKey && (e.key === 'y' || e.key === 'Y')) {
    e.preventDefault();
    redo();
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const map = {
    Enter: 'enter', Backspace: 'backspace', Delete: 'backspace', Escape: 'escape',
    ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down',
    x: '*', X: '*', '*': '*', '/': '/', '+': '+', '-': '-',
    '%': '%', '(': '(', ')': ')', '.': '.', ',': '.',
  };
  let key;
  if (/^[0-9]$/.test(e.key)) key = e.key;
  else if (map[e.key] !== undefined) key = map[e.key];
  else if (/^[a-zA-Z]$/.test(e.key)) key = e.key.toLowerCase(); // unit letters
  if (!key) return;
  e.preventDefault();
  press(key);
});

const pad = document.getElementById('pad');
pad.addEventListener('pointerdown', (e) => {
  const b = e.target.closest('button');
  if (b) {
    e.preventDefault(); // keep focus off the button so Enter still means "new line"
    b.classList.add('pressed');
  }
});
window.addEventListener('pointerup', () => {
  pad.querySelectorAll('.pressed').forEach((b) => b.classList.remove('pressed'));
});
pad.addEventListener('click', (e) => {
  const b = e.target.closest('button[data-key]');
  if (b) {
    press(b.dataset.key);
    if (b.dataset.key.startsWith('unit:')) closeUnitPop();
  }
});

/* ---- unit popover: every unit, grouped by dimension ---- */

const unitPop = document.getElementById('unitpop');

function closeUnitPop() {
  unitPop.hidden = true;
}

{
  const groups = [
    ['Length', { L: 1 }],
    ['Mass', { M: 1 }],
    ['Time', { T: 1 }],
    ['Volume', { L: 3 }],
  ];
  for (const [label, dim] of groups) {
    const g = document.createElement('div');
    g.className = 'ugroup';
    const h = document.createElement('h3');
    h.textContent = label;
    g.appendChild(h);
    const row = document.createElement('div');
    row.className = 'ubtns';
    for (const sym of UNIT_NAMES) {
      if (!sameDim(UNITS[sym].dim, dim)) continue;
      const b = document.createElement('button');
      b.className = 'key ukey';
      b.dataset.key = 'unit:' + sym;
      b.textContent = sym;
      row.appendChild(b);
    }
    g.appendChild(row);
    unitPop.appendChild(g);
  }
}

document.getElementById('more-units').addEventListener('click', () => {
  unitPop.hidden = !unitPop.hidden;
});


const summaryEl = document.getElementById('summary');
summaryEl.addEventListener('click', (e) => {
  const row = e.target.closest('.srow');
  if (!row) return;
  const sid = Number(row.dataset.sheet);
  const lid = Number(row.dataset.line);
  if (sid === currentProject().currentSheetId) insertRefFrom(lid);
  else insertCrossRef(sid, lid);
});
summaryEl.addEventListener('mouseover', (e) => {
  const row = e.target.closest('.srow');
  setRefHighlight(row ? row.dataset.sheet + ':' + row.dataset.line : null);
});
summaryEl.addEventListener('mouseleave', () => setRefHighlight(null));

/* ---- cross-sheet reference picker ---- */

const refPop = document.getElementById('refpop');

function closeRefPop() {
  refPop.hidden = true;
}

// Rebuilt on every open: lists the LABELED results of every other sheet in
// the current project, grouped by sheet.
function buildRefPop() {
  refPop.textContent = '';
  const p = currentProject();
  let any = false;
  for (const s of (p ? p.sheets : [])) {
    if (s.id === p.currentSheetId) continue;
    const labeled = s.lines.filter((l) => l.label);
    if (!labeled.length) continue;
    any = true;
    const g = document.createElement('div');
    g.className = 'ugroup';
    const h = document.createElement('h3');
    h.textContent = s.name;
    g.appendChild(h);
    const rows = document.createElement('div');
    rows.className = 'refrows';
    for (const l of labeled) {
      const entry = projResults.get(s.id + ':' + l.id);
      const b = document.createElement('button');
      b.className = 'refrow';
      b.dataset.sheet = s.id;
      b.dataset.line = l.id;
      const nm = document.createElement('span');
      nm.className = 'rn';
      nm.textContent = l.label;
      const vv = document.createElement('span');
      vv.className = 'rv2';
      vv.textContent = entry ? (entry.err || fmtVal(entry)) : '…';
      b.append(nm, vv);
      rows.appendChild(b);
    }
    g.appendChild(rows);
    refPop.appendChild(g);
  }
  if (!any) {
    const msg = document.createElement('p');
    msg.className = 'refempty';
    msg.textContent = 'Label a line on another sheet, then insert its live value here.';
    refPop.appendChild(msg);
  }
}

document.getElementById('refbtn').addEventListener('click', () => {
  if (refPop.hidden) {
    closeUnitPop();
    buildRefPop();
    refPop.hidden = false;
  } else {
    closeRefPop();
  }
});

refPop.addEventListener('click', (e) => {
  const row = e.target.closest('.refrow');
  if (!row) return;
  closeRefPop();
  insertCrossRef(Number(row.dataset.sheet), Number(row.dataset.line));
});

window.addEventListener('pointerdown', (e) => {
  if (!e.target.closest) return;
  if (!unitPop.hidden && !e.target.closest('#unitpop') && !e.target.closest('#more-units')) {
    closeUnitPop();
  }
  if (!refPop.hidden && !e.target.closest('#refpop') && !e.target.closest('#refbtn')) {
    closeRefPop();
  }
});

const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const isMac = /Mac|iP/.test(navigator.platform || '');
undoBtn.title = isMac ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)';
redoBtn.title = isMac ? 'Redo (⇧⌘Z)' : 'Redo (Ctrl+Y)';
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

document.getElementById('export').addEventListener('click', exportProjects);

const importFile = document.getElementById('import-file');
document.getElementById('import').addEventListener('click', () => {
  importFile.value = '';
  importFile.click();
});
importFile.addEventListener('change', () => {
  const f = importFile.files && importFile.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    let n = 0;
    try { n = importProjectsFromData(JSON.parse(reader.result)); } catch { /* invalid JSON */ }
    toast(n ? `Imported ${n} project${n === 1 ? '' : 's'}` : "Couldn't read that file");
  };
  reader.readAsText(f);
});

const clearAllBtn = document.getElementById('clear-all');
let clearArm = null;
function disarmClear() {
  clearTimeout(clearArm);
  clearArm = null;
  clearAllBtn.textContent = 'Clear all';
  clearAllBtn.classList.remove('armed');
}
clearAllBtn.addEventListener('click', () => {
  if (!clearArm) {
    clearAllBtn.textContent = 'Really clear?';
    clearAllBtn.classList.add('armed');
    clearArm = setTimeout(disarmClear, 2200);
  } else {
    disarmClear();
    commitLabelEditFromDom();
    const before = snapshot();
    state.lines = [{ id: state.nextId++, tokens: [] }];
    state.activeId = state.lines[0].id;
    state.caret = 0;
    state.sel = null;
    state.colors = {};
    state.nextColor = 0;
    prevFmt = new Map();
    commitHistory(before, null);
    update();
  }
});

load();
save(); // persist immediately so a migrated document is stored in the new format
render();

// Debug/console access. Getters because the stacks are rebound per sheet.
window.__bionicalc = {
  state,
  evaluateAll,
  switchProject,
  switchSheet,
  newSheet,
  get projects() { return projects; },
  get currentProjectId() { return currentProjectId; },
  get currentSheet() { return currentSheet(); },
  get undoStack() { return undoStack; },
  get redoStack() { return redoStack; },
};
