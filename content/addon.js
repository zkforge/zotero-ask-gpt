// Global plugin state: windows, reader tabs, and one conversation per PDF attachment.
var AIChatAddon = class {
  constructor({ id, version, rootURI }) {
    this.id = id;
    this.rootURI = rootURI;
    this.codex = new CodexService(version);
    this.sidebars = new Map();
    this.conversations = new Map();
  }

  startup() {
    // Defaults for every setting bound in the settings pane (string prefs must exist, or the
    // pane shows "undefined").
    const defaults = Services.prefs.getDefaultBranch('extensions.zoteroaichat.');
    defaults.setBoolPref('open', true);
    defaults.setBoolPref('selectionButton', true);
    for (const [name, value] of [['language', 'auto'], ['codexPath', ''], ['proxy', ''], ['baseInstructions', '']])
      defaults.setStringPref(name, value);
    this.prefPaneID = Zotero.PreferencePanes.register({
      pluginID: this.id,
      label: 'Ask GPT',
      image: this.rootURI + 'content/icon.svg',
      src: this.rootURI + 'content/prefs.xhtml',
      scripts: [this.rootURI + 'content/prefs.js'],
      stylesheets: [this.rootURI + 'content/prefs.css']
    });
    // Connection settings need a new codex process; answer settings only a new thread.
    this.prefObservers = [
      ...['codexPath', 'proxy'].map(name => Zotero.Prefs.registerObserver(`extensions.zoteroaichat.${name}`, () => this.restartCodex(), true)),
      ...['baseInstructions', 'language'].map(name => Zotero.Prefs.registerObserver(`extensions.zoteroaichat.${name}`, () => this.resetThreads(), true))
    ];

    this.tabObserver = Zotero.Notifier.registerObserver({
      notify: event => {
        if (['select', 'load', 'close'].includes(event))
          for (const win of Zotero.getMainWindows()) this.updateWindow(win);
      }
    }, ['tab'], 'zoteroaichat-tabs');
    for (const win of Zotero.getMainWindows()) this.addWindow(win);

    Zotero.Reader.registerEventListener('renderTextSelectionPopup', ({ reader, doc, params, append }) => {
      if (!Zotero.Prefs.get('extensions.zoteroaichat.selectionButton', true)) return;
      const button = doc.createElement('button');
      button.title = '把选中的文字作为引用发到 AI 侧栏 (⌘⇧G)';
      button.innerHTML = '<span>问 AI</span><kbd style="margin-left:auto;font:inherit;font-size:11px;opacity:.6">⌘⇧G</kbd>';
      button.style.cssText = 'display:flex;align-items:center;gap:6px;box-sizing:border-box;width:calc(100% - 8px);margin:4px;padding:6px 10px;border:0;border-radius:8px;'
        + 'background:color-mix(in srgb, AccentColor 12%, transparent);color:AccentColor;font-size:13px;font-weight:500;cursor:pointer;';
      button.addEventListener('mouseenter', () => { button.style.background = 'color-mix(in srgb, AccentColor 20%, transparent)'; });
      button.addEventListener('mouseleave', () => { button.style.background = 'color-mix(in srgb, AccentColor 12%, transparent)'; });
      button.addEventListener('click', () => this.quote(reader, params.annotation));
      append(button);
    }, this.id);
    Zotero.Reader.registerEventListener('createViewContextMenu', ({ reader, append }) => {
      const annotation = this.selection(reader);
      if (annotation) append({ label: '问 AI', onCommand: () => this.quote(reader, annotation) });
    }, this.id);

    // Development aid: send one question through the real pipeline and log the reply.
    if (Zotero.Prefs.get('extensions.zoteroaichat.devSelfTest', true)) this.selfTest();
  }

  async selfTest() {
    try {
      let reader = null;
      for (let i = 0; i < 40 && !reader; i++) {
        reader = this.currentReader(Zotero.getMainWindow());
        if (!reader) await Zotero.Promise.delay(500);
      }
      if (!reader) throw new Error('no reader tab open');
      const conv = this.conversation(reader.itemID);
      await Promise.all([conv.contextReady, conv.restored]);
      Zotero.debug(`[zoteroaichat] self-test context: ${conv.notice}; restored ${conv.messages.length} messages`);
      await reader._initPromise;
      await Zotero.Promise.delay(1500);
      await this.locate(reader.itemID, { page: 5 });
      await Zotero.Promise.delay(1000);
      Zotero.debug(`[zoteroaichat] self-test navigate: asked p.5, reader at pageIndex ${reader._internalReader?._state?.primaryViewStats?.pageIndex}`);
      const mode = Zotero.Prefs.get('extensions.zoteroaichat.devSelfTest', true);
      if (mode === 'prefs') {
        // Open the settings pane, log what it shows, press "test connection", then close it.
        const win = Zotero.Utilities.Internal.openPreferences(await this.prefPaneID);
        let root = null;
        for (let i = 0; i < 40 && !root?.dataset.ready; i++) {
          await Zotero.Promise.delay(250);
          root = win.document?.getElementById('zoteroaichat-prefs');
        }
        await Zotero.Promise.delay(1500);
        const $ = id => root.querySelector('#zoteroaichat-' + id);
        const checks = [...root.querySelectorAll('checkbox')].map(c => `${c.getAttribute('preference').split('.').pop()}=${c.checked}`);
        Zotero.debug(`[zoteroaichat] self-test prefs: ready=${root?.dataset.ready}, codex placeholder="${$('codex-path').placeholder}" value="${$('codex-path').value}", proxy placeholder="${$('proxy').placeholder}" value="${$('proxy').value}", language=${$('language').value}, ${checks.join(' ')}, prompt ${$('prompt').value.length} chars, data="${$('data-usage').textContent}" at ${$('data-path').textContent}`);
        $('test').doCommand();
        for (let i = 0; i < 60 && /正在|^$/.test($('test-status').textContent); i++) await Zotero.Promise.delay(250);
        Zotero.debug(`[zoteroaichat] self-test prefs test: ${$('test-status').className} "${$('test-status').textContent}"`);
        win.close();
        return;
      }
      if (mode === 'image') {
        // Drive the real overlay with synthetic mouse events over the visible page, then ask
        // the model about the crop in a throwaway thread.
        const win = reader._internalReader._primaryView._iframeWindow;
        const canvas = [...win.document.querySelectorAll('.page .canvasWrapper canvas')]
          .find(c => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < win.innerHeight; });
        Zotero.debug(`[zoteroaichat] self-test image: canvases=${win.document.querySelectorAll('.page .canvasWrapper canvas').length}, visible=${!!canvas}`);
        const page = canvas.getBoundingClientRect();
        const top = Math.max(page.top, 0);
        const bottom = Math.min(page.bottom, win.innerHeight);
        // Event init dicts must live in the pdf.js window, or the coordinates are dropped.
        const mouse = (type, point) => new win.MouseEvent(type, Components.utils.cloneInto({ bubbles: true, ...point }, win));
        // Two captures: the upper and the lower part of the visible page.
        for (const [y1, y2] of [[0.1, 0.45], [0.55, 0.9]]) {
          const count = conv.images?.length || 0;
          this.startCapture(reader.itemID);
          const overlay = win.document.getElementById('zoteroaichat-capture');
          const from = { clientX: page.left + page.width * 0.1, clientY: top + (bottom - top) * y1 };
          const to = { clientX: page.left + page.width * 0.9, clientY: top + (bottom - top) * y2 };
          overlay.dispatchEvent(mouse('mousedown', from));
          overlay.dispatchEvent(mouse('mousemove', to));
          overlay.dispatchEvent(mouse('mouseup', to));
          for (let i = 0; i < 20 && (conv.images?.length || 0) === count && !conv.captureError; i++) await Zotero.Promise.delay(200);
        }
        const images = conv.images || [];
        Zotero.debug(`[zoteroaichat] self-test image: overlay removed=${!win.document.getElementById('zoteroaichat-capture')}, images=${images.length} ${JSON.stringify(images.map(i => [i.page, i.width, i.height]))}, error=${conv.captureError}`);
        if (images.length) {
          const threadId = await this.codex.startThread('');
          let reply = '';
          const done = new Promise(resolve => this.codex.listen(threadId, ({ method, params }) => {
            if (method === 'item/agentMessage/delta') reply += params.delta;
            if (method === 'turn/completed') resolve(params.turn.status);
          }));
          await this.codex.startTurn(threadId, 'How many images did you receive? Describe each in one short sentence.', images.map(i => i.path));
          Zotero.debug(`[zoteroaichat] self-test image reply (${await done}): ${reply}`);
          for (const image of images) await IOUtils.remove(image.path, { ignoreAbsent: true });
          this.clearImage(reader.itemID);
        }
        return;
      }
      if (mode === 'note') {
        // Save a sample note through the real path, log it, then erase it and the temp messages.
        const start = conv.messages.length;
        conv.messages.push({ role: 'user', text: 'self-test' }, { role: 'assistant', text: 'self-test' });
        await this.saveNote(reader.itemID, start + 1, '<h1>Ask GPT self-test</h1><p>See <a href="page:2">(p. 2)</a> and <span class="math">$x^2$</span>.</p><pre class="math">$$y = f(x)$$</pre>');
        const attachment = Zotero.Items.get(reader.itemID);
        const note = Zotero.Items.getByLibraryAndKey(attachment.libraryID, conv.messages[start + 1].note);
        Zotero.debug(`[zoteroaichat] self-test note: child of paper=${note?.parentID === attachment.parentID}, html=${note?.getNote()}`);
        await note?.eraseTx();
        conv.messages.splice(start);
        this.changed(conv);
        await this.save(conv);
        return;
      }
      // "nav" checks navigation only, without adding a message to the saved conversation.
      if (mode === 'nav') return;
      // Full mode: ask something that needs citations, follow the first one, then remove the
      // test exchange so the saved conversation is left as it was.
      const before = conv.messages.length;
      await this.send(reader.itemID, 'Self-test: in two sentences, what taxonomy does the paper propose and what future challenges does it name? Cite pages.');
      while (conv.busy) await Zotero.Promise.delay(200);
      const reply = conv.messages[conv.messages.length - 1];
      Zotero.debug(`[zoteroaichat] self-test reply: ${reply.text} ${reply.error || ''}`);
      const citations = [...reply.text.matchAll(/\]\(page:(\d+) "([^"]+)"\)/g)];
      Zotero.debug(`[zoteroaichat] self-test citations: ${citations.length}`);
      for (const [, page, phrase] of citations.slice(0, 2)) await this.locate(reader.itemID, { page: Number(page), text: phrase });
      await Zotero.Promise.delay(500);
      const chat = [...this.sidebars.values()][0]?.chat;
      Zotero.debug(`[zoteroaichat] self-test render: ${chat?.document.querySelectorAll('.markdown .page-ref[data-quote]').length} quoted page links`);
      conv.messages.splice(before);
      this.changed(conv);
      await this.save(conv);
    } catch (error) {
      Zotero.debug('[zoteroaichat] self-test failed: ' + error.message);
    }
  }

  shutdown() {
    for (const symbol of this.prefObservers || []) Zotero.Prefs.unregisterObserver(symbol);
    Zotero.Notifier.unregisterObserver(this.tabObserver);
    for (const win of Zotero.getMainWindows()) this.removeWindow(win);
    this.codex.stop();
    this.conversations.clear();
  }

  // Settings pane support -------------------------------------------------------

  defaultInstructions() {
    return CodexService.BASE_INSTRUCTIONS;
  }

  // Drop every idle conversation's codex thread, so the next message starts a new one under
  // the current settings (stored history is replayed into it).
  resetThreads() {
    for (const conv of this.conversations.values()) if (!conv.busy) conv.threadId = null;
  }

  restartCodex() {
    this.codex.stop();
    for (const conv of this.conversations.values()) {
      conv.threadId = null;
      if (conv.busy) this.finishTurn(conv, '设置已更改，请重新发送');
    }
  }

  async testConnection() {
    this.restartCodex();
    await this.codex.start();
    return { version: this.codex.serverVersion, models: (await this.codex.listModels()).length };
  }

  dataDir() {
    return PathUtils.join(Zotero.DataDirectory.dir, 'ai-chat');
  }

  async storageUsage() {
    const dir = this.dataDir();
    const scan = async (sub, ext) => {
      const path = PathUtils.join(dir, sub);
      if (!(await IOUtils.exists(path))) return [0, 0];
      let count = 0, bytes = 0;
      for (const child of await IOUtils.getChildren(path)) {
        if (!child.endsWith(ext)) continue;
        count++;
        bytes += (await IOUtils.stat(child)).size;
      }
      return [count, bytes];
    };
    const [conversations, conversationBytes] = await scan('conversations', '.json');
    const [images, imageBytes] = await scan('images', '.png');
    return { dir, conversations, images, bytes: conversationBytes + imageBytes };
  }

  async revealData() {
    await IOUtils.makeDirectory(this.dataDir(), { ignoreExisting: true });
    Zotero.File.reveal(this.dataDir());
  }

  // Delete every stored conversation and screenshot (the settings pane confirms first).
  async clearAllData() {
    for (const itemID of [...this.conversations.keys()]) this.reset(itemID);
    for (const sub of ['conversations', 'images'])
      await IOUtils.remove(PathUtils.join(this.dataDir(), sub), { recursive: true, ignoreAbsent: true });
  }

  currentReader(win) {
    if (!String(win.Zotero_Tabs.selectedType).startsWith('reader')) return null;
    return Zotero.Reader.getByTabID(win.Zotero_Tabs.selectedID) || null;
  }

  // Current text selection in a reader as { text, position }, read from the reader's
  // selection popup state (the same data renderTextSelectionPopup receives).
  selection(reader) {
    const state = reader?._internalReader?._state;
    const annotation = state?.primaryViewSelectionPopup?.annotation || state?.secondaryViewSelectionPopup?.annotation;
    return annotation?.text ? annotation : null;
  }

  addWindow(win) {
    const doc = win.document;
    if (doc.getElementById('zoteroaichat-toggle')) return;
    const toolbar = doc.getElementById('zotero-tabs-toolbar');
    if (toolbar) {
      const button = doc.createXULElement('toolbarbutton');
      button.id = 'zoteroaichat-toggle';
      button.setAttribute('label', 'Ask GPT');
      button.setAttribute('tooltiptext', '展开或收起 Ask GPT 侧栏 (⌘⇧G)');
      // Zotero sizes every button in this toolbar to 28px wide (icon buttons); let the label fit.
      button.style.cssText = 'width:auto;min-width:0;height:28px;margin:0 6px;padding:0 10px;border-radius:6px;font-size:12px;font-weight:500;';
      button.addEventListener('command', () => this.toggle(win));
      toolbar.prepend(button);
    }
    const keys = doc.getElementById('mainKeyset');
    if (keys) {
      const key = doc.createXULElement('key');
      key.id = 'zoteroaichat-shortcut';
      key.setAttribute('key', 'G');
      key.setAttribute('modifiers', 'accel,shift');
      key.setAttribute('oncommand', '');
      key.addEventListener('command', () => {
        const reader = this.currentReader(win);
        const annotation = this.selection(reader);
        if (annotation) this.quote(reader, annotation);
        else this.toggle(win);
      });
      keys.appendChild(key);
    }
    this.updateWindow(win);
  }

  removeWindow(win) {
    this.sidebars.get(win)?.destroy();
    this.sidebars.delete(win);
    for (const id of ['zoteroaichat-toggle', 'zoteroaichat-shortcut']) win.document.getElementById(id)?.remove();
  }

  updateWindow(win) {
    const reader = this.currentReader(win);
    const button = win.document.getElementById('zoteroaichat-toggle');
    if (button) button.hidden = !reader;
    let sidebar = this.sidebars.get(win);
    if (!sidebar && reader && Zotero.Prefs.get('extensions.zoteroaichat.open', true) !== false) {
      sidebar = new AIChatSidebar(this, win);
      this.sidebars.set(win, sidebar);
    }
    sidebar?.sync(reader);
  }

  toggle(win, open) {
    const reader = this.currentReader(win);
    if (!reader) return;
    const sidebar = this.sidebars.get(win);
    if (open === undefined) open = !(sidebar && sidebar.isVisible());
    Zotero.Prefs.set('extensions.zoteroaichat.open', open, true);
    if (open && !sidebar) this.sidebars.set(win, new AIChatSidebar(this, win));
    this.sidebars.get(win)?.sync(reader);
    if (open) this.sidebars.get(win).focusInput();
  }

  readerFor(itemID) {
    const current = this.currentReader(Zotero.getMainWindow());
    return current?.itemID === itemID ? current : Zotero.Reader._readers.find(r => r.itemID === itemID) || null;
  }

  // Let the user drag a box over the PDF and attach that region as an image to the next
  // message. The overlay lives in the pdf.js document; wheel events still scroll the PDF.
  startCapture(itemID) {
    const reader = this.readerFor(itemID);
    const win = reader?._internalReader?._primaryView?._iframeWindow;
    if (!win) return;
    const conv = this.conversation(itemID);
    if ((conv.images || []).length >= AIChatAddon.MAX_IMAGES) {
      conv.captureError = `一条消息最多附 ${AIChatAddon.MAX_IMAGES} 张截图`;
      this.changed(conv);
      return;
    }
    const doc = win.document;
    doc.getElementById('zoteroaichat-capture')?.remove();
    const overlay = doc.createElement('div');
    overlay.id = 'zoteroaichat-capture';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:2147483647;cursor:crosshair;background:rgba(0,0,0,0.06);';
    const hint = doc.createElement('div');
    hint.textContent = '拖动框选图表或公式 · Esc 取消';
    hint.style.cssText = 'position:fixed;top:12px;left:50%;transform:translateX(-50%);padding:5px 12px;border-radius:8px;background:rgba(0,0,0,0.75);color:#fff;font:12px -apple-system,system-ui,sans-serif;pointer-events:none;';
    const box = doc.createElement('div');
    box.style.cssText = 'position:fixed;display:none;border:1.5px solid AccentColor;background:color-mix(in srgb, AccentColor 12%, transparent);border-radius:2px;pointer-events:none;';
    overlay.append(hint, box);
    doc.body.append(overlay);
    win.focus();

    let start = null;
    const rectOf = event => ({
      left: Math.min(start.x, event.clientX), top: Math.min(start.y, event.clientY),
      right: Math.max(start.x, event.clientX), bottom: Math.max(start.y, event.clientY)
    });
    const finish = () => { overlay.remove(); win.removeEventListener('keydown', onKey, true); };
    const onKey = event => { if (event.key === 'Escape') { event.preventDefault(); finish(); } };
    win.addEventListener('keydown', onKey, true);
    overlay.addEventListener('wheel', event => {
      doc.getElementById('viewerContainer')?.scrollBy(event.deltaX, event.deltaY);
      event.preventDefault();
    }, { passive: false });
    overlay.addEventListener('mousedown', event => {
      start = { x: event.clientX, y: event.clientY };
      Object.assign(box.style, { display: 'block', left: start.x + 'px', top: start.y + 'px', width: '0px', height: '0px' });
      event.preventDefault();
    });
    overlay.addEventListener('mousemove', event => {
      if (!start) return;
      const r = rectOf(event);
      Object.assign(box.style, { left: r.left + 'px', top: r.top + 'px', width: (r.right - r.left) + 'px', height: (r.bottom - r.top) + 'px' });
    });
    overlay.addEventListener('mouseup', event => {
      if (!start) return;
      const rect = rectOf(event);
      finish();
      this.attachCapture(itemID, reader, rect).catch(error => {
        Zotero.logError(error);
        const conv = this.conversation(itemID);
        conv.captureError = error.message;
        this.changed(conv);
      });
    });
  }

  async attachCapture(itemID, reader, rect) {
    const conv = this.conversation(itemID);
    if ((conv.images || []).length >= AIChatAddon.MAX_IMAGES) throw new Error(`一条消息最多附 ${AIChatAddon.MAX_IMAGES} 张截图`);
    const image = await this.cropRegion(reader, rect);
    conv.images = [...(conv.images || []), image];
    conv.captureError = null;
    this.toggle(Zotero.getMainWindow(), true);
    this.changed(conv);
  }

  // Crop a viewport rect from the rendered canvas of the page under it and save it as PNG.
  async cropRegion(reader, rect) {
    const doc = reader._internalReader._primaryView._iframeWindow.document;
    // Hit-test by geometry: Zotero disables pointer events on pdf.js pages, so
    // elementsFromPoint() does not return them.
    const cx = (rect.left + rect.right) / 2;
    const cy = (rect.top + rect.bottom) / 2;
    const pageEl = [...doc.querySelectorAll('.page')].find(el => {
      const r = el.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    });
    const canvas = pageEl?.querySelector('.canvasWrapper canvas');
    if (!canvas) {
      Zotero.debug(`[zoteroaichat] capture miss: rect=${JSON.stringify(rect)} pages=${JSON.stringify([...doc.querySelectorAll('.page')].map(el => { const r = el.getBoundingClientRect(); return [el.dataset.pageNumber, Math.round(r.left), Math.round(r.top), Math.round(r.right), Math.round(r.bottom), !!el.querySelector('.canvasWrapper canvas')]; }))}`);
      throw new Error('请框选 PDF 页面上的区域');
    }
    const page = canvas.getBoundingClientRect();
    const scaleX = canvas.width / page.width;
    const scaleY = canvas.height / page.height;
    const left = Math.max(rect.left, page.left), top = Math.max(rect.top, page.top);
    const right = Math.min(rect.right, page.right), bottom = Math.min(rect.bottom, page.bottom);
    if (right - left < 8 || bottom - top < 8) throw new Error('框选区域太小');
    const out = doc.createElement('canvas');
    out.width = Math.round((right - left) * scaleX);
    out.height = Math.round((bottom - top) * scaleY);
    out.getContext('2d').drawImage(canvas, (left - page.left) * scaleX, (top - page.top) * scaleY, out.width, out.height, 0, 0, out.width, out.height);
    const binary = atob(out.toDataURL('image/png').split(',')[1]);
    const dir = PathUtils.join(Zotero.DataDirectory.dir, 'ai-chat', 'images');
    await IOUtils.makeDirectory(dir, { ignoreExisting: true });
    const path = PathUtils.join(dir, `${Date.now()}-${Zotero.Utilities.randomString(6)}.png`);
    await IOUtils.write(path, Uint8Array.from(binary, c => c.charCodeAt(0)));
    return { path, url: PathUtils.toFileURI(path), page: Number(pageEl.dataset.pageNumber) || null, width: out.width, height: out.height };
  }

  // Remove one attached screenshot, or all of them when no index is given.
  clearImage(itemID, index) {
    const conv = this.conversations.get(itemID);
    if (!conv) return;
    conv.images = Number.isInteger(index) ? (conv.images || []).filter((_, i) => i !== index) : [];
    conv.captureError = null;
    this.changed(conv);
  }

  quote(reader, annotation) {
    if (!annotation?.text) return;
    const conv = this.conversation(reader.itemID);
    const pageIndex = annotation.position?.pageIndex;
    // The selection's position (page + rects) comes from the reader's compartment; keep a
    // plain copy so the quote can later be highlighted exactly and saved as JSON.
    const position = annotation.position ? JSON.parse(JSON.stringify(annotation.position)) : null;
    conv.quote = { text: annotation.text.trim(), page: Number.isInteger(pageIndex) ? pageIndex + 1 : null, position };
    this.toggle(reader._window || Zotero.getMainWindow(), true);
    this.changed(conv);
  }

  // Show a cited spot in the reader for this attachment. A saved selection position is
  // highlighted exactly; otherwise jump to the page (1-based, as in the [p.N] markers) and,
  // when a verbatim phrase is given, find it with the reader's search, which scrolls to and
  // highlights the match. A phrase that is not found closes the find bar again.
  async locate(itemID, { page, text, position }) {
    const reader = this.readerFor(itemID);
    if (!reader) return;
    if (position) {
      reader.navigate({ position });
      return;
    }
    const last = this.conversations.get(itemID)?.pageCount || page;
    await reader.navigate({ pageIndex: Math.min(Math.max(page, 1), last) - 1 });
    if (!text) return;
    const internal = reader._internalReader;
    const find = { popupOpen: true, active: true, query: text, highlightAll: false, caseSensitive: false, entireWord: false, index: null, result: null };
    const setFind = state => internal._updateState(Components.utils.cloneInto({ primaryViewFindState: state }, reader._iframeWindow));
    // Reset first so the same phrase searches again, and let the page scroll settle so the
    // search starts from the cited page.
    setFind({ ...find, active: false, popupOpen: false, query: '' });
    await Zotero.Promise.delay(200);
    setFind(find);
    await Zotero.Promise.delay(1500);
    const state = internal._state.primaryViewFindState;
    const total = state?.result?.total ?? state?.result?.matchesCount?.total;
    Zotero.debug(`[zoteroaichat] locate p.${page} "${text}": ${JSON.stringify(state?.result ?? null)}`);
    if (state?.query === text && total === 0) setFind({ ...find, active: false, popupOpen: false, query: '' });
  }

  // Save one question/answer as a note: a child of the paper's parent item, or a standalone
  // note when the PDF has no parent. page:N links become zotero://open-pdf links.
  async saveNote(itemID, index, html) {
    const conv = this.conversations.get(itemID);
    const message = conv?.messages[index];
    if (!message || message.role !== 'assistant') return;
    const attachment = Zotero.Items.get(itemID);
    const prefix = `zotero://open-pdf/${Zotero.API.getLibraryPrefix(attachment.libraryID)}/items/${attachment.key}`;
    const note = new Zotero.Item('note');
    note.libraryID = attachment.libraryID;
    if (attachment.parentItem?.isRegularItem()) note.parentID = attachment.parentID;
    note.setNote(html.replace(/href="page:(\d+)"/g, (_, page) => `href="${prefix}?page=${page}"`));
    await note.saveTx();
    message.note = note.key;
    this.changed(conv);
    await this.save(conv);
  }

  openNote(itemID, index) {
    const conv = this.conversations.get(itemID);
    const message = conv?.messages[index];
    const attachment = Zotero.Items.get(itemID);
    const note = message?.note && Zotero.Items.getByLibraryAndKey(attachment.libraryID, message.note);
    if (note && !note.deleted) {
      Zotero.getMainWindow().ZoteroPane.openNoteWindow(note.id);
      return;
    }
    // The note was deleted since; offer saving again.
    delete message.note;
    this.changed(conv);
    this.save(conv);
  }

  clearQuote(itemID) {
    const conv = this.conversations.get(itemID);
    if (!conv?.quote) return;
    conv.quote = null;
    this.changed(conv);
  }

  conversation(itemID) {
    let conv = this.conversations.get(itemID);
    if (!conv) {
      const item = Zotero.Items.get(itemID);
      const parent = item?.parentItem || item;
      conv = { itemID, title: parent?.getDisplayTitle() || '未命名文献', threadId: null, turnId: null, busy: false, messages: [], quote: null, notice: '正在读取全文…', noticeLevel: 'loading', instructions: '' };
      this.conversations.set(itemID, conv);
      conv.contextReady = this.loadContext(conv);
      conv.restored = this.restore(conv);
    }
    return conv;
  }

  storePath(itemID) {
    const item = Zotero.Items.get(itemID);
    return PathUtils.join(Zotero.DataDirectory.dir, 'ai-chat', 'conversations', `${item.libraryID}-${item.key}.json`);
  }

  async restore(conv) {
    try {
      const path = this.storePath(conv.itemID);
      if (!(await IOUtils.exists(path))) return;
      const { messages } = await IOUtils.readJSON(path);
      if (!conv.messages.length && Array.isArray(messages)) {
        // Older saves kept a single `image` per message.
        conv.messages = messages.map(({ image, ...m }) => image && !m.images ? { ...m, images: [image] } : m);
        this.changed(conv);
      }
    } catch (error) {
      Zotero.logError(error);
    }
  }

  async save(conv) {
    try {
      const path = this.storePath(conv.itemID);
      if (!conv.messages.length) {
        await IOUtils.remove(path, { ignoreAbsent: true });
        return;
      }
      await IOUtils.makeDirectory(PathUtils.parent(path), { ignoreExisting: true });
      const messages = conv.messages.filter(m => !m.pending).map(({ role, text, quote, images, error, note }) => ({ role, text, quote, images, error, note }));
      await IOUtils.writeJSON(path, { version: 1, messages }, { tmpPath: path + '.tmp' });
    } catch (error) {
      Zotero.logError(error);
    }
  }

  // The text codex sees for a user message, with the quoted passage inlined.
  // An attached image is sent as a local image with the turn; in replayed history only a
  // note that it was there survives.
  promptFor(message, { replay = false } = {}) {
    const { quote, images = [], text } = message;
    const parts = [];
    if (images.length) {
      const where = images.map((image, i) => `image ${i + 1}${image.page ? ` from p. ${image.page}` : ''}`).join(', ');
      parts.push(replay
        ? `[${images.length} image(s) cropped from the PDF were attached here (${where}); they are no longer available.]`
        : `[Attached ${images.length} image(s) cropped from the PDF, in order: ${where}.]`);
    }
    if (quote) parts.push(`Quoted passage from the paper${quote.page ? ` (p. ${quote.page})` : ''}:\n"""\n${quote.text}\n"""`);
    parts.push(text);
    return parts.join('\n\n');
  }

  // Builds the developer instructions for the paper: metadata plus full text with
  // [p.N] page markers. Extraction starts as soon as the paper's conversation exists.
  async loadContext(conv) {
    const item = Zotero.Items.get(conv.itemID);
    const parent = item?.parentItem || item;
    const authors = parent?.getCreators?.().map(c => [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name).filter(Boolean).join(', ');
    const header = [
      'The user is reading this paper in the Zotero PDF reader.',
      `Title: ${conv.title}`,
      authors && `Authors: ${authors}`,
      parent?.getField?.('date') && `Date: ${parent.getField('date')}`,
      parent?.getField?.('abstractNote') && `Abstract: ${parent.getField('abstractNote')}`
    ].filter(Boolean).join('\n');

    let body = '';
    try {
      if (!item?.isPDFAttachment()) throw new Error('not a PDF');
      const { text } = await Zotero.PDFWorker.getFullText(conv.itemID, null);
      const pages = text.split('\f');
      if (!text.trim()) {
        conv.notice = '没有可提取的文字（可能是扫描件）';
        conv.noticeLevel = 'warn';
      } else {
        body = pages.map((page, i) => `[p.${i + 1}]\n${page.trim()}`).join('\n\n');
        conv.pageCount = pages.length;
        conv.notice = `已读取全文 · ${pages.length} 页`;
        conv.noticeLevel = 'ok';
        if (body.length > AIChatAddon.MAX_CONTEXT_CHARS) {
          body = body.slice(0, AIChatAddon.MAX_CONTEXT_CHARS);
          const lastPage = [...body.matchAll(/^\[p\.(\d+)\]$/gm)].pop()?.[1];
          body += `\n\n[Full text truncated after p.${lastPage}; later pages are not available.]`;
          conv.notice = `篇幅过长，已读取前 ${lastPage} / ${pages.length} 页`;
          conv.noticeLevel = 'warn';
        }
      }
    } catch (error) {
      Zotero.logError(error);
      conv.notice = '未能提取全文，仅有题录信息';
      conv.noticeLevel = 'warn';
    }
    conv.instructions = body
      ? `${header}\n\nFull text of the PDF, with [p.N] marking the start of PDF page N:\n\n${body}`
      : header;
    this.changed(conv);
  }

  changed(conv) {
    for (const sidebar of this.sidebars.values()) if (sidebar.itemID === conv.itemID) sidebar.render();
  }

  async send(itemID, text) {
    const conv = this.conversation(itemID);
    await conv.restored;
    const { quote } = conv;
    const images = conv.images || [];
    text = text.trim() || (images.length > 1 ? '比较并解释这几张图（或表格、公式）。'
      : images.length ? '解释这张图（或表格、公式）的含义。' : quote ? '解释这段文字。' : '');
    if (conv.busy || !text) return;
    Zotero.debug(`[zoteroaichat] send for item ${itemID}`);
    const history = conv.threadId ? [] : conv.messages.map(m => ({ role: m.role, text: m.role === 'user' ? this.promptFor(m, { replay: true }) : m.text }));
    const message = { role: 'user', text, quote, images };
    conv.quote = null;
    conv.images = [];
    conv.messages.push(message);
    conv.messages.push({ role: 'assistant', text: '', pending: true });
    conv.busy = true;
    this.changed(conv);
    try {
      await conv.contextReady;
      if (!conv.threadId) {
        const language = { zh: 'Always reply in Simplified Chinese.', en: 'Always reply in English.' }[Zotero.Prefs.get('extensions.zoteroaichat.language', true)];
        conv.threadId = await this.codex.startThread([conv.instructions, language].filter(Boolean).join('\n\n'), history);
        this.codex.listen(conv.threadId, event => this.onEvent(conv, event));
      }
      conv.turnId = await this.codex.startTurn(conv.threadId, this.promptFor(message), images.map(image => image.path));
    } catch (error) {
      Zotero.logError(error);
      this.finishTurn(conv, error.message);
    }
  }

  stop(itemID) {
    const conv = this.conversations.get(itemID);
    if (conv?.busy && conv.threadId && conv.turnId)
      this.codex.interrupt(conv.threadId, conv.turnId).catch(error => Zotero.logError(error));
  }

  // Starts a fresh conversation for the paper, reusing the already extracted context.
  reset(itemID) {
    const conv = this.conversations.get(itemID);
    if (!conv) return;
    this.stop(itemID);
    const fresh = { ...conv, threadId: null, turnId: null, busy: false, messages: [], quote: null, images: [] };
    this.conversations.set(itemID, fresh);
    this.changed(fresh);
    this.save(fresh);
  }

  finishTurn(conv, error = null) {
    const reply = conv.messages[conv.messages.length - 1];
    if (reply?.role === 'assistant') {
      reply.pending = false;
      if (error) reply.error = error;
    }
    conv.busy = false;
    conv.turnId = null;
    this.changed(conv);
    if (this.conversations.get(conv.itemID) === conv) this.save(conv);
  }

  // Model catalog plus the effective choice: the user's pick, else codex's configured default.
  async models() {
    const [models, config] = await Promise.all([
      this.codex.listModels(),
      this.codex.request('config/read', {}).then(r => r.config, () => ({}))
    ]);
    const model = Zotero.Prefs.get('extensions.zoteroaichat.model', true)
      || config.model || models.find(m => m.isDefault)?.id || models[0]?.id || '';
    const effort = Zotero.Prefs.get('extensions.zoteroaichat.effort', true)
      || config.model_reasoning_effort || models.find(m => m.id === model)?.defaultEffort || '';
    return { models, model, effort };
  }

  setModel(model, effort) {
    Zotero.Prefs.set('extensions.zoteroaichat.model', model, true);
    Zotero.Prefs.set('extensions.zoteroaichat.effort', effort, true);
  }

  onEvent(conv, { method, params }) {
    if (this.conversations.get(conv.itemID) !== conv) return;
    const reply = conv.messages[conv.messages.length - 1];
    if (method === 'item/agentMessage/delta' && reply?.pending) {
      if (reply.itemId && reply.itemId !== params.itemId && reply.text) reply.text += '\n\n';
      reply.itemId = params.itemId;
      reply.text += params.delta;
      this.changed(conv);
    } else if (method === 'error' && !params.willRetry) {
      if (reply?.pending) reply.error = params.error?.message || '请求失败';
    } else if (method === 'turn/completed') {
      const turn = params.turn;
      const error = turn.status === 'failed' ? (turn.error?.message || reply?.error || '请求失败')
        : turn.status === 'interrupted' ? '已停止' : reply?.error;
      this.finishTurn(conv, error);
    } else if (method === 'process/exited') {
      conv.threadId = null;
      if (conv.busy) this.finishTurn(conv, params.error.message);
    }
  }
};

AIChatAddon.MAX_IMAGES = 6;

// Roughly 120k tokens of paper text; keeps room for the conversation itself.
AIChatAddon.MAX_CONTEXT_CHARS = 480000;
