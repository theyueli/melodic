// Executed inside the renderer during `--self-test` runs. Returns a results object.
(async () => {
  const results = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const write = document.querySelector('#write');
  const blockAt = (i) => write.children[i];

  function clickEl(el) {
    const r = el.getBoundingClientRect();
    const opts = {
      bubbles: true,
      cancelable: true,
      clientX: r.left + Math.min(40, r.width / 2),
      clientY: r.top + r.height / 2
    };
    el.dispatchEvent(new MouseEvent('mousedown', opts));
    el.dispatchEvent(new MouseEvent('click', opts));
  }

  function key(el, keyName, init = {}) {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...init }));
  }

  try {
    // 1. click paragraph block -> textarea with markdown source appears
    const para = blockAt(1);
    clickEl(para.querySelector('p') || para);
    await sleep(50);
    const ta = write.querySelector('textarea.block-source');
    results.activateShowsSource = !!ta && ta.value.startsWith('**Melodic**');

    // 2. edit the source, press Escape -> block re-renders with new content
    if (ta) {
      ta.value = 'Edited **live** paragraph.';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      key(ta, 'Escape');
      await sleep(50);
      const rendered = blockAt(1).innerHTML;
      results.commitRerenders =
        !write.querySelector('textarea.block-source') &&
        rendered.includes('<strong>live</strong>');
    }

    // 3. Enter splits a paragraph into two blocks
    const countBefore = write.children.length;
    clickEl(blockAt(1));
    await sleep(30);
    const ta2 = write.querySelector('textarea.block-source');
    ta2.selectionStart = ta2.selectionEnd = ta2.value.length;
    key(ta2, 'Enter');
    await sleep(30);
    const ta3 = write.querySelector('textarea.block-source');
    results.enterCreatesBlock =
      write.children.length === countBefore + 1 && !!ta3 && ta3.value === '';

    // 4. type markdown in the new block and commit -> renders as heading
    ta3.value = '### Brand new heading';
    ta3.dispatchEvent(new Event('input', { bubbles: true }));
    key(ta3, 'Escape');
    await sleep(50);
    results.newHeadingRenders = !!write.querySelector('h3') &&
      Array.from(write.querySelectorAll('h3')).some((h) => h.textContent === 'Brand new heading');

    // 5. checkbox toggle updates the source
    const cb = write.querySelector('li input[type="checkbox"]:not(:checked)');
    if (cb) {
      const blockEl = cb.closest('.md-block');
      const idx = Number(blockEl.dataset.i);
      cb.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(80);
      const editor = window.__editor;
      results.checkboxTogglesSource = editor
        ? /\[x\]\s+Write something great/.test(editor.getText())
        : write.children[idx].querySelector('input[type="checkbox"]:checked') !== null;
    }

    // 6. undo restores the checkbox
    if (window.__editor) {
      window.__editor.undo();
      await sleep(50);
      results.undoWorks = /\[ \]\s+Write something great/.test(window.__editor.getText());
    }

    // 7. backspace at start merges blocks
    if (window.__editor) {
      const ed = window.__editor;
      const before = ed.blocks.length;
      ed.activate(2, 0);
      await sleep(30);
      const taM = write.querySelector('textarea.block-source');
      key(taM, 'Backspace');
      await sleep(30);
      results.backspaceMerges = ed.blocks.length === before - 1;
      key(write.querySelector('textarea.block-source'), 'Escape');
    }

    results.blockCount = write.children.length;

    // 8. setext H2 stays one block and renders as a heading
    {
      const ed = window.__editor;
      ed.setText('Section Title\n---\n\nbody text');
      await sleep(50);
      results.setextH2 =
        ed.blocks[0] === 'Section Title\n---' && !!write.querySelector('h2');
    }

    // 9. checkbox ordinals skip non-task [x] occurrences (code spans, links)
    {
      const ed = window.__editor;
      ed.setText('- note `[x]` means done\n- [ ] ship the release');
      await sleep(50);
      const cb2 = write.querySelector('li input[type="checkbox"]');
      cb2.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      await sleep(50);
      const src = ed.getText();
      results.checkboxOrdinalSafe =
        src.includes('`[x]`') && src.includes('- [x] ship the release');
    }

    // 10. Chinese documents get lang="zh-Hans" (CJK typography); Latin docs don't
    {
      const ed = window.__editor;
      ed.setText('# 中文文档\n\n' + '这是一个包含大量汉字的中文文档，用于验证语言检测。'.repeat(10));
      ed.opts.onChange();
      await sleep(400);
      const zhSet = write.getAttribute('lang') === 'zh-Hans';
      ed.setText('# English\n\n' + 'This is a plain English document for language detection. '.repeat(10));
      ed.opts.onChange();
      await sleep(400);
      results.cjkLangDetection = zhSet && !write.hasAttribute('lang');
    }

    // 11. find & replace over block sources
    {
      const ed = window.__editor;
      const fb = window.__find;
      ed.setText('# Doc\n\nthe quick fox\n\nquick again `quick`');
      await sleep(80);
      fb.open({ replace: true });
      fb.input.value = 'quick';
      fb.refresh();
      const found = fb.matches.length === 3;
      fb.replaceInput.value = 'slow';
      fb.replaceAll();
      await sleep(80);
      const txt = ed.getText();
      fb.close();
      results.findReplace = found && txt.includes('the slow fox') && txt.includes('slow again `slow`');
    }

    // 12. visual table editing: grid appears, add row via toolbar, edit cell, commit
    {
      const ed = window.__editor;
      ed.setText('| a | b |\n| --- | --- |\n| 1 | 2 |');
      await sleep(80);
      ed.activate(0, 0);
      await sleep(50);
      const grid = write.querySelector('table.table-grid');
      const gridShown = !!grid && !write.querySelector('textarea.block-source');
      write.querySelector('[data-act="row-add"]').click();
      await sleep(30);
      const cell = write.querySelector('[data-row="1"][data-col="0"]');
      cell.textContent = 'NEW';
      ed.commitActive();
      await sleep(50);
      const txt = ed.getText();
      results.tableGrid =
        gridShown && txt.split('\n').length === 4 && txt.includes('| NEW |');
    }

    // 13. smart paste converts HTML to markdown
    {
      const ed = window.__editor;
      ed.setText('start ');
      await sleep(50);
      ed.activate(0, 'end');
      const ta = write.querySelector('textarea.block-source');
      const dt = new DataTransfer();
      dt.setData('text/html', '<p>Hello <strong>bold</strong> and <em>em</em></p>');
      dt.setData('text/plain', 'Hello bold and em');
      ta.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
      // turndown loads lazily on first paste
      for (let i = 0; i < 40 && !ta.value.includes('**bold**'); i++) await sleep(100);
      results.smartPaste = ta.value.includes('Hello **bold** and *em*');
      key(ta, 'Escape');
    }

    // 14. footnotes: ref + def render, hover shows preview tooltip
    {
      const ed = window.__editor;
      ed.setText('Text with a footnote[^note] here.\n\n[^note]: The **definition** body.');
      await sleep(80);
      const ref = write.querySelector('.fn-ref');
      const def = write.querySelector('.md-footnote');
      ref.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
      await sleep(50);
      const tip = document.querySelector('#fn-tooltip');
      const tipShown = tip && !tip.classList.contains('hidden') && tip.innerHTML.includes('<strong>definition</strong>');
      results.footnotes = !!ref && !!def && tipShown;
      tip.classList.add('hidden');
    }

    // 15. multiple windows via IPC
    {
      const before = await window.api.windowCount();
      window.api.newWindow();
      let after = before;
      for (let i = 0; i < 30 && after !== before + 1; i++) {
        await sleep(100);
        after = await window.api.windowCount();
      }
      results.multiWindow = before >= 1 && after === before + 1;
    }

    // 16. spellcheck: on by default in prose textareas, toggleable
    {
      const ed = window.__editor;
      ed.setText('spellcheck test paragraph');
      await sleep(50);
      ed.activate(0, 0);
      const taS = write.querySelector('textarea.block-source');
      const onByDefault = taS.spellcheck === true;
      ed.setSpellcheck(false);
      const off = taS.spellcheck === false;
      ed.setSpellcheck(true);
      results.spellcheckToggle = onByDefault && off;
      key(taS, 'Escape');
    }

    // 17. music sheets: ```abc fence engraves to SVG with a play button
    {
      const ed = window.__editor;
      ed.setText('# Music\n\n```abc\nX: 1\nT: Scale\nM: 4/4\nL: 1/8\nK: C\nCDEF GABc|\n```');
      await sleep(100);
      let sheet = null;
      for (let i = 0; i < 60 && !sheet; i++) {
        await sleep(100);
        sheet = write.querySelector('.abc-sheet svg');
      }
      const play = write.querySelector('.abc-play');
      results.musicSheet = !!sheet && !!play;
    }

    // 18. plain-text mode: byte-exact round trip, no markdown, ANSI + level tint
    {
      const ed = window.__editor;
      const doc = window.__doc;
      const raw =
        '# not a heading\n' +
        '2026-07-10 12:00:01 INFO  starting up\n' +
        '2026-07-10 12:00:02 \x1b[31mERROR\x1b[0m something failed\n' +
        '2026-07-10 12:00:03 WARNING disk almost full\n' +
        '   indented   with   spaces\t\ttabs\n' +   // whitespace must survive
        '\n' +
        'trailing blank line above; no trailing newline here';
      const tmp = '/tmp/melodic-e2e-tail.log';
      doc.markClean();
      await window.api.saveFile({ filePath: tmp, content: raw });
      await doc.openPath(tmp);
      await sleep(120);
      const pre = write.querySelector('pre.plain-chunk');
      const noMarkdown = !!pre && !write.querySelector('h1') && pre.textContent.includes('# not a heading');
      const roundTrip = doc.isPlain() && ed.getText() === raw;
      const ansi = !!write.querySelector('.ansi-31');
      const tinted = !!write.querySelector('.pl-line.log-err') && !!write.querySelector('.pl-line.log-warn');
      results.plainMode = noMarkdown && roundTrip && ansi && tinted;
    }

    // 19. tail-follow: appended bytes stream in; truncation reloads
    {
      const ed = window.__editor;
      const doc = window.__doc;
      const tmp = '/tmp/melodic-e2e-tail.log';
      const wasFollowing = doc.isFollowing(); // .log opens with follow on
      const appended = '\n2026-07-10 12:00:04 INFO  appended line';
      await window.api.saveFile({ filePath: tmp, content: ed.getText() + appended });
      let grew = false;
      for (let i = 0; i < 40 && !grew; i++) {
        await sleep(100);
        grew = ed.getText().endsWith(appended);
      }
      const shorter = 'fresh after rotation\n';
      await window.api.saveFile({ filePath: tmp, content: shorter });
      let reloaded = false;
      for (let i = 0; i < 40 && !reloaded; i++) {
        await sleep(100);
        reloaded = ed.getText() === shorter;
      }
      results.tailFollow = wasFollowing && grew && reloaded;
    }
  } catch (err) {
    results.error = String(err && err.stack ? err.stack : err);
  }
  return results;
})();
