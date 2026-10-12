// Execute the real React host and provider against controllable async reads.
import fs from 'node:fs';
import ts from 'typescript';
import assert from 'node:assert/strict';

let hooks = [], cursor = 0, effects = [], tree, component, queued = false;
let dom, host, panels, held, holdA;
const storage = new Map();
const same = (a, b) => a && b && a.length === b.length && a.every((v, i) => v === b[i]);
const schedule = () => {
  if (queued) return;
  queued = true;
  queueMicrotask(() => { queued = false; render(); });
};
const useState = initial => {
  const i = cursor++;
  hooks[i] ??= { value: initial };
  return [hooks[i].value, value => {
    const next = typeof value === 'function' ? value(hooks[i].value) : value;
    if (next !== hooks[i].value) { hooks[i].value = next; schedule(); }
  }];
};
const useRef = initial => {
  const i = cursor++;
  hooks[i] ??= { ref: { current: initial } };
  return hooks[i].ref;
};
const useEffect = (callback, deps) => {
  const i = cursor++, old = hooks[i];
  if (old && same(old.deps, deps)) return;
  effects.push(() => { old?.cleanup?.(); hooks[i] = { deps, cleanup: callback() }; });
};
const React = {
  Fragment: Symbol('fragment'),
  createElement(tag, props, ...children) {
    if (props?.className === 'hypatia-copilot-host') props.ref.current = host;
    return { tag, props, children };
  },
};
function render() {
  cursor = 0; effects = [];
  tree = component();
  for (const effect of effects) effect();
}
function find(node, label) {
  if (node?.props?.['aria-label'] === label && node.tag === 'button') return node;
  for (const child of node?.children || []) { const found = find(child, label); if (found) return found; }
}
class Panel extends EventTarget {
  session = null; draft = ''; isConnected = false; transcript = '';
  remove() { this.isConnected = false; if (host.current === this) host.current = undefined; }
  async loadHistory() { this.transcript = this.session || ''; }
  async refreshConversations() {}
}
async function hoardJson(path) {
  if (path === '/copilot/info') return { app_id: 'hypatia', app_name: 'Hypatia', data_space_id: 'space',
    tool_server_id: 'hypatia', panel_url: 'data:text/javascript,export%20default%20true', settings_url: '/settings' };
  const id = decodeURIComponent(path.split('/').pop());
  if (id === 'A' && holdA) await new Promise(resolve => held.push(resolve));
  return { record: { id, name: id === 'A' ? 'Networks' : 'Biology' } };
}
globalThis.__copilotTest = { useState, useEffect, useRef, React, hoardJson,
  useLocation: () => ({ pathname: location.hash.slice(1) || '/', search: '', hash: '' }),
  useHoardMode: () => true, useTheme: () => ({ theme: 'dark' }), TEACHER_KIND_TABLE: {}, FaustusMark: () => null };
globalThis.MutationObserver = class { observe() {} disconnect() {} };
globalThis.localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value), removeItem: key => storage.delete(key) };

const stripImports = source => source.replace(/^import[\s\S]*?;\r?\n/gm, '');
const source = stripImports(fs.readFileSync('src/data/hoardSyncCore.ts', 'utf8')) + '\n' +
  stripImports(fs.readFileSync('src/data/copilotCore.ts', 'utf8')) + '\n' +
  'const { useState, useEffect, useRef, useLocation, React, hoardJson, useHoardMode, useTheme, TEACHER_KIND_TABLE, FaustusMark } = globalThis.__copilotTest;\n' +
  stripImports(fs.readFileSync(process.env.COPILOT_HOST_SOURCE || 'src/ui/components/FaustusCopilot.tsx', 'utf8'));
const js = ts.transpileModule(source, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022, jsx: ts.JsxEmit.React,
} }).outputText;
component = (await import('data:text/javascript;base64,' + Buffer.from(js).toString('base64'))).FaustusCopilot;

function setup(paused, initialHash = '#/subject/A') {
  for (const hook of hooks) hook?.cleanup?.();
  hooks = []; panels = []; held = []; holdA = paused;
  storage.clear();
  for (const id of ['A', 'B']) { storage.set('hypatia-faustus-space-' + id, 'SID-' + id); storage.set('hypatia-faustus-space-' + id + '-draft', 'Draft ' + id); }
  dom = { id: 'A', heading: 'Networks', field: 'Editor A', selection: 'Selection A' };
  globalThis.location = { hash: initialHash, origin: 'http://qa.invalid' };
  globalThis.window = new EventTarget();
  window.location = location;
  window.getSelection = () => ({ toString: () => dom.selection });
  window.addEventListener('hypatia:context-request', event => event.detail.provide({
    kind: 'subject', object_id: dom.id, draft: { name: dom.field },
  }));
  host = { current: undefined, replaceChildren(panel) { this.current?.remove(); this.current = panel; panel.isConnected = true; } };
  globalThis.document = {
    title: 'Hypatia', documentElement: { lang: 'es', dataset: { theme: 'dark' } },
    querySelector: selector => selector === 'h1' ? { textContent: dom.heading } : null,
    querySelectorAll: selector => selector.startsWith('#root') ? [{
      type: 'text', disabled: false, value: dom.field, labels: [{ textContent: 'Name' }], getClientRects: () => [{}],
    }] : [],
    createElement: () => { const panel = new Panel(); panels.push(panel); return panel; },
  };
  render();
  find(tree, 'Faustus').props.onClick();
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (predicate()) return; await new Promise(setImmediate); }
  assert.fail('Async host did not settle: ' + JSON.stringify({ states: hooks.filter(h => h && 'value' in h).map(h => h.value), panels: panels.map(p => ({session:p.session, connected:p.isConnected})) }));
}
function navigate(id) {
  dom = { id, heading: id === 'A' ? 'Networks' : 'Biology', field: 'Editor ' + id, selection: 'Selection ' + id };
  location.hash = '#/subject/' + id;
  // HashRouter's pushState navigation updates React, without a hashchange event.
  render();
}
function release() { holdA = false; for (const resume of held.splice(0)) resume(); }

// A admitted turn awaits a GET while navigation mounts B independently.
setup(false);
await until(() => host.current?.session === 'SID-A');
const panelA = host.current;
panelA.draft = 'Unsent A';
holdA = true;
const pendingContext = panelA.contextProvider();
assert.equal(held.length, 1);
navigate('B');
await until(() => host.current?.session === 'SID-B');
assert.notEqual(host.current, panelA);
assert.equal(panelA.isConnected, false);
assert.equal(host.current.draft, 'Draft B');
assert.equal(host.current.transcript, 'SID-B');
release();
const context = await pendingContext;
assert.equal(context.project.external_project_id, 'A');
assert.equal(context.view.route, '#/subject/A');
assert.equal(context.view.heading, 'Networks');
assert.equal(context.view.editor.fields[0].value, 'Editor A');
assert.equal(context.view.editor.objects[0].draft.name, 'Editor A');
assert.equal(context.selection.text, 'Selection A');
assert.equal((await panelA.contextProvider()).project.external_project_id, 'A');
navigate('A');
await until(() => host.current?.session === 'SID-A');
assert.equal(host.current.draft, 'Unsent A');

// Navigation also wins over a first mount still resolving the A project.
setup(true);
await until(() => held.length > 0);
navigate('B');
await until(() => host.current?.session === 'SID-B');
const panelB = host.current;
release();
await new Promise(setImmediate);
assert.equal(host.current, panelB);
assert.equal(panelB.session, 'SID-B');
assert.equal(panelB.transcript, 'SID-B');
assert.equal((await panelB.contextProvider()).project.external_project_id, 'B');

// The normal launcher URL has no hash; HashRouter still calls that route '/'.
setup(false, '');
await until(() => host.current?.isConnected);
dom.field = 'New subject unsaved name';
const dashboard = await host.current.contextProvider();
assert.equal(dashboard.view.route, '#/');
assert.equal(dashboard.view.editor.fields[0].value, 'New subject unsaved name');
assert.equal(dashboard.view.editor.objects[0].draft.name, 'New subject unsaved name');
for (const hook of hooks) hook?.cleanup?.();
console.log('Pending navigation keeps A/B scoped; root URL without hash provides fresh editor drafts');
