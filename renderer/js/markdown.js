import { Marked } from 'marked';

/* ---------------- lazy libraries ----------------
 * KaTeX and highlight.js together are ~2/3 of the bundle. They are built as
 * separate bundles and injected only when the document actually needs them.
 * Until then math renders as a subtle source placeholder and code renders
 * unhighlighted; both are upgraded in place the moment the library lands.
 */

let katex = null;
let hljs = null;
let katexLoading = null;
let hljsLoading = null;
const libListeners = [];

function injectScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

export function ensureKatex() {
  if (katex) return Promise.resolve(katex);
  if (!katexLoading) {
    katexLoading = injectScript('dist/katex.bundle.js').then(
      () => {
        katex = window.__katex;
        clearRenderCache(); // cached math placeholders are stale now
        libListeners.forEach((cb) => cb('katex'));
        return katex;
      },
      (err) => {
        katexLoading = null; // allow a retry on the next render
        throw err;
      }
    );
  }
  return katexLoading;
}

export function ensureHljs() {
  if (hljs) return Promise.resolve(hljs);
  if (!hljsLoading) {
    hljsLoading = injectScript('dist/hljs.bundle.js').then(
      () => {
        hljs = window.__hljs;
        drainHighlightQueue();
        libListeners.forEach((cb) => cb('hljs'));
        return hljs;
      },
      (err) => {
        hljsLoading = null; // allow a retry on the next render
        throw err;
      }
    );
  }
  return hljsLoading;
}

export function ensureLibs() {
  return Promise.all([ensureKatex(), ensureHljs()]);
}

/** cb(name) fires when a lazy library finishes loading ('katex' | 'hljs'). */
export function onLibLoaded(cb) {
  libListeners.push(cb);
}

/* ---------------- deferred syntax highlighting ----------------
 * Highlighting is never done during render — blocks appear instantly with
 * plain <pre><code>, then get highlighted in idle time once hljs is loaded.
 */

let hlQueue = [];
let hlScheduled = false;

export function scheduleHighlight(root) {
  const targets = root.querySelectorAll('pre code:not([data-hl]):not(.language-abc)');
  if (!targets.length) return;
  for (const el of targets) {
    el.dataset.hl = 'q';
    hlQueue.push(el);
  }
  ensureHljs().catch(() => {});
  if (hljs) drainHighlightQueue();
}

function drainHighlightQueue() {
  if (hlScheduled || !hljs || !hlQueue.length) return;
  hlScheduled = true;
  const work = (deadline) => {
    while (hlQueue.length && deadline.timeRemaining() > 3) {
      const el = hlQueue.pop();
      if (!el.isConnected || el.dataset.hl === 'done') continue;
      try {
        hljs.highlightElement(el);
      } catch {}
      el.dataset.hl = 'done';
    }
    if (hlQueue.length) requestIdleCallback(work, { timeout: 200 });
    else hlScheduled = false;
  };
  requestIdleCallback(work, { timeout: 200 });
}

/* ---------------- music sheets (```abc fences) ----------------
 * Engraving follows the same deferred pattern as syntax highlighting: blocks
 * render instantly as plain code, then upgrade to engraved SVG in idle time
 * once abcjs (a lazy 500KB bundle) lands. Documents without music pay zero. */

let abcjsLib = null;
let abcjsLoading = null;
const SOUNDFONT_URL = new URL('assets/soundfont/', document.baseURI).href;

export function ensureAbcjs() {
  if (abcjsLib) return Promise.resolve(abcjsLib);
  if (!abcjsLoading) {
    abcjsLoading = injectScript('dist/abcjs.bundle.js').then(
      () => {
        abcjsLib = window.__abcjs;
        drainAbcQueue();
        libListeners.forEach((cb) => cb('abcjs'));
        return abcjsLib;
      },
      (err) => {
        abcjsLoading = null; // allow a retry
        throw err;
      }
    );
  }
  return abcjsLoading;
}

let abcQueue = [];
let abcScheduled = false;

export function scheduleAbc(root) {
  const targets = root.querySelectorAll('pre code.language-abc:not([data-abc])');
  if (!targets.length) return;
  for (const el of targets) {
    el.dataset.abc = 'q';
    abcQueue.push(el);
  }
  ensureAbcjs().catch(() => {});
  if (abcjsLib) drainAbcQueue();
}

function drainAbcQueue() {
  if (abcScheduled || !abcjsLib || !abcQueue.length) return;
  abcScheduled = true;
  const work = (deadline) => {
    while (abcQueue.length && deadline.timeRemaining() > 5) {
      const el = abcQueue.pop();
      if (!el.isConnected || el.dataset.abc === 'done') continue;
      engraveAbc(el, true);
      el.dataset.abc = 'done';
    }
    if (abcQueue.length) requestIdleCallback(work, { timeout: 300 });
    else abcScheduled = false;
  };
  requestIdleCallback(work, { timeout: 300 });
}

function engraveAbc(codeEl, interactive) {
  const pre = codeEl.closest('pre');
  if (!pre) return;
  const src = codeEl.textContent.replace(/\n$/, '');
  const wrap = document.createElement('div');
  wrap.className = 'abc-sheet';
  const mount = document.createElement('div');
  wrap.appendChild(mount);
  try {
    const visual = abcjsLib.renderAbc(mount, src, {
      responsive: 'resize',
      staffwidth: 680,
      paddingtop: 0,
      paddingbottom: 4
    })[0];
    pre.replaceWith(wrap);
    if (interactive && visual && abcjsLib.synth && abcjsLib.synth.supportsAudio()) {
      const btn = document.createElement('button');
      btn.className = 'abc-play';
      btn.textContent = '▶';
      btn.title = 'Play';
      wrap.appendChild(btn);
      wireAbcPlayback(btn, visual);
    }
  } catch {
    // unparseable notation stays as a plain code block
  }
}

/* one tune plays at a time */
let abcSynth = null;
let abcPlayingBtn = null;
let abcAudioCtx = null;

function stopAbcPlayback() {
  if (abcSynth) {
    try { abcSynth.stop(); } catch {}
  }
  if (abcPlayingBtn) {
    abcPlayingBtn.textContent = '▶';
    abcPlayingBtn.title = 'Play';
  }
  abcSynth = null;
  abcPlayingBtn = null;
}

function wireAbcPlayback(btn, visual) {
  btn.addEventListener('click', async (e) => {
    e.stopPropagation(); // never activate the block for editing
    e.preventDefault();
    if (abcPlayingBtn === btn) {
      stopAbcPlayback();
      return;
    }
    stopAbcPlayback();
    btn.textContent = '…';
    try {
      abcAudioCtx = abcAudioCtx || new AudioContext();
      if (abcAudioCtx.state === 'suspended') await abcAudioCtx.resume();
      const synth = new abcjsLib.synth.CreateSynth();
      await synth.init({
        visualObj: visual,
        audioContext: abcAudioCtx,
        options: {
          soundFontUrl: SOUNDFONT_URL,
          onEnded: () => {
            if (abcSynth === synth) stopAbcPlayback();
          }
        }
      });
      await synth.prime();
      abcSynth = synth;
      abcPlayingBtn = btn;
      btn.textContent = '◼';
      btn.title = 'Stop';
      synth.start();
    } catch (err) {
      btn.textContent = '▶';
      btn.title = 'Playback unavailable';
    }
  });
  // block-activation guard for the mousedown path too
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
}

/** Synchronously engrave all ```abc blocks under a detached root (export). */
export function engraveAllSync(root) {
  if (!abcjsLib) return;
  root.querySelectorAll('pre code.language-abc').forEach((el) => engraveAbc(el, false));
}

/** Synchronously highlight everything under a detached root (used by export). */
export function highlightAllSync(root) {
  if (!hljs) return;
  root.querySelectorAll('pre code').forEach((el) => {
    try {
      hljs.highlightElement(el);
    } catch {}
  });
}

/* ---------------- marked setup ---------------- */

const inlineMath = {
  name: 'inlineMath',
  level: 'inline',
  start(src) {
    const i = src.indexOf('$');
    return i === -1 ? undefined : i;
  },
  tokenizer(src) {
    const match = src.match(/^\$([^$\n]+?)\$(?!\d)/);
    if (match && match[1].trim()) {
      return { type: 'inlineMath', raw: match[0], text: match[1] };
    }
  },
  renderer(token) {
    if (!katex) {
      ensureKatex().catch(() => {});
      return `<span class="math-pending">${escapeHtml(token.raw)}</span>`;
    }
    try {
      return katex.renderToString(token.text, { throwOnError: false });
    } catch {
      return escapeHtml(token.raw);
    }
  }
};

const blockMath = {
  name: 'blockMath',
  level: 'block',
  start(src) {
    const m = src.match(/(^|\n)\s{0,3}\$\$/);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const match = src.match(/^\s{0,3}\$\$([\s\S]+?)\$\$\s*(?:\n+|$)/);
    if (match) {
      return { type: 'blockMath', raw: match[0], text: match[1] };
    }
  },
  renderer(token) {
    if (!katex) {
      ensureKatex().catch(() => {});
      return `<pre class="math-pending">${escapeHtml(token.raw)}</pre>`;
    }
    try {
      return `<div class="math-block">${katex.renderToString(token.text, {
        displayMode: true,
        throwOnError: false
      })}</div>`;
    } catch {
      return `<pre>${escapeHtml(token.raw)}</pre>`;
    }
  }
};

/* Footnotes: [^id] references and "[^id]: definition" blocks. Each renders
 * self-contained (the label is the id, not a global number), so blocks stay
 * independently cacheable — no cross-block state, no render-cache invalidation. */
const footnoteRef = {
  name: 'footnoteRef',
  level: 'inline',
  start(src) {
    const i = src.indexOf('[^');
    return i === -1 ? undefined : i;
  },
  tokenizer(src) {
    const match = src.match(/^\[\^([^\]\s]{1,40})\](?!:)/);
    if (match) {
      return { type: 'footnoteRef', raw: match[0], text: match[1] };
    }
  },
  renderer(token) {
    const id = escapeHtml(token.text);
    return `<sup class="fn-ref" data-fn="${id}" title="Click to jump to the footnote">${id}</sup>`;
  }
};

const footnoteDef = {
  name: 'footnoteDef',
  level: 'block',
  start(src) {
    const m = src.match(/(^|\n)\s{0,3}\[\^/);
    return m ? m.index : undefined;
  },
  tokenizer(src) {
    const match = src.match(/^\s{0,3}\[\^([^\]\s]{1,40})\]:[ \t]*([\s\S]*?)(?:\n(?=\s{0,3}\[\^)|$)/);
    if (match) {
      // continuation lines are dedented and joined
      const text = match[2].replace(/\n\s+/g, ' ').trim();
      return {
        type: 'footnoteDef',
        raw: match[0],
        id: match[1],
        text,
        tokens: this.lexer.inlineTokens(text)
      };
    }
  },
  renderer(token) {
    const id = escapeHtml(token.id);
    return `<div class="md-footnote" data-fn="${id}"><span class="fn-label">${id}.</span> ${this.parser.parseInline(token.tokens)}</div>`;
  }
};

const markHighlight = {
  name: 'markHighlight',
  level: 'inline',
  start(src) {
    const i = src.indexOf('==');
    return i === -1 ? undefined : i;
  },
  tokenizer(src) {
    const match = src.match(/^==([^=\n]+?)==/);
    if (match) {
      return {
        type: 'markHighlight',
        raw: match[0],
        text: match[1],
        tokens: this.lexer.inlineTokens(match[1])
      };
    }
  },
  renderer(token) {
    return `<mark>${this.parser.parseInline(token.tokens)}</mark>`;
  }
};

const marked = new Marked({ gfm: true, breaks: false });
marked.use({ extensions: [inlineMath, blockMath, markHighlight, footnoteRef, footnoteDef] });

export function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/* ---------------- rendering ---------------- */

let currentFileDir = null;
export function setBaseDir(dir) {
  if (dir !== currentFileDir) clearRenderCache(); // image paths are baked into cached html
  currentFileDir = dir;
}

function resolveSrc(src) {
  if (!src || /^(https?:|data:|file:|\/)/i.test(src)) return src;
  if (!currentFileDir) return src;
  return 'file://' + currentFileDir.replace(/\/$/, '') + '/' + src;
}

/* LRU cache: block source -> rendered html. Re-renders (undo, source-mode
 * toggle, lib upgrades, repeated content) become near-free. */
const renderCache = new Map();
const RENDER_CACHE_MAX = 4000;

function clearRenderCache() {
  renderCache.clear();
}

const sharedTpl = document.createElement('template');

/**
 * Render one markdown block to an HTML string (no syntax highlighting here —
 * that happens lazily in idle time via scheduleHighlight).
 */
export function renderBlockHtml(source) {
  if (!source.trim()) {
    return '<p class="md-empty"><br/></p>';
  }
  const hit = renderCache.get(source);
  if (hit !== undefined) {
    // refresh LRU position
    renderCache.delete(source);
    renderCache.set(source, hit);
    return hit;
  }

  let html;
  try {
    html = marked.parse(source);
  } catch (err) {
    html = `<pre>${escapeHtml(source)}</pre>`;
  }

  // post-process only when the html needs it — template parsing is not free
  if (html.includes('<pre') || html.includes('<img') || html.includes('checkbox')) {
    sharedTpl.innerHTML = html;
    const content = sharedTpl.content;

    content.querySelectorAll('pre').forEach((el) => el.classList.add('md-fences'));

    content.querySelectorAll('img').forEach((img) => {
      img.setAttribute('src', resolveSrc(img.getAttribute('src')));
      img.setAttribute('loading', 'lazy');
      img.setAttribute('decoding', 'async');
    });

    let cbIndex = 0;
    content.querySelectorAll('li input[type="checkbox"]').forEach((cb) => {
      cb.removeAttribute('disabled');
      cb.dataset.cbIndex = String(cbIndex++);
      cb.closest('li').classList.add('task-list-item');
    });

    html = sharedTpl.innerHTML;
  }

  renderCache.set(source, html);
  if (renderCache.size > RENDER_CACHE_MAX) {
    renderCache.delete(renderCache.keys().next().value);
  }
  return html;
}

/* ---------------- plain-text (log) rendering ----------------
 * Plain mode renders text verbatim — no markdown, no normalization — with
 * ANSI SGR colors translated to spans and ERROR/WARN lines tinted. */

const ANSI_SGR_RE = /\x1b\[([0-9;]*)m/g;
const ANSI_OTHER_RE = /\x1b(?:\[[0-9;?]*[A-Za-ln-z]|\][^\x07]*(?:\x07|\x1b\\)|[()][AB012])/g;
const LOG_ERR_RE = /\b(?:ERROR|FATAL|ERR|PANIC|EXCEPTION|FAILED)\b/i;
const LOG_WARN_RE = /\bWARN(?:ING)?\b/i;

const SGR_CLASSES = {
  1: 'ansi-bold',
  30: 'ansi-30', 31: 'ansi-31', 32: 'ansi-32', 33: 'ansi-33',
  34: 'ansi-34', 35: 'ansi-35', 36: 'ansi-36', 37: 'ansi-37',
  90: 'ansi-30', 91: 'ansi-31', 92: 'ansi-32', 93: 'ansi-33',
  94: 'ansi-34', 95: 'ansi-35', 96: 'ansi-36', 97: 'ansi-37'
};

function renderPlainLine(line) {
  const clean = line.replace(ANSI_OTHER_RE, '');
  let html = '';
  let last = 0;
  let open = false;
  let classes = [];
  ANSI_SGR_RE.lastIndex = 0;
  let m;
  while ((m = ANSI_SGR_RE.exec(clean))) {
    const text = clean.slice(last, m.index);
    if (text) html += escapeHtml(text);
    last = m.index + m[0].length;
    if (open) { html += '</span>'; open = false; }
    const codes = (m[1] || '0').split(';').map(Number);
    for (const code of codes) {
      if (code === 0 || code === 39) classes = [];
      else if (SGR_CLASSES[code]) {
        // a new color replaces the previous color; bold replaces bold
        const isBold = code === 1;
        classes = classes.filter((cl) => (cl === 'ansi-bold') !== isBold);
        classes.push(SGR_CLASSES[code]);
      }
    }
    if (classes.length) { html += `<span class="${classes.join(' ')}">`; open = true; }
  }
  const tail = clean.slice(last);
  if (tail) html += escapeHtml(tail);
  if (open) html += '</span>';

  const stripped = clean.replace(ANSI_SGR_RE, '');
  let cls = 'pl-line';
  if (LOG_ERR_RE.test(stripped)) cls += ' log-err';
  else if (LOG_WARN_RE.test(stripped)) cls += ' log-warn';
  return `<span class="${cls}">${html || '&#8203;'}</span>`;
}

/** Render a chunk of plain text lines verbatim. */
export function renderPlainHtml(source) {
  const lines = source.split('\n');
  return `<pre class="plain-chunk">${lines.map(renderPlainLine).join('\n')}</pre>`;
}

/** Partition text into fixed line-count chunks that re-join byte-exactly. */
export function splitPlainChunks(text, linesPerChunk = 40) {
  const lines = (text || '').split('\n');
  const chunks = [];
  for (let i = 0; i < lines.length; i += linesPerChunk) {
    chunks.push(lines.slice(i, i + linesPerChunk).join('\n'));
  }
  if (!chunks.length) chunks.push('');
  return chunks;
}

/* ---------------- block splitting ---------------- */

const LIST_RE = /^\s{0,3}(?:[-+*]|\d{1,9}[.)])\s/;
const FENCE_RE = /^(\s{0,3})(`{3,}|~{3,})/;
const HEADING_RE = /^\s{0,3}#{1,6}(\s|$)/;
const HR_RE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE_RE = /^\s{0,3}>/;
const TABLE_DELIM_RE = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

const isBlank = (l) => l.length === 0 || /^\s*$/.test(l);

function startsNewBlock(line) {
  // fast path: a line starting with a letter or CJK char can never start a
  // special block, and that is the overwhelmingly common case
  const c = line.charCodeAt(0);
  if ((c >= 97 && c <= 122) || (c >= 65 && c <= 90) || c > 0x2fff) return false;
  return (
    HEADING_RE.test(line) ||
    FENCE_RE.test(line) ||
    QUOTE_RE.test(line) ||
    HR_RE.test(line) ||
    /^\s{0,3}[-+*]\s/.test(line) ||
    /^\s{0,3}\d{1,9}[.)]\s/.test(line) ||
    /^\s{0,3}\$\$/.test(line)
  );
}

/**
 * Split a markdown document into an array of block source strings.
 * Blocks joined with "\n\n" reproduce an equivalent document.
 */
export function splitBlocks(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const n = lines.length;
  let i = 0;

  // YAML front matter
  if (lines[0] === '---') {
    let j = 1;
    while (j < n && !/^(---|\.\.\.)\s*$/.test(lines[j])) j++;
    if (j < n) {
      blocks.push(lines.slice(0, j + 1).join('\n'));
      i = j + 1;
    }
  }

  while (i < n) {
    if (isBlank(lines[i])) { i++; continue; }
    const line = lines[i];
    const c0 = line.charCodeAt(0);
    // fast path for plain-prose lines (letters / CJK): they can only start a
    // paragraph, so skip all the special-block matching below
    const isProse = (c0 >= 97 && c0 <= 122) || (c0 >= 65 && c0 <= 90) || c0 > 0x2fff;

    if (!isProse) {
      // fenced code
      const fence = line.match(FENCE_RE);
      if (fence) {
        const ch = fence[2][0];
        const len = fence[2].length;
        const closeRe = new RegExp('^\\s{0,3}\\' + ch + '{' + len + ',}\\s*$');
        let j = i + 1;
        while (j < n && !closeRe.test(lines[j])) j++;
        const end = j < n ? j : n - 1;
        blocks.push(lines.slice(i, end + 1).join('\n'));
        i = end + 1;
        continue;
      }

      // math block
      if (/^\s{0,3}\$\$/.test(line)) {
        const rest = line.trim().slice(2);
        if (rest.includes('$$')) {
          blocks.push(line);
          i++;
          continue;
        }
        let j = i + 1;
        while (j < n && !/\$\$\s*$/.test(lines[j])) j++;
        const end = j < n ? j : n - 1;
        blocks.push(lines.slice(i, end + 1).join('\n'));
        i = end + 1;
        continue;
      }

      // heading / hr: single-line blocks
      if (HEADING_RE.test(line) || HR_RE.test(line)) {
        blocks.push(line);
        i++;
        continue;
      }

      // list (keeps loose-list blank lines inside one block)
      if (LIST_RE.test(line)) {
        let end = i;
        let j = i + 1;
        while (j < n) {
          if (!isBlank(lines[j])) {
            if (FENCE_RE.test(lines[j]) && !/^\s{2,}/.test(lines[j])) break;
            end = j;
            j++;
            continue;
          }
          let k = j;
          while (k < n && isBlank(lines[k])) k++;
          if (k < n && (LIST_RE.test(lines[k]) || /^\s{2,}\S/.test(lines[k]))) {
            end = k;
            j = k + 1;
          } else break;
        }
        blocks.push(lines.slice(i, end + 1).join('\n'));
        i = end + 1;
        continue;
      }

      // blockquote (with lazy continuation)
      if (QUOTE_RE.test(line)) {
        let end = i;
        let j = i + 1;
        while (j < n && !isBlank(lines[j])) { end = j; j++; }
        blocks.push(lines.slice(i, end + 1).join('\n'));
        i = end + 1;
        continue;
      }

      // footnote definition (with indented continuation lines)
      if (/^\s{0,3}\[\^[^\]\s]+\]:/.test(line)) {
        let end = i;
        let j = i + 1;
        while (j < n && /^\s{2,}\S/.test(lines[j])) { end = j; j++; }
        blocks.push(lines.slice(i, end + 1).join('\n'));
        i = end + 1;
        continue;
      }

      // HTML block
      if (/^\s{0,3}<[a-zA-Z!/]/.test(line)) {
        let end = i;
        let j = i + 1;
        while (j < n && !isBlank(lines[j])) { end = j; j++; }
        blocks.push(lines.slice(i, end + 1).join('\n'));
        i = end + 1;
        continue;
      }
    }

    // table (a prose line can be a table header, so this stays outside the gate)
    if (i + 1 < n && line.includes('|') && lines[i + 1].includes('-') && TABLE_DELIM_RE.test(lines[i + 1])) {
      let end = i + 1;
      let j = i + 2;
      while (j < n && lines[j].includes('|') && !isBlank(lines[j])) { end = j; j++; }
      blocks.push(lines.slice(i, end + 1).join('\n'));
      i = end + 1;
      continue;
    }

    // paragraph: until blank line or an interrupting block start
    {
      let end = i;
      let j = i + 1;
      while (j < n && !isBlank(lines[j])) {
        // setext underline (H1 '=' or H2 '-') terminates and joins the
        // paragraph — checked before startsNewBlock, which would otherwise
        // misread a '---' underline as a horizontal rule
        if (/^\s{0,3}(=+|-+)\s*$/.test(lines[j])) { end = j; j++; break; }
        if (startsNewBlock(lines[j])) break;
        end = j;
        j++;
      }
      blocks.push(lines.slice(i, end + 1).join('\n'));
      i = end + 1;
      continue;
    }
  }

  if (blocks.length === 0) blocks.push('');
  return blocks;
}

/* ---------------- block type helpers ---------------- */

export function blockKind(source) {
  const first = source.split('\n', 1)[0];
  if (FENCE_RE.test(first)) return 'fence';
  if (source.startsWith('---') && /\n---\s*$|\n\.\.\.\s*$/.test(source)) return 'meta';
  if (/^\s{0,3}\$\$/.test(first)) return 'math';
  if (HEADING_RE.test(first)) return 'heading';
  if (LIST_RE.test(first)) return 'list';
  if (QUOTE_RE.test(first)) return 'quote';
  if (source.includes('\n') && TABLE_DELIM_RE.test(source.split('\n')[1] || '')) return 'table';
  if (HR_RE.test(first)) return 'hr';
  return 'paragraph';
}

/** Blocks whose textarea should use a monospace font. */
export function isMonoKind(kind) {
  return kind === 'fence' || kind === 'meta' || kind === 'math' || kind === 'table';
}

/** Blocks where Enter should insert a newline rather than split the block. */
export function isMultilineKind(kind) {
  return kind === 'fence' || kind === 'meta' || kind === 'math' || kind === 'table' || kind === 'list' || kind === 'quote';
}
