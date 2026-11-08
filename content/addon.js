// Global plugin state: windows, reader tabs, and one conversation per PDF attachment.
var AIChatAddon = class {
  constructor({ id, version, rootURI }) {
    this.id = id;
    this.rootURI = rootURI;
    this.codex = new CodexService(version);
    this.sidebars = new Map();
    this.conversations = new Map();
    this.paperTexts = new Map();
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

    // Development aid: content/selftest.js is loaded only when this pref is set.
    if (typeof runSelfTest === 'function') runSelfTest(this);
  }

  shutdown() {
    for (const symbol of this.prefObservers || []) Zotero.Prefs.unregisterObserver(symbol);
    Zotero.Notifier.unregisterObserver(this.tabObserver);
    for (const win of Zotero.getMainWindows()) this.removeWindow(win);
    this.codex.stop();
    this.conversations.clear();
  }

  // Settings pane support -------------------------------------------------------

  async openSettings() {
    Zotero.Utilities.Internal.openPreferences(await this.prefPaneID);
  }

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
  // `paper` ("<libraryID>/<attachmentKey>") targets another paper added to the conversation:
  // its reader tab is reused or opened at the cited page.
  async locate(itemID, { page, text, position, paper }) {
    let targetID = itemID;
    let reader;
    if (paper) {
      const [libraryID, key] = paper.split('/');
      const attachment = Zotero.Items.getByLibraryAndKey(Number(libraryID), key);
      if (!attachment?.isPDFAttachment() || attachment.deleted) return;
      targetID = attachment.id;
      reader = this.readerFor(targetID);
      if (reader) Zotero.getMainWindow().Zotero_Tabs.select(reader.tabID);
      else {
        reader = await Zotero.Reader.open(targetID, { pageIndex: Math.max(page, 1) - 1 });
        // Zotero selects a restored, unloaded tab without returning its reader.
        for (let i = 0; i < 100 && !reader; i++) {
          await Zotero.Promise.delay(50);
          reader = this.readerFor(targetID);
        }
      }
      await reader?._initPromise;
    } else {
      reader = this.readerFor(itemID);
    }
    if (!reader) return;
    if (position) {
      reader.navigate({ position });
      return;
    }
    const last = this.conversations.get(targetID)?.pageCount || page;
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
    note.setNote(html
      .replace(/href="page:(\d+)"/g, (_, page) => `href="${prefix}?page=${page}"`)
      .replace(/href="paper:(\d+)\/([A-Z0-9]{8})\/(\d+)"/g, (_, libraryID, key, page) =>
        `href="zotero://open-pdf/${Zotero.API.getLibraryPrefix(Number(libraryID))}/items/${key}?page=${page}"`));
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
      conv = { itemID, title: parent?.getDisplayTitle() || '未命名文献', threadId: null, turnId: null, busy: false, messages: [], quote: null, notice: '正在读取全文…', noticeLevel: 'loading', status: { state: 'loading' }, instructions: '' };
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
      const messages = conv.messages.filter(m => !m.pending).map(({ role, text, quote, images, papers, error, note }) => ({ role, text, quote, images, papers, error, note }));
      await IOUtils.writeJSON(path, { version: 1, messages }, { tmpPath: path + '.tmp' });
    } catch (error) {
      Zotero.logError(error);
    }
  }

  // The text codex sees for a user message, with the quoted passage inlined.
  // An attached image is sent as a local image with the turn; in replayed history only a
  // note that it was there survives.
  promptFor(message, { replay = false } = {}) {
    const { quote, images = [], papers = [], text } = message;
    const parts = [];
    for (const paper of papers) {
      const cached = this.paperTexts.get(`${paper.libraryID}/${paper.attachmentKey}`);
      const cite = `[(${paper.title.split(/[:：]/)[0].slice(0, 40)}, p. N)](paper:${paper.libraryID}/${paper.attachmentKey}/N "phrase copied from that page")`;
      parts.push([
        'The user added another paper from their library to this conversation.',
        cached?.header || `Title: ${paper.title}`,
        `Cite this paper as ${cite}, not with page: links (those point to the paper open in the reader).`,
        cached?.body ? `Full text, with [p.N] marking the start of PDF page N:\n\n${cached.body}` : '(Its full text could not be extracted; only the metadata above is available.)'
      ].join('\n'));
    }
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

  // Title, authors, date and abstract of the regular item an attachment belongs to.
  paperHeader(attachment) {
    const parent = attachment?.parentItem || attachment;
    const authors = parent?.getCreators?.().map(c => [c.firstName, c.lastName].filter(Boolean).join(' ') || c.name).filter(Boolean).join(', ');
    return [
      `Title: ${parent?.getDisplayTitle() || 'Untitled'}`,
      authors && `Authors: ${authors}`,
      parent?.getField?.('date') && `Date: ${parent.getField('date')}`,
      parent?.getField?.('abstractNote') && `Abstract: ${parent.getField('abstractNote')}`
    ].filter(Boolean).join('\n');
  }

  // Full text of a PDF attachment with [p.N] marking the start of each page, cut after
  // maxChars. state: full | truncated | scanned | failed.
  async paperText(attachment, maxChars) {
    try {
      if (!attachment?.isPDFAttachment()) throw new Error('not a PDF');
      const { text } = await Zotero.PDFWorker.getFullText(attachment.id, null);
      const pages = text.split('\f');
      if (!text.trim()) return { state: 'scanned', pages: pages.length, body: '' };
      let body = pages.map((page, i) => `[p.${i + 1}]\n${page.trim()}`).join('\n\n');
      if (body.length <= maxChars) return { state: 'full', pages: pages.length, body };
      body = body.slice(0, maxChars);
      const readPages = Number([...body.matchAll(/^\[p\.(\d+)\]$/gm)].pop()?.[1]);
      body += `\n\n[Full text truncated after p.${readPages}; later pages are not available.]`;
      return { state: 'truncated', pages: pages.length, readPages, body };
    } catch (error) {
      Zotero.logError(error);
      return { state: 'failed', body: '' };
    }
  }

  // Builds the developer instructions for the paper: metadata plus full text with
  // [p.N] page markers. Extraction starts as soon as the paper's conversation exists.
  async loadContext(conv) {
    const item = Zotero.Items.get(conv.itemID);
    const header = `The user is reading this paper in the Zotero PDF reader.\n${this.paperHeader(item)}`;
    const { state, pages, readPages, body } = await this.paperText(item, AIChatAddon.MAX_CONTEXT_CHARS);
    conv.status = { state, pages, readPages };
    if (pages) conv.pageCount = pages;
    [conv.notice, conv.noticeLevel] = {
      full: [`已读取全文 · ${pages} 页`, 'ok'],
      truncated: [`篇幅过长，已读取前 ${readPages} / ${pages} 页`, 'warn'],
      scanned: ['没有可提取的文字（可能是扫描件）', 'warn'],
      failed: ['未能提取全文，仅有题录信息', 'warn']
    }[state];
    conv.instructions = body
      ? `${header}\n\nFull text of the PDF, with [p.N] marking the start of PDF page N:\n\n${body}`
      : header;
    conv.paperTokens = AIChatAddon.estimateTokens(conv.instructions);
    this.changed(conv);
  }

  // Papers the user can add to the conversation, grouped for the "+" menu: the paper's
  // related items first (empty query only), then each library, newest first. Only items
  // with a PDF, excluding the paper being read.
  async searchPapers(itemID, query) {
    const current = Zotero.Items.get(itemID);
    const currentParent = current?.parentItem || current;
    const toEntry = async item => {
      if (!item?.isRegularItem() || item.id === currentParent?.id || item.deleted) return null;
      const pdf = await item.getBestAttachment();
      if (!pdf?.isPDFAttachment()) return null;
      const year = Zotero.Date.strToDate(item.getField('date') || '').year;
      return { libraryID: item.libraryID, key: item.key, attachmentKey: pdf.key, title: item.getDisplayTitle(), meta: [item.firstCreator, year].filter(Boolean).join(' · ') };
    };
    const collect = async (items, limit) => {
      const papers = [];
      for (const item of items) {
        if (papers.length >= limit) break;
        const entry = await toEntry(item);
        if (entry) papers.push(entry);
      }
      return papers;
    };
    const groups = [];
    const q = query.trim();
    if (!q && currentParent?.isRegularItem()) {
      const related = currentParent.relatedItems.map(key => Zotero.Items.getByLibraryAndKey(currentParent.libraryID, key));
      const papers = await collect(related, 20);
      if (papers.length) groups.push({ label: '相关条目', papers });
    }
    for (const library of Zotero.Libraries.getAll().filter(l => ['user', 'group'].includes(l.libraryType))) {
      const search = new Zotero.Search();
      search.libraryID = library.libraryID;
      if (q) search.addCondition('quicksearch-titleCreatorYear', 'contains', q);
      for (const type of ['attachment', 'note', 'annotation']) search.addCondition('itemType', 'isNot', type);
      const items = (await Zotero.Items.getAsync(await search.search()))
        .sort((a, b) => (a.dateAdded < b.dateAdded ? 1 : -1));
      const papers = await collect(items, q ? 50 : 30);
      if (papers.length) groups.push({ label: library.libraryType === 'user' ? '我的文库' : library.name, papers });
    }
    return groups;
  }

  // Full text of added papers, cached by attachment so prompts can be built synchronously.
  async loadPapers(papers) {
    for (const paper of papers) {
      const id = `${paper.libraryID}/${paper.attachmentKey}`;
      if (this.paperTexts.has(id)) continue;
      const attachment = Zotero.Items.getByLibraryAndKey(paper.libraryID, paper.attachmentKey);
      const { body, ...status } = await this.paperText(attachment, AIChatAddon.MAX_ATTACHED_CHARS);
      this.paperTexts.set(id, { header: this.paperHeader(attachment), body, status });
    }
  }

  addPaper(itemID, paper) {
    const conv = this.conversation(itemID);
    const papers = conv.papers || [];
    if (papers.some(p => p.key === paper.key && p.libraryID === paper.libraryID)) return;
    conv.papers = [...papers, paper];
    this.changed(conv);
  }

  removePaper(itemID, index) {
    const conv = this.conversations.get(itemID);
    if (!conv) return;
    conv.papers = (conv.papers || []).filter((_, i) => i !== index);
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
    const papers = conv.papers || [];
    text = text.trim() || (images.length > 1 ? '比较并解释这几张图（或表格、公式）。'
      : images.length ? '解释这张图（或表格、公式）的含义。' : quote ? '解释这段文字。'
      : papers.length ? '附加的论文和当前这篇有什么关系？各自的方法和结论有什么异同？' : '');
    if (conv.busy || !text) return;
    Zotero.debug(`[zoteroaichat] send for item ${itemID}`);
    conv.quote = null;
    conv.images = [];
    conv.papers = [];
    await this.ask(conv, { role: 'user', text, quote, images, papers });
  }

  // Ask the last question again, or an edited version of it, on a fresh thread whose replayed
  // history stops before that question, so the model never sees the answer being replaced.
  async rerun(itemID, editedText = null) {
    const conv = this.conversations.get(itemID);
    if (!conv || conv.busy) return;
    const index = conv.messages.map(m => m.role).lastIndexOf('user');
    if (index < 0) return;
    const question = conv.messages[index];
    conv.messages = conv.messages.slice(0, index);
    conv.threadId = null;
    await this.ask(conv, editedText?.trim() ? { ...question, text: editedText.trim() } : question);
  }

  // Run one question: append it with a pending reply, start a thread if there is none
  // (replaying the earlier messages into it), then start the turn.
  async ask(conv, message) {
    const earlier = conv.threadId ? [] : [...conv.messages];
    const images = message.images || [];
    conv.messages.push(message);
    conv.messages.push({ role: 'assistant', text: '', pending: true });
    conv.busy = true;
    this.changed(conv);
    try {
      // Added papers' full text goes into the prompt, including in replayed history.
      await this.loadPapers([...earlier, message].flatMap(m => m.papers || []));
      this.changed(conv);
      const history = earlier.map(m => ({ role: m.role, text: m.role === 'user' ? this.promptFor(m, { replay: true }) : m.text }));
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
    const fresh = { ...conv, threadId: null, turnId: null, busy: false, messages: [], quote: null, images: [], papers: [] };
    this.conversations.set(itemID, fresh);
    this.changed(fresh);
    this.save(fresh);
    // Screenshots belong to the conversation; saved notes keep only page links, not the files.
    const images = [...conv.messages.flatMap(m => m.images || []), ...(conv.images || [])];
    for (const image of images) IOUtils.remove(image.path, { ignoreAbsent: true }).catch(error => Zotero.logError(error));
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
    if (method === 'thread/tokenUsage/updated') {
      // `last` is the latest request: everything the model saw plus its reply.
      conv.usage = { used: params.tokenUsage.last.totalTokens, window: params.tokenUsage.modelContextWindow };
      this.changed(conv);
    } else if (method === 'item/agentMessage/delta' && reply?.pending) {
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

// Each added paper's text is capped lower than the paper being read.
AIChatAddon.MAX_ATTACHED_CHARS = 200000;

// Rough token count for status display: CJK characters count about one token each, other
// text about four characters per token.
AIChatAddon.estimateTokens = text => {
  const cjk = (text.match(/[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/g) || []).length;
  return Math.round(cjk + (text.length - cjk) / 4);
};

// Roughly 120k tokens of paper text; keeps room for the conversation itself.
AIChatAddon.MAX_CONTEXT_CHARS = 480000;
