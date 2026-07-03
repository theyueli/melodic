import { Editor } from './editor.js';
import { setBaseDir, renderBlockHtml, splitBlocks, ensureLibs, highlightAllSync, ensureAbcjs, engraveAllSync } from './markdown.js';
import { FindBar } from './find.js';
import { installSmartPaste, pastePlain, copyRich, htmlToMarkdown } from './clipboard.js';

const $ = (sel) => document.querySelector(sel);

const writeEl = $('#write');
const scrollEl = $('#editor-scroll');
const sourceTA = $('#source-editor');
const sidebar = $('#sidebar');
const wordCountEl = $('#word-count');

let filePath = null;
let savedText = '';
let sourceMode = false;
let folder = null; // { root, name, tree }

/* ---------------- editor ---------------- */

const editor = new Editor(writeEl, {
  onChange: onDocChange,
  openExternal: (url) => window.api.openExternal(url),
  onNavigateAnchor: (anchor) => editor.scrollToHeadingText(anchor),
  spellcheck: (window.api.config || {}).spellcheck !== false
});
sourceTA.spellcheck = (window.api.config || {}).spellcheck !== false;
if (window.api.dev) window.__editor = editor; // test harness hook, dev builds only

const findBar = new FindBar(editor, $('#content'), { onDidChangeDoc: () => onDocChange() });
if (window.api.dev) window.__find = findBar;
if (window.api.dev) window.__clip = { htmlToMarkdown };

installSmartPaste();

/** Render a markdown fragment to themed-free HTML for the rich clipboard. */
async function renderClipboardHtml(md) {
  await ensureLibs();
  const tpl = document.createElement('template');
  tpl.innerHTML = splitBlocks(md).map((b) => renderBlockHtml(b)).join('\n');
  highlightAllSync(tpl.content);
  return tpl.innerHTML;
}

function currentText() {
  return sourceMode ? sourceTA.value : editor.getText();
}

function isDirty() {
  const t = currentText();
  // length check first: makes the common "definitely dirty" case O(1)
  return t.length !== savedText.length || t !== savedText;
}

/* All change-driven work (word count, outline, exact dirty check) is
 * throttled off the keystroke path — typing only pays for the textarea
 * autosize. The dirty *signal* however is sent immediately on the first
 * change (O(1)), so closing the window right after a keystroke still
 * prompts to save. */
let changeTimer = 0;
let loadingDoc = false;
let lastSentDirty = false;

function sendDirty(d) {
  if (d !== lastSentDirty) {
    lastSentDirty = d;
    window.api.setDirty(d);
  }
}

function onDocChange() {
  if (loadingDoc) return;
  sendDirty(true); // pessimistic, corrected below by the exact check
  if (changeTimer) return;
  changeTimer = setTimeout(() => {
    changeTimer = 0;
    updateWordCount();
    updateOutline();
    updateDocLang();
    if (findBar.visible) findBar.refresh();
    sendDirty(isDirty());
  }, 250);
}

/* Language-aware typography: predominantly-Chinese documents get CJK reading
 * rules (line height, justification, kinsoku, CJK–Latin autospacing, Kaiti
 * emphasis) via #write:lang(zh-Hans) selectors in the theme CSS. */
function detectDocLang(text) {
  const sample = text.length > 40000 ? text.slice(0, 40000) : text;
  let cjk = 0;
  let latin = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf)) cjk++;
    else if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) latin++;
  }
  // enough hanzi to matter, and at least ~20% of the letter mass
  return cjk > 50 && cjk * 4 > latin ? 'zh-Hans' : '';
}

function updateDocLang() {
  const lang = detectDocLang(currentText());
  if (lang) writeEl.setAttribute('lang', lang);
  else writeEl.removeAttribute('lang');
}

/* word count with a per-block cache: only blocks that changed are recounted */
const wcCache = new Map();

function countWordsIn(src) {
  if (!src || src.charCodeAt(0) === 96 /* ` fence */) return 0;
  const text = src.replace(/[#>*_`~|=-]/g, ' ');
  const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
  const words = (text.replace(/[一-鿿぀-ヿ가-힯]/g, ' ').match(/[A-Za-z0-9'’-]+/g) || []).length;
  return cjk + words;
}

function updateWordCount() {
  let total = 0;
  if (sourceMode) {
    total = countWordsIn(sourceTA.value.replace(/```[\s\S]*?```/g, ' '));
  } else {
    if (wcCache.size > 50000) wcCache.clear();
    const active = editor.active;
    for (let i = 0; i < editor.blocks.length; i++) {
      if (active && i === active.index) {
        total += countWordsIn(editor.activeValue());
        continue;
      }
      const src = editor.blocks[i];
      let c = wcCache.get(src);
      if (c === undefined) {
        c = countWordsIn(src);
        wcCache.set(src, c);
      }
      total += c;
    }
  }
  wordCountEl.textContent = `${total} ${total === 1 ? 'word' : 'words'}`;
}

/* ---------------- footnotes: hover preview + click-to-jump ---------------- */

const fnTip = document.createElement('div');
fnTip.id = 'fn-tooltip';
fnTip.className = 'hidden';
$('#content').appendChild(fnTip);
let fnHideTimer = 0;

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function findFootnoteDef(id) {
  const re = new RegExp('^\\s{0,3}\\[\\^' + escapeRegExp(id) + '\\]:');
  return editor.blocks.findIndex((b) => re.test(b));
}

function showFnTip(refEl) {
  clearTimeout(fnHideTimer);
  const id = refEl.dataset.fn;
  const idx = findFootnoteDef(id);
  fnTip.innerHTML = idx === -1
    ? '<em class="fn-missing">No footnote definition for [^' + id + ']</em>'
    : renderBlockHtml(editor.blocks[idx]);
  fnTip.classList.remove('hidden');
  const contentRect = $('#content').getBoundingClientRect();
  const r = refEl.getBoundingClientRect();
  const top = r.bottom - contentRect.top + 6;
  const left = Math.min(r.left - contentRect.left, contentRect.width - 380);
  fnTip.style.top = top + 'px';
  fnTip.style.left = Math.max(8, left) + 'px';
}

function hideFnTipSoon() {
  clearTimeout(fnHideTimer);
  fnHideTimer = setTimeout(() => fnTip.classList.add('hidden'), 200);
}

writeEl.addEventListener('mouseover', (e) => {
  const ref = e.target.closest('.fn-ref');
  if (ref) showFnTip(ref);
});
writeEl.addEventListener('mouseout', (e) => {
  if (e.target.closest('.fn-ref')) hideFnTipSoon();
});
fnTip.addEventListener('mouseenter', () => clearTimeout(fnHideTimer));
fnTip.addEventListener('mouseleave', hideFnTipSoon);

// capture-phase so the editor's block-activation click never fires for refs
writeEl.addEventListener(
  'click',
  (e) => {
    const ref = e.target.closest('.fn-ref');
    if (!ref) return;
    const idx = findFootnoteDef(ref.dataset.fn);
    if (idx !== -1) {
      e.preventDefault();
      e.stopPropagation();
      fnTip.classList.add('hidden');
      editor.scrollToBlock(idx);
    }
  },
  true
);

/* ---------------- document lifecycle ---------------- */

function loadDocument(text, path) {
  filePath = path || null;
  setBaseDir(filePath ? filePath.replace(/\/[^/]*$/, '') : null);
  loadingDoc = true;
  clearTimeout(changeTimer);
  changeTimer = 0;
  editor.setText(text);
  loadingDoc = false;
  // compare against the editor's canonical round-trip, not the raw bytes —
  // otherwise files whose whitespace normalizes (trailing newline, blank-line
  // runs) would read as dirty the moment they open
  savedText = editor.getText();
  if (sourceMode) {
    sourceTA.value = savedText;
  }
  window.api.setFile(filePath);
  lastSentDirty = false;
  window.api.setDirty(false);
  updateWordCount();
  updateOutline();
  updateDocLang();
  markActiveInTree();
  scrollEl.scrollTop = 0;
}

async function openPath(p) {
  if (isDirty() && !(await window.api.confirmDiscard())) return;
  const res = await window.api.readFile(p);
  if (!res.ok) {
    alert('Could not open file:\n' + res.error);
    return;
  }
  loadDocument(res.content, p);
}

async function newDocument() {
  if (isDirty() && !(await window.api.confirmDiscard())) return;
  loadDocument('', null);
}

async function openDialog() {
  const p = await window.api.openFileDialog();
  if (p) await openPath(p);
}

async function save(saveAs = false, thenClose = false) {
  if (sourceMode) syncFromSource();
  const content = editor.getText();
  const res = await window.api.saveFile({ filePath, content, saveAs });
  if (res.ok) {
    filePath = res.path;
    savedText = content;
    if (sourceMode) sourceTA.value = content; // keep the source view in sync with disk
    setBaseDir(filePath.replace(/\/[^/]*$/, ''));
    window.api.setFile(filePath);
    lastSentDirty = false;
    window.api.setDirty(false);
    if (folder) refreshTree();
    if (thenClose) window.api.closeNow();
  }
}

/* ---------------- export ---------------- */

/**
 * Render the whole document to a standalone HTML page (theme CSS, KaTeX and
 * syntax highlighting inlined). Shared by HTML export, PDF export and Print.
 */
async function buildExportHtml() {
  await ensureLibs(); // math + syntax highlighting must be live for export
  const text = currentText();
  const blocks = splitBlocks(text);
  const tpl = document.createElement('template');
  tpl.innerHTML = blocks.map((b) => renderBlockHtml(b)).join('\n');
  highlightAllSync(tpl.content);
  if (text.includes('```abc')) {
    try {
      await ensureAbcjs();
      engraveAllSync(tpl.content);
    } catch {}
  }
  const body = tpl.innerHTML;
  const themeHref = $('#theme-css').getAttribute('href');
  const cssTexts = [];
  for (const sheet of document.styleSheets) {
    const href = sheet.href || '';
    if (href.includes('katex') || href.endsWith(themeHref.replace('css/', '')) || href.includes('highlight.js')) {
      try {
        cssTexts.push(Array.from(sheet.cssRules).map((r) => r.cssText).join('\n'));
      } catch {}
    }
  }
  const title = filePath ? filePath.split('/').pop().replace(/\.\w+$/, '') : 'Untitled';
  const lang = detectDocLang(text);
  const html = `<!DOCTYPE html>
<html${lang ? ` lang="${lang}"` : ''}><head><meta charset="utf-8"><title>${title}</title>
<style>${cssTexts.join('\n')}
body { padding: 0; } #write { max-width: 860px; margin: 0 auto; padding: 40px 30px; }
@media print {
  #write { max-width: none; padding: 0; }
  pre, table, blockquote, .math-block { break-inside: avoid; }
  h1, h2, h3, h4, h5, h6 { break-after: avoid; }
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
}
</style></head>
<body><div id="write"${lang ? ` lang="${lang}"` : ''}>${body}</div></body></html>`;
  return { title, html };
}
if (window.api.dev) window.__buildExportHtml = buildExportHtml; // dev harness hook

const LIB_FAIL_MSG = 'could not load the math/highlighting libraries. Please try again.';

async function exportHtml() {
  let out;
  try {
    out = await buildExportHtml();
  } catch {
    alert('Export failed: ' + LIB_FAIL_MSG);
    return;
  }
  await window.api.exportHtml({ defaultName: out.title, html: out.html });
}

async function exportPdf() {
  let out;
  try {
    out = await buildExportHtml();
  } catch {
    alert('Export failed: ' + LIB_FAIL_MSG);
    return;
  }
  const res = await window.api.exportPdf({ defaultName: out.title, html: out.html });
  if (res && res.ok === false && !res.canceled) {
    alert('PDF export failed:\n' + (res.error || 'unknown error'));
  }
}

async function printDoc() {
  let out;
  try {
    out = await buildExportHtml();
  } catch {
    alert('Print failed: ' + LIB_FAIL_MSG);
    return;
  }
  const res = await window.api.printHtml({ html: out.html });
  if (res && res.ok === false) {
    alert('Print failed:\n' + (res.error || 'unknown error'));
  }
}

/* ---------------- source mode ---------------- */

function toggleSourceMode() {
  if (!sourceMode) {
    editor.commitActive();
    sourceTA.value = editor.getText();
    sourceTA.classList.remove('hidden');
    sourceTA.focus();
    sourceMode = true;
  } else {
    syncFromSource();
    sourceTA.classList.add('hidden');
    sourceMode = false;
  }
}

function syncFromSource() {
  if (editor.getText() !== sourceTA.value) {
    editor.setText(sourceTA.value);
  }
}

sourceTA.addEventListener('input', onDocChange);
sourceTA.addEventListener('keydown', (e) => {
  if (e.key === 'Tab') {
    e.preventDefault();
    const s = sourceTA.selectionStart;
    sourceTA.value = sourceTA.value.slice(0, s) + '  ' + sourceTA.value.slice(sourceTA.selectionEnd);
    sourceTA.selectionStart = sourceTA.selectionEnd = s + 2;
  }
});

/* ---------------- sidebar ---------------- */

function toggleSidebar(force) {
  const show = force !== undefined ? force : sidebar.classList.contains('hidden');
  sidebar.classList.toggle('hidden', !show);
  window.api.saveConfig({ sidebar: show });
}

function showSidebarTab(tab) {
  toggleSidebar(true);
  $('#tab-files').classList.toggle('active', tab === 'files');
  $('#tab-outline').classList.toggle('active', tab === 'outline');
  $('#panel-files').style.display = tab === 'files' ? '' : 'none';
  $('#panel-outline').style.display = tab === 'outline' ? '' : 'none';
  if (tab === 'outline') updateOutline();
}

$('#tab-files').addEventListener('click', () => showSidebarTab('files'));
$('#tab-outline').addEventListener('click', () => showSidebarTab('outline'));

/* file tree */

async function openFolderDialog() {
  const res = await window.api.openFolderDialog();
  if (res) {
    folder = res;
    window.api.saveConfig({ folder: res.root });
    renderTree();
    showSidebarTab('files');
  }
}

async function refreshTree() {
  if (!folder) return;
  const res = await window.api.refreshFolder(folder.root);
  if (res) {
    folder = res;
    renderTree();
  }
}

function renderTree() {
  const treeEl = $('#file-tree');
  treeEl.innerHTML = '';
  $('#file-empty').style.display = folder ? 'none' : '';
  if (!folder) return;

  const rootLabel = document.createElement('div');
  rootLabel.className = 'folder-root-label';
  rootLabel.textContent = folder.name;
  treeEl.appendChild(rootLabel);
  treeEl.appendChild(buildTreeNodes(folder.tree));
  markActiveInTree();
}

function buildTreeNodes(nodes) {
  const frag = document.createDocumentFragment();
  for (const node of nodes) {
    const div = document.createElement('div');
    div.className = 'tree-node';
    const row = document.createElement('div');
    row.className = 'tree-row';
    if (node.type === 'dir') {
      row.innerHTML = `<span class="twisty">▾</span><span>${escapeText(node.name)}</span>`;
      const children = document.createElement('div');
      children.className = 'tree-children';
      children.appendChild(buildTreeNodes(node.children));
      div.appendChild(row);
      div.appendChild(children);
      row.addEventListener('click', () => div.classList.toggle('collapsed'));
    } else {
      row.dataset.path = node.path;
      row.innerHTML = `<span class="file-icon">📄</span><span>${escapeText(node.name)}</span>`;
      row.addEventListener('click', () => openPath(node.path));
      div.appendChild(row);
    }
    frag.appendChild(div);
  }
  return frag;
}

function escapeText(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function markActiveInTree() {
  document.querySelectorAll('.tree-row.active').forEach((el) => el.classList.remove('active'));
  if (!filePath) return;
  const row = document.querySelector(`.tree-row[data-path="${CSS.escape(filePath)}"]`);
  if (row) row.classList.add('active');
}

/* outline */

let outlineTimer = null;
function updateOutline() {
  clearTimeout(outlineTimer);
  outlineTimer = setTimeout(() => {
    const items = editor.getOutline();
    const el = $('#outline');
    el.innerHTML = '';
    $('#outline-empty').style.display = items.length ? 'none' : '';
    for (const item of items) {
      const div = document.createElement('div');
      div.className = `outline-item outline-h${item.level}`;
      div.textContent = item.text;
      div.title = item.text;
      div.addEventListener('click', () => editor.scrollToBlock(item.index));
      el.appendChild(div);
    }
  }, 200);
}

/* sidebar resize */

(() => {
  const resizer = $('#sidebar-resizer');
  let dragging = false;
  resizer.addEventListener('mousedown', (e) => {
    dragging = true;
    e.preventDefault();
    document.body.style.cursor = 'col-resize';
  });
  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const w = Math.max(180, Math.min(480, e.clientX));
    sidebar.style.width = w + 'px';
  });
  window.addEventListener('mouseup', () => {
    if (dragging) {
      dragging = false;
      document.body.style.cursor = '';
      window.api.saveConfig({ sidebarWidth: sidebar.style.width });
    }
  });
})();

/* ---------------- theme ---------------- */

function setTheme(name) {
  $('#theme-css').setAttribute('href', `css/theme-${name}.css`);
  $('#hljs-theme').setAttribute(
    'href',
    `../node_modules/highlight.js/styles/${name === 'night' ? 'github-dark' : 'github'}.css`
  );
  document.body.dataset.theme = name;
  window.api.saveConfig({ theme: name }); // also drives the window background color
}

/* ---------------- menu dispatch ---------------- */

window.api.onMenu(async (action, arg) => {
  switch (action) {
    case 'new': return newDocument();
    case 'open': return openDialog();
    case 'open-folder': return openFolderDialog();
    case 'save': return save(false);
    case 'save-as': return save(true);
    case 'save-and-close': return save(false, true);
    case 'export-html': return exportHtml();
    case 'export-pdf': return exportPdf();
    case 'print': return printDoc();
    case 'toggle-sidebar': return toggleSidebar();
    case 'sidebar-outline': return showSidebarTab('outline');
    case 'sidebar-files': return showSidebarTab('files');
    case 'source-mode': return toggleSourceMode();
    case 'theme': return setTheme(arg);
    case 'undo':
      if (sourceMode) return document.execCommand('undo');
      return editor.undo();
    case 'redo':
      if (sourceMode) return document.execCommand('redo');
      return editor.redo();
    case 'copy-markdown':
      return navigator.clipboard.writeText(currentText());
    case 'copy-rich':
      return copyRich(() => currentText(), renderClipboardHtml).catch(() => {});
    case 'paste-plain':
      return pastePlain();
    case 'find':
      if (sourceMode) return; // source mode: use the textarea's native search via ⌘F? not available — ignore
      return findBar.open({ replace: false });
    case 'find-replace':
      if (sourceMode) return;
      return findBar.open({ replace: true });
    case 'find-next':
      return findBar.visible ? findBar.next() : undefined;
    case 'find-prev':
      return findBar.visible ? findBar.prev() : undefined;
    case 'spellcheck':
      editor.setSpellcheck(arg);
      sourceTA.spellcheck = !!arg;
      return;
    default:
      if (!sourceMode) editor.applyAction(action, arg);
  }
});

window.api.onOpenPath((p) => openPath(p));

/* ---------------- drag & drop ---------------- */

window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => {
  e.preventDefault();
  const file = e.dataTransfer.files && e.dataTransfer.files[0];
  if (file && /\.(md|markdown|mdown|mkd|txt)$/i.test(file.name)) {
    const p = window.api.getPathForFile(file);
    if (p) openPath(p);
  }
});

/* ---------------- startup ---------------- */

const WELCOME = `# Welcome to Melodic

**Melodic** is a live-rendering markdown editor — click any paragraph to edit its markdown source *in place*, click away (or press \`Esc\`) and it renders back.

## Getting started

- Open a file with \`⌘O\`, or a whole folder with \`⇧⌘O\`
- Toggle the sidebar with \`⇧⌘L\` — it has **Files** and **Outline** tabs
- Find & replace with \`⌘F\`, raw **source mode** with \`⌘/\`
- Switch theme in *View → Theme* (GitHub / Night)

## Things it renders

1. Inline **bold**, *italic*, ~~strike~~, ==highlight==, \`code\`, [links](https://example.com), and footnotes[^1]
2. Task lists — click the checkbox:

- [x] Build a markdown editor
- [ ] Write something great

> Blockquotes, tables, and fenced code with syntax highlighting:

\`\`\`js
function greet(name) {
  return \`Hello, \${name}!\`;
}
\`\`\`

| Key | Action |
| ---- | ---- |
| ⌘S | Save |
| ⌘P | Print |

Math, via KaTeX:

$$
e^{i\\pi} + 1 = 0
$$

## Sheet music

Melodic plays its namesake: write [ABC notation](https://abcnotation.com) in a \`\`\`abc fence and it engraves itself. Click the sheet to edit the notation — hover it and press ▶ to listen. *Paragraph → Music Sheet* (⌥⌘M) inserts a starter tune.

\`\`\`abc
X: 1
T: Concerto in F minor, BWV 1056
C: J. S. Bach
M: 2/4
L: 1/16
K: Fmin
F2F2- FcA=E | F=EF2- FcA=E | (3_G2=E2F2- FcAF | (3dc=B .c2 z4 |
\`\`\`

[^1]: Like this one — hover the marker to preview it, click to jump here.
`;

(async function init() {
  const cfg = window.api.config || {};
  if (cfg.theme) setTheme(cfg.theme);
  if (cfg.sidebarWidth) sidebar.style.width = cfg.sidebarWidth;
  if (cfg.sidebar) toggleSidebar(true);

  loadDocument(WELCOME, null);
  window.api.rendererReady();

  // folder tree restore is I/O — keep it off the startup path
  if (cfg.folder) {
    const res = await window.api.refreshFolder(cfg.folder);
    if (res) {
      folder = res;
      renderTree();
    }
  }
})();
