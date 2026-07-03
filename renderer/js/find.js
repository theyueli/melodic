/**
 * In-document Find & Replace.
 *
 * Matching runs over block *sources* (authoritative for counting and replace);
 * visual highlighting runs over the rendered text via the CSS Custom Highlight
 * API, which needs no DOM mutation and so never disturbs the editor's render
 * cache or virtualization.
 */

const MATCH_CAP = 20000;
const HIGHLIGHT_CAP = 1500;

export class FindBar {
  /**
   * @param {Editor} editor
   * @param {HTMLElement} host   element the bar is appended to (#content)
   * @param {object} opts { onDidChangeDoc() } — notify app of replacements
   */
  constructor(editor, host, opts = {}) {
    this.editor = editor;
    this.opts = opts;
    this.visible = false;
    this.caseSensitive = false;
    this.wholeWord = false;
    this.regex = false;
    this.matches = []; // { block, start, end }
    this.current = -1;
    this._refreshTimer = 0;

    this._buildDom(host);
  }

  _buildDom(host) {
    const bar = document.createElement('div');
    bar.id = 'find-bar';
    bar.className = 'hidden';
    bar.innerHTML = `
      <div class="find-row">
        <input id="find-input" type="text" placeholder="Find" spellcheck="false" />
        <button class="find-opt" data-opt="case" title="Match case">Aa</button>
        <button class="find-opt" data-opt="word" title="Whole word">ab</button>
        <button class="find-opt" data-opt="regex" title="Regular expression">.*</button>
        <span id="find-count">0/0</span>
        <button id="find-prev" title="Previous match (⇧⌘G)">‹</button>
        <button id="find-next" title="Next match (⌘G)">›</button>
        <button id="find-close" title="Close (Esc)">✕</button>
      </div>
      <div class="find-row" id="find-replace-row" style="display:none">
        <input id="replace-input" type="text" placeholder="Replace" spellcheck="false" />
        <button id="replace-one">Replace</button>
        <button id="replace-all">All</button>
      </div>`;
    host.appendChild(bar);
    this.bar = bar;
    this.input = bar.querySelector('#find-input');
    this.replaceInput = bar.querySelector('#replace-input');
    this.countEl = bar.querySelector('#find-count');

    this.input.addEventListener('input', () => this._scheduleRefresh());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        e.shiftKey ? this.prev() : this.next();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    this.replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.replaceCurrent();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.close();
      }
    });
    bar.querySelectorAll('.find-opt').forEach((btn) => {
      btn.addEventListener('click', () => {
        const key = { case: 'caseSensitive', word: 'wholeWord', regex: 'regex' }[btn.dataset.opt];
        this[key] = !this[key];
        btn.classList.toggle('on', this[key]);
        this.refresh();
        this.input.focus();
      });
    });
    bar.querySelector('#find-prev').addEventListener('click', () => this.prev());
    bar.querySelector('#find-next').addEventListener('click', () => this.next());
    bar.querySelector('#find-close').addEventListener('click', () => this.close());
    bar.querySelector('#replace-one').addEventListener('click', () => this.replaceCurrent());
    bar.querySelector('#replace-all').addEventListener('click', () => this.replaceAll());
  }

  /* ---------------- visibility ---------------- */

  open({ replace = false } = {}) {
    // adopt the current editor selection as the query
    const ta = this.editor.active && this.editor.active.ta;
    if (ta && ta.selectionStart !== ta.selectionEnd) {
      const sel = ta.value.slice(ta.selectionStart, ta.selectionEnd);
      if (sel && !sel.includes('\n')) this.input.value = sel;
    }
    this.editor.commitActive();
    this.bar.classList.remove('hidden');
    this.bar.querySelector('#find-replace-row').style.display = replace ? '' : 'none';
    this.visible = true;
    this.input.focus();
    this.input.select();
    this.refresh();
  }

  close() {
    this.bar.classList.add('hidden');
    this.visible = false;
    this._clearHighlights();
    this.matches = [];
    this.current = -1;
  }

  /* ---------------- matching ---------------- */

  _buildRegex(global = true) {
    let src = this.input.value;
    if (!src) return null;
    if (!this.regex) src = src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (this.wholeWord) src = `\\b(?:${src})\\b`;
    const flags = (this.caseSensitive ? '' : 'i') + (global ? 'g' : '');
    try {
      const re = new RegExp(src, flags);
      this.input.classList.remove('invalid');
      return re;
    } catch {
      this.input.classList.add('invalid');
      return null;
    }
  }

  _scheduleRefresh() {
    clearTimeout(this._refreshTimer);
    this._refreshTimer = setTimeout(() => this.refresh(), 120);
  }

  /** Recollect matches (keeps the current index pointed at the same-ish spot). */
  refresh() {
    if (!this.visible) return;
    const re = this._buildRegex();
    this.matches = [];
    if (re && this.input.value) {
      const blocks = this.editor.blocks;
      outer: for (let b = 0; b < blocks.length; b++) {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(blocks[b]))) {
          if (m[0] === '') { re.lastIndex++; continue; } // zero-width safety
          this.matches.push({ block: b, start: m.index, end: m.index + m[0].length });
          if (this.matches.length >= MATCH_CAP) break outer;
        }
      }
    }
    this.current = this.matches.length ? Math.min(Math.max(this.current, 0), this.matches.length - 1) : -1;
    this._fresh = true; // first Enter/⌘G lands on the current match, not the one after
    this._updateCount();
    this._highlightAll();
  }

  _updateCount() {
    const total = this.matches.length >= MATCH_CAP ? `${MATCH_CAP}+` : this.matches.length;
    this.countEl.textContent = this.matches.length ? `${this.current + 1}/${total}` : '0/0';
  }

  /* ---------------- navigation ---------------- */

  next() {
    if (!this.matches.length) return;
    if (this._fresh) this._fresh = false;
    else this.current = (this.current + 1) % this.matches.length;
    this._goto();
  }

  prev() {
    if (!this.matches.length) return;
    if (this._fresh) this._fresh = false;
    else this.current = (this.current - 1 + this.matches.length) % this.matches.length;
    this._goto();
  }

  _goto() {
    const m = this.matches[this.current];
    if (!m) return;
    const el = this.editor.ensureBlockRendered(m.block);
    if (el) el.scrollIntoView({ block: 'center', behavior: 'auto' });
    this._updateCount();
    this._highlightAll();
  }

  /* ---------------- replace ---------------- */

  replaceCurrent() {
    // a block under edit has a stale entry in editor.blocks — commit and
    // re-collect so the replacement never works from outdated source
    if (this.editor.active) {
      this.editor.commitActive();
      this.refresh();
    }
    const m = this.matches[this.current];
    if (!m) return;
    const src = this.editor.blocks[m.block];
    const segment = src.slice(m.start, m.end);
    const single = this._buildRegex(false);
    if (!single) return;
    const replaced = this.regex
      ? segment.replace(single, this.replaceInput.value)
      : this.replaceInput.value;
    const next = src.slice(0, m.start) + replaced + src.slice(m.end);
    const keep = this.current;
    this.editor.replaceBlockSource(m.block, next);
    if (this.opts.onDidChangeDoc) this.opts.onDidChangeDoc();
    this.refresh();
    this.current = this.matches.length ? Math.min(keep, this.matches.length - 1) : -1;
    this._goto();
  }

  replaceAll() {
    if (this.editor.active) {
      this.editor.commitActive();
      this.refresh();
    }
    const re = this._buildRegex();
    if (!re || !this.matches.length) return;
    const replacement = this.replaceInput.value;
    const blocks = new Set(this.matches.map((m) => m.block));
    this.editor.pushUndo();
    let count = 0;
    for (const b of blocks) {
      const src = this.editor.blocks[b];
      re.lastIndex = 0;
      const next = src.replace(re, (...args) => {
        count++;
        return this.regex ? args[0].replace(this._buildRegex(false), replacement) : replacement;
      });
      if (next !== src) this.editor.replaceBlockSource(b, next, { undo: false });
    }
    if (this.opts.onDidChangeDoc) this.opts.onDidChangeDoc();
    this.countEl.textContent = `${count} replaced`;
    this.matches = [];
    this.current = -1;
    this._clearHighlights();
  }

  /* ---------------- highlighting (CSS Custom Highlight API) ---------------- */

  _clearHighlights() {
    if (typeof CSS !== 'undefined' && CSS.highlights) {
      CSS.highlights.delete('find-match');
      CSS.highlights.delete('find-current');
    }
  }

  _highlightAll() {
    if (typeof CSS === 'undefined' || !CSS.highlights) return;
    this._clearHighlights();
    const re = this._buildRegex();
    if (!re || !this.matches.length) return;

    // rendered-text ranges, computed only for blocks that have source matches
    const blockOrdinal = new Map(); // block index -> ordinal of current match within it
    const cur = this.matches[this.current];
    if (cur) {
      let ord = 0;
      for (let i = 0; i < this.matches.length; i++) {
        const m = this.matches[i];
        if (m.block === cur.block) {
          if (i === this.current) break;
          ord++;
        }
      }
      blockOrdinal.set(cur.block, ord);
    }

    const blocks = [...new Set(this.matches.map((m) => m.block))];
    const all = [];
    let currentRange = null;

    for (const b of blocks) {
      if (all.length >= HIGHLIGHT_CAP && !blockOrdinal.has(b)) continue;
      const el = this.editor.getBlockEl(b);
      if (!el || el.classList.contains('md-lazy') || el.classList.contains('md-editing')) continue;

      // flatten the block's text nodes
      const nodes = [];
      const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let n;
      let text = '';
      while ((n = walker.nextNode())) {
        nodes.push({ node: n, start: text.length });
        text += n.nodeValue;
      }
      re.lastIndex = 0;
      let m;
      let ordinal = 0;
      while ((m = re.exec(text))) {
        if (m[0] === '') { re.lastIndex++; continue; }
        const range = this._rangeFor(nodes, m.index, m.index + m[0].length);
        if (range) {
          if (blockOrdinal.get(b) === ordinal) currentRange = range;
          else if (all.length < HIGHLIGHT_CAP) all.push(range);
        }
        ordinal++;
      }
    }

    if (all.length) CSS.highlights.set('find-match', new Highlight(...all));
    if (currentRange) CSS.highlights.set('find-current', new Highlight(currentRange));
  }

  _rangeFor(nodes, start, end) {
    let sNode = null, sOff = 0, eNode = null, eOff = 0;
    for (const { node, start: base } of nodes) {
      const len = node.nodeValue.length;
      if (sNode === null && start >= base && start < base + len) {
        sNode = node;
        sOff = start - base;
      }
      if (end > base && end <= base + len) {
        eNode = node;
        eOff = end - base;
        break;
      }
    }
    if (!sNode || !eNode) return null;
    try {
      const r = new Range();
      r.setStart(sNode, Math.max(0, sOff));
      r.setEnd(eNode, eOff);
      return r;
    } catch {
      return null;
    }
  }
}
