/* Runs the remote page's inline script against a minimal DOM stub.
   The page is served straight from resources/remote-page.html to a phone, so
   a throw at load time is invisible until someone opens it on a real device:
   the WebSocket simply never opens and the header sits on "connecting…" with
   no error anywhere. `node --check` only parses; this executes.
   Run: npm run check:remote-page */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const html = readFileSync(join(root, 'resources/remote-page.html'), 'utf8');

const match = html.match(/<script>([\s\S]*?)<\/script>/);
if (!match) fail('no inline <script> found in remote-page.html');
/* hand the checker the pure functions it needs to test on their own */
const source = match[1] + '\n;globalThis.__probe = {'
  + ' openPane: openPane, closeViewer: closeViewer, renderFrame: renderFrame,'
  + ' slot: slot, FONT: FONT };';

/* every id the page looks up must exist in the markup: a rename that leaves a
   getElementById dangling is the exact failure this file exists for */
const declared = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...match[1].matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((id) => !declared.has(id));
if (missing.length) fail(`script queries ids the page does not declare: ${missing.join(', ')}`);

function mkText(value) {
  const t = mkNode('#text');
  t.nodeType = 3;
  t.nodeValue = value;
  return t;
}

function mkNode(tag) {
  return {
    nodeName: tag.toUpperCase(),
    nodeType: 1,
    childNodes: [],
    parent: null,
    attrs: {},
    className: '',
    style: { cssText: '', display: '', fontSize: '' },
    value: '',
    hidden: false,
    scrollTop: 0,
    scrollHeight: 0,
    clientHeight: 500,
    clientWidth: 360,
    classList: {
      _on: new Set(),
      toggle(name, on) {
        if (on === undefined ? !this._on.has(name) : on) this._on.add(name);
        else this._on.delete(name);
      },
      add(name) { this._on.add(name); },
      remove(name) { this._on.delete(name); },
      contains(name) { return this._on.has(name); }
    },
    addEventListener(type, fn) {
      const list = this.listeners || (this.listeners = {});
      (list[type] || (list[type] = [])).push(fn);
    },
    removeEventListener() {},
    focus() {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
    querySelectorAll: () => [],
    append(...kids) {
      for (const kid of kids) {
        if (!kid) continue;
        /* a fragment lands as its children, the way a real DOM does it */
        if (kid.nodeName === '#FRAGMENT') { this.append(...kid.childNodes); kid.childNodes = []; continue; }
        kid.parent = this;
        this.childNodes.push(kid);
      }
    },
    replaceChildren(...kids) {
      this.childNodes = [];
      this.append(...kids);
      (this.ownerDocument || document).mutations.push('replaceChildren');
    },
    insertBefore(kid, ref) {
      const i = this.childNodes.indexOf(ref);
      kid.parent = this;
      this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, kid);
      return kid;
    },
    remove() {
      if (!this.parent) return;
      const i = this.parent.childNodes.indexOf(this);
      if (i >= 0) this.parent.childNodes.splice(i, 1);
    },
    removeChild(kid) {
      const i = this.childNodes.indexOf(kid);
      if (i >= 0) this.childNodes.splice(i, 1);
      return kid;
    },
    get firstChild() { return this.childNodes[0] || null; },
    get nextSibling() {
      if (!this.parent) return null;
      return this.parent.childNodes[this.parent.childNodes.indexOf(this) + 1] || null;
    },
    get textContent() {
      if (this.nodeType === 3) return this.nodeValue;
      return this.childNodes.map((c) => c.textContent).join('');
    },
    set textContent(v) {
      this.childNodes = [];
      if (v !== '' && v != null) this.append(mkText(String(v)));
      (this.ownerDocument || document).mutations.push('textContent');
    },
    /* the page parses the backend's frame with innerHTML; the stub does the
       same for the handful of tags the sanitizer allows through */
    set innerHTML(v) {
      this.childNodes = [];
      for (const part of String(v).split('<')) {
        if (part[0] === '/') continue;                       // a closing tag
        if (part[0] === undefined) continue;
        const gt = part.indexOf('>');
        if (part[0] === '!') continue;                       // a doctype or comment
        if (gt < 0 || part[0] === '/') { if (part.trim()) this.append(mkText(part)); continue; }
        const n = mkNode(part.slice(0, gt).split(/\s/)[0]);
        const st = /style="([^"]*)"/.exec(part.slice(0, gt));
        if (st) n.setAttribute('style', st[1]);
        this.append(n);
      }
    },
  };
}

const document = {
  mutations: [],
  getElementById: (id) => (declared.has(id) ? (nodes[id] ||= mkNode(id)) : null),
  querySelectorAll: () => [],
  createElement: (tag) => mkNode(tag),
  createTextNode: (v) => mkText(String(v)),
  createDocumentFragment: () => mkNode('#fragment'),
  addEventListener() {},
};
const nodes = {};
const winHandlers = {};
const window_ = {
  innerWidth: 390,          // iPhone 14 portrait
  innerHeight: 844,
  addEventListener: (type, fn) => { winHandlers[type] = fn; },
};

let socket = null;
const sent = [];
const timers = [];
/* the page scrolls in a rAF (WebKit #261692), so the checker holds the frame
   callbacks and fires them by hand, in order */
const frames = [];
function flushFrame() {
  const due = frames.splice(0, frames.length);
  for (const fn of due) fn();
  return due.length;
}
new Function(
  'document', 'location', 'WebSocket', 'setTimeout', 'clearTimeout',
  'requestAnimationFrame', 'console', 'globalThis', 'window',
  source,
)(
  document,
  { protocol: 'https:', host: 'x.trycloudflare.com' },
  function WebSocket(url) {
    this.url = url;
    this.readyState = 0;
    this.send = (raw) => sent.push(JSON.parse(raw));
    this.close = () => {};
    socket = this;
  },
  (fn) => { timers.push(fn); return timers.length; },
  () => {},
  (fn) => { frames.push(fn); return frames.length; },
  console,
  globalThis,
  window_,
);

if (!socket) fail('page script ran but never opened a WebSocket — it threw before connect()');

/* the socket is live and the header says so */
socket.readyState = 1;
socket.onopen();
if (node('cstate').textContent !== 'live') fail(`onopen did not set the connection label (got "${node('cstate').textContent}")`);

socket.onmessage({ data: JSON.stringify({
  t: 'panes',
  panes: [
    /* t-1: an agent with no readable log, so the phone offers the terminal */
    { id: 't-1', title: 'x', workspace: 'y', cwd: '/p/y', state: 'idle', runtime: 'qwenpaw' },
    /* t-2: an agent whose log the phone can read */
    { id: 't-2', title: 'z', workspace: 'p', cwd: '/p', state: 'working', runtime: 'pi', agent: 'pi' },
  ],
}) });
socket.onmessage({ data: JSON.stringify({ t: 'status', statuses: { 't-1': { state: 'working', runtime: 'qwenpaw' } } }) });
socket.onmessage({ data: 'not json' });
socket.onclose();

/* ---------------- the phone watches a pane, not a size ------------------
   One view, one input: the pane behind the screen is the desktop's own
   terminal at its own width. A `cols`/`rows` on the wire would mean the
   desktop had been resized to fit a phone again. */
const { openPane, closeViewer, renderFrame, slot } = globalThis.__probe;
/* per-slot view of the DOM: `logOf` is the phone's one screen, whichever pane
   owns it right now */
const logOf = (id) => slot(id).log;
const scrollOf = (id) => {
  for (const fn of (slot(id).log.listeners || {}).scroll || []) fn();
};

/* two panes open on the desktop: the phone mirrors both at once, in one tap */
socket.onmessage({ data: JSON.stringify({ t: 'panes', panes: [
  { id: 't-1', tabId: 'tab-a', title: 'pi — build', state: 'working' },
  { id: 't-2', tabId: 'tab-a', title: 'shell', state: null },
  { id: 't-3', tabId: 'tab-b', title: 'other tab', state: null }
] }) });
sent.length = 0;
openPane('t-1');
const watched = sent.filter((m) => m.t === 'watch').map((m) => m.paneId);
if (watched.join(',') !== 't-1,t-2') fail(`open mirrored ${watched.join(',')}, want both panes`);
if (node('panes').childNodes.length !== 2) fail('the grid did not build a slot per pane');
/* el() takes varargs, so a slot handed it an array once and rendered the
   literal text "[object HTMLDivElement],[object HTMLPreElement]" instead of
   a title and a terminal. Assert the shape of a slot, not just its count. */
for (const [i, want] of [['t-1', 'pi — build'], ['t-2', 'shell']]) {
  const box = slot(i).box;
  const kids = box.childNodes;
  if (kids.length !== 2) fail(`slot ${i} has ${kids.length} children, want a title and a log`);
  if (kids[0].nodeName !== 'DIV' || kids[0].className !== 'ptitle') fail(`slot ${i} has no title bar`);
  if (kids[0].textContent !== want) fail(`slot ${i} is titled ${JSON.stringify(kids[0].textContent)}`);
  if (kids[1].nodeName !== 'PRE' || kids[1] !== slot(i).log) fail(`slot ${i} does not hold its own terminal`);
  if (box.textContent.includes('[object')) fail(`slot ${i} stringified its children: ${box.textContent.slice(0, 60)}`);
}
const first = lastSent('watch');
if (first.paneId !== 't-2') fail(`watch named the wrong pane: ${first.paneId}`);
if ('cols' in first || 'rows' in first) {
  fail(`watch still carries a grid (${first.cols}x${first.rows}) — the desktop pty must keep its own width`);
}
if (node('viewer').hidden) fail('the pane did not open on the terminal');
for (const gone of ['tabs', 'sesswrap', 'sess', 'sbar', 'spick', 'stext', 'ssend']) {
  if (node(gone)) fail(`${gone} is still on the page — the phone is terminal-only`);
}

/* the view is scrolled, never folded: a 200-column row arrives whole and
   overflows to the right, because a fold would invent line breaks the
   desktop terminal never printed */
if (!/\.plog\{[^}]*overflow:auto/.test(html) || !/\.plog\{[^}]*white-space:pre[;\s]/.test(html)) {
  fail('.plog lost its `white-space:pre` + `overflow:auto` — long rows would wrap again');
}
const long = 'x'.repeat(200);
renderFrame(slot('t-1'), null, long + '\nshort');
const rows = logOf('t-1').childNodes;
if (rows.length !== 3) fail(`a 2-row frame rendered as ${rows.length} nodes`);
if (rows[0].nodeType !== 3 || rows[0].nodeValue !== long) {
  fail(`a long row was rewritten: ${rows[0].nodeType === 3 ? rows[0].nodeValue.length + ' chars' : 'an element'}`);
}
if (rows[1].nodeName !== 'BR') fail('the newline between rows was dropped');
if (rows[2].nodeValue !== 'short') fail(`the second row is ${JSON.stringify(rows[2].nodeValue)}`);

/* colors come from the backend's sanitized html, and only from it */
renderFrame(slot('t-1'), '<span style="color:#0f0">hi</span><script>x</script>', 'ignored');
const painted = logOf('t-1').childNodes;
if (painted.length !== 1 || painted[0].nodeName !== 'SPAN') fail('a styled frame did not render as one span');if (painted[0].getAttribute('style') !== 'color:#0f0') fail(`the color was dropped: ${painted[0].getAttribute('style')}`);
renderFrame(slot('t-1'), '<span style="background:url(javascript:1)">x</span>', 'ignored');
if (logOf('t-1').childNodes[0].getAttribute('style')) fail('a style carrying url() was kept');

/* an unchanged frame costs nothing: the desktop re-renders an idle pane four
   times a second, and rebuilding the DOM for that is the phone-side lag */
renderFrame(slot('t-1'), null, long + '\nshort');
const afterFirst = logOf('t-1').childNodes;

/* the scroll to the bottom is deferred to the next animation frame. Safari
   paints a DOM change and a scrollTop change in two passes when one task does
   both (WebKit #261692), which showed a block of the new screen cut off; a
   rAF lands after the layout and before the paint, so they stay together. */
flushFrame();
logOf('t-1').scrollTop = 0;
document.mutations.length = 0;
renderFrame(slot('t-1'), null, 'a\nb\nc');
if (document.mutations.length !== 1 || document.mutations[0] !== 'replaceChildren') {
  fail(`a frame made ${document.mutations.length} DOM mutations (${document.mutations.join(', ')}) — WebKit can paint a clear and an append as two different screens`);
}
if (logOf('t-1').scrollTop !== 0) fail('the scroll was applied inside the same task as the DOM change');
if (flushFrame() !== 1) fail('a pinned frame did not schedule exactly one animation frame');
if (logOf('t-1').scrollTop !== logOf('t-1').scrollHeight) {
  fail(`the frame did not reach the bottom: scrollTop ${logOf('t-1').scrollTop}, scrollHeight ${logOf('t-1').scrollHeight}`);
}
/* a user who scrolled up keeps their place, so nothing is scheduled at all */
logOf('t-1').scrollHeight = 900;
logOf('t-1').scrollTop = 0;
scrollOf('t-1');
renderFrame(slot('t-1'), null, 'a\nb\nd');
if (flushFrame() !== 0) fail('an unpinned view still jumped to the bottom');
logOf('t-1').scrollHeight = 0;
logOf('t-1').scrollTop = 0;
scrollOf('t-1');

const frame = JSON.stringify({ t: 'view', paneId: 't-1', text: long + '\nshort' });
socket.onmessage({ data: frame });
const settled = logOf('t-1').childNodes;
socket.onmessage({ data: frame });
if (logOf('t-1').childNodes !== settled) fail('an identical frame rebuilt the DOM');
/* a frame for a pane nobody watches must not land */
socket.onmessage({ data: JSON.stringify({ t: 'view', paneId: 't-9', text: 'other' }) });
if (logOf('t-1').textContent !== afterFirst.map((c) => c.textContent).join('')) {
  fail('a frame for another pane replaced the one on screen');
}

/* rotating the phone is a font-size change, never a resize of the desktop pty */
logOf('t-1').clientWidth = 844;
window_.innerWidth = 844;
sent.length = 0;
winHandlers.resize();
if (!sent.some((m) => m.t === 'watch' && m.paneId === 't-1')) fail('rotating did not ask for a fresh frame');
if (sent.some((m) => 'cols' in m || 'rows' in m)) fail('rotation put a grid on the wire');

/* the quick keys are the raw sequences a terminal expects: a phone has no
   arrow cluster, and history/cursor movement is most of what a shell user
   reaches for between two commands */
const seqs = [...html.matchAll(/data-seq="&quot;([^&]+)&quot;">([^<]+)</g)]
  .map((m) => [m[2].replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)), m[1]]);
const want = { '←': '\\u001b[D', '→': '\\u001b[C', '↑': '\\u001b[A', '↓': '\\u001b[B' };
for (const [label, code] of Object.entries(want)) {
  if (!seqs.some(([l, c]) => l === label && c === code)) {
    fail(`the ${label} key sends ${seqs.find(([l]) => l === label)?.[1] || 'nothing'}, want ${code}`);
  }
}
if (!seqs.length) fail('the quick key bar has no keys at all');

/* the type field is the only input, and Enter is a carriage return */
socket.readyState = 1;
socket.onopen();
node('tinput').value = 'npm test';
handlersOf('tsend').fire('click');
const typed = lastSent('write');
if (typed.paneId !== 't-1' || typed.data !== 'npm test\r') {
  fail(`the field sent ${JSON.stringify(typed)}, want "npm test\\r" to t-1`);
}
if (node('tinput').value !== '') fail('the field kept the sent text');
node('tinput').value = '';
sent.length = 0;
handlersOf('tsend').fire('click');
if (sent.length) fail('an empty field must not reach the pty');
/* a space is a keystroke, not nothing, so it is not trimmed away */
node('tinput').value = ' ';
sent.length = 0;
handlersOf('tsend').fire('click');
if (lastSent('write').data !== ' \r') fail('a lone space did not reach the pty');

/* a reconnect re-arms the watch it had */
socket.onclose();
sent.length = 0;
socket.readyState = 1;
socket.onopen();
if (!sent.some((m) => m.t === 'watch' && m.paneId === 't-1')) fail('reconnect did not re-arm the watch');
if (!sent.some((m) => m.t === 'watch' && m.paneId === 't-2')) fail('reconnect did not re-arm the second pane');

/* ---- two panes, one input -------------------------------------------
   The split desktop shows both terminals; the keyboard goes to the one the
   outline marks, because there is still exactly one input. */
sent.length = 0;
openPane('t-1');
const one = logOf('t-1');
const two = logOf('t-2');
if (one === two) fail('both panes share one screen — that is a single-pane viewer again');
socket.onmessage({ data: JSON.stringify({ t: 'view', paneId: 't-2', text: 'second pane' }) });
if (!two.textContent.includes('second pane')) fail('a frame for the second pane did not reach its slot');
if (one.textContent.includes('second pane')) fail("the second pane's frame landed in the first slot");
flushFrame();
/* the pane the typebar was given last is the pane it types into */
node('tinput').value = 'ls';
sent.length = 0;
handlersOf('tsend').fire('click');
if (lastSent('write').paneId !== 't-1') fail(`input went to ${lastSent('write').paneId}, want the focused t-1`);
/* a tap moves the focus, and with it the input */
for (const fn of (slot('t-2').box.listeners || {}).click || []) fn();
if (!slot('t-2').box.classList.contains('on')) fail('tapping a pane did not focus it');
if (slot('t-1').box.classList.contains('on')) fail('both panes claim the input');
node('tinput').value = 'pwd';
sent.length = 0;
handlersOf('tsend').fire('click');
if (lastSent('write').paneId !== 't-2') fail(`after the tap input went to ${lastSent('write').paneId}, want t-2`);
if (node('vtitle').textContent !== 'shell') fail(`the header names ${JSON.stringify(node('vtitle').textContent)}, want the focused pane's title`);
/* a pane that exits on the desktop takes its own slot and leaves the other
   one running — the whole point of mirroring two instead of switching */
socket.onmessage({ data: JSON.stringify({ t: 'gone', paneId: 't-2' }) });
if (slot('t-2')) fail('the closed pane kept its slot');
if (!slot('t-1')) fail('a pane closing took the other one with it');
if (node('viewer').hidden) fail('the viewer closed while a pane was still open');
socket.onmessage({ data: JSON.stringify({ t: 'view', paneId: 't-1', text: 'still here' }) });
if (!one.textContent.includes('still here')) fail('the surviving pane stopped updating');

/* leaving the viewer releases every pane it held and stops talking */
const closedLog = logOf('t-1');
sent.length = 0;
closeViewer();
if (!lastSent('unwatch')) fail('leaving the viewer did not release the pane');
if ('paneId' in lastSent('unwatch')) fail('unwatch named one pane — the phone held two');
if (node('panes').childNodes.length) fail('closing the viewer left slots behind');
sent.length = 0;
openPane('t-3');
const otherTabWatches = sent.filter((m) => m.t === 'watch').map((m) => m.paneId);
if (otherTabWatches.join(',') !== 't-3') fail(`opening another tab watched ${otherTabWatches.join(',')}`);
if (node('panes').childNodes.length !== 1) fail('another tab inherited unrelated pane slots');
closeViewer();
sent.length = 0;
socket.onmessage({ data: JSON.stringify({ t: 'view', paneId: 't-1', text: 'late' }) });
if (closedLog.textContent.includes('late')) fail('a frame landed after the viewer closed');
socket.onmessage({ data: JSON.stringify({ t: 'gone', paneId: 't-1' }) });
if (sent.length) fail('a closed viewer kept talking to the desktop');

console.log('remote-page.html: script executes, socket opens, one grid of up to two panes with one focused input, rows scroll instead of folding, the pty is never resized');


/* the page binds its own listeners, so the checker fires them by name */
function handlersOf(id) {
  const list = node(id).listeners || {};
  return { fire: (type) => { for (const fn of list[type] || []) fn(); } };
}
function lastSent(type) {
  for (let i = sent.length - 1; i >= 0; i--) if (sent[i].t === type) return sent[i];
  return fail(`no "${type}" message was sent`);
}
function node(id) { return nodes[id]; }
function fail(msg) {
  console.error(`remote-page.html: ${msg}`);
  process.exit(1);
}
