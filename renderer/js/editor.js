import {
  splitBlocks,
  renderBlockHtml,
  blockKind,
  isMonoKind,
  isMultilineKind,
  scheduleHighlight,
  onLibLoaded
} from './markdown.js';
import { buildTableGrid } from './table-grid.js';

const LIST_ITEM_RE = /^(\s*)([-+*]|\d{1,9}[.)])(\s+\[[ xX]\])?(\s+)/;

/** Blocks rendered synchronously on document load; the rest materialize lazily. */
const SYNC_RENDER_COUNT = 60;

/** Native auto-growing textareas (Chromium 123+) make JS autosize unnecessary. */
const FIELD_SIZING = typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content');

export class Editor {
  /**
   * @param {HTMLElement} container  the #write element
   * @param {object} opts { onChange(), openExternal(url), onNavigateAnchor(text) }
   */
  constructor(container, opts = {}) {
    this.container = container;
    this.opts = opts;
    this.blocks = [''];
    this.active = null; // { index, ta }
    this.lastActiveIndex = 0;
    this.undoStack = [];
    this.redoStack = [];
    this._lastEditAt = 0;
    this._suppressBlurCommit = false;

    this._io = null;
    this._lazyQueue = null;
    this._lazyPtr = 0;
    this._idleHandle = 0;
    this._releaseHandle = 0;
    this._cvReleased = true;

    container.addEventListener('mousedown', (e) => this._onMouseDown(e));
    container.addEventListener('click', (e) => this._onClick(e));
    window.addEventListener('resize', () => this._autosize());

    // when KaTeX lands, upgrade the blocks that rendered math placeholders
    onLibLoaded((name) => {
      if (name !== 'katex') return;
      const stale = new Set();
      this.container
        .querySelectorAll('.md-block:not(.md-editing):not(.md-lazy) .math-pending')
        .forEach((el) => stale.add(el.closest('.md-block')));
      for (const el of stale) {
        el.innerHTML = renderBlockHtml(this.blocks[Number(el.dataset.i)]);
        scheduleHighlight(el);
      }
    });
  }

  /* ---------------- document ---------------- */

  setText(text) {
    this.active = null;
    this.blocks = splitBlocks(text || '');
    this.undoStack = [];
    this.redoStack = [];
    this.renderAll();
  }

  getText() {
    const parts = this.blocks.slice();
    if (this.active) parts[this.active.index] = this.activeValue();
    return parts.join('\n\n');
  }

  /** Source of the block being edited (textarea or table grid). */
  activeValue() {
    if (!this.active) return '';
    return this.active.ta ? this.active.ta.value : this.active.getValue();
  }

  getBlockEl(index) {
    return this.container.children[index] || null;
  }

  /** Materialize (if lazy) and return a block's element. */
  ensureBlockRendered(index) {
    const el = this.getBlockEl(index);
    if (el) this._materializeEl(el);
    return el;
  }

  /** Replace one block's source (used by find & replace). */
  replaceBlockSource(index, source, { undo = true } = {}) {
    if (index < 0 || index >= this.blocks.length) return;
    if (this.active && this.active.index === index) this.commitActive();
    if (undo) this.pushUndo();
    this._replaceBlocks(index, 1, [source]);
  }

  renderAll() {
    this._cancelLazyWork();
    // small documents skip virtualization entirely
    this._cvReleased = this.blocks.length <= SYNC_RENDER_COUNT;
    this.container.innerHTML = '';
    const frag = document.createDocumentFragment();
    this.blocks.forEach((src, i) => {
      frag.appendChild(i < SYNC_RENDER_COUNT ? this._makeBlockEl(src) : this._makeLazyEl(src));
    });
    this.container.appendChild(frag);
    this._reindex();
    scheduleHighlight(this.container);
    this._startLazyMaterialize();
    this._changed(false);
  }

  _makeBlockEl(source) {
    const div = document.createElement('div');
    div.className = this._cvReleased ? 'md-block' : 'md-block md-cv';
    div.innerHTML = renderBlockHtml(source);
    return div;
  }

  /** Placeholder for a not-yet-rendered block, sized so scrolling feels right. */
  _makeLazyEl(source) {
    const div = document.createElement('div');
    div.className = 'md-block md-cv md-lazy';
    let nl = 0;
    for (let i = source.indexOf('\n'); i !== -1; i = source.indexOf('\n', i + 1)) nl++;
    // rough wrapped-height estimate: newlines plus soft-wrap of long content
    const est = Math.min(2400, 26 * (nl + 1 + (source.length / 90) | 0) + 14);
    div.style.containIntrinsicSize = `auto ${est}px`;
    return div;
  }

  _materializeEl(el) {
    if (!el.classList.contains('md-lazy')) return;
    el.innerHTML = renderBlockHtml(this.blocks[Number(el.dataset.i)]);
    el.classList.remove('md-lazy');
    if (this._io) this._io.unobserve(el);
    scheduleHighlight(el);
  }

  _startLazyMaterialize() {
    const lazies = this.container.querySelectorAll('.md-lazy');
    if (!lazies.length) return;

    // near-viewport blocks first
    this._io = new IntersectionObserver(
      (entries) => {
        for (const en of entries) {
          if (en.isIntersecting) this._materializeEl(en.target);
        }
      },
      { root: this.container.parentElement, rootMargin: '2000px' }
    );
    lazies.forEach((el) => this._io.observe(el));

    // then drain the rest in idle time so the whole doc is eventually live
    this._lazyQueue = Array.from(lazies);
    this._lazyPtr = 0;
    const drain = (deadline) => {
      const q = this._lazyQueue;
      if (!q) return;
      while (this._lazyPtr < q.length && deadline.timeRemaining() > 2) {
        const el = q[this._lazyPtr++];
        if (el.isConnected) this._materializeEl(el);
      }
      if (this._lazyPtr < q.length) {
        this._idleHandle = requestIdleCallback(drain, { timeout: 500 });
      } else {
        this._cancelLazyWork();
        this._startCvRelease();
      }
    };
    this._idleHandle = requestIdleCallback(drain, { timeout: 500 });
  }

  /**
   * Once every block is materialized, progressively drop content-visibility
   * in idle time, forcing layout in small slices. After this, the whole
   * document is laid out and scrolling costs nothing but paint.
   */
  _startCvRelease() {
    let i = 0;
    const els = this.container.children;
    const step = (deadline) => {
      let released = 0;
      while (i < els.length && (released < 300 || deadline.timeRemaining() > 3)) {
        const el = els[i++];
        if (el) el.classList.remove('md-cv');
        released++;
        if (released >= 600) break;
      }
      void this.container.offsetHeight; // lay out this slice now, off the hot path
      if (i < els.length) {
        this._releaseHandle = requestIdleCallback(step, { timeout: 1000 });
      } else {
        this._releaseHandle = 0;
        this._cvReleased = true;
      }
    };
    this._releaseHandle = requestIdleCallback(step, { timeout: 1000 });
  }

  _cancelLazyWork() {
    if (this._idleHandle) cancelIdleCallback(this._idleHandle);
    this._idleHandle = 0;
    if (this._releaseHandle) cancelIdleCallback(this._releaseHandle);
    this._releaseHandle = 0;
    this._lazyQueue = null;
    this._lazyPtr = 0;
    if (this._io) this._io.disconnect();
    this._io = null;
  }

  _blockEls() {
    return Array.from(this.container.children);
  }

  _reindex(from = 0) {
    const els = this.container.children;
    for (let i = from; i < els.length; i++) els[i].dataset.i = String(i);
  }

  _changed(structural = true) {
    if (this.opts.onChange) this.opts.onChange();
  }

  /**
   * Replace `count` blocks starting at `start` with `sources` (both model and DOM).
   */
  _replaceBlocks(start, count, sources) {
    this.blocks.splice(start, count, ...sources);
    const els = this._blockEls();
    const newEls = sources.map((s) => this._makeBlockEl(s));
    const anchor = els[start + count] || null;
    for (let k = 0; k < count; k++) els[start + k].remove();
    newEls.forEach((el) => this.container.insertBefore(el, anchor));
    if (this.blocks.length === 0) {
      this.blocks = [''];
      this.container.appendChild(this._makeBlockEl(''));
      this._reindex(start);
    } else if (sources.length === count) {
      // same-count replacement (the common case): indices don't shift
      newEls.forEach((el, k) => (el.dataset.i = String(start + k)));
    } else {
      this._reindex(start);
    }
    newEls.forEach((el) => scheduleHighlight(el));
    this._changed();
  }

  /* ---------------- undo / redo ---------------- */

  _snapshot() {
    return {
      text: this.getText(),
      index: this.active ? this.active.index : this.lastActiveIndex,
      caret: this.active && this.active.ta ? this.active.ta.selectionStart : 0
    };
  }

  pushUndo() {
    this.undoStack.push(this._snapshot());
    if (this.undoStack.length > 200) this.undoStack.shift();
    this.redoStack = [];
  }

  _maybePushUndoForTyping() {
    const now = Date.now();
    if (now - this._lastEditAt > 800) this.pushUndo();
    this._lastEditAt = now;
  }

  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(this._snapshot());
    this._restore(this.undoStack.pop());
  }

  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(this._snapshot());
    this._restore(this.redoStack.pop());
  }

  _restore(snap) {
    this.active = null;
    this.blocks = splitBlocks(snap.text);
    this.renderAll();
    const idx = Math.min(snap.index, this.blocks.length - 1);
    this.activate(idx, snap.caret);
  }

  /* ---------------- activation ---------------- */

  activate(index, caret = 'end', opts = {}) {
    if (index < 0 || index >= this.blocks.length) return;
    if (this.active && this.active.index === index) {
      if (this.active.ta) {
        this._setCaret(this.active.ta, caret);
        this.active.ta.focus();
      }
      return;
    }
    // committing may remove or split the previously active block,
    // shifting the indices of everything after it
    if (this.active) {
      const preIndex = this.active.index;
      const preLen = this.blocks.length;
      this.commitActive();
      if (index > preIndex) index += this.blocks.length - preLen;
    }
    index = Math.max(0, Math.min(index, this.blocks.length - 1));

    const el = this.container.children[index];
    if (el.classList.contains('md-lazy')) {
      el.classList.remove('md-lazy');
      if (this._io) this._io.unobserve(el);
    }
    const source = this.blocks[index];
    const kind = blockKind(source);

    // tables edit visually as a cell grid (MD button falls back to source)
    if (kind === 'table' && !opts.forceSource) {
      this._activateTableGrid(index, el, source, opts.cell);
      return;
    }

    const ta = document.createElement('textarea');
    ta.className = 'block-source' + (isMonoKind(kind) ? ' mono' : '');
    ta.value = source;
    ta.spellcheck = false;
    ta.rows = 1;

    el.classList.add('md-editing');
    el.innerHTML = '';
    el.appendChild(ta);

    this.active = { index, ta };
    this.lastActiveIndex = index;

    this._autosize();
    this._setCaret(ta, caret);
    this._suppressBlurCommit = true;
    ta.focus();
    this._suppressBlurCommit = false;

    ta.addEventListener('input', () => {
      this._autosize();
      this._changed(false);
      // switch font style live if the kind changes (e.g. typing ``` )
      const k = blockKind(ta.value);
      ta.classList.toggle('mono', isMonoKind(k));
    });
    ta.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') {
        e.preventDefault();
        e.inputType === 'historyUndo' ? this.undo() : this.redo();
        return;
      }
      this._maybePushUndoForTyping();
    });
    ta.addEventListener('keydown', (e) => this._onKeydown(e));
    ta.addEventListener('blur', () => {
      if (this._suppressBlurCommit || !document.hasFocus()) return;
      // wait a tick: a click that re-activates another block handles its own commit
      setTimeout(() => {
        if (this.active && this.active.ta === ta && document.activeElement !== ta) {
          this.commitActive();
        }
      }, 0);
    });
  }

  _activateTableGrid(index, el, source, cell) {
    el.classList.add('md-editing');
    const grid = buildTableGrid(el, source, {
      onCommit: () => this.commitActive(),
      onExitToSource: (src) => {
        // hand off to the raw-source textarea, keeping current edits
        this.active = null;
        el.classList.remove('md-editing');
        this._replaceBlocks(index, 1, [src]);
        this.activate(index, 'start', { forceSource: true });
      }
    });
    this.active = { index, ta: null, getValue: grid.getValue };
    this.lastActiveIndex = index;
    const at = cell || { row: 0, col: 0 };
    grid.focusCell(at.row, at.col);

    grid.el.addEventListener('focusout', () => {
      setTimeout(() => {
        if (
          this.active &&
          this.active.index === index &&
          !this.active.ta &&
          !grid.el.contains(document.activeElement) &&
          document.hasFocus()
        ) {
          this.commitActive();
        }
      }, 0);
    });
  }

  _setCaret(ta, caret) {
    let pos;
    if (caret === 'end') pos = ta.value.length;
    else if (caret === 'start') pos = 0;
    else pos = Math.max(0, Math.min(ta.value.length, caret | 0));
    ta.selectionStart = ta.selectionEnd = pos;
  }

  _autosize() {
    // with native field-sizing the browser grows the textarea itself
    if (FIELD_SIZING) return;
    if (!this.active) return;
    const ta = this.active.ta;
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 'px';
  }

  /**
   * Commit the active textarea back into the model and re-render.
   * The edited source may split into several blocks (or vanish).
   */
  commitActive() {
    if (!this.active) return;
    const index = this.active.index;
    const value = this.activeValue();
    this.active = null;

    let sources;
    if (!value.trim()) {
      sources = this.blocks.length > 1 ? [] : [''];
    } else {
      sources = splitBlocks(value);
    }
    this._replaceBlocks(index, 1, sources);
  }

  /* ---------------- mouse ---------------- */

  _onMouseDown(e) {
    // clicking blank area below the last block appends a paragraph
    if (e.target === this.container) {
      this.commitActive();
      const els = this._blockEls();
      const last = els[els.length - 1];
      if (last && e.clientY > last.getBoundingClientRect().bottom) {
        e.preventDefault();
        const lastIdx = this.blocks.length - 1;
        if (this.blocks[lastIdx].trim() === '') {
          this.activate(lastIdx, 'end');
        } else {
          this.pushUndo();
          this._replaceBlocks(this.blocks.length, 0, ['']);
          this.activate(this.blocks.length - 1, 0);
        }
      }
    }
  }

  _onClick(e) {
    const blockEl = e.target.closest('.md-block');
    if (!blockEl || blockEl.classList.contains('md-editing')) return;
    // commit any active edit first — it may re-split and shift indices,
    // so read the clicked block's index only afterwards (reindexed DOM)
    this.commitActive();
    if (!blockEl.isConnected) return;
    const index = Number(blockEl.dataset.i);
    this._materializeEl(blockEl);

    // task checkbox toggle
    if (e.target.matches('input[type="checkbox"]')) {
      e.preventDefault();
      this._toggleCheckbox(index, Number(e.target.dataset.cbIndex));
      return;
    }

    // links: cmd+click opens, plain click also opens external (Typora-like)
    const a = e.target.closest('a[href]');
    if (a) {
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) {
        if (this.opts.onNavigateAnchor) this.opts.onNavigateAnchor(href.slice(1));
      } else if (e.metaKey || e.ctrlKey) {
        if (this.opts.openExternal) this.opts.openExternal(href);
      } else {
        this.activate(index, this._caretFromPoint(blockEl, index, e));
      }
      return;
    }

    // clicking a rendered table cell lands the grid focus on that cell
    let cell = null;
    const cellEl = e.target.closest('td, th');
    if (cellEl && blockEl.contains(cellEl)) {
      const tr = cellEl.parentElement;
      const col = Array.prototype.indexOf.call(tr.children, cellEl);
      const row =
        cellEl.tagName === 'TH'
          ? 0
          : 1 + Array.prototype.indexOf.call(tr.parentElement.children, tr);
      cell = { row, col };
    }

    this.activate(index, this._caretFromPoint(blockEl, index, e), { cell });
  }

  _caretFromPoint(blockEl, index, e) {
    let prefix = '';
    try {
      const range = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (range && blockEl.contains(range.startContainer)) {
        const pre = document.createRange();
        pre.selectNodeContents(blockEl);
        pre.setEnd(range.startContainer, range.startOffset);
        prefix = pre.toString();
      }
    } catch {}
    const source = this.blocks[index];
    if (!prefix) return 'end';
    for (let len = Math.min(32, prefix.length); len >= 3; len--) {
      const frag = prefix.slice(-len);
      const idx = source.indexOf(frag);
      if (idx !== -1) return idx + frag.length;
    }
    return Math.min(prefix.length, source.length);
  }

  _toggleCheckbox(index, cbOrdinal) {
    this.pushUndo();
    const src = this.blocks[index];
    let count = -1;
    // count only markers at list-item starts — a literal "[x]" in a code span
    // or link text is not a checkbox and must not shift the ordinals
    const next = src.replace(
      /^(\s*(?:[-+*]|\d{1,9}[.)])\s+\[)([ xX])(\])/gm,
      (m, pre, c, post) => {
        count++;
        if (count !== cbOrdinal) return m;
        return pre + (c === ' ' ? 'x' : ' ') + post;
      }
    );
    this._replaceBlocks(index, 1, [next]);
  }

  /* ---------------- keyboard ---------------- */

  _onKeydown(e) {
    if (e.isComposing) return;
    const ta = this.active.ta;
    const i = this.active.index;
    const val = ta.value;
    const s = ta.selectionStart;
    const en = ta.selectionEnd;
    const collapsed = s === en;
    const kind = blockKind(val);

    if (e.key === 'Escape') {
      e.preventDefault();
      this.commitActive();
      return;
    }

    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.undo();
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      this.redo();
      return;
    }

    if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault();
      if (e.shiftKey) {
        this._insertAtCaret(kind === 'paragraph' ? '  \n' : '\n');
        return;
      }
      this._handleEnter(kind, ta, i, val, s, en);
      return;
    }

    if (e.key === 'Backspace' && collapsed && s === 0) {
      e.preventDefault();
      this._handleBackspaceAtStart(i, val);
      return;
    }

    if (e.key === 'Delete' && collapsed && s === val.length && i < this.blocks.length - 1) {
      e.preventDefault();
      this.pushUndo();
      const nextSrc = this.blocks[i + 1];
      const joined = val ? val + '\n' + nextSrc : nextSrc;
      this.active = null;
      this._replaceBlocks(i, 2, [joined]);
      this.activate(i, val ? val.length + 1 : 0);
      return;
    }

    if (e.key === 'ArrowUp' && collapsed && !val.slice(0, s).includes('\n')) {
      if (i > 0) {
        e.preventDefault();
        this.activate(i - 1, 'end');
      }
      return;
    }
    if (e.key === 'ArrowDown' && collapsed && !val.slice(en).includes('\n')) {
      if (i < this.blocks.length - 1) {
        e.preventDefault();
        this.activate(i + 1, 'start');
      }
      return;
    }
    if (e.key === 'ArrowLeft' && collapsed && s === 0 && i > 0) {
      e.preventDefault();
      this.activate(i - 1, 'end');
      return;
    }
    if (e.key === 'ArrowRight' && collapsed && s === val.length && i < this.blocks.length - 1) {
      e.preventDefault();
      this.activate(i + 1, 'start');
      return;
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (kind === 'list') {
        this._indentLine(!e.shiftKey);
      } else {
        if (!e.shiftKey) this._insertAtCaret('  ');
      }
      return;
    }
  }

  _handleEnter(kind, ta, i, val, s, en) {
    // fenced code / math / meta: exit when caret sits at the very end after the closing marker
    if (kind === 'fence' || kind === 'math' || kind === 'meta') {
      const lines = val.split('\n');
      const last = lines[lines.length - 1];
      const closed =
        kind === 'fence'
          ? lines.length > 1 && /^\s{0,3}(`{3,}|~{3,})\s*$/.test(last)
          : kind === 'math'
            ? lines.length > 1 && /\$\$\s*$/.test(last)
            : true;
      if (s === val.length && closed && kind !== 'meta') {
        this._exitToNewParagraph(i);
      } else if (kind === 'meta' && s === val.length) {
        this._exitToNewParagraph(i);
      } else {
        this._insertAtCaret('\n');
      }
      return;
    }

    if (kind === 'list') {
      const lineStart = val.lastIndexOf('\n', s - 1) + 1;
      let lineEnd = val.indexOf('\n', s);
      if (lineEnd === -1) lineEnd = val.length;
      const line = val.slice(lineStart, lineEnd);
      const m = line.match(LIST_ITEM_RE);
      if (m && line.slice(m[0].length).trim() === '') {
        // empty item: exit the list
        this.pushUndo();
        const before = val.slice(0, lineStart).replace(/\n$/, '');
        const after = val.slice(lineEnd + 1);
        this.active = null;
        const parts = [];
        if (before.trim()) parts.push(...splitBlocks(before));
        parts.push('');
        if (after.trim()) parts.push(...splitBlocks(after));
        const newIdx = i + (before.trim() ? splitBlocks(before).length : 0);
        this._replaceBlocks(i, 1, parts);
        this.activate(newIdx, 0);
        return;
      }
      if (m) {
        let marker = m[2];
        const num = marker.match(/^(\d+)([.)])$/);
        if (num) marker = String(Number(num[1]) + 1) + num[2];
        const task = m[3] ? ' [ ]' : '';
        this._insertAtCaret('\n' + m[1] + marker + task + m[4]);
        return;
      }
      this._insertAtCaret('\n');
      return;
    }

    if (kind === 'quote') {
      const lineStart = val.lastIndexOf('\n', s - 1) + 1;
      let lineEnd = val.indexOf('\n', s);
      if (lineEnd === -1) lineEnd = val.length;
      const line = val.slice(lineStart, lineEnd);
      if (/^\s*>\s*$/.test(line)) {
        this.pushUndo();
        const before = val.slice(0, lineStart).replace(/\n$/, '');
        this.active = null;
        const parts = before.trim() ? [...splitBlocks(before), ''] : [''];
        this._replaceBlocks(i, 1, parts);
        this.activate(i + parts.length - 1, 0);
      } else {
        this._insertAtCaret('\n> ');
      }
      return;
    }

    if (kind === 'table') {
      const cols = (val.split('\n')[0].match(/\|/g) || []).length;
      if (s === val.length) {
        const lastLine = val.slice(val.lastIndexOf('\n') + 1);
        if (/^[\s|]*$/.test(lastLine) && lastLine.includes('|')) {
          // empty trailing row: exit table
          this.pushUndo();
          const trimmed = val.slice(0, val.lastIndexOf('\n'));
          this.active = null;
          this._replaceBlocks(i, 1, [trimmed, '']);
          this.activate(i + 1, 0);
          return;
        }
        this._insertAtCaret('\n' + '|  '.repeat(Math.max(1, cols - 1)) + '|');
        return;
      }
      this._insertAtCaret('\n');
      return;
    }

    // paragraph / heading / hr / html: split the block at the caret
    this.pushUndo();
    const before = val.slice(0, s);
    const after = val.slice(en);
    this.active = null;
    const first = before.trim() ? splitBlocks(before) : [''];
    const second = after.trim() ? splitBlocks(after) : [''];
    this._replaceBlocks(i, 1, [...first, ...second]);
    this.activate(i + first.length, 0);
  }

  _exitToNewParagraph(i) {
    this.pushUndo();
    const lenBefore = this.blocks.length;
    this.commitActive();
    // the committed source may have re-split into several blocks
    const delta = this.blocks.length - lenBefore;
    const insertAt = Math.min(i + 1 + delta, this.blocks.length);
    this._replaceBlocks(insertAt, 0, ['']);
    this.activate(insertAt, 0);
  }

  _handleBackspaceAtStart(i, val) {
    if (i === 0) {
      if (!val.trim() && this.blocks.length > 1) {
        this.pushUndo();
        this.active = null;
        this._replaceBlocks(0, 1, []);
        this.activate(0, 'start');
      }
      return;
    }
    this.pushUndo();
    if (!val.trim()) {
      this.active = null;
      this._replaceBlocks(i, 1, []);
      this.activate(i - 1, 'end');
      return;
    }
    const prev = this.blocks[i - 1];
    if (!prev.trim()) {
      this.active = null;
      const cur = val;
      this._replaceBlocks(i - 1, 2, [cur]);
      this.activate(i - 1, 'start');
      return;
    }
    const joined = prev + '\n' + val;
    this.active = null;
    this._replaceBlocks(i - 1, 2, [joined]);
    this.activate(i - 1, prev.length + 1);
  }

  _insertAtCaret(text) {
    const ta = this.active.ta;
    this._maybePushUndoForTyping();
    const s = ta.selectionStart;
    const en = ta.selectionEnd;
    ta.value = ta.value.slice(0, s) + text + ta.value.slice(en);
    ta.selectionStart = ta.selectionEnd = s + text.length;
    this._autosize();
    this._changed(false);
  }

  _indentLine(indent) {
    const ta = this.active.ta;
    this.pushUndo();
    const s = ta.selectionStart;
    const val = ta.value;
    const lineStart = val.lastIndexOf('\n', s - 1) + 1;
    if (indent) {
      ta.value = val.slice(0, lineStart) + '  ' + val.slice(lineStart);
      ta.selectionStart = ta.selectionEnd = s + 2;
    } else {
      const m = val.slice(lineStart).match(/^ {1,2}/);
      if (m) {
        ta.value = val.slice(0, lineStart) + val.slice(lineStart + m[0].length);
        ta.selectionStart = ta.selectionEnd = Math.max(lineStart, s - m[0].length);
      }
    }
    this._autosize();
    this._changed(false);
  }

  /* ---------------- formatting commands (menu-driven) ---------------- */

  _ensureActive() {
    if (this.active) return true;
    const idx = Math.min(this.lastActiveIndex, this.blocks.length - 1);
    this.activate(idx, 'end');
    return !!this.active;
  }

  _wrapSelection(left, right = left) {
    if (!this._ensureActive()) return;
    const ta = this.active.ta;
    if (!ta) return; // table grid — inline formatting applies inside cells natively
    this.pushUndo();
    const s = ta.selectionStart;
    const en = ta.selectionEnd;
    const sel = ta.value.slice(s, en);
    const before = ta.value.slice(0, s);
    const after = ta.value.slice(en);

    // toggle off if already wrapped
    if (before.endsWith(left) && after.startsWith(right)) {
      ta.value = before.slice(0, -left.length) + sel + after.slice(right.length);
      ta.selectionStart = s - left.length;
      ta.selectionEnd = en - left.length;
    } else if (sel.startsWith(left) && sel.endsWith(right) && sel.length >= left.length + right.length) {
      const inner = sel.slice(left.length, sel.length - right.length);
      ta.value = before + inner + after;
      ta.selectionStart = s;
      ta.selectionEnd = s + inner.length;
    } else {
      ta.value = before + left + sel + right + after;
      ta.selectionStart = s + left.length;
      ta.selectionEnd = en + left.length;
    }
    this._autosize();
    this._changed(false);
    ta.focus();
  }

  _prefixLines(prefixFn) {
    if (!this._ensureActive()) return;
    const ta = this.active.ta;
    if (!ta) return;
    this.pushUndo();
    const s = ta.selectionStart;
    const en = ta.selectionEnd;
    const val = ta.value;
    const start = val.lastIndexOf('\n', s - 1) + 1;
    let end = val.indexOf('\n', en);
    if (end === -1) end = val.length;
    const segment = val.slice(start, end);
    const out = segment
      .split('\n')
      .map((l, idx) => prefixFn(l, idx))
      .join('\n');
    ta.value = val.slice(0, start) + out + val.slice(end);
    ta.selectionStart = start;
    ta.selectionEnd = start + out.length;
    this._autosize();
    this._changed(false);
    ta.focus();
  }

  _insertBlockAfterCurrent(source, caret = 'end') {
    this.pushUndo();
    let at;
    if (this.active) {
      const idx = this.active.index;
      this.commitActive();
      at = Math.min(idx + 1, this.blocks.length);
    } else {
      at = this.blocks.length;
    }
    this._replaceBlocks(at, 0, [source]);
    this.activate(at, caret);
  }

  applyAction(action, arg) {
    switch (action) {
      case 'bold': return this._wrapSelection('**');
      case 'italic': return this._wrapSelection('*');
      case 'inline-code': return this._wrapSelection('`');
      case 'strike': return this._wrapSelection('~~');
      case 'highlight': return this._wrapSelection('==');
      case 'underline': return this._wrapSelection('<u>', '</u>');
      case 'link': {
        if (!this._ensureActive()) return;
        const ta = this.active.ta;
        if (!ta) return;
        this.pushUndo();
        const s = ta.selectionStart, en = ta.selectionEnd;
        const sel = ta.value.slice(s, en) || 'link';
        ta.value = ta.value.slice(0, s) + '[' + sel + '](url)' + ta.value.slice(en);
        ta.selectionStart = s + sel.length + 3;
        ta.selectionEnd = s + sel.length + 6;
        this._autosize(); this._changed(false); ta.focus();
        return;
      }
      case 'image': {
        if (!this._ensureActive()) return;
        const ta = this.active.ta;
        if (!ta) return;
        this.pushUndo();
        const s = ta.selectionStart, en = ta.selectionEnd;
        const sel = ta.value.slice(s, en) || 'alt';
        ta.value = ta.value.slice(0, s) + '![' + sel + '](path)' + ta.value.slice(en);
        ta.selectionStart = s + sel.length + 4;
        ta.selectionEnd = s + sel.length + 8;
        this._autosize(); this._changed(false); ta.focus();
        return;
      }
      case 'clear-format': {
        if (!this._ensureActive()) return;
        const ta = this.active.ta;
        if (!ta) return;
        this.pushUndo();
        const s = ta.selectionStart, en = ta.selectionEnd;
        const sel = ta.value.slice(s, en);
        const cleaned = sel
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1')
          .replace(/~~([^~]+)~~/g, '$1')
          .replace(/==([^=]+)==/g, '$1')
          .replace(/`([^`]+)`/g, '$1')
          .replace(/<\/?u>/g, '');
        ta.value = ta.value.slice(0, s) + cleaned + ta.value.slice(en);
        ta.selectionStart = s;
        ta.selectionEnd = s + cleaned.length;
        this._autosize(); this._changed(false); ta.focus();
        return;
      }
      case 'heading': {
        if (!this._ensureActive()) return;
        const ta = this.active.ta;
        if (!ta) return;
        this.pushUndo();
        const n = arg | 0;
        const val = ta.value;
        const s = ta.selectionStart;
        const lineStart = val.lastIndexOf('\n', s - 1) + 1;
        let lineEnd = val.indexOf('\n', s);
        if (lineEnd === -1) lineEnd = val.length;
        const line = val.slice(lineStart, lineEnd).replace(/^\s{0,3}#{1,6}\s+/, '');
        const newLine = (n > 0 ? '#'.repeat(n) + ' ' : '') + line;
        ta.value = val.slice(0, lineStart) + newLine + val.slice(lineEnd);
        ta.selectionStart = ta.selectionEnd = lineStart + newLine.length;
        this._autosize(); this._changed(false); ta.focus();
        return;
      }
      case 'quote':
        return this._prefixLines((l) => (l.startsWith('> ') ? l.slice(2) : '> ' + l));
      case 'unordered-list':
        return this._prefixLines((l) =>
          /^\s*[-+*]\s/.test(l) ? l.replace(/^(\s*)[-+*]\s+/, '$1') : '- ' + l
        );
      case 'ordered-list':
        return this._prefixLines((l, i) =>
          /^\s*\d+[.)]\s/.test(l) ? l.replace(/^(\s*)\d+[.)]\s+/, '$1') : `${i + 1}. ` + l
        );
      case 'task-list':
        return this._prefixLines((l) =>
          /^\s*[-+*]\s+\[[ xX]\]\s/.test(l) ? l.replace(/^(\s*)[-+*]\s+\[[ xX]\]\s+/, '$1') : '- [ ] ' + l
        );
      case 'code-fence': {
        if (this.active && this.active.ta && this.active.ta.value.trim()) {
          const ta = this.active.ta;
          this.pushUndo();
          ta.value = '```\n' + ta.value + '\n```';
          ta.selectionStart = ta.selectionEnd = 3;
          ta.classList.add('mono');
          this._autosize(); this._changed(false); ta.focus();
        } else {
          this._insertBlockAfterCurrent('```\n\n```', 4);
        }
        return;
      }
      case 'math-block':
        return this._insertBlockAfterCurrent('$$\n\n$$', 3);
      case 'hr':
        return this._insertBlockAfterCurrent('------');
      case 'insert-table':
        return this._insertBlockAfterCurrent(
          '|      |      |\n| ---- | ---- |\n|      |      |',
          2
        );
      case 'undo':
        return this.undo();
      case 'redo':
        return this.redo();
    }
  }

  /* ---------------- outline support ---------------- */

  getOutline() {
    const items = [];
    this.blocks.forEach((src, i) => {
      const m = src.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/m);
      if (m) items.push({ level: m[1].length, text: m[2].replace(/[*_`]/g, ''), index: i });
    });
    return items;
  }

  scrollToBlock(index) {
    const el = this.container.children[index];
    if (!el) return;
    this._materializeEl(el);
    el.scrollIntoView({ behavior: 'auto', block: 'start' });
    // while the document is still virtualized, placeholder height estimates
    // above the target make the landing offset drift — re-anchor after the
    // surrounding blocks materialize to their real heights
    if (!this._cvReleased) {
      const reanchor = () => {
        if (el.isConnected) el.scrollIntoView({ behavior: 'auto', block: 'start' });
      };
      setTimeout(reanchor, 300);
      setTimeout(reanchor, 900);
    }
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }

  scrollToHeadingText(text) {
    const outline = this.getOutline();
    const hit = outline.find(
      (o) => o.text.toLowerCase().replace(/\s+/g, '-') === text.toLowerCase() || o.text.toLowerCase() === text.toLowerCase()
    );
    if (hit) this.scrollToBlock(hit.index);
  }
}
