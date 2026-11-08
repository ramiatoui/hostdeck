// Text editor for remote files, built on CodeMirror 6.
import { EditorView, basicSetup } from 'codemirror';
import { EditorState, Compartment } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { indentWithTab } from '@codemirror/commands';
import { StreamLanguage, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as t } from '@lezer/highlight';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { markdown } from '@codemirror/lang-markdown';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { yaml } from '@codemirror/legacy-modes/mode/yaml';
import { nginx } from '@codemirror/legacy-modes/mode/nginx';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { xml, html } from '@codemirror/legacy-modes/mode/xml';
import { css } from '@codemirror/legacy-modes/mode/css';
import { sql } from '@codemirror/legacy-modes/mode/sql';

const legacy = (mode) => StreamLanguage.define(mode);

function languageFor(filePath) {
  const name = filePath.split('/').pop().toLowerCase();
  const ext = name.includes('.') ? name.split('.').pop() : '';
  if (name === 'dockerfile' || name.startsWith('dockerfile.')) return legacy(dockerFile);
  if (/^(\.bashrc|\.profile|\.bash_profile|\.zshrc|\.bash_aliases)$/.test(name)) return legacy(shell);
  if (name.endsWith('.conf') && /nginx|sites-(available|enabled)/.test(filePath)) return legacy(nginx);
  switch (ext) {
    case 'js': case 'mjs': case 'cjs': return javascript();
    case 'ts': return javascript({ typescript: true });
    case 'jsx': return javascript({ jsx: true });
    case 'tsx': return javascript({ jsx: true, typescript: true });
    case 'json': return json();
    case 'py': return python();
    case 'md': case 'markdown': return markdown();
    case 'sh': case 'bash': case 'zsh': return legacy(shell);
    case 'yml': case 'yaml': return legacy(yaml);
    case 'toml': return legacy(toml);
    case 'ini': case 'env': case 'properties': case 'cfg': case 'conf': return legacy(properties);
    case 'xml': case 'svg': return legacy(xml);
    case 'html': case 'htm': return legacy(html);
    case 'css': return legacy(css({}));
    case 'sql': return legacy(sql({}));
    default:
      if (name.startsWith('.env')) return legacy(properties);
      return [];
  }
}

const highlight = HighlightStyle.define([
  { tag: [t.keyword, t.operatorKeyword, t.modifier], color: 'var(--hl-keyword)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--hl-string)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--hl-number)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--hl-comment)', fontStyle: 'italic' },
  { tag: [t.propertyName, t.attributeName, t.definition(t.variableName)], color: 'var(--hl-prop)' },
  { tag: [t.typeName, t.className, t.tagName, t.heading], color: 'var(--hl-type)' },
  { tag: [t.variableName, t.meta], color: 'var(--text)' },
]);

const theme = EditorView.theme({
  '&': { backgroundColor: 'var(--sunken)', color: 'var(--text)' },
  '.cm-content': { caretColor: 'var(--amber)', padding: '10px 0' },
  '.cm-cursor': { borderLeftColor: 'var(--amber)', borderLeftWidth: '2px' },
  '.cm-gutters': { backgroundColor: 'var(--sunken)', color: 'var(--faint)', border: 'none', paddingLeft: '6px' },
  '.cm-activeLine, .cm-activeLineGutter': { backgroundColor: 'color-mix(in srgb, var(--raised) 60%, transparent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': { backgroundColor: 'var(--amber-soft) !important' },
  '.cm-searchMatch': { backgroundColor: 'var(--amber-soft)', outline: '1px solid var(--amber)' },
  '.cm-panels': { backgroundColor: 'var(--panel)', color: 'var(--text)', borderColor: 'var(--line)' },
  '.cm-panels input, .cm-panels button': { color: 'var(--text)' },
  '.cm-tooltip': { backgroundColor: 'var(--panel)', border: '1px solid var(--line)' },
  '&.cm-focused': { outline: 'none' },
});

/**
 * @param {HTMLElement} parent
 * @param {{content:string, path:string, onChange:() => void, onSave:() => void}} opts
 */
export function createEditor(parent, { content, path, onChange, onSave }) {
  const lang = new Compartment();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: content,
      extensions: [
        basicSetup,
        keymap.of([
          indentWithTab,
          { key: 'Mod-s', preventDefault: true, run: () => { onSave(); return true; } },
        ]),
        lang.of(languageFor(path)),
        syntaxHighlighting(highlight),
        theme,
        EditorView.updateListener.of((u) => { if (u.docChanged) onChange(); }),
      ],
    }),
  });
  return {
    view,
    getValue: () => view.state.doc.toString(),
    setValue: (text) => view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } }),
    focus: () => view.focus(),
    destroy: () => view.destroy(),
  };
}
