/**
 * Smart clipboard:
 *  - pasting rich text/HTML converts to markdown (Turndown, lazy-loaded)
 *  - "Paste as Plain Text" bypasses the conversion
 *  - "Copy as Rich Text" puts rendered HTML + markdown on the clipboard
 */

let turndown = null;
let turndownLoading = null;

function ensureTurndown() {
  if (turndown) return Promise.resolve(turndown);
  if (!turndownLoading) {
    turndownLoading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = 'dist/turndown.bundle.js';
      s.onload = () => {
        turndown = window.__turndown();
        resolve(turndown);
      };
      s.onerror = (err) => {
        turndownLoading = null;
        reject(err);
      };
      document.head.appendChild(s);
    });
  }
  return turndownLoading;
}

export async function htmlToMarkdown(html) {
  const svc = await ensureTurndown();
  let md = svc.turndown(html);
  // collapse the 3+ blank lines some converters emit
  md = md.replace(/\n{3,}/g, '\n\n').trim();
  return md;
}

function isEditableTarget(t) {
  return (
    t instanceof HTMLTextAreaElement &&
    (t.classList.contains('block-source') || t.id === 'source-editor')
  );
}

export function insertIntoTextarea(ta, text) {
  ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
  ta.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Intercept paste into markdown-editing textareas: when the clipboard carries
 * HTML, convert it to markdown. Plain-text clipboards use the default path.
 */
export function installSmartPaste() {
  document.addEventListener(
    'paste',
    (e) => {
      const ta = e.target;
      if (!isEditableTarget(ta)) return;
      if (!e.clipboardData) return;
      const html = e.clipboardData.getData('text/html');
      const plain = e.clipboardData.getData('text/plain');
      if (!html || !html.trim()) return; // no rich content — default paste
      // heuristic: HTML that carries no structure beyond a wrapper adds nothing
      if (!/<(h[1-6]|ul|ol|li|table|pre|blockquote|b|strong|i|em|a|img|code|del|s|input)\b/i.test(html)) {
        return;
      }
      e.preventDefault();
      htmlToMarkdown(html)
        .then((md) => insertIntoTextarea(ta, md && md.trim() ? md : plain))
        .catch(() => insertIntoTextarea(ta, plain));
    },
    true
  );
}

/** Paste the clipboard's plain text verbatim (menu: ⇧⌘V). */
export async function pastePlain() {
  const t = document.activeElement;
  if (!isEditableTarget(t)) return;
  try {
    const text = await navigator.clipboard.readText();
    if (text) insertIntoTextarea(t, text);
  } catch {}
}

/**
 * Copy as rich text: the current textarea selection (or the whole document)
 * rendered to HTML, alongside the raw markdown as text/plain. Pastes rich
 * into Word/Gmail/Lark and as markdown into plain-text targets.
 */
export async function copyRich(getMarkdown, renderFragment) {
  const t = document.activeElement;
  let md = null;
  if (isEditableTarget(t) && t.selectionStart !== t.selectionEnd) {
    md = t.value.slice(t.selectionStart, t.selectionEnd);
  }
  if (md === null) md = getMarkdown();
  if (!md || !md.trim()) return false;
  const html = await renderFragment(md);
  await navigator.clipboard.write([
    new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([md], { type: 'text/plain' })
    })
  ]);
  return true;
}
