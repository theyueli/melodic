const { app, BrowserWindow, Menu, dialog, ipcMain, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

/* per-window state: win.id -> { isDirty, closing, ready, pendingPath, filePath } */
const winState = new Map();
let firstWin = null;          // the dev harness (self-test/bench) attaches here
let pendingStartupPath = null; // open-file arriving before app ready

// the test/benchmark harness exists only in dev — packaged builds expose
// nothing beyond the user-facing app
const DEV = !app.isPackaged;
const SELF_TEST = DEV && process.argv.includes('--self-test');
const BENCH_ARG = DEV ? process.argv.find((a) => a.startsWith('--bench=')) : undefined;
const MAIN_START = Date.now();

// dev runs get their own profile so they never contend with the installed app
if (DEV) {
  app.setPath('userData', path.join(app.getPath('appData'), 'Melodic-dev'));
}

// single instance: a second launch focuses the app and opens its file here
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', (e, argv) => {
  const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  if (focused) {
    if (focused.isMinimized()) focused.restore();
    focused.focus();
  }
  const f = fileArgFromArgv(argv);
  if (f) openPathInBestWindow(f);
});

function fileArgFromArgv(argv) {
  return argv.slice(1).find((a) => /\.(md|markdown|mdown|txt)$/i.test(a) && fs.existsSync(a)) || null;
}

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'config.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeConfig(patch) {
  try {
    const cfg = { ...readConfig(), ...patch };
    fs.writeFileSync(path.join(app.getPath('userData'), 'config.json'), JSON.stringify(cfg));
  } catch {}
}

const senderWin = (e) => BrowserWindow.fromWebContents(e.sender);
const stateOf = (win) => (win ? winState.get(win.id) : undefined);

/**
 * Route a file to the focused window when it is empty and clean;
 * otherwise open a fresh window for it (Typora-style).
 */
function openPathInBestWindow(p) {
  const focused = BrowserWindow.getFocusedWindow() || BrowserWindow.getAllWindows()[0];
  const st = stateOf(focused);
  if (focused && st && st.ready && !st.isDirty && !st.filePath) {
    focused.webContents.send('open-path', p);
    focused.focus();
  } else if (focused && st && !st.ready && !st.pendingPath) {
    // window still booting — queue the file there instead of opening another
    st.pendingPath = p;
  } else {
    createWindow(p);
  }
}

function createWindow(openPath = null) {
  const cfg = readConfig();
  const win = new BrowserWindow({
    width: 1080,
    height: 780,
    minWidth: 480,
    minHeight: 360,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 12, y: 16 },
    backgroundColor: cfg.theme === 'night' ? '#363b40' : '#ffffff',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: true, // native macOS checker; applies only to editable fields
      v8CacheOptions: 'bypassHeatCheck',
      // settings ride into the renderer synchronously — startup never touches
      // localStorage (whose LevelDB lock can stall seconds if another instance
      // shares the profile)
      additionalArguments: [
        '--t2cfg=' + JSON.stringify(cfg),
        ...(SELF_TEST || BENCH_ARG ? ['--t2dev'] : [])
      ]
    }
  });

  winState.set(win.id, {
    isDirty: false,
    closing: false,
    ready: false,
    pendingPath: openPath,
    filePath: null
  });

  // offset additional windows so they don't stack exactly
  if (firstWin && !firstWin.isDestroyed()) {
    const [x, y] = win.getPosition();
    win.setPosition(x + 28, y + 28);
  }

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('close', (e) => {
    const st = stateOf(win);
    if (!st || st.closing || !st.isDirty) return;
    e.preventDefault();
    const choice = dialog.showMessageBoxSync(win, {
      type: 'warning',
      buttons: ['Save', "Don't Save", 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      message: 'Do you want to save the changes you made?',
      detail: "Your changes will be lost if you don't save them."
    });
    if (choice === 0) {
      win.webContents.send('menu', 'save-and-close');
    } else if (choice === 1) {
      st.closing = true;
      win.close();
    }
  });

  win.on('closed', () => {
    winState.delete(win.id);
    if (firstWin === win) firstWin = null;
  });

  // spell-check context menu: suggestions, learn/unlearn, standard edit ops
  win.webContents.on('context-menu', (e, params) => {
    const items = [];
    if (params.misspelledWord) {
      for (const s of params.dictionarySuggestions.slice(0, 5)) {
        items.push({ label: s, click: () => win.webContents.replaceMisspelling(s) });
      }
      if (!params.dictionarySuggestions.length) {
        items.push({ label: 'No Guesses Found', enabled: false });
      }
      items.push({ type: 'separator' });
      items.push({
        label: 'Learn Spelling',
        click: () =>
          win.webContents.session.addWordToSpellCheckerDictionary(params.misspelledWord)
      });
      items.push({ type: 'separator' });
    }
    if (params.isEditable) {
      items.push({ role: 'cut' }, { role: 'copy' }, { role: 'paste' });
    } else if (params.selectionText.trim()) {
      items.push({ role: 'copy' });
    }
    if (items.length) Menu.buildFromTemplate(items).popup({ window: win });
  });

  if (!firstWin) {
    firstWin = win;
    attachDevHarness(win);
  }
  return win;
}

/* self-test / bench harness (dev only, first window only) */
function attachDevHarness(win) {
  const st = () => stateOf(win);

  if (BENCH_ARG) {
    win.webContents.on('console-message', (e) => {
      console.log(`[renderer:${e.level}] ${e.message}`);
    });
    win.webContents.on('did-finish-load', () => {
      const loadedMs = Date.now() - MAIN_START;
      setTimeout(async () => {
        try {
          const docPath = BENCH_ARG.slice(8);
          const src = fs
            .readFileSync(path.join(__dirname, 'bench.js'), 'utf8')
            .replaceAll('__DOC__', docPath);
          const result = await win.webContents.executeJavaScript(src);
          result.mainToLoadedMs = loadedMs;
          console.log('BENCH_RESULT ' + JSON.stringify(result));
        } catch (err) {
          console.error('BENCH_FAIL', err);
        }
        if (st()) st().closing = true;
        app.quit();
      }, 600);
    });
  }

  if (SELF_TEST) {
    win.webContents.on('console-message', (e) => {
      console.log(`[renderer:${e.level}] ${e.message}`);
    });
    win.webContents.on('did-finish-load', () => {
      setTimeout(async () => {
        let failed = false;
        try {
          const e2ePath = path.join(__dirname, 'e2e.js');
          if (fs.existsSync(e2ePath)) {
            const result = await win.webContents.executeJavaScript(fs.readFileSync(e2ePath, 'utf8'));
            console.log('E2E_RESULT ' + JSON.stringify(result, null, 1));
            failed = !result || !!result.error || Object.values(result).some((v) => v === false);
          }
          const img = await win.webContents.capturePage();
          const out = process.argv.find((a) => a.startsWith('--shot='));
          const dest = out ? out.slice(7) : path.join(__dirname, 'selftest.png');
          fs.writeFileSync(dest, img.toPNG());
          console.log('SELFTEST_OK ' + dest);
        } catch (err) {
          console.error('SELFTEST_FAIL', err);
          failed = true;
        }
        app.exit(failed ? 1 : 0); // CI-friendly: failing checks fail the process
      }, 2500);
    });
  }
}

/* ---------------- folder tree ---------------- */

const MD_EXT = /\.(md|markdown|mdown|mkd|txt)$/i;

function readTree(dir, depth = 0) {
  if (depth > 6) return [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes = [];
  for (const ent of entries) {
    if (ent.name.startsWith('.') || ent.name === 'node_modules') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      nodes.push({ type: 'dir', name: ent.name, path: full, children: readTree(full, depth + 1) });
    } else if (MD_EXT.test(ent.name)) {
      nodes.push({ type: 'file', name: ent.name, path: full });
    }
  }
  nodes.sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'dir' ? -1 : 1));
  return nodes;
}

/* ---------------- IPC ---------------- */

ipcMain.handle('dialog:openFile', async (e) => {
  const res = await dialog.showOpenDialog(senderWin(e), {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:openFolder', async (e) => {
  const res = await dialog.showOpenDialog(senderWin(e), { properties: ['openDirectory'] });
  if (res.canceled || !res.filePaths.length) return null;
  const root = res.filePaths[0];
  return { root, name: path.basename(root), tree: readTree(root) };
});

ipcMain.handle('folder:refresh', (e, root) => {
  if (!root || !fs.existsSync(root)) return null;
  return { root, name: path.basename(root), tree: readTree(root) };
});

ipcMain.handle('file:read', (e, filePath) => {
  try {
    return { ok: true, content: fs.readFileSync(filePath, 'utf8') };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('file:save', async (e, { filePath, content, saveAs }) => {
  let target = filePath;
  if (!target || saveAs) {
    const res = await dialog.showSaveDialog(senderWin(e), {
      defaultPath: target || 'Untitled.md',
      filters: [{ name: 'Markdown', extensions: ['md'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    target = res.filePath;
  }
  try {
    fs.writeFileSync(target, content, 'utf8');
    app.addRecentDocument(target);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('export:html', async (e, { defaultName, html }) => {
  const res = await dialog.showSaveDialog(senderWin(e), {
    defaultPath: (defaultName || 'Untitled') + '.html',
    filters: [{ name: 'HTML', extensions: ['html'] }]
  });
  if (res.canceled || !res.filePath) return { ok: false, canceled: true };
  try {
    fs.writeFileSync(res.filePath, html, 'utf8');
    return { ok: true, path: res.filePath };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  }
});

/**
 * Render export HTML in a hidden window (the live editor view is virtualized
 * and contains app chrome, so PDF/print always go through the clean export
 * pipeline). Returns { window, cleanup } once the page has finished loading.
 */
async function renderHiddenExport(html) {
  const tmpPath = path.join(
    app.getPath('temp'),
    `melodic-export-${process.pid}-${Date.now()}.html`
  );
  fs.writeFileSync(tmpPath, html, 'utf8');
  const hidden = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true }
  });
  const cleanup = () => {
    if (!hidden.isDestroyed()) hidden.destroy();
    fs.unlink(tmpPath, () => {});
  };
  try {
    await hidden.loadFile(tmpPath);
    // brief settle for fonts/layout before capture
    await new Promise((r) => setTimeout(r, 250));
    return { window: hidden, cleanup };
  } catch (err) {
    cleanup();
    throw err;
  }
}

ipcMain.handle('export:pdf', async (e, { defaultName, html, path: explicitPath }) => {
  let target = explicitPath;
  if (!target) {
    const res = await dialog.showSaveDialog(senderWin(e), {
      defaultPath: (defaultName || 'Untitled') + '.pdf',
      filters: [{ name: 'PDF', extensions: ['pdf'] }]
    });
    if (res.canceled || !res.filePath) return { ok: false, canceled: true };
    target = res.filePath;
  }
  let rendered = null;
  try {
    rendered = await renderHiddenExport(html);
    const data = await rendered.window.webContents.printToPDF({
      printBackground: true,
      margins: { top: 0.6, bottom: 0.6, left: 0.6, right: 0.6 } // inches
    });
    fs.writeFileSync(target, data);
    return { ok: true, path: target };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    if (rendered) rendered.cleanup();
  }
});

ipcMain.handle('print:html', async (e, { html }) => {
  let rendered = null;
  try {
    rendered = await renderHiddenExport(html);
    return await new Promise((resolve) => {
      rendered.window.webContents.print({ printBackground: true }, (ok, reason) => {
        rendered.cleanup();
        rendered = null;
        resolve(ok || reason === 'cancelled'
          ? { ok: true }
          : { ok: false, error: reason || 'print failed' });
      });
    });
  } catch (err) {
    if (rendered) rendered.cleanup();
    return { ok: false, error: String(err.message || err) };
  }
});

ipcMain.handle('app:confirmDiscard', (e) => {
  const win = senderWin(e);
  const st = stateOf(win);
  if (!st || !st.isDirty) return true;
  const choice = dialog.showMessageBoxSync(win, {
    type: 'warning',
    buttons: ['Discard Changes', 'Cancel'],
    defaultId: 1,
    cancelId: 1,
    message: 'The current document has unsaved changes.',
    detail: 'Discard them and continue?'
  });
  return choice === 0;
});

ipcMain.on('app:setDirty', (e, dirty) => {
  const win = senderWin(e);
  const st = stateOf(win);
  if (!st) return;
  st.isDirty = !!dirty;
  win.setDocumentEdited(st.isDirty);
});

ipcMain.on('app:setFile', (e, filePath) => {
  const win = senderWin(e);
  const st = stateOf(win);
  if (!win || !st) return;
  st.filePath = filePath || null;
  if (filePath) {
    win.setRepresentedFilename(filePath);
    win.setTitle(path.basename(filePath));
    app.addRecentDocument(filePath);
  } else {
    win.setRepresentedFilename('');
    win.setTitle('Untitled');
  }
});

ipcMain.on('app:closeNow', (e) => {
  const win = senderWin(e);
  const st = stateOf(win);
  if (st) st.closing = true;
  if (win) win.close();
});

ipcMain.on('app:saveConfig', (e, patch) => {
  if (!patch || typeof patch !== 'object') return;
  const clean = {};
  if (patch.theme === 'github' || patch.theme === 'night') clean.theme = patch.theme;
  if (typeof patch.sidebar === 'boolean') clean.sidebar = patch.sidebar;
  if (typeof patch.sidebarWidth === 'string' && /^\d{2,4}px$/.test(patch.sidebarWidth)) {
    clean.sidebarWidth = patch.sidebarWidth;
  }
  if (patch.folder === null || typeof patch.folder === 'string') clean.folder = patch.folder;
  if (Object.keys(clean).length) writeConfig(clean);
});

ipcMain.on('app:rendererReady', (e) => {
  const win = senderWin(e);
  const st = stateOf(win);
  if (!st) return;
  st.ready = true;
  const initial =
    st.pendingPath ||
    (win === firstWin ? pendingStartupPath || fileArgFromArgv(process.argv) : null);
  if (initial) win.webContents.send('open-path', initial);
  st.pendingPath = null;
  if (win === firstWin) pendingStartupPath = null;
});

ipcMain.on('window:new', () => {
  createWindow();
});

ipcMain.handle('window:count', () => {
  if (!DEV) return -1; // dev harness only
  return BrowserWindow.getAllWindows().length;
});

ipcMain.on('shell:openExternal', (e, url) => {
  if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
});

/* ---------------- menu ---------------- */

function send(action, arg) {
  const win = BrowserWindow.getFocusedWindow() || firstWin;
  if (win) win.webContents.send('menu', action, arg);
}

function broadcast(action, arg) {
  for (const w of BrowserWindow.getAllWindows()) w.webContents.send('menu', action, arg);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const cfg = readConfig();
  const template = [
    ...(isMac
      ? [{
          label: app.name,
          submenu: [
            { role: 'about' },
            { type: 'separator' },
            { role: 'services' },
            { type: 'separator' },
            { role: 'hide' },
            { role: 'hideOthers' },
            { role: 'unhide' },
            { type: 'separator' },
            { role: 'quit' }
          ]
        }]
      : []),
    {
      label: 'File',
      submenu: [
        { label: 'New', accelerator: 'CmdOrCtrl+N', click: () => send('new') },
        { label: 'New Window', accelerator: 'Shift+CmdOrCtrl+N', click: () => createWindow() },
        { type: 'separator' },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-folder') },
        { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: () => send('save-as') },
        { type: 'separator' },
        { label: 'Export as HTML…', click: () => send('export-html') },
        { label: 'Export as PDF…', click: () => send('export-pdf') },
        { type: 'separator' },
        { label: 'Print…', accelerator: 'CmdOrCtrl+P', click: () => send('print') },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => send('undo') },
        { label: 'Redo', accelerator: 'Shift+CmdOrCtrl+Z', click: () => send('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { label: 'Paste as Plain Text', accelerator: 'Shift+CmdOrCtrl+V', click: () => send('paste-plain') },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find…', accelerator: 'CmdOrCtrl+F', click: () => send('find') },
        { label: 'Find and Replace…', accelerator: 'Alt+CmdOrCtrl+F', click: () => send('find-replace') },
        { label: 'Find Next', accelerator: 'CmdOrCtrl+G', click: () => send('find-next') },
        { label: 'Find Previous', accelerator: 'Shift+CmdOrCtrl+G', click: () => send('find-prev') },
        { type: 'separator' },
        {
          label: 'Check Spelling While Typing',
          type: 'checkbox',
          checked: cfg.spellcheck !== false,
          click: (item) => {
            writeConfig({ spellcheck: item.checked });
            session.defaultSession.spellCheckerEnabled = item.checked;
            broadcast('spellcheck', item.checked);
          }
        },
        { type: 'separator' },
        { label: 'Copy as Markdown', click: () => send('copy-markdown') },
        { label: 'Copy as Rich Text', click: () => send('copy-rich') }
      ]
    },
    {
      label: 'Paragraph',
      submenu: [
        { label: 'Heading 1', accelerator: 'CmdOrCtrl+1', click: () => send('heading', 1) },
        { label: 'Heading 2', accelerator: 'CmdOrCtrl+2', click: () => send('heading', 2) },
        { label: 'Heading 3', accelerator: 'CmdOrCtrl+3', click: () => send('heading', 3) },
        { label: 'Heading 4', accelerator: 'CmdOrCtrl+4', click: () => send('heading', 4) },
        { label: 'Heading 5', accelerator: 'CmdOrCtrl+5', click: () => send('heading', 5) },
        { label: 'Heading 6', accelerator: 'CmdOrCtrl+6', click: () => send('heading', 6) },
        { type: 'separator' },
        { label: 'Paragraph', accelerator: 'CmdOrCtrl+0', click: () => send('heading', 0) },
        { type: 'separator' },
        { label: 'Code Fence', accelerator: 'Alt+CmdOrCtrl+C', click: () => send('code-fence') },
        { label: 'Math Block', accelerator: 'Alt+CmdOrCtrl+B', click: () => send('math-block') },
        { label: 'Music Sheet', accelerator: 'Alt+CmdOrCtrl+M', click: () => send('music-sheet') },
        { label: 'Quote', accelerator: 'Alt+CmdOrCtrl+Q', click: () => send('quote') },
        { type: 'separator' },
        { label: 'Ordered List', accelerator: 'Alt+CmdOrCtrl+O', click: () => send('ordered-list') },
        { label: 'Unordered List', accelerator: 'Alt+CmdOrCtrl+U', click: () => send('unordered-list') },
        { label: 'Task List', accelerator: 'Alt+CmdOrCtrl+X', click: () => send('task-list') },
        { type: 'separator' },
        { label: 'Insert Table', click: () => send('insert-table') },
        { label: 'Horizontal Line', click: () => send('hr') }
      ]
    },
    {
      label: 'Format',
      submenu: [
        { label: 'Bold', accelerator: 'CmdOrCtrl+B', click: () => send('bold') },
        { label: 'Italic', accelerator: 'CmdOrCtrl+I', click: () => send('italic') },
        { label: 'Underline', accelerator: 'CmdOrCtrl+U', click: () => send('underline') },
        { label: 'Code', accelerator: 'CmdOrCtrl+E', click: () => send('inline-code') },
        { label: 'Strike', accelerator: 'Ctrl+Shift+X', click: () => send('strike') },
        { label: 'Highlight', accelerator: 'Shift+CmdOrCtrl+H', click: () => send('highlight') },
        { type: 'separator' },
        { label: 'Hyperlink', accelerator: 'CmdOrCtrl+K', click: () => send('link') },
        { label: 'Image', accelerator: 'Ctrl+CmdOrCtrl+I', click: () => send('image') },
        { type: 'separator' },
        { label: 'Clear Format', accelerator: 'CmdOrCtrl+\\', click: () => send('clear-format') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Toggle Sidebar', accelerator: 'Shift+CmdOrCtrl+L', click: () => send('toggle-sidebar') },
        { label: 'Outline', accelerator: 'Ctrl+Shift+1', click: () => send('sidebar-outline') },
        { label: 'Files', accelerator: 'Ctrl+Shift+2', click: () => send('sidebar-files') },
        { type: 'separator' },
        { label: 'Source Code Mode', accelerator: 'CmdOrCtrl+/', click: () => send('source-mode') },
        { type: 'separator' },
        {
          label: 'Theme',
          submenu: [
            { label: 'GitHub', click: () => send('theme', 'github') },
            { label: 'Night', click: () => send('theme', 'night') }
          ]
        },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' }
      ]
    },
    { role: 'windowMenu' },
    {
      role: 'help',
      submenu: [{ label: 'Melodic on GitHub', click: () => shell.openExternal('https://github.com/theyueli/melodic') }]
    }
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

/* ---------------- app lifecycle ---------------- */

app.on('open-file', (e, filePath) => {
  e.preventDefault();
  if (app.isReady()) openPathInBestWindow(filePath);
  else pendingStartupPath = filePath;
});

app.whenReady().then(() => {
  const cfg = readConfig();
  session.defaultSession.spellCheckerEnabled = cfg.spellcheck !== false;
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  // macOS convention: the app stays alive without windows
  if (process.platform !== 'darwin' || SELF_TEST || BENCH_ARG) app.quit();
});
