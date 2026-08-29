// Headless smoke test for BioniCalc: stub the DOM, load app.js, drive press()/clicks.
// Run with: node test.js
const fs = require('fs');
const vm = require('vm');
const path = require('path');

function el() {
  return {
    className: '', textContent: '', title: '', dataset: {},
    style: { setProperty() {} },
    classList: { add() {}, remove() {} },
    appendChild(c) { return c; }, append() {},
    setAttribute() {}, removeAttribute() {},
    querySelector() { return null; }, querySelectorAll() { return []; },
    addEventListener() {}, scrollIntoView() {},
  };
}

const byId = {};
const sandbox = {
  console, setTimeout, clearTimeout,
  document: {
    getElementById(id) { return (byId[id] ||= el()); },
    createElement() { return el(); },
    createElementNS() { return el(); },
  },
  window: { addEventListener() {} },
  navigator: { platform: 'MacIntel' },
  localStorage: { getItem() { return null; }, setItem() {} },
};
sandbox.window.window = sandbox.window;
const ctx = vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), ctx, { filename: 'app.js' });

let failures = 0;
function check(name, actual, expected) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}  ->  ${JSON.stringify(actual)}${ok ? '' : `  (expected ${JSON.stringify(expected)})`}`);
}

const t = (code) => vm.runInContext(code, ctx);
const res = (i) => t(`(() => { const l = state.lines[${i}]; const r = results.get(l.id); return r === null ? null : r.err ? r.err : r.v; })()`);
const keys = (s) => { for (const k of s) t(`press(${JSON.stringify(k)})`); };
// Jump to the end of the document, then open a new line (Enter inserts after the ACTIVE line).
const NL = () => {
  t('state.activeId = state.lines[state.lines.length - 1].id; state.caret = activeLine().tokens.length; state.sel = null; update();');
  keys(['enter']);
};

// 1. Basic arithmetic with live result
keys(['1', '2', '+', '3', '4']);
check('12 + 34', res(0), 46);

// 2. Incomplete input evaluates longest valid prefix
keys(['+']);
check('trailing operator ignored', res(0), 46);
keys(['backspace']);

// 3. New line, operator auto-references previous result
keys(['enter', '*', '2']);
check('auto-ref: [46] × 2', res(1), 92);
check('line 2 starts with a ref token', t('state.lines[1].tokens[0].t'), 'r');

// 4. Edit a number upstream -> dependents update (select "34", retype "50")
t('state.activeId = state.lines[0].id; state.sel = { idx: 2 };');
keys(['5', '0']);
check('edited line: 12 + 50', res(0), 62);
check('dependent updated: [62] × 2', res(1), 124);

// 5. Enter after editing line 0 inserts the new line right below it
keys(['enter']);
check('new line inserted after active line', t('state.lines[1].tokens.length'), 0);
t('removeLine(state.activeId); update();');

// 6. Parens, percent, precedence
NL();
keys(['(', '1', '+', '2', ')', '%']);
check('(1+2)% = 0.03', res(2), 0.03);
NL();
keys(['2', '+', '3', '*', '4']);
check('precedence 2+3×4', res(3), 14);

// 7. Division by zero -> Error
NL();
keys(['1', '/', '0']);
check('1/0 is Error', res(4), 'Error');

// 8. Explicit ref insertion (clicking a result): line 0 into a new line
NL();
keys(['9', '+']);
t('insertRefFrom(state.lines[0].id)');
check('9 + [62]', res(5), 71);

// 9. Auto-multiply: digit typed right after a ref
NL();
t('insertRefFrom(state.lines[0].id)');
keys(['3']);
check('[62] 3 becomes [62] × 3', res(6), 186);
check('auto-inserted operator', t('state.lines[6].tokens[1].v'), '*');

// 10. Self-references and references to result-less lines are rejected
t('state.activeId = state.lines[0].id; state.caret = state.lines[0].tokens.length; state.sel = null;');
t('insertRefFrom(state.lines[0].id)');
check('self-ref rejected', t('state.lines[0].tokens.length'), 3);
t('insertRefFrom(state.lines[4].id)');
check('ref to error line rejected', t('state.lines[0].tokens.length'), 3);

// 11. Deleting a referenced line freezes its value downstream
t('removeLine(state.lines[0].id); update();');
check('line count after delete', t('state.lines.length'), 6);
check('old ref frozen to 62: 62 × 2', res(0), 124);
check('frozen token is a plain number', t('state.lines[0].tokens[0]'), { t: 'n', v: '62' });
check('other dependents frozen too: 9 + 62', res(4), 71);

// 12. Unary minus and backspace digit editing
NL();
keys(['-', '5', '*', '-', '3']);
check('-5 × -3', res(6), 15);
keys(['backspace', '8']);
check('backspace then 8: -5 × -8', res(6), 40);

// 13. Adjacent numbers merge when the operator between them is deleted
NL();
keys(['1', '2', '+', '3']);
t('state.caret = 2; backspace(); update();');
check('deleting + merges 12,3 -> 123', res(7), 123);

// 14. Empty new line has no result; enter on empty line is a no-op
NL();
const n = t('state.lines.length');
keys(['enter']);
check('enter on empty line adds nothing', t('state.lines.length'), n);
check('empty line result is null', res(8), null);

// 15. Decimal typing and formatting helpers
keys(['.', '5', '+', '1', '.', '2', '5']);
check('0.5 + 1.25', res(8), 1.75);
check('fmt cleans float noise', t('fmt(0.1 + 0.2)'), '0.3');
check('fmt grouping', t('fmt(1234567.891)'), '1,234,567.891');
check('fmtNum grouping', t('fmtNum("1234567.5")'), '1,234,567.5');

// 16. Undo/redo: enter + a typed run of digits = two coalesced steps
const stackLen = t('undoStack.length');
NL();
keys(['7', '7']);
check('enter + typing = 2 undo steps', t('undoStack.length'), stackLen + 2);
t('undo()');
check('undo removes the typed digits', t('state.lines[9].tokens.length'), 0);
t('undo()');
check('second undo removes the line', t('state.lines.length'), 9);
t('redo()');
t('redo()');
check('redo restores 77', res(9), 77);

// 17. Operator and following digit are separate steps
keys(['+', '3']);
check('77 + 3', res(9), 80);
t('undo()');
check('undo removes the 3', t('state.lines[9].tokens.length'), 2);
t('undo()');
check('undo removes the +', t('state.lines[9].tokens.length'), 1);

// 18. Labels: set (trimmed), undo, redo
t('startLabelEdit(state.lines[9].id)');
t('commitLabel(state.lines[9].id, "  subtotal  ")');
check('label set and trimmed', t('state.lines[9].label'), 'subtotal');
t('undo()');
check('label undone', t('state.lines[9].label'), undefined);
t('redo()');
check('label redone', t('state.lines[9].label'), 'subtotal');

// 19. Deleting a referenced line is undoable — the live ref comes back
NL();
keys(['+', '1']);
check('auto-ref to labeled line: [77] + 1', res(10), 78);
t('(() => { const b = snapshot(); removeLine(state.lines[9].id); commitHistory(b, null); update(); })()');
check('after delete: frozen 77 + 1', res(9), 78);
check('ref frozen to a number', t('state.lines[9].tokens[0].t'), 'n');
t('undo()');
check('undo restores the line', t('state.lines.length'), 11);
check('undo restores the live ref', t('state.lines[10].tokens[0].t'), 'r');
check('label survived the round trip', t('state.lines[9].label'), 'subtotal');

// 20. Reordering keeps references live (forward refs now evaluate)
t('state.activeId = state.lines[10].id; state.caret = 0; state.sel = null;');
t('moveLine(-1)');
check('dependent moved above its source', t('state.lines[9].tokens[0].t'), 'r');
check('forward ref still live: 78', res(9), 78);
t('undo()');
check('undo restores order', res(10), 78);

// 21. Consecutive keyboard moves coalesce into one undo step
const mv = t('undoStack.length');
t('state.activeId = state.lines[10].id;');
t('moveLine(-1); moveLine(-1);');
check('two moves = one undo step', t('undoStack.length'), mv + 1);
check('line moved up two slots', t('state.lines[8].tokens[0].t'), 'r');
t('undo()');
check('one undo restores both moves', t('state.lines[10].tokens[0].t'), 'r');

// 22. Referencing a line below is allowed when acyclic
t('state.activeId = state.lines[0].id; state.caret = state.lines[0].tokens.length; state.sel = null;');
t('insertRefFrom(state.lines[1].id)');
check('forward reference inserted', t('state.lines[0].tokens.length'), 5);
check('124 × 0.03 = 3.72', t('fmt(results.get(state.lines[0].id).v)'), '3.72');

// 23. A reference that would close a cycle is rejected
t('state.activeId = state.lines[1].id; state.caret = state.lines[1].tokens.length; state.sel = null;');
t('insertRefFrom(state.lines[0].id)');
check('cycle rejected at insertion', t('state.lines[1].tokens.length'), 6);

// 24. Defensive: a forced cycle evaluates to an error, not a hang
t('state.lines[1].tokens.push({t:"o",v:"+"},{t:"r",ref:state.lines[0].id}); update(); 0');
check('forced cycle errors line A', res(0), '—');
check('forced cycle errors line B', res(1), '—');
t('state.lines[1].tokens.length -= 2; update(); 0');
check('recovers when cycle removed', t('fmt(results.get(state.lines[0].id).v)'), '3.72');

// 25. Units: typed entry, mixed-unit addition converts to the left unit
const lastVal = () => t('fmtVal(results.get(state.lines[state.lines.length - 1].id))');
NL();
keys(['1', '2', 'c', 'm', '+', '3', '0', 'm', 'm']);
check('12cm + 30mm', lastVal(), '15 cm');

// 26. Unitless operands adopt the united side's unit; percent keeps units
NL();
keys(['1', '0', 'c', 'm', '+', '5']);
check('10cm + 5', lastVal(), '15 cm');
NL();
keys(['1', '0', 'c', 'm', '*', '5', '0', '%']);
check('10cm × 50%', lastVal(), '5 cm');

// 27. Multiplication and division compose and cancel units
NL();
keys(['2', 'c', 'm', '*', '3', 'c', 'm']);
check('2cm × 3cm', lastVal(), '6 cm²');
NL();
keys(['1', '0', '0', 'k', 'm', '/', '2', 'h']);
check('100km / 2h', lastVal(), '50 km/h');
NL();
keys(['1', 'm', '/', '5', '0', 'c', 'm']);
check('1m / 50cm cancels to a ratio', lastVal(), '2');

// 28. Volume is length³, so cm·cm·cm meets ml
NL();
keys(['2', 'c', 'm', '*', '3', 'c', 'm', '*', '4', 'c', 'm', '+', '1', '0', 'm', 'l']);
check('2cm × 3cm × 4cm + 10ml', lastVal(), '34 cm³');

// 29. Incompatible dimensions error; incomplete units are ignored
NL();
keys(['5', 'k', 'g', '+', '3', 'c', 'm']);
check('kg + cm is a unit error', res(t('state.lines.length') - 1), 'unit error');
NL();
keys(['1', 'c']);
check('half-typed unit is ignored', lastVal(), '1');
keys(['backspace']);
check('backspace removes the unit letter', t('state.lines[state.lines.length - 1].tokens.length'), 1);
keys(['q']);
check('non-unit letter is ignored', t('state.lines[state.lines.length - 1].tokens.length'), 1);

// 30. A unit typed after a reference converts it
NL();
keys(['1', '5', 'c', 'm']);
NL();
t('insertRefFrom(state.lines[state.lines.length - 2].id)');
keys(['m', 'm']);
check('[15 cm] mm converts', lastVal(), '150 mm');

// 31. Deleting a referenced line freezes value AND unit
NL();
keys(['+', '2']);
check('auto-ref continues from converted value', lastVal(), '152 mm');
t('(() => { const src = state.lines[state.lines.length - 3]; const b = snapshot(); removeLine(src.id); commitHistory(b, null); update(); })()');
check('frozen with unit intact', lastVal(), '152 mm');
check('frozen tokens are number + unit', t('state.lines[state.lines.length - 2].tokens.slice(0, 2).map((x) => x.t).join("")'), 'nu');

// 32. Tapped units (keypad): insert, swap, and quick-row promotion
NL();
keys(['5', 'unit:cm']);
check('5 + tap cm', lastVal(), '5 cm');
keys(['unit:mm']);
check('tapping another unit swaps it', lastVal(), '5 mm');
keys(['unit:kg']);
check('swap across dimensions too', lastVal(), '5 kg');
check('quick row is most-recently-used', t('JSON.stringify(quickUnits)'), '["kg","mm","cm","m"]');

// 33. Tapped unit coalesces with the number for undo
const uStack = t('undoStack.length');
NL();
keys(['7', 'unit:km']);
check('number + tapped unit = one undo step', t('undoStack.length'), uStack + 2); // NL + typing run
t('undo()');
check('one undo clears both', t('state.lines[state.lines.length - 1].tokens.length'), 0);

// 34. Tapped unit after a reference converts it
NL();
keys(['2', 'm']);
NL();
t('insertRefFrom(state.lines[state.lines.length - 2].id)');
keys(['unit:cm']);
check('[2 m] tap cm converts', lastVal(), '200 cm');

// 35. Tapping a unit on an empty line is a no-op
NL();
keys(['unit:cm']);
check('unit tap needs a value first', t('state.lines[state.lines.length - 1].tokens.length'), 0);

// 36. Projects: separate documents with separate undo stacks
check('starts with one project', t('projects.length'), 1);
const p1 = t('currentProjectId');
const p1Undo = t('undoStack.length');
const p1Lines = t('state.lines.length');
t('newProject()');
check('new project created and adopted', t('projects.length'), 2);
check('fresh project is one empty line', t('state.lines.length'), 1);
check('fresh project has a fresh undo stack', t('undoStack.length'), 0);
keys(['4', '2']);
check('typing lands in project 2', res(0), 42);
check('project 2 has one undo step', t('undoStack.length'), 1);
t(`switchProject(${p1})`);
check('project 1 document intact', t('state.lines.length'), p1Lines);
check('project 1 undo stack intact', t('undoStack.length'), p1Undo);
t('switchProject(projects[1].id)');
check('project 2 document kept across switches', res(0), 42);
check('project 2 undo stack kept across switches', t('undoStack.length'), 1);
t('undo()');
check('undo stays inside project 2', res(0), null);
check('project 1 still untouched by that undo', t(`projects.find(p => p.id === ${p1}).sheets[0].lines.length`), p1Lines);

// 37. Rename (trimmed) and delete (falls back to the neighbor)
t('renameProject(currentProjectId, "  Bench  ");');
check('rename trims and applies', t('projects[1].name'), 'Bench');
t('deleteProject(currentProjectId)');
check('delete removes the project', t('projects.length'), 1);
check('neighbor project adopted', t('currentProjectId'), p1);
check('adopted document is project 1', t('state.lines.length'), p1Lines);

// 38. Old single-document storage migrates into a project
{
  const stored = {
    data: JSON.stringify({
      lines: [{ id: 1, tokens: [{ t: 'n', v: '7' }] }],
      activeId: 1, colors: {}, nextId: 2, nextColor: 0,
    }),
  };
  const sb = {
    console, setTimeout, clearTimeout,
    document: { getElementById: () => el(), createElement: () => el(), createElementNS: () => el() },
    window: { addEventListener() {} },
    navigator: { platform: 'MacIntel' },
    localStorage: {
      getItem: () => stored.data,
      setItem: (k, v) => { stored.data = v; },
    },
  };
  sb.window.window = sb.window;
  const ctx2 = vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), ctx2, { filename: 'app.js' });
  const m = (c) => vm.runInContext(c, ctx2);
  check('migration: one project', m('projects.length'), 1);
  check('migration: document intact', m('results.get(state.lines[0].id).v'), 7);
  check('migration: named', m('projects[0].name'), 'Project 1');
  check('migration: wrapped into one sheet', m('projects[0].sheets.filter(s => s.kind !== "cuts").length'), 1);
  check('migration adds the pinned Cuts sheet', m('projects[0].sheets[projects[0].sheets.length - 1].kind'), 'cuts');
  check('migration: saved with sheets', m('JSON.parse(localStorage.getItem("bionicalc.v1")).projects[0].sheets.filter(s => s.kind !== "cuts").length'), 1);
}

// 38b. The previous format (documents at the project level) migrates too
{
  const stored = {
    data: JSON.stringify({
      projects: [{
        id: 3, name: 'Bench',
        lines: [{ id: 1, tokens: [{ t: 'n', v: '5' }] }],
        activeId: 1, colors: {}, nextId: 2, nextColor: 0,
      }],
      currentId: 3, nextProjectId: 4,
    }),
  };
  const sb = {
    console, setTimeout, clearTimeout,
    document: { getElementById: () => el(), createElement: () => el(), createElementNS: () => el() },
    window: { addEventListener() {} },
    navigator: { platform: 'MacIntel' },
    localStorage: {
      getItem: () => stored.data,
      setItem: (k, v) => { stored.data = v; },
    },
  };
  sb.window.window = sb.window;
  const ctx3 = vm.createContext(sb);
  vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), ctx3, { filename: 'app.js' });
  const m = (c) => vm.runInContext(c, ctx3);
  check('sheetless project migrates', m('projects[0].sheets.filter(s => s.kind !== "cuts").length'), 1);
  check('project name kept through migration', m('projects[0].name'), 'Bench');
  check('migrated sheet evaluates', m('results.get(state.lines[0].id).v'), 5);
}

// 39. Import appends sanitized projects (never overwrites)
const before39 = t('projects.length');
const payload = {
  app: 'bionicalc',
  version: 1,
  projects: [
    {
      name: '  Deck  ',
      lines: [
        { id: 1, tokens: [{ t: 'n', v: '2' }, { t: 'o', v: '*' }, { t: 'n', v: '3' }] },
        { id: 2, tokens: [{ t: 'r', ref: 1 }, { t: 'o', v: '+' }, { t: 'n', v: '4' }] },
      ],
      activeId: 2, colors: { 1: 99 }, nextId: 3, nextColor: 1,
    },
    { name: 'Units', lines: [{ id: 1, tokens: [{ t: 'n', v: '5' }, { t: 'u', v: 'cm' }, { t: 'bogus' }, null] }], nextId: 2 },
  ],
};
check('import returns count', t(`importProjectsFromData(${JSON.stringify(payload)})`), 2);
check('existing projects untouched', t('projects.length'), before39 + 2);
check('first imported project adopted, name trimmed',
  t('projects.find(p => p.id === currentProjectId).name'), 'Deck');
check('imported references evaluate', res(1), 10);
check('imported color index sanitized', t('state.colors[1] >= 0 && state.colors[1] < 8'), true);
t('switchProject(projects[projects.length - 1].id)');
check('malformed tokens filtered out', t('state.lines[0].tokens.length'), 2);
check('imported units evaluate', lastVal(), '5 cm');

// 40. Garbage is rejected; legacy single-document files wrap into a project
check('garbage import rejected', t('importProjectsFromData({ nope: true })'), 0);
check('legacy single-doc import wraps',
  t('importProjectsFromData({ lines: [{ id: 1, tokens: [{ t: "n", v: "9" }] }] })'), 1);
check('legacy import named', t('projects[projects.length - 1].name'), 'Imported');
check('legacy import evaluates', res(0), 9);

// 41. Sheets: separate pages within a project, each with its own undo
check('project starts with one sheet', t('currentProject().sheets.filter(s => s.kind !== "cuts").length'), 1);
const s1Undo = t('undoStack.length');
t('newSheet()');
check('sheet added and adopted', t('currentProject().sheets.filter(s => s.kind !== "cuts").length'), 2);
check('fresh sheet is empty', res(0), null);
check('fresh sheet has a fresh undo stack', t('undoStack.length'), 0);
keys(['7']);
check('typing lands in the new sheet', res(0), 7);
t('switchSheet(currentProject().sheets[0].id)');
check('first sheet restored', res(0), 9);
check('first sheet undo untouched', t('undoStack.length'), s1Undo);
t('switchSheet(currentProject().sheets[1].id)');
check('second sheet kept across switches', res(0), 7);
check('second sheet undo kept', t('undoStack.length'), 1);
t('renameSheet(currentProject().currentSheetId, "  Drawers  ")');
check('sheet renamed and trimmed', t('currentSheet().name'), 'Drawers');
t('deleteSheet(currentProject().currentSheetId)');
check('sheet deleted', t('currentProject().sheets.filter(s => s.kind !== "cuts").length'), 1);
check('neighbor sheet adopted', res(0), 9);

// 42. Importing the current format preserves sheets
const nf = {
  projects: [{
    name: 'NewFmt',
    sheets: [
      { name: 'Carcase', lines: [{ id: 1, tokens: [{ t: 'n', v: '3' }] }] },
      { name: 'Drawers', lines: [{ id: 1, tokens: [{ t: 'n', v: '4' }] }] },
    ],
  }],
};
check('sheeted import accepted', t(`importProjectsFromData(${JSON.stringify(nf)})`), 1);
check('sheets preserved on import', t('currentProject().sheets.filter(s => s.kind !== "cuts").length'), 2);
check('sheet names preserved', t('currentProject().sheets.filter(s => s.kind !== "cuts").map(s => s.name).join(",")'), 'Carcase,Drawers');
check('first imported sheet adopted', res(0), 3);
t('switchSheet(currentProject().sheets[1].id)');
check('second imported sheet evaluates', res(0), 4);

// 43. Cross-sheet references: a master sheet's parameters drive detail sheets
t('newProject()');
t('renameSheet(currentProject().currentSheetId, "Master")');
keys(['6', '0', '0', 'm', 'm']);
t('startLabelEdit(state.activeId); commitLabel(state.activeId, "width")');
const masterSheetId = t('currentProject().sheets[0].id');
const widthLineId = t('currentProject().sheets[0].lines[0].id');
t('newSheet()');
t(`insertCrossRef(${masterSheetId}, ${widthLineId})`);
keys(['/', '2']);
check('cross-sheet ref evaluates', lastVal(), '300 mm');

// editing the master updates the detail sheet
t(`switchSheet(${masterSheetId})`);
t('state.sel = { idx: 0 };');
keys(['8', '0', '0']);
check('master edited', lastVal(), '800 mm');
t('switchSheet(currentProject().sheets[1].id)');
check('detail follows the master', lastVal(), '400 mm');

// 44. Cycles across sheets are rejected
t('startLabelEdit(state.activeId); commitLabel(state.activeId, "half")');
const detailSheetId = t('currentProject().currentSheetId');
const detailLineId = t('state.activeId');
t(`switchSheet(${masterSheetId})`);
t('state.activeId = state.lines[0].id; state.caret = state.lines[0].tokens.length; state.sel = null;');
t(`insertCrossRef(${detailSheetId}, ${detailLineId})`);
check('cross-sheet cycle rejected', t('state.lines[0].tokens.length'), 2);

// 45. Deleting a sheet freezes cross-references into it
t(`switchSheet(${detailSheetId})`);
t(`deleteSheet(${masterSheetId})`);
check('cross ref frozen on sheet delete', lastVal(), '400 mm');
check('frozen to number + unit', t('state.lines[0].tokens.slice(0, 2).map(x => x.t).join("")'), 'nu');

// 46. Export/import round-trips cross-sheet references (sheet ids remapped)
t('newProject()');
t('renameSheet(currentProject().currentSheetId, "M2")');
keys(['5', '0']);
t('startLabelEdit(state.activeId); commitLabel(state.activeId, "param")');
const m2Sheet = t('currentProject().currentSheetId');
const m2Line = t('state.activeId');
t('newSheet()');
t(`insertCrossRef(${m2Sheet}, ${m2Line})`);
keys(['*', '3']);
check('setup: [param] × 3', lastVal(), '150');
const roundTrip = t('JSON.stringify({ projects: [JSON.parse(JSON.stringify(currentProject()))] })');
check('re-import of exported project', t(`importProjectsFromData(${roundTrip})`), 1);
t('switchSheet(currentProject().sheets[1].id)');
check('cross ref survives import remap', lastVal(), '150');
check('imported chip still cross-sheet', t('state.lines[0].tokens[0].sheet'), 1);

// 47. Powered unit suffixes: entry, conversion, cycling, freezing
NL();
keys(['5', 'm', '2']);
check('5m2 enters square meters', lastVal(), '5 m²');
NL();
keys(['2', 'm', '2', '+', '5', '0', '0', '0', 'c', 'm', '2']);
check('mixed-power addition converts', lastVal(), '2.5 m²');
NL();
keys(['4', '4', 'm', 'm', '*', '9', '6', 'm', 'm']);
check('setup: area in mm²', lastVal(), '4,224 mm²');
NL();
t('insertRefFrom(state.lines[state.lines.length - 2].id)');
keys(['c', 'm', '2']);
check('[area mm²] cm2 converts', lastVal(), '42.24 cm²');
NL();
keys(['1', 'l']);
NL();
t('insertRefFrom(state.lines[state.lines.length - 2].id)');
keys(['c', 'm', '3']);
check('[1 l] cm3 bridges volume to length³', lastVal(), '1,000 cm³');
NL();
keys(['5', 'unit:cm', 'unit:cm']);
check('tapping the same unit squares it', lastVal(), '5 cm²');
keys(['unit:cm']);
check('third tap cubes it', lastVal(), '5 cm³');
keys(['unit:cm']);
check('fourth tap cycles back', lastVal(), '5 cm');
keys(['unit:cm', 'backspace']);
check('backspace strips the power first', t('state.lines[state.lines.length - 1].tokens[1].v'), 'cm');
keys(['2', '5']);
check('digit after a powered unit multiplies', lastVal(), '25 cm²');

// 48. Deleting a line freezes powered units intact
NL();
keys(['3', 'm', '2']);
t('startLabelEdit(state.activeId); commitLabel(state.activeId, "panel")');
NL();
keys(['+', '1', 'm', '2']);
t('(() => { const src = state.lines[state.lines.length - 2]; const b = snapshot(); removeLine(src.id); commitHistory(b, null); update(); })()');
check('powered unit frozen on delete', lastVal(), '4 m²');
check('frozen token keeps its power', t('state.lines[state.lines.length - 1].tokens[1].v'), 'm2');

// 49. Component blanks: create with "b", fill w/h/t, unitless parts adopt mm
NL();
keys(['b']);
check('b on an empty line makes a component', t('activeLine().kind'), 'comp');
check('quantity prefilled with 1', t('activeLine().parts.n[0].v'), '1');
keys(['1', '2', '0', 'm', 'm', 'enter', '4', '5', 'enter', '1', '9', 'enter']);
check('dims resolve, unitless adopts mm', t('fmtComp(results.get(state.activeId))'), '120 × 45 × 19 mm ×1');
check('component value is total volume', lastVal(), '102,600 mm³');
keys(['4']);
check('enter lands on qty pre-selected: typing replaces the 1', lastVal(), '410,400 mm³');

// 50. Enter from qty begets another component; b toggles a pristine one back
keys(['enter']);
check('enter from a component adds a component', t('activeLine().kind'), 'comp');
check('the new component is pristine', t('compIsPristine(activeLine())'), true);
keys(['b']);
check('b converts a pristine component back', t('activeLine().kind === undefined'), true);
check('parts removed on conversion', t('activeLine().parts === undefined'), true);

// 51. Component parts reference other lines and stay live
keys(['6', '0', '0', 'm', 'm']);
const src600 = t('state.activeId');
keys(['b']); // non-empty line: b inserts a new component after it
check('b after a full line inserts a component', t('activeLine().kind'), 'comp');
t(`insertRefFrom(${src600})`);
keys(['-', '4', '0', 'enter', '4', '5', 'enter', '1', '9', 'enter', '2']);
const compA = t('state.activeId');
check('width = [600 mm] − 40', t(`fmtComp(results.get(${compA}))`), '560 × 45 × 19 mm ×2');
check('volume follows', lastVal(), '957,600 mm³');
t(`state.activeId = ${src600}; state.sel = { idx: 0 };`);
keys(['5', '0', '0']);
check('editing the source updates the blank', t(`fmtComp(results.get(${compA}))`), '460 × 45 × 19 mm ×2');

// 52. Referencing a component yields its volume; a unit suffix converts it
t(`state.activeId = ${compA}; caretToEnd(); state.sel = null;`);
keys(['enter', 'b']); // component + toggle back = calc line after a component
t(`insertRefFrom(${compA})`);
keys(['l']);
const volLine = t('state.activeId');
check('[blank] l converts total volume to liters', lastVal(), '0.7866 l');

// 53. Quantity must be a bare number; unitless components work.
// (Keyboard "b" right after the unit "l" completes "lb" instead — the pad
// key is unambiguous.)
check('b after l extends the unit to lb', t('(() => { const n = curToks().length; press("b"); const v = curToks()[n - 1].v; press("backspace"); return v; })()'), 'lb');
keys(['blank']);
keys(['1', '0', 'enter', '1', '0', 'enter', '1', '0', 'enter', '2', 'm', 'm']);
check('unit on qty is an error', t('results.get(state.activeId).err'), 'unit error');
keys(['backspace', 'backspace']);
check('all-unitless component evaluates plain', lastVal(), '2,000');

// 54. Deleting a referenced component freezes its volume downstream
t(`(() => { const b = snapshot(); removeLine(${compA}); commitHistory(b, null); update(); })()`);
check('volume frozen on component delete', t(`fmtVal(results.get(${volLine}))`), '0.7866 l');
check('frozen to number + unit', t(`state.lines.find(l => l.id === ${volLine}).tokens.slice(0, 2).map(x => x.t).join("")`), 'nu');
check('frozen unit keeps its power', t(`state.lines.find(l => l.id === ${volLine}).tokens[1].v`), 'mm3');

// 55. Deleting a line referenced BY a component part freezes inside the part
t('state.activeId = state.lines[state.lines.length - 1].id; caretToEnd(); state.sel = null;');
keys(['enter', 'b']);
keys(['1', '0', '0', 'm', 'm']);
const src100 = t('state.activeId');
keys(['b']);
t(`insertRefFrom(${src100})`);
keys(['enter', '5', 'enter', '5', 'enter']);
const compB = t('state.activeId');
check('setup: [100 mm] × 5 × 5', lastVal(), '2,500 mm³');
t(`(() => { const b = snapshot(); removeLine(${src100}); commitHistory(b, null); update(); })()`);
check('part frozen to number + unit', t(`state.lines.find(l => l.id === ${compB}).parts.w.map(x => x.t).join("")`), 'nu');
check('volume unchanged after freeze', lastVal(), '2,500 mm³');

// 56. Cycles through component parts are rejected
t(`state.activeId = ${compB}; caretToEnd(); state.sel = null;`);
keys(['enter', 'b']);
t(`insertRefFrom(${compB})`);
const cycLine = t('state.activeId');
t(`state.activeId = ${compB}; state.part = 'w'; state.caret = state.lines.find(l => l.id === ${compB}).parts.w.length; state.sel = null;`);
t(`insertRefFrom(${cycLine})`);
check('cycle through a part rejected', t(`state.lines.find(l => l.id === ${compB}).parts.w.length`), 2);

// 57. Undo steps: new line, blank conversion, coalesced digits
t('state.activeId = state.lines[state.lines.length - 1].id; caretToEnd(); state.sel = null; update();');
const compStack = t('undoStack.length');
keys(['enter', 'b', '1', '2']);
check('enter + b + digits = 3 undo steps', t('undoStack.length'), compStack + 3);
t('undo()');
check('undo clears the typed width', t('activeLine().parts.w.length'), 0);
t('undo()');
check('second undo reverts to a calc line', t('activeLine().kind === undefined'), true);
t('undo()');

// 58. Arrow keys and backspace hop between parts
keys(['enter', 'b']); // fresh component (last line is non-empty after undos)
keys(['2', '0', 'm', 'm', 'enter', '2', 'c', 'm', 'enter', '5', 'm', 'm', 'enter']);
check('mixed units shown per part', t('fmtComp(results.get(state.activeId))'), '20 mm × 2 cm × 5 mm ×1');
check('mixed units compose the volume', lastVal(), '2,000 mm³');
keys(['left', 'left']);
check('left from qty start hops to thickness', t('state.part'), 't');
t('state.caret = 0;');
keys(['backspace']);
check('backspace at part start hops back', t('state.part'), 'h');
check('caret lands at the end of that part', t('state.caret'), 2);

// 59. Components survive export/import (live part refs included)
t('state.activeId = state.lines[state.lines.length - 1].id; caretToEnd(); state.sel = null;');
keys(['enter', 'b', '3', '0', 'm', 'm']);
const src30 = t('state.activeId');
keys(['b']);
t(`insertRefFrom(${src30})`);
keys(['*', '2', 'enter', '5', 'enter', '5', 'enter']);
check('setup: [30 mm] × 2 wide', lastVal(), '1,500 mm³');
const compCount = t('state.lines.filter(l => l.kind === "comp").length');
const rtComp = t('JSON.stringify({ projects: [JSON.parse(JSON.stringify(currentProject()))] })');
check('re-import with components', t(`importProjectsFromData(${rtComp})`), 1);
t('switchSheet(currentProject().sheets[1].id)');
check('component lines survive import', t('state.lines.filter(l => l.kind === "comp").length'), compCount);
check('first imported blank intact', t('fmtComp(results.get(state.lines.find(l => l.kind === "comp").id))'), '120 × 45 × 19 mm ×4');
check('part ref still live after import', t('fmtComp(results.get(state.lines.filter(l => l.kind === "comp").pop().id))'), '60 × 5 × 5 mm ×1');

// 60. Every project pins a Cuts sheet; regular sheets stay ahead of it
t('newProject()');
check('new project pins a Cuts sheet', t('currentProject().sheets[currentProject().sheets.length - 1].kind'), 'cuts');
check('cuts sheet is named Cuts', t('currentProject().sheets.find(s => s.kind === "cuts").name'), 'Cuts');
check('cuts sheet starts with a material line', t('currentProject().sheets.find(s => s.kind === "cuts").lines[0].kind'), 'comp');
t('newSheet()');
check('new sheets insert ahead of Cuts', t('currentProject().sheets[currentProject().sheets.length - 1].kind'), 'cuts');

// 61. A blank on a calc sheet + materials on the Cuts page
keys(['b', '1', '0', '0', 'm', 'm', 'enter', '5', '0', 'enter', '1', '0', 'enter', '2']);
check('part blank on a calc sheet', lastVal(), '100,000 mm³');
const cutsId = t('currentProject().sheets.find(s => s.kind === "cuts").id');
t(`switchSheet(${cutsId})`);
check('landing on a pristine material starts at width', t('state.part'), 'w');
keys(['2', '4', '4', '0', 'm', 'm', 'enter', '1', '2', '2', '0', 'enter', '1', '8', 'enter']);
check('material entered', t('fmtComp(results.get(state.activeId))'), '2,440 × 1,220 × 18 mm ×1');
keys(['enter']);
check('enter on Cuts begets another material', t('activeLine().kind'), 'comp');
keys(['b']);
check('materials cannot toggle back to calc lines', t('activeLine().kind'), 'comp');

// 62. The Cuts sheet cannot be deleted
const sheetsBefore = t('currentProject().sheets.length');
t(`deleteSheet(${cutsId})`);
check('cuts sheet delete refused', t('currentProject().sheets.length'), sheetsBefore);
check('cuts sheet still there', t('currentProject().sheets.some(s => s.kind === "cuts")'), true);

// 63. cutsData aggregates parts (other sheets) and stock (Cuts lines)
check('cuts aggregation', t('(() => { const d = cutsData(currentProject()); return { parts: d.parts.length, pieces: d.pieces, partsMm3: Math.round(d.partsVol * 1e9), stockMm3: Math.round(d.stockVol * 1e9) }; })()'),
  { parts: 1, pieces: 2, partsMm3: 100000, stockMm3: 53582400 });
check('fmtVol picks liters from 1 l', t('fmtVol(0.0535824)'), '53.5824 l');
check('fmtVol picks cm³ below', t('fmtVol(0.0001)'), '100 cm³');

// 64. Export/import keeps exactly one Cuts sheet, materials intact
const rtc = t('JSON.stringify({ projects: [JSON.parse(JSON.stringify(currentProject()))] })');
check('cuts project re-imports', t(`importProjectsFromData(${rtc})`), 1);
check('exactly one Cuts sheet after import', t('currentProject().sheets.filter(s => s.kind === "cuts").length'), 1);
check('imported material intact', t('(() => { const c = currentProject().sheets.find(s => s.kind === "cuts"); return fmtComp(projResults.get(c.id + ":" + c.lines[0].id)); })()'),
  '2,440 × 1,220 × 18 mm ×1');

// 65. Imports without a Cuts sheet gain one
check('legacy import gains a Cuts sheet', t('(() => { importProjectsFromData({ lines: [{ id: 1, tokens: [{ t: "n", v: "9" }] }] }); return currentProject().sheets.some(s => s.kind === "cuts"); })()'), true);

// 66. Parts group by thickness and match against stock thicknesses
t('newProject()');
keys(['b',
  '5', '0', '0', 'm', 'm', 'enter', '1', '0', '0', 'enter', '1', '9', 'enter', '2', 'enter',
  '3', '0', '0', 'm', 'm', 'enter', '2', '0', '0', 'enter', '1', '9', 'enter', 'enter',
  '4', '0', '0', 'm', 'm', 'enter', '1', '0', '0', 'enter', '1', '2', 'enter', '3', 'enter',
  '1', '0', '0', 'm', 'm', 'enter', '1', '0', '0', 'enter', '1', '.', '9', 'c', 'm']);
const cuts66 = t('currentProject().sheets.find(s => s.kind === "cuts").id');
t(`switchSheet(${cuts66})`);
keys(['2', '4', '4', '0', 'm', 'm', 'enter', '1', '2', '2', '0', 'enter', '1', '9', 'enter']);
t('startLabelEdit(state.activeId); commitLabel(state.activeId, "ply19")');
check('groups by thickness, thinnest first, 1.9cm folds into 19mm',
  t('(() => { const d = cutsData(currentProject()); return d.groups.map(g => ({ label: g.label, n: g.parts.length, matched: g.matched, names: g.stockNames.join(",") })); })()'),
  [
    { label: '12 mm', n: 1, matched: false, names: '' },
    { label: '19 mm', n: 3, matched: true, names: 'ply19' },
  ]);
check('group piece counts', t('cutsData(currentProject()).groups.map(g => g.pieces)'), [3, 4]);

// 67. Editing a part's thickness regroups and rematches live
t('switchSheet(currentProject().sheets[0].id)');
t('state.activeId = state.lines.find(l => l.kind === "comp").id; state.part = "t"; state.sel = { idx: 0 }; update();');
keys(['1', '2']);
check('retyped 19 -> 12 moves the part between groups',
  t('(() => { const d = cutsData(currentProject()); return d.groups.map(g => g.parts.length); })()'),
  [2, 2]);
t('undo()');
check('undo restores the grouping', t('cutsData(currentProject()).groups.map(g => g.parts.length)'), [1, 3]);

// 68. Kerf: defaults to 3 mm, settable, clamped, survives export/import
check('kerf defaults to 3 mm', t('kerfOf(currentProject())'), 3);
t('setKerf("2.8")');
check('kerf set', t('currentProject().kerf'), 2.8);
t('setKerf("999")');
check('kerf clamped', t('currentProject().kerf'), 20);
t('setKerf("2.8")');
const rtk = t('JSON.stringify({ projects: [JSON.parse(JSON.stringify(currentProject()))] })');
t(`importProjectsFromData(${rtk})`);
check('kerf survives import', t('currentProject().kerf'), 2.8);

// 69. planCuts: uniform strips per size, kerf between strips and neighbours
const P = 'const P = (w,h,n) => ({ sheet: { colors: {} }, line: { id: 1 }, entry: { si: 1, dim: { L: 3 }, comp: { w: { si: w }, h: { si: h }, n: { si: n } } } });';
check('planCuts groups same-size pieces into their own strip',
  t(`(() => { ${P} const plan = planCuts([P(0.5,0.1,2), P(0.3,0.2,1)], [P(2.44,1.22,1)], 0.01);
      const pl = plan.sheets[0].placed;
      return { sheets: plan.sheets.length, placed: pl.length, unplaced: plan.unplaced.length,
               first: pl[0].x, y2mm: Math.round(pl[1].y * 1000), x3mm: Math.round(pl[2].x * 1000),
               cuts: plan.cuts }; })()`),
  { sheets: 1, placed: 3, unplaced: 0, first: 0, y2mm: 210, x3mm: 510, cuts: 5 });

// 69b. The cabinet case: sides 600×900 ×2 + tops 580×600 ×2 on one sheet —
// identical parts pair up in uniform strips instead of mixing (6 cuts)
check('cabinet example: pairs in uniform strips',
  t(`(() => { ${P} const plan = planCuts([P(0.6,0.9,2), P(0.58,0.6,2)], [P(2.44,1.22,1)], 0.003);
      const pl = plan.sheets[0].placed;
      return { cuts: plan.cuts, strips: [...new Set(pl.map(p => Math.round(p.y * 1000)))].length,
               strip1: pl.filter(p => p.y === 0).map(p => Math.round(p.w * 1000)).join(','),
               strip2: pl.filter(p => p.y > 0).map(p => Math.round(p.w * 1000)).join(',') }; })()`),
  { cuts: 6, strips: 2, strip1: '900,900', strip2: '600,600' });

// 69c. cutList: rips first, grouped crosscuts, steps sum to the cut count
check('cabinet cut list: 2 rips then 2 grouped crosscut steps',
  t(`(() => { ${P} const plan = planCuts([P(0.6,0.9,2), P(0.58,0.6,2)], [P(2.44,1.22,1)], 0.003);
      const steps = cutList(plan.sheets[0]);
      return { seq: steps.map(s => s.kind + '@' + Math.round(s.at * 1000) + 'x' + s.count),
               total: steps.reduce((a, s) => a + s.count, 0), cuts: plan.cuts }; })()`),
  { seq: ['rip@600x1', 'rip@580x1', 'cross@900x2', 'cross@600x2'], total: 6, cuts: 6 });

// 69d. cutList: trims listed after their strip's crosscuts
check('cut list includes trims',
  t(`(() => { ${P} const plan = planCuts([P(0.3,0.2,1), P(0.25,0.1,1)], [P(0.6,0.2,1)], 0);
      const steps = cutList(plan.sheets[0]);
      return { seq: steps.map(s => s.kind + '@' + Math.round(s.at * 1000)),
               total: steps.reduce((a, s) => a + s.count, 0), cuts: plan.cuts }; })()`),
  { seq: ['cross@300', 'cross@250', 'trim@100'], total: 3, cuts: 3 });

// 69e. sheetYield: blanks plus offcuts (strip tails, trim cutoffs, remainder)
check('cabinet yield: parts and three offcuts, kerf deducted',
  t(`(() => { ${P} const plan = planCuts([P(0.6,0.9,2), P(0.58,0.6,2)], [P(2.44,1.22,1)], 0.003);
      const y = sheetYield(plan.sheets[0], 0.003);
      return { parts: y.parts.map(p => [Math.round(p.w * 1000), Math.round(p.h * 1000), p.count]),
               offcuts: y.offcuts.map(o => [Math.round(o.w * 1000), Math.round(o.h * 1000)]) }; })()`),
  { parts: [[900, 600, 2], [600, 580, 2]],
    offcuts: [[1234, 580], [634, 600], [2440, 34]] });
check('trim-case yield includes the trim cutoff',
  t(`(() => { ${P} const plan = planCuts([P(0.3,0.2,1), P(0.25,0.1,1)], [P(0.6,0.2,1)], 0);
      const y = sheetYield(plan.sheets[0], 0);
      return y.offcuts.map(o => [Math.round(o.w * 1000), Math.round(o.h * 1000)]); })()`),
  [[250, 100], [50, 200]]);

// 70. planCuts: overflow reports unplaced pieces; new shelves stack with kerf
check('planCuts overflow',
  t(`(() => { ${P} const plan = planCuts([P(0.5,0.1,2), P(0.3,0.2,1), P(0.1,0.1,1)], [P(0.6,0.3,1)], 0);
      return { placed: plan.sheets[0].placed.length, unplaced: plan.unplaced.length,
               shelf2y: Math.round(plan.sheets[0].placed[1].y * 1000) }; })()`),
  { placed: 3, unplaced: 1, shelf2y: 200 });

// 71. planCuts: rotation is tried when the natural orientation doesn't fit
check('planCuts rotates to fit',
  t(`(() => { ${P} const plan = planCuts([P(0.9,0.5,1), P(0.4,0.08,1)], [P(1.0,0.55,1)], 0);
      const second = plan.sheets[0].placed[1];
      return { placed: plan.sheets[0].placed.length, w2mm: Math.round(second.w * 1000), h2mm: Math.round(second.h * 1000) }; })()`),
  { placed: 2, w2mm: 80, h2mm: 400 });

// 72. planCuts: second stock sheet opens when the first is full, in line order
check('planCuts opens more stock',
  t(`(() => { ${P} const plan = planCuts([P(0.5,0.5,3)], [P(0.6,0.6,2), P(1.2,0.6,1)], 0.01);
      return plan.sheets.map(s => [Math.round(s.W * 1000), s.placed.length]); })()`),
  [[600, 1], [600, 1], [1200, 1]]);

// 73. Matched groups carry a plan; unmatched don't (via the live document)
check('matched group gets a cut plan',
  t('(() => { const d = cutsData(currentProject()); const g19 = d.groups.find(g => g.label === "19 mm"); const g12 = d.groups.find(g => g.label === "12 mm"); return { planned: g19.plan.sheets.length, allPlaced: g19.plan.unplaced.length === 0, unmatchedHasNoPlan: g12.plan === undefined }; })()'),
  { planned: 1, allPlaced: true, unmatchedHasNoPlan: true });

// 74. Grain chip cycles w -> h -> don't care, undoably
t('state.activeId = state.lines.find(l => l.kind === "comp").id;');
const grainLine = t('state.activeId');
t(`cycleGrain(${grainLine})`);
check('grain cycles to width', t(`state.lines.find(l => l.id === ${grainLine}).grain`), 'w');
t(`cycleGrain(${grainLine})`);
check('grain cycles to height', t(`state.lines.find(l => l.id === ${grainLine}).grain`), 'h');
t(`cycleGrain(${grainLine})`);
check('grain cycles back to unset', t(`state.lines.find(l => l.id === ${grainLine}).grain`), undefined);
t('undo()');
check('grain change is undoable', t(`state.lines.find(l => l.id === ${grainLine}).grain`), 'h');
t(`cycleGrain(${grainLine})`); // back to unset for later tests

// 75. planCuts honors grain: aligned grain forces rotation
const PG = 'const P = (w,h,n,g) => ({ sheet: { colors: {} }, line: { id: 1, ...(g ? { grain: g } : {}) }, entry: { si: 1, dim: { L: 3 }, comp: { w: { si: w }, h: { si: h }, n: { si: n } } } });';
check('cross-grain piece is rotated into alignment',
  t(`(() => { ${PG} const plan = planCuts([P(0.5,0.2,1,'h')], [P(1,1,1,'w')], 0);
      const pl = plan.sheets[0].placed[0];
      return { w2mm: Math.round(pl.w * 1000), h2mm: Math.round(pl.h * 1000), grain: pl.grain }; })()`),
  { w2mm: 200, h2mm: 500, grain: 'x' });

// 76. Grain can make a piece unplaceable that would otherwise fit
check('grain conflict leaves the piece unplaced',
  t(`(() => { ${PG} const plan = planCuts([P(0.5,0.2,1,'h')], [P(1.0,0.3,1,'w')], 0);
      return { placed: plan.sheets.length, unplaced: plan.unplaced.length }; })()`),
  { placed: 0, unplaced: 1 });
check('same piece places once either side stops caring',
  t(`(() => { ${PG} const plan = planCuts([P(0.5,0.2,1,'h')], [P(1.0,0.3,1)], 0);
      const pl = plan.sheets[0].placed[0];
      return { w2mm: Math.round(pl.w * 1000), unplaced: plan.unplaced.length }; })()`),
  { w2mm: 500, unplaced: 0 });

// 77. Normalization keeps the physical grain axis: portrait part, grain
// along its narrow width, aligns with stock grain along the height
check('grain survives landscape normalization',
  t(`(() => { ${PG} const plan = planCuts([P(0.2,0.5,1,'w')], [P(1.2,1.0,1,'h')], 0);
      const pl = plan.sheets[0].placed[0];
      return { w2mm: Math.round(pl.w * 1000), grain: pl.grain }; })()`),
  { w2mm: 500, grain: 'y' });

// 77b. A grain-set part never rotates on stock without grain
check('grain-set part keeps its authored orientation',
  t(`(() => { ${PG} const plan = planCuts([P(0.2,0.5,1,'w')], [P(1.0,0.6,1)], 0);
      const pl = plan.sheets[0].placed[0];
      return { w2mm: Math.round(pl.w * 1000), h2mm: Math.round(pl.h * 1000) }; })()`),
  { w2mm: 200, h2mm: 500 });
check('authored orientation is refused room rather than rotated',
  t(`(() => { ${PG} const plan = planCuts([P(0.2,0.5,1,'w')], [P(1.0,0.3,1)], 0);
      return { sheets: plan.sheets.length, unplaced: plan.unplaced.length }; })()`),
  { sheets: 0, unplaced: 1 });
check('same piece without grain lies down and fits',
  t(`(() => { ${PG} const plan = planCuts([P(0.2,0.5,1)], [P(1.0,0.3,1)], 0);
      return { placed: plan.sheets[0].placed.length, w2mm: Math.round(plan.sheets[0].placed[0].w * 1000) }; })()`),
  { placed: 1, w2mm: 500 });

// 78. Grain survives export/import
t(`cycleGrain(${grainLine})`); // set to 'w'
const rtg = t('JSON.stringify({ projects: [JSON.parse(JSON.stringify(currentProject()))] })');
t(`importProjectsFromData(${rtg})`);
check('grain survives import', t('state.lines.find(l => l.kind === "comp").grain'), 'w');

// 79. Two saws: over-capacity rips go to the tracksaw, oversize by the
// margin, then a table saw clean-up; once the remainder fits, table saw
const SAWS = 'const SAWS = { kerf: 0.003, tkKerf: 0.0022, margin: 0.01, capW: 2.5, capH: 0.63 };';
check('two-saw cabinet: one tracksaw break, then all table saw',
  t(`(() => { ${P} ${SAWS} const plan = planCuts([P(0.6,0.9,2), P(0.58,0.6,2)], [P(2.44,1.22,1)], SAWS);
      const steps = cutList(plan.sheets[0]);
      return { cuts: plan.cuts, risky: plan.risky, trackOps: plan.trackOps,
               seq: steps.map(s => (s.tool === 'track' ? 'tk-' : '') + s.kind + '@' + Math.round(s.at * 1000) + 'x' + s.count),
               total: steps.reduce((a, s) => a + s.count, 0) }; })()`),
  { cuts: 7, risky: 0, trackOps: 1,
    seq: ['tk-break@609x1', 'rip@600x1', 'cross@900x2', 'cross@580x1', 'rip@580x1', 'cross@600x1'],
    total: 7 });

// 79b. Steps carry the workpiece they cut into, for the schematics
check('steps track the shrinking workpiece',
  t(`(() => { ${P} ${SAWS} const plan = planCuts([P(0.6,0.9,2), P(0.58,0.6,2)], [P(2.44,1.22,1)], SAWS);
      return cutList(plan.sheets[0]).map(s =>
        s.dir + Math.round(s.wpW * 1000) + 'x' + Math.round(s.wpH * 1000)); })()`),
  ['h2440x1220', 'h2440x609', 'v2440x600', 'v634x600', 'h2440x609', 'v2440x580']);

// 79c. Half-sheet table saw: ONE tracksaw crosscut across the length
// yields two panels, then everything runs on the table saw
check('half-sheet capacity: one breakdown crosscut, rest table saw',
  t(`(() => { ${P} const saws = { kerf: 0.003, tkKerf: 0.0022, margin: 0.01, capW: 1.25, capH: 1.25 };
      const plan = planCuts([P(0.6,0.9,2), P(0.58,0.6,2)], [P(2.44,1.22,1)], saws);
      const steps = cutList(plan.sheets[0]);
      return { trackOps: plan.trackOps, risky: plan.risky,
               break1: steps[0].kind + '-' + steps[0].dir + '@' + Math.round(steps[0].at * 1000),
               restAllTable: steps.slice(1).every(s => s.tool !== 'track') }; })()`),
  { trackOps: 1, risky: 0, break1: 'break-v@1219', restAllTable: true });

// 79d. Many thin strips: one breakdown beats repeated tracksaw rips
check('strip stack: single break instead of two tracksaw rips',
  t(`(() => { ${P} ${SAWS} const plan = planCuts([P(1.0,0.3,4)], [P(2.44,1.22,1)], SAWS);
      const steps = cutList(plan.sheets[0]);
      return { trackOps: plan.trackOps, risky: plan.risky,
               kinds: steps.map(s => (s.tool === 'track' ? 'tk-' : '') + s.kind) }; })()`),
  { trackOps: 1, risky: 0,
    kinds: ['tk-break', 'rip', 'rip', 'cross', 'cross'] });

// 80. Margin and the extra kerf come out of the sheet's leftovers
check('two-saw yield: margin eats into the bottom remainder',
  t(`(() => { ${P} ${SAWS} const plan = planCuts([P(0.6,0.9,2), P(0.58,0.6,2)], [P(2.44,1.22,1)], SAWS);
      const y = sheetYield(plan.sheets[0]);
      return y.offcuts.map(o => [Math.round(o.w * 1000), Math.round(o.h * 1000)]); })()`),
  [[1837, 580], [2440, 26], [51, 600], [2440, 6]]);

// 81. A piece over capacity itself: tracksaw-finished edges, flagged risky
check('over-capacity piece flags risky tracksaw edges',
  t(`(() => { ${P} const saws = { kerf: 0.003, tkKerf: 0.0022, margin: 0.01, capW: 0.5, capH: 0.5 };
      const plan = planCuts([P(0.9,0.6,1)], [P(2.44,1.22,1)], saws);
      const steps = cutList(plan.sheets[0]);
      return { risky: plan.risky, cuts: plan.cuts,
               allTrack: steps.every(s => s.tool === 'track'),
               allRisky: steps.every(s => s.risky === true) }; })()`),
  { risky: 2, cuts: 2, allTrack: true, allRisky: true });

// 82. Saw settings: setters, clearing capacity, survival through import
t('setCapW("2500"); setCapH("630"); setTkKerf("2.2"); setTkMargin("8")');
check('capacity and tracksaw settings set',
  t('[currentProject().tsCapW, currentProject().tsCapH, currentProject().tkKerf, currentProject().tkMargin]'),
  [2500, 630, 2.2, 8]);
const rts = t('JSON.stringify({ projects: [JSON.parse(JSON.stringify(currentProject()))] })');
t(`importProjectsFromData(${rts})`);
check('saw settings survive import',
  t('[currentProject().tsCapW, currentProject().tsCapH, currentProject().tkKerf, currentProject().tkMargin]'),
  [2500, 630, 2.2, 8]);
t('setCapW(""); setCapH("")');
check('blank clears the capacity back to single-saw',
  t('[currentProject().tsCapW, currentProject().tsCapH]'), [null, null]);

process.exit(failures ? 1 : 0);
