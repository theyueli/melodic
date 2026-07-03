/**
 * Visual table editing: a table block activates into a grid of editable
 * cells with a toolbar (add/remove row/column, column alignment) instead of a
 * raw-source textarea. Cells hold the cell's markdown source text; the grid
 * serializes back to a pipe table on commit.
 */

const CELL_SPLIT_RE = /(?<!\\)\|/;

export function parseTable(source) {
  const lines = source.split('\n').filter((l) => l.trim() !== '');
  const parseRow = (line) => {
    // pipes inside code spans are cell content, not separators — mask them
    const masked = line.replace(/`[^`]*`/g, (span) => span.replace(/\|/g, '\u0000'));
    return masked
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split(CELL_SPLIT_RE)
      .map((c) => c.trim().replace(/\\\|/g, '|').replace(/\u0000/g, '|'));
  };

  const header = parseRow(lines[0] || '');
  const aligns = (lines[1] ? parseRow(lines[1]) : []).map((d) => {
    const l = d.startsWith(':');
    const r = d.endsWith(':');
    return l && r ? 'center' : r ? 'right' : l ? 'left' : '';
  });
  const rows = lines.slice(2).map(parseRow);
  const cols = Math.max(header.length, ...rows.map((r) => r.length), 1);
  // normalize widths
  while (header.length < cols) header.push('');
  while (aligns.length < cols) aligns.push('');
  for (const r of rows) while (r.length < cols) r.push('');
  return { header, aligns, rows };
}

export function serializeTable({ header, aligns, rows }) {
  const esc = (c) => c.replace(/\|/g, '\\|').replace(/\n/g, ' ').trim();
  const line = (cells) => '| ' + cells.map((c) => esc(c) || ' ').join(' | ') + ' |';
  const delim =
    '| ' +
    aligns
      .map((a) =>
        a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '----'
      )
      .join(' | ') +
    ' |';
  return [line(header), delim, ...rows.map(line)].join('\n');
}

/**
 * Build the grid UI inside `el` for a table block.
 * Returns the active-edit handle: { getValue(), focusCell(r,c), el }.
 * @param {object} cb { onCommit(), onExitToSource(caret) }
 */
export function buildTableGrid(el, source, cb) {
  const model = parseTable(source);
  let cur = { row: 0, col: 0 }; // row 0 = header

  const wrap = document.createElement('div');
  wrap.className = 'table-editor';
  const toolbar = document.createElement('div');
  toolbar.className = 'table-toolbar';
  toolbar.innerHTML = `
    <button data-act="row-add" title="Add row below (⌘Enter)">＋ Row</button>
    <button data-act="row-del" title="Delete row">－ Row</button>
    <span class="tt-sep"></span>
    <button data-act="col-add" title="Add column right">＋ Col</button>
    <button data-act="col-del" title="Delete column">－ Col</button>
    <span class="tt-sep"></span>
    <button data-act="align-left" title="Align column left">⇤</button>
    <button data-act="align-center" title="Align column center">↔</button>
    <button data-act="align-right" title="Align column right">⇥</button>
    <span class="tt-sep"></span>
    <button data-act="source" title="Edit as markdown">MD</button>`;
  const table = document.createElement('table');
  table.className = 'table-grid';
  wrap.appendChild(toolbar);
  wrap.appendChild(table);

  function cellCount() {
    return model.header.length;
  }

  function rebuild(focus) {
    table.innerHTML = '';
    const thead = document.createElement('thead');
    const headTr = document.createElement('tr');
    model.header.forEach((text, c) => headTr.appendChild(makeCell('th', text, 0, c)));
    thead.appendChild(headTr);
    table.appendChild(thead);
    const tbody = document.createElement('tbody');
    model.rows.forEach((row, r) => {
      const tr = document.createElement('tr');
      row.forEach((text, c) => tr.appendChild(makeCell('td', text, r + 1, c)));
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    if (focus) focusCell(focus.row, focus.col);
  }

  function makeCell(tag, text, row, col) {
    const cell = document.createElement(tag);
    cell.contentEditable = 'plaintext-only';
    cell.spellcheck = false;
    cell.textContent = text;
    cell.dataset.row = String(row);
    cell.dataset.col = String(col);
    if (model.aligns[col]) cell.style.textAlign = model.aligns[col];
    cell.addEventListener('focus', () => {
      cur = { row, col };
    });
    return cell;
  }

  /** Pull the DOM cell texts back into the model. */
  function syncModel() {
    table.querySelectorAll('th, td').forEach((cell) => {
      const r = Number(cell.dataset.row);
      const c = Number(cell.dataset.col);
      const text = cell.textContent.replace(/\n/g, ' ');
      if (r === 0) model.header[c] = text;
      else if (model.rows[r - 1]) model.rows[r - 1][c] = text;
    });
  }

  function focusCell(row, col) {
    row = Math.max(0, Math.min(row, model.rows.length));
    col = Math.max(0, Math.min(col, cellCount() - 1));
    const cell = table.querySelector(`[data-row="${row}"][data-col="${col}"]`);
    if (cell) {
      cell.focus();
      // caret at end of cell
      const sel = window.getSelection();
      sel.selectAllChildren(cell);
      sel.collapseToEnd();
    }
  }

  function act(action) {
    syncModel();
    const { row, col } = cur;
    switch (action) {
      case 'row-add':
        model.rows.splice(row === 0 ? 0 : row, 0, new Array(cellCount()).fill(''));
        rebuild({ row: row === 0 ? 1 : row + 1, col });
        break;
      case 'row-del':
        if (row === 0 || !model.rows.length) return; // header stays
        model.rows.splice(row - 1, 1);
        rebuild({ row: Math.min(row, model.rows.length), col });
        break;
      case 'col-add':
        model.header.splice(col + 1, 0, '');
        model.aligns.splice(col + 1, 0, '');
        model.rows.forEach((r) => r.splice(col + 1, 0, ''));
        rebuild({ row, col: col + 1 });
        break;
      case 'col-del':
        if (cellCount() <= 1) return;
        model.header.splice(col, 1);
        model.aligns.splice(col, 1);
        model.rows.forEach((r) => r.splice(col, 1));
        rebuild({ row, col: Math.min(col, cellCount() - 1) });
        break;
      case 'align-left':
      case 'align-center':
      case 'align-right': {
        model.aligns[col] = action.slice(6);
        table
          .querySelectorAll(`[data-col="${col}"]`)
          .forEach((cell) => (cell.style.textAlign = model.aligns[col]));
        focusCell(row, col);
        break;
      }
      case 'source':
        syncModel();
        cb.onExitToSource(serializeTable(model));
        return;
    }
  }

  toolbar.addEventListener('mousedown', (e) => e.preventDefault()); // keep cell focus
  toolbar.addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (btn) act(btn.dataset.act);
  });

  table.addEventListener('keydown', (e) => {
    if (e.isComposing) return;
    const { row, col } = cur;
    if (e.key === 'Tab') {
      e.preventDefault();
      syncModel();
      if (e.shiftKey) {
        if (col > 0) focusCell(row, col - 1);
        else if (row > 0) focusCell(row - 1, cellCount() - 1);
      } else if (col < cellCount() - 1) {
        focusCell(row, col + 1);
      } else if (row < model.rows.length) {
        focusCell(row + 1, 0);
      } else {
        // Tab at the last cell appends a row (Typora behavior)
        model.rows.push(new Array(cellCount()).fill(''));
        rebuild({ row: row + 1, col: 0 });
      }
      return;
    }
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      act('row-add');
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      syncModel();
      if (row < model.rows.length) focusCell(row + 1, col);
      else cb.onCommit();
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      cb.onCommit();
    }
  });

  rebuild(null);
  el.innerHTML = '';
  el.appendChild(wrap);

  return {
    el: wrap,
    focusCell,
    getValue() {
      syncModel();
      return serializeTable(model);
    }
  };
}
