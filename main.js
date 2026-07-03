const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');
const path = require('path');
const fs = require('fs');

let win = null;
let isDirty = false;
let pendingOpenPath = null;   // file passed before window/renderer was ready
let rendererReady = false;
let closing = false;

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

// single instance: a second launch focuses the window and opens its file here
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
}
app.on('second-instance', (e, argv) => {
  if (win) {
    if (win.isMinimized()) win.restore();
    win.focus();
  }
  const f = fileArgFromArgv(argv);
  if (!f) return;
  // queue like the macOS open-file path: the window or renderer may not be up yet
  if (win && rendererReady) win.webContents.send('open-path', f);
  else pendingOpenPath = f;
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

function createWindow() {
  const cfg = readConfig();
  win = new BrowserWindow({
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
      spellcheck: false,
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

  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  win.on('close', (e) => {
    if (closing || !isDirty) return;
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
      closing = true;
      win.close();
    }
  });

  win.on('closed', () => { win = null; });

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
        closing = true;
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
        try {
          const e2ePath = path.join(__dirname, 'e2e.js');
          if (fs.existsSync(e2ePath)) {
            const result = await win.webContents.executeJavaScript(fs.readFileSync(e2ePath, 'utf8'));
            console.log('E2E_RESULT ' + JSON.stringify(result, null, 1));
          }
          const img = await win.webContents.capturePage();
          const out = process.argv.find((a) => a.startsWith('--shot='));
          const dest = out ? out.slice(7) : path.join(__dirname, 'selftest.png');
          fs.writeFileSync(dest, img.toPNG());
          console.log('SELFTEST_OK ' + dest);
        } catch (err) {
          console.error('SELFTEST_FAIL', err);
        }
        closing = true;
        app.quit();
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

ipcMain.handle('dialog:openFile', async () => {
  const res = await dialog.showOpenDialog(win, {
    properties: ['openFile'],
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown', 'mdown', 'mkd', 'txt'] }]
  });
  if (res.canceled || !res.filePaths.length) return null;
  return res.filePaths[0];
});

ipcMain.handle('dialog:openFolder', async () => {
  const res = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
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
    const res = await dialog.showSaveDialog(win, {
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
  const res = await dialog.showSaveDialog(win, {
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

ipcMain.handle('app:confirmDiscard', () => {
  if (!isDirty) return true;
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
  isDirty = !!dirty;
  if (win) win.setDocumentEdited(isDirty);
});

ipcMain.on('app:setFile', (e, filePath) => {
  if (!win) return;
  if (filePath) {
    win.setRepresentedFilename(filePath);
    win.setTitle(path.basename(filePath));
    app.addRecentDocument(filePath);
  } else {
    win.setRepresentedFilename('');
    win.setTitle('Untitled');
  }
});

ipcMain.on('app:closeNow', () => {
  closing = true;
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

ipcMain.on('app:rendererReady', () => {
  rendererReady = true;
  const initial = pendingOpenPath || fileArgFromArgv(process.argv);
  if (initial) win.webContents.send('open-path', initial);
  pendingOpenPath = null;
});

ipcMain.on('shell:openExternal', (e, url) => {
  if (/^https?:|^mailto:/i.test(url)) shell.openExternal(url);
});

/* ---------------- menu ---------------- */

function send(action, arg) {
  if (win) win.webContents.send('menu', action, arg);
}

function buildMenu() {
  const isMac = process.platform === 'darwin';
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
        { type: 'separator' },
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => send('open') },
        { label: 'Open Folder…', accelerator: 'CmdOrCtrl+Shift+O', click: () => send('open-folder') },
        { role: 'recentDocuments', submenu: [{ role: 'clearRecentDocuments' }] },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => send('save') },
        { label: 'Save As…', accelerator: 'Shift+CmdOrCtrl+S', click: () => send('save-as') },
        { type: 'separator' },
        { label: 'Export as HTML…', click: () => send('export-html') },
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
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Copy as Markdown', click: () => send('copy-markdown') }
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
  if (win && rendererReady) win.webContents.send('open-path', filePath);
  else pendingOpenPath = filePath;
});

app.whenReady().then(() => {
  buildMenu();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});
