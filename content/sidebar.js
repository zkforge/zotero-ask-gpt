// Mounts the chat panel to the right of the reader inside the main window.
var AIChatSidebar = class {
  constructor(addon, win) {
    this.addon = addon;
    this.win = win;
    this.itemID = null;
    const doc = win.document;
    this.host = doc.getElementById('browser');

    this.splitter = doc.createXULElement('splitter');
    this.splitter.id = 'zoteroaichat-splitter';
    this.splitter.setAttribute('resizebefore', 'closest');
    this.splitter.setAttribute('resizeafter', 'closest');
    // A 1px hairline with a wider transparent grab area on its left.
    this.splitter.style.cssText = 'width:5px;min-width:5px;margin:0;border:0;border-right:1px solid color-mix(in srgb,currentColor 12%,transparent);background:transparent;cursor:col-resize;';

    this.panel = doc.createXULElement('vbox');
    this.panel.id = 'zoteroaichat-panel';
    const width = Zotero.Prefs.get('extensions.zoteroaichat.width', true) || Math.max(340, Math.min(460, Math.floor(win.innerWidth * 0.36)));
    this.panel.setAttribute('width', width);
    this.panel.style.cssText = 'min-width:300px;max-width:1000px;min-height:0;flex-shrink:0;overflow:hidden;';

    this.frame = doc.createElementNS('http://www.w3.org/1999/xhtml', 'iframe');
    this.frame.setAttribute('src', 'chrome://zoteroaichat/content/chat.html');
    this.frame.style.cssText = 'border:0;flex:1;width:100%;min-height:0;';
    // chat.js calls attach() itself when its script runs, so this survives iframe reloads
    // and does not depend on catching the frame's load event.
    this.frame.aiChatSidebar = this;
    this.panel.appendChild(this.frame);

    this.layoutStyle = doc.createElementNS('http://www.w3.org/1999/xhtml', 'style');
    this.layoutStyle.textContent = `
      #browser.zoteroaichat-visible > #appcontent { min-width:0 !important; width:0; flex:1 1 0; overflow:hidden; }
      #browser.zoteroaichat-visible #tabs-deck { min-width:0 !important; }
      #browser.zoteroaichat-visible #zotero-context-pane.stacked { right:var(--zoteroaichat-space) !important; }
    `;
    doc.documentElement.appendChild(this.layoutStyle);
    this.host.append(this.splitter, this.panel);

    this.resize = new win.ResizeObserver(() => {
      const size = Math.round(this.panel.getBoundingClientRect().width);
      this.panel.style.maxWidth = Math.max(300, Math.min(1000, this.host.getBoundingClientRect().width - 360)) + 'px';
      if (size >= 300) {
        Zotero.Prefs.set('extensions.zoteroaichat.width', size, true);
        this.host.style.setProperty('--zoteroaichat-space', (size + 5) + 'px');
      }
    });
    this.resize.observe(this.panel);
    this.resize.observe(this.host);
  }

  attach(chatWindow) {
    Zotero.debug('[zoteroaichat] chat view attached');
    this.chat = chatWindow;
    this.frameScheduled = false;
    const guard = action => (...args) => {
      try { return action(...args); } catch (error) { Zotero.logError(error); }
    };
    this.render();
    return {
      send: guard(text => this.itemID && this.addon.send(this.itemID, text)),
      stop: guard(() => this.itemID && this.addon.stop(this.itemID)),
      reset: guard(() => this.itemID && this.addon.reset(this.itemID)),
      clearQuote: guard(() => this.itemID && this.addon.clearQuote(this.itemID)),
      models: () => this.addon.models(),
      setModel: guard((model, effort) => this.addon.setModel(model, effort)),
      openURL: guard(url => /^https?:\/\//i.test(url) && Zotero.launchURL(url)),
      locate: guard(target => this.itemID && this.addon.locate(this.itemID, target).catch(error => Zotero.logError(error))),
      saveNote: guard((index, html) => this.itemID && this.addon.saveNote(this.itemID, index, html)
        .catch(error => { Zotero.logError(error); this.render(); })),
      openNote: guard(index => this.itemID && this.addon.openNote(this.itemID, index)),
      capture: guard(() => this.itemID && this.addon.startCapture(this.itemID)),
      clearImage: guard(() => this.itemID && this.addon.clearImage(this.itemID)),
      close: guard(() => this.addon.toggle(this.win)),
      logError: error => Zotero.logError(error)
    };
  }

  isVisible() {
    return !this.panel.hidden;
  }

  sync(reader) {
    const visible = !!reader && Zotero.Prefs.get('extensions.zoteroaichat.open', true) !== false;
    this.panel.hidden = !visible;
    this.splitter.hidden = !visible;
    this.host.classList.toggle('zoteroaichat-visible', visible);
    if (reader && reader.itemID !== this.itemID) {
      this.itemID = reader.itemID;
      this.render();
    }
  }

  render() {
    if (!this.chat?.render || !this.itemID || this.frameScheduled) return;
    this.frameScheduled = true;
    this.win.requestAnimationFrame(() => {
      this.frameScheduled = false;
      try { this.chat.render(this.addon.conversation(this.itemID)); }
      catch (error) { Zotero.logError(error); }
    });
  }

  focusInput() {
    this.chat?.focusInput?.();
  }

  destroy() {
    this.resize.disconnect();
    this.panel.remove();
    this.splitter.remove();
    this.layoutStyle.remove();
    this.host.classList.remove('zoteroaichat-visible');
    this.host.style.removeProperty('--zoteroaichat-space');
  }
};
