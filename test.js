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

process.exit(failures ? 1 : 0);
