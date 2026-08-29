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

const state = {
  lines: [],      // [{ id, tokens: [...] }]
  activeId: null,
  caret: 0,       // token index within the active line (between tokens)
  sel: null,      // { idx } — number/ref token in the active line, selected for retyping
  colors: {},     // lineId -> palette index, assigned when a line is first referenced
  nextId: 1,
  nextColor: 0,
};

let results = new Map();  // lineId -> { v } | { err } | null (empty line)
let prevFmt = new Map();  // lineId -> last displayed result, to flash changes

const undoStack = [];     // snapshots taken BEFORE each mutation
const redoStack = [];
const HISTORY_MAX = 200;
let lastKind = null;      // 'digit' | 'backspace' | null — for coalescing typing runs
let lastKindLine = null;

let labelEditId = null;   // line whose label is being edited (transient)
let labelEditSnap = null; // snapshot from when that edit started

const activeLine = () => state.lines.find((l) => l.id === state.activeId);
const activeIndex = () => state.lines.findIndex((l) => l.id === state.activeId);

// Tokens that can end an operand — a binary operator may follow these.
const isValue = (t) =>
  !!t && (t.t === 'n' || t.t === 'r' ||
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

function parseTokens(tokens, resolve) {
  let i = 0;
  const fail = () => { throw new Error('parse'); };

  function expr() {
    let v = term();
    while (i < tokens.length && tokens[i].t === 'o' && (tokens[i].v === '+' || tokens[i].v === '-')) {
      const op = tokens[i++].v;
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  function term() {
    let v = factor();
    while (i < tokens.length && tokens[i].t === 'o' && (tokens[i].v === '*' || tokens[i].v === '/')) {
      const op = tokens[i++].v;
      const r = factor();
      v = op === '*' ? v * r : v / r;
    }
    return v;
  }

  function factor() {
    let neg = false;
    while (i < tokens.length && tokens[i].t === 'o' && tokens[i].v === '-') { neg = !neg; i++; }
    let v = primary();
    while (i < tokens.length && tokens[i].t === 'o' && tokens[i].v === '%') { v /= 100; i++; }
    return neg ? -v : v;
  }

  function primary() {
    const tok = tokens[i];
    if (!tok) fail();
    if (tok.t === 'n') {
      i++;
      const n = parseFloat(tok.v);
      return isNaN(n) ? 0 : n;
    }
    if (tok.t === 'r') {
      i++;
      const r = resolve(tok.ref);
      if (!r || r.err) fail();
      return r.v;
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

// Lines are evaluated as a dependency graph, not in document order: each
// line's references are resolved recursively (memoized), so reordering lines
// never changes any result. A cycle — impossible through the UI, but possible
// via hand-edited storage — bottoms out as an error instead of recursing.
function evaluateAll() {
  const res = new Map();
  const visiting = new Set();

  function evalLine(id) {
    if (res.has(id)) return res.get(id);
    if (visiting.has(id)) return { err: '—' };
    const line = state.lines.find((l) => l.id === id);
    if (!line) return { err: '—' };
    visiting.add(id);
    let r;
    const t = cleanTokens(line.tokens);
    if (!t.length) r = null;
    else {
      try {
        const v = parseTokens(t, evalLine);
        r = isFinite(v) ? { v } : { err: 'Error' };
      } catch {
        r = { err: '—' };
      }
    }
    visiting.delete(id);
    res.set(id, r);
    return r;
  }

  for (const line of state.lines) evalLine(line.id);
  return res;
}

// Does line `aId` (transitively) depend on line `bId`? Used to refuse
// reference insertions that would close a cycle.
function dependsOn(aId, bId) {
  const seen = new Set();
  const walk = (id) => {
    if (id === bId) return true;
    if (seen.has(id)) return false;
    seen.add(id);
    const line = state.lines.find((l) => l.id === id);
    return !!line && line.tokens.some((t) => t.t === 'r' && walk(t.ref));
  };
  return walk(aId);
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
  if (prev.t === 'n' && prev.v.length > 1) prev.v = prev.v.slice(0, -1);
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
  if (srcId === state.activeId) { toast("A calculation can't use its own result"); return; }
  if (dependsOn(srcId, state.activeId)) { toast('That would create a circular reference'); return; }
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

function removeLine(id) {
  const idx = state.lines.findIndex((l) => l.id === id);
  if (idx < 0) return;
  // Freeze references to this line into plain numbers so dependents keep working.
  const r = results.get(id);
  const frozen = r && !r.err ? plainNum(r.v) : '0';
  for (const line of state.lines) {
    line.tokens = line.tokens.map((t) =>
      t.t === 'r' && t.ref === id ? { t: 'n', v: frozen } : t);
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
    else deselect();
    breakCoalescing();
    update();
    return;
  }
  commitLabelEditFromDom();
  const before = snapshot();
  let kind = null;
  if (/^[0-9.]$/.test(key)) { inputDigit(key); kind = 'digit'; }
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
  } else if (tok.t === 'r') {
    s.className = 'tok ref' + (selected ? ' selected' : '');
    s.dataset.ref = tok.ref;
    const r = results.get(tok.ref);
    const valText = r && !r.err ? fmt(r.v) : '…';
    const src = state.lines.find((l) => l.id === tok.ref);
    if (src && src.label) {
      const rl = document.createElement('span');
      rl.className = 'rl';
      rl.textContent = src.label;
      const rv = document.createElement('span');
      rv.className = 'rv';
      rv.textContent = valText;
      s.append(rl, rv);
      s.title = `${src.label} = ${valText}`;
    } else {
      s.textContent = valText;
      s.title = 'Live value from another line';
    }
    const ci = state.colors[tok.ref];
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
      const s = fmt(r.v);
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
      val.textContent = s;
      resEl.append(eq, val);
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

/* ---- hover: light up a result and every reference to it ---- */

let hoverRefId = null;

// Re-applied after every render so the highlight survives re-renders while
// the pointer rests on a chip or result.
function applyRefHighlight() {
  linesEl.querySelectorAll('.hl').forEach((el) => el.classList.remove('hl'));
  if (hoverRefId === null) return;
  const chips = linesEl.querySelectorAll(`.tok.ref[data-ref="${hoverRefId}"]`);
  if (!chips.length) return; // an unreferenced result has nothing to connect
  chips.forEach((el) => el.classList.add('hl'));
  const src = linesEl.querySelector(`.line[data-id="${hoverRefId}"] .result`);
  if (src) src.classList.add('hl');
}

function setRefHighlight(id) {
  if (id === hoverRefId) return;
  hoverRefId = id;
  applyRefHighlight();
}

/* ================= persistence ================= */

function save() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify({
      lines: state.lines,
      activeId: state.activeId,
      colors: state.colors,
      nextId: state.nextId,
      nextColor: state.nextColor,
    }));
  } catch { /* storage unavailable — run without persistence */ }
}

function load() {
  try {
    const d = JSON.parse(localStorage.getItem(STORE_KEY));
    if (d && Array.isArray(d.lines) && d.lines.length) {
      state.lines = d.lines;
      state.colors = d.colors || {};
      state.nextId = d.nextId || Math.max(...d.lines.map((l) => l.id)) + 1;
      state.nextColor = d.nextColor || 0;
      state.activeId = d.lines.some((l) => l.id === d.activeId)
        ? d.activeId
        : d.lines[d.lines.length - 1].id;
      state.caret = activeLine().tokens.length;
      return;
    }
  } catch { /* corrupt state — start fresh */ }
  state.lines = [{ id: state.nextId++, tokens: [] }];
  state.activeId = state.lines[0].id;
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
  if (chip) { setRefHighlight(Number(chip.dataset.ref)); return; }
  const resEl = e.target.closest('.result');
  if (resEl) { setRefHighlight(Number(resEl.closest('.line').dataset.id)); return; }
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
  const key = /^[0-9]$/.test(e.key) ? e.key : map[e.key];
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
  if (b) press(b.dataset.key);
});

const undoBtn = document.getElementById('undo');
const redoBtn = document.getElementById('redo');
const isMac = /Mac|iP/.test(navigator.platform || '');
undoBtn.title = isMac ? 'Undo (⌘Z)' : 'Undo (Ctrl+Z)';
redoBtn.title = isMac ? 'Redo (⇧⌘Z)' : 'Redo (Ctrl+Y)';
undoBtn.addEventListener('click', undo);
redoBtn.addEventListener('click', redo);

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
render();

// Debug/console access.
window.__bionicalc = { state, evaluateAll, undoStack, redoStack };
