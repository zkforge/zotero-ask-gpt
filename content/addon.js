// Global plugin state: windows, reader tabs, and one conversation per PDF attachment.
var AIChatAddon = class {
  constructor({ id, version }) {
    this.id = id;
    this.codex = new CodexService(version);
    this.sidebars = new Map();
    this.conversations = new Map();
  }

  startup() {
    this.tabObserver = Zotero.Notifier.registerObserver({
      notify: event => {
        if (['select', 'load', 'close'].includes(event))
          for (const win of Zotero.getMainWindows()) this.updateWindow(win);
      }
    }, ['tab'], 'zoteroaichat-tabs');
    for (const win of Zotero.getMainWindows()) this.addWindow(win);

    Zotero.Reader.registerEventListener('renderTextSelectionPopup', ({ reader, doc, params, append }) => {
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
      // "nav" checks navigation only, without adding a message to the saved conversation.
      if (Zotero.Prefs.get('extensions.zoteroaichat.devSelfTest', true) === 'nav') return;
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
    Zotero.Notifier.unregisterObserver(this.tabObserver);
    for (const win of Zotero.getMainWindows()) this.removeWindow(win);
    this.codex.stop();
    this.conversations.clear();
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
    const current = this.currentReader(Zotero.getMainWindow());
    const reader = current?.itemID === itemID ? current : Zotero.Reader._readers.find(r => r.itemID === itemID);
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
        conv.messages = messages;
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
      const messages = conv.messages.filter(m => !m.pending).map(({ role, text, quote, error }) => ({ role, text, quote, error }));
      await IOUtils.writeJSON(path, { version: 1, messages }, { tmpPath: path + '.tmp' });
    } catch (error) {
      Zotero.logError(error);
    }
  }

  // The text codex sees for a user message, with the quoted passage inlined.
  promptFor(message) {
    const { quote, text } = message;
    return quote
      ? `Quoted passage from the paper${quote.page ? ` (p. ${quote.page})` : ''}:\n"""\n${quote.text}\n"""\n\n${text}`
      : text;
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
    const quote = conv.quote;
    text = text.trim() || (quote ? '解释这段文字。' : '');
    if (conv.busy || !text) return;
    Zotero.debug(`[zoteroaichat] send for item ${itemID}`);
    const history = conv.threadId ? [] : conv.messages.map(m => ({ role: m.role, text: m.role === 'user' ? this.promptFor(m) : m.text }));
    const message = { role: 'user', text, quote };
    conv.quote = null;
    conv.messages.push(message);
    conv.messages.push({ role: 'assistant', text: '', pending: true });
    conv.busy = true;
    this.changed(conv);
    try {
      await conv.contextReady;
      if (!conv.threadId) {
        conv.threadId = await this.codex.startThread(conv.instructions, history);
        this.codex.listen(conv.threadId, event => this.onEvent(conv, event));
      }
      conv.turnId = await this.codex.startTurn(conv.threadId, this.promptFor(message));
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
    const fresh = { ...conv, threadId: null, turnId: null, busy: false, messages: [], quote: null };
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

// Roughly 120k tokens of paper text; keeps room for the conversation itself.
AIChatAddon.MAX_CONTEXT_CHARS = 480000;
