// Executed inside the renderer during `--bench=<doc>` runs. __DOC__ is templated by main.js.
(async () => {
  const results = { doc: '__DOC__' };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const now = () => performance.now();
  const editor = window.__editor;
  const write = document.querySelector('#write');

  try {
    // startup paint metrics for the app itself
    const paint = performance.getEntriesByType('paint');
    for (const p of paint) results[p.name.replace('first-', '')] = Math.round(p.startTime);
    const nav = performance.getEntriesByType('navigation')[0];
    if (nav) {
      results.fetchStart = Math.round(nav.fetchStart);
      results.responseEnd = Math.round(nav.responseEnd);
      results.domInteractive = Math.round(nav.domInteractive);
      results.dclStart = Math.round(nav.domContentLoadedEventStart);
      results.domContentLoaded = Math.round(nav.domContentLoadedEventEnd);
      results.domComplete = Math.round(nav.domComplete);
      results.loadEvent = Math.round(nav.loadEventEnd);
    }
    for (const k of ['t0','tApp','tEditor','tInit','tPreLoad']) results[k] = Math.round(window['__'+k] || -1);
    results.tWelcome = Math.round(window.__tWelcome || -1);
    results.tDcl = Math.round(window.__tDcl || -1);
    const marks = {};
    for (const m of performance.getEntriesByType('mark')) marks[m.name] = m.startTime;
    if (marks['bundle-start'] != null && marks['bundle-end'] != null) {
      results.bundleEvalMs = Math.round(marks['bundle-end'] - marks['bundle-start']);
      results.bundleStartAt = Math.round(marks['bundle-start']);
    }

    // read the stress doc
    let t = now();
    const res = await window.api.readFile('__DOC__');
    results.readMs = Math.round(now() - t);
    const text = res.content;
    results.docKB = Math.round(text.length / 1024);

    // parse + initial render (synchronous part = time until user sees content)
    t = now();
    editor.setText(text);
    results.setTextMs = Math.round(now() - t);
    results.blockCount = editor.blocks.length;

    // time until the document is fully materialized (all blocks rendered)
    t = now();
    for (let i = 0; i < 600; i++) {
      if (!write.querySelector('.md-lazy')) break;
      await sleep(50);
    }
    results.settleMs = Math.round(now() - t);

    // time until virtualization is fully released (document fully laid out)
    t = now();
    for (let i = 0; i < 600; i++) {
      if (editor._cvReleased) break;
      await sleep(50);
    }
    results.cvReleaseMs = Math.round(now() - t);

    // block activation latency (middle of the document)
    const mid = Math.floor(editor.blocks.length / 2);
    t = now();
    editor.activate(mid, 0);
    results.activateMs = Math.round(now() - t);

    // typing latency: 40 keystrokes into the active textarea
    const ta = write.querySelector('textarea.block-source');
    const samples = [];
    for (let i = 0; i < 40; i++) {
      const t0 = now();
      ta.value += 'x';
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      samples.push(now() - t0);
      if (i % 10 === 9) await sleep(10);
    }
    samples.sort((a, b) => a - b);
    results.typeAvgMs = +(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2);
    results.typeP95Ms = +samples[Math.floor(samples.length * 0.95)].toFixed(2);

    // commit latency
    t = now();
    editor.commitActive();
    results.commitMs = Math.round(now() - t);

    // full-document serialization (used by save)
    t = now();
    editor.getText();
    results.getTextMs = Math.round(now() - t);

    // scroll cost: jump around the document and force layout
    const scroller = document.querySelector('#editor-scroll');
    t = now();
    for (let i = 0; i < 30; i++) {
      scroller.scrollTop = (scroller.scrollHeight * ((i * 37) % 100)) / 100;
      void scroller.getBoundingClientRect().height;
      await new Promise((r) => requestAnimationFrame(r));
    }
    results.scroll30Ms = Math.round(now() - t);

    // incremental scroll (wheel-like): 60 steps of half a viewport
    scroller.scrollTop = 0;
    t = now();
    for (let i = 0; i < 60; i++) {
      scroller.scrollTop += scroller.clientHeight / 2;
      void scroller.getBoundingClientRect().height;
      await new Promise((r) => requestAnimationFrame(r));
    }
    results.scrollStep60Ms = Math.round(now() - t);

    // memory (renderer heap)
    if (performance.memory) {
      results.heapMB = Math.round(performance.memory.usedJSHeapSize / 1024 / 1024);
    }
  } catch (err) {
    results.error = String(err && err.stack ? err.stack : err);
  }
  return results;
})();
