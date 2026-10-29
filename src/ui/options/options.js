/**
 * The options page: settings, backup, import/export and a diagnostics view.
 *
 * The diagnostics are here rather than in the panel because they are the thing a user is asked for when
 * they report a problem, and they need to be findable rather than hidden behind a menu.
 */

import { api } from '../../platform/api.js';

const el = (tag, props = {}, ...children) => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    // no `html` prop, for the same reason as the panel helper: textContent cannot carry markup
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v !== null && v !== undefined && v !== false) node.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
};

// promise-based, so it works on Firefox as well as Chromium (see ui/panel/panel.js for the reason)
const send = (msg) => api.runtime.sendMessage(msg)
  .then((res) => res ?? { ok: false, error: 'no response' })
  .catch((e) => ({ ok: false, error: String(e?.message ?? e) }));

const state = { settings: {}, automations: [], diagnostics: null };

function toast(text, bad = false) {
  const t = el('div', { class: `toast ${bad ? 'bad' : ''}`, text });
  document.body.append(t);
  setTimeout(() => t.remove(), 3200);
}

function settingsSection() {
  const s = state.settings;
  const toggle = (key, label, hint) => el('div', { class: 'row' },
    el('input', {
      type: 'checkbox', checked: s[key] !== false, id: key,
      onchange: async (e) => {
        state.settings = (await send({ type: 'save-settings', patch: { [key]: e.target.checked } })).settings ?? state.settings;
      },
    }),
    el('label', { for: key, text: label }),
    hint ? el('span', { class: 'hint', text: hint }) : null,
  );

  return el('section', {},
    el('h2', { text: 'Settings' }),
    el('div', { class: 'row' },
      el('label', { text: 'Theme' }),
      el('select', {
        onchange: async (e) => {
          state.settings = (await send({ type: 'save-settings', patch: { theme: e.target.value } })).settings ?? state.settings;
          document.body.classList.toggle('light', e.target.value === 'light');
        },
      },
        el('option', { value: 'dark', text: 'Dark', selected: s.theme !== 'light' }),
        el('option', { value: 'light', text: 'Light', selected: s.theme === 'light' })),
    ),
    el('div', { class: 'row' },
      el('label', { text: 'Keep' }),
      el('input', {
        type: 'number', class: 'small', value: String(s.runHistoryLimit ?? 50), min: '1', max: '500',
        onchange: async (e) => {
          state.settings = (await send({ type: 'save-settings', patch: { runHistoryLimit: Number(e.target.value) } })).settings ?? state.settings;
        },
      }),
      el('span', { class: 'hint', text: 'run records in history' }),
    ),
    toggle('shortcutsEnabled', 'Keyboard shortcuts', 'Alt+Shift+S to start or stop, Alt+Shift+X to stop everything'),
    toggle('showStatusBadge', 'Show progress badge', 'a small indicator while a run is active'),
    toggle('stopOnTabBlur', 'Stop when the tab loses focus', 'useful when an automation must not run in the background'),
  );
}

function backupSection() {
  return el('section', {},
    el('h2', { text: 'Backup' }),
    el('div', { class: 'row' },
      el('button', {
        class: 'primary', text: '⭳ Export all automations',
        onclick: async () => {
          const res = await send({ type: 'export-all' });
          if (!res.ok) { toast(res.error, true); return; }
          const blob = new Blob([JSON.stringify(res.document, null, 2)], { type: 'application/json' });
          const url = URL.createObjectURL(blob);
          const a = el('a', { href: url, download: `autoflow-backup-${new Date().toISOString().slice(0, 10)}.json` });
          document.body.append(a);
          a.click();
          a.remove();
          URL.revokeObjectURL(url);
          toast(`Exported ${res.document.automations.length} automations`);
        },
      }),
      el('label', { class: 'primary', for: 'import-file', text: '⭱ Import',
        style: 'background:#2962ff;border:1px solid #2962ff;color:#fff;padding:5px 7px;border-radius:6px;cursor:pointer;font-size:12px' }),
      el('input', {
        type: 'file', id: 'import-file', accept: '.json', style: 'display:none',
        onchange: async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          const text = await file.text();
          let doc;
          try {
            doc = JSON.parse(text);
          } catch (err) {
            toast(`That file is not valid JSON: ${err.message}`, true);
            return;
          }
          /**
           * AUDIT FIRST, then import.
           *
           * The worker exposes `audit-import` (a dry run that returns `concerns[]` and `containsScripts`)
           * precisely so the user can be warned BEFORE anything is saved. The original flow skipped it and
           * imported blindly, so a shared file carrying a `runScript` step was silently skipped and the user
           * was told "Imported 3, skipped 1" with no statement of WHY - and no way to accept it deliberately.
           * A script step is arbitrary code in the user's own pages, so the decision has to be the user's and
           * has to be informed.
           */
          const preview = await send({ type: 'audit-import', document: doc });
          if (!preview.ok) { toast(preview.error, true); return; }

          let allowScripts = false;
          if (preview.containsScripts) {
            const high = (preview.concerns ?? []).filter((c) => c.severity === 'high');
            const names = high.map((c) => c.automationName).filter(Boolean);
            const detail = names.length
              ? `in: ${[...new Set(names)].slice(0, 5).join(', ')}`
              : `${high.length} step(s)`;
            const ok = window.confirm(
              `${preview.count} automation(s) in this file, and at least one contains a SCRIPT step (${detail}).\n\n`
              + 'A script step runs whatever JavaScript it contains in whatever page the automation later '
              + 'operates on. Only continue if you wrote it or you trust where the file came from.\n\n'
              + 'OK = import everything, including script steps.\n'
              + 'Cancel = import everything EXCEPT automations containing a script step.',
            );
            allowScripts = ok;
          }

          const res = await send({ type: 'import-all', document: doc, allowScripts });
          if (!res.ok) { toast(res.error, true); return; }
          const skipped = res.skipped?.length ?? 0;
          if (skipped) {
            // Name the reason rather than only the count: "skipped 1" with no reason leaves the user unable
            // to tell a script refusal from a malformed file.
            const why = (res.skipped ?? []).map((s) => s.name ?? `#${s.index}`).slice(0, 3).join(', ');
            toast(`Imported ${res.imported}, skipped ${skipped} (${why} — script steps are held back unless you confirm)`);
          } else {
            toast(`Imported ${res.imported}`);
          }
          refresh();
        },
      }),
    ),
    el('p', { class: 'hint', text: 'The backup is a plain JSON file. Importing merges by default; automations with the same id are kept separately.' }),
  );
}

function diagnosticsSection() {
  const d = state.diagnostics;
  return el('section', {},
    el('h2', { text: 'Diagnostics' }),
    el('div', { class: 'row' },
      el('button', {
        text: '↻ Refresh',
        onclick: async () => {
          state.diagnostics = (await send({ type: 'diagnostics' })).diagnostics;
          render();
        },
      }),
      el('button', {
        text: '⧉ Copy',
        onclick: async () => {
          await navigator.clipboard.writeText(JSON.stringify(state.diagnostics, null, 2));
          toast('Copied');
        },
      }),
    ),
    d
      ? el('pre', { class: 'trace', text: JSON.stringify(d, null, 2) })
      : el('p', { class: 'hint', text: 'Press Refresh to collect environment and state information. This is what to include when reporting a problem.' }),
  );
}

function automationsSection() {
  return el('section', {},
    el('h2', { text: `Automations (${state.automations.length})` }),
    state.automations.length === 0
      ? el('p', { class: 'hint', text: 'None yet. Create one from the side panel.' })
      : el('div', {}, ...state.automations.map((a) => el('div', { class: 'row' },
          el('span', { class: 'grow', text: a.name }),
          el('span', { class: 'hint', text: `${(a.steps ?? []).length} steps` }),
        ))),
  );
}

function render() {
  const root = document.getElementById('root');
  root.replaceChildren();
  document.body.classList.toggle('light', state.settings.theme === 'light');

  root.append(el('h1', { text: 'AutoFlow' }));
  root.append(el('p', { class: 'hint', text: 'Auto-click, fill and record browser automations, on a schedule.' }));
  root.append(settingsSection());
  root.append(automationsSection());
  root.append(backupSection());
  root.append(diagnosticsSection());
  root.append(el('p', { class: 'hint', text: `Version ${api.runtime.getManifest().version}`
    + ` · ${api.side.kind() === 'sidebar' ? 'Firefox sidebar' : 'Chrome side panel'}` }));
}

async function refresh() {
  const [s, a] = await Promise.all([send({ type: 'get-settings' }), send({ type: 'list-automations' })]);
  if (s?.ok) state.settings = s.settings;
  if (a?.ok) state.automations = a.automations;
  render();
}

refresh();