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
  } catch (err) {
    results.error = String(err && err.stack ? err.stack : err);
  }
  return results;
})();
