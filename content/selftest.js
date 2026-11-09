// Development self-test, loaded by bootstrap.js only when the pref
// extensions.zoteroaichat.devSelfTest is set. Results go to the Zotero debug log
// ([zoteroaichat] self-test …). Modes: true (full: citations through the model),
// "nav", "limits", "history", "note", "image", "prefs" — see docs/design.md.
async function runSelfTest(addon) {
  try {
    let reader = null;
    for (let i = 0; i < 40 && !reader; i++) {
      reader = addon.currentReader(Zotero.getMainWindow());
      if (!reader) await Zotero.Promise.delay(500);
    }
    // With no PDF open, open the attachment named by extensions.zoteroaichat.devSelfTestItem
    // ("<libraryID>/<key>").
    const fallback = Zotero.Prefs.get('extensions.zoteroaichat.devSelfTestItem', true);
    if (!reader && fallback) {
      const [libraryID, key] = fallback.split('/');
      const item = Zotero.Items.getByLibraryAndKey(Number(libraryID), key);
      Zotero.debug(`[zoteroaichat] self-test opening fallback ${fallback}: item=${item?.id}`);
      if (item) reader = await Zotero.Reader.open(item.id);
      Zotero.debug(`[zoteroaichat] self-test fallback reader=${!!reader} current=${!!addon.currentReader(Zotero.getMainWindow())}`);
      reader ||= addon.currentReader(Zotero.getMainWindow());
      await reader?._initPromise;
    }
    if (!reader) throw new Error('no reader tab open');
    const conv = addon.conversation(reader.itemID);
    await Promise.all([conv.contextReady, conv.restored]);
    Zotero.debug(`[zoteroaichat] self-test context: ${conv.notice}; restored ${conv.messages.length} messages`);
    await reader._initPromise;
    await Zotero.Promise.delay(1500);
    await addon.locate(reader.itemID, { page: 5 });
    await Zotero.Promise.delay(1000);
    Zotero.debug(`[zoteroaichat] self-test navigate: asked p.5, reader at pageIndex ${reader._internalReader?._state?.primaryViewStats?.pageIndex}`);
    const mode = Zotero.Prefs.get('extensions.zoteroaichat.devSelfTest', true);
    if (mode === 'limits') {
      // No model calls. A question over the context limit comes back to the input, a paper
      // already in the conversation is not repeated, and closing the tab frees the paper.
      const itemID = reader.itemID;
      const saved = addon.codex.contextWindow;
      const before = conv.messages.length;
      addon.codex.contextWindow = 1000;
      conv.quote = { text: 'self-test quote', page: 1, position: null };
      await addon.send(itemID, 'self-test question');
      addon.codex.contextWindow = saved;
      Zotero.debug(`[zoteroaichat] self-test limits: messages ${before}->${conv.messages.length}, busy=${conv.busy}, draft=${JSON.stringify(conv.draft)}, quote=${!!conv.quote}, error=${conv.inputError}`);
      addon.clearQuote(itemID);
      conv.inputError = null;
      const paper = { libraryID: 1, attachmentKey: 'SELFTEST', title: 'Self-test paper' };
      const again = addon.promptFor({ text: 'q', papers: [paper] }, { earlier: [{ role: 'user', text: 'q', papers: [paper] }] });
      const first = addon.promptFor({ text: 'q', papers: [paper] });
      Zotero.debug(`[zoteroaichat] self-test dedupe: first has full-text block=${first.includes('added another paper')}, repeat refers back=${again.includes('given earlier')} and omits it=${!again.includes('added another paper')}`);
      for (const query of ['', 'a']) {
        const started = Date.now();
        const groups = await addon.searchPapers(itemID, query);
        Zotero.debug(`[zoteroaichat] self-test picker "${query}": ${Date.now() - started} ms, ${groups.map(g => `${g.label} ${g.papers.length}`).join(', ')}`);
      }
      Zotero.getMainWindow().Zotero_Tabs.close(reader.tabID);
      await Zotero.Promise.delay(500);
      Zotero.debug(`[zoteroaichat] self-test release: conversation kept after tab close=${addon.conversations.has(itemID)}`);
      const reopened = await Zotero.Reader.open(itemID);
      await reopened?._initPromise;
      const restored = addon.conversation(itemID);
      await Promise.all([restored.contextReady, restored.restored]);
      Zotero.debug(`[zoteroaichat] self-test reopen: ${restored.notice}; restored ${restored.messages.length} messages`);
      return;
    }
    if (mode === 'history') {
      // Archive, switch and delete conversations, read the quick prompts, then check that a
      // screenshot from replayed history reaches the model (one model call). The paper's
      // real conversations are put back afterwards.
      const itemID = reader.itemID;
      const original = { id: conv.id, created: conv.created, messages: conv.messages, archived: conv.archived };
      const current = () => addon.conversations.get(itemID);
      const file = async () => {
        const data = await IOUtils.readJSON(addon.storePath(itemID));
        return `v${data.version} current=${data.current?.messages.length} archived=${data.archived?.length}`;
      };
      addon.replaceConversation(conv, { messages: [{ role: 'user', text: 'self-test A' }, { role: 'assistant', text: 'A' }], archived: [] });
      addon.reset(itemID);
      await Zotero.Promise.delay(300);
      const archivedID = current().archived[0]?.id;
      Zotero.debug(`[zoteroaichat] self-test history reset: current=${current().messages.length} archived=${current().archived.length} file ${await file()}`);
      current().messages = [{ role: 'user', text: 'self-test B' }, { role: 'assistant', text: 'B' }];
      addon.openArchived(itemID, archivedID);
      await Zotero.Promise.delay(300);
      Zotero.debug(`[zoteroaichat] self-test history open: current="${current().messages[0]?.text}" archived=${current().archived.map(e => e.messages[0].text).join(',')} file ${await file()}`);
      addon.deleteArchived(itemID, current().archived[0].id);
      await Zotero.Promise.delay(300);
      Zotero.debug(`[zoteroaichat] self-test history delete: archived=${current().archived.length} file ${await file()}`);

      const saved = Zotero.Prefs.get('extensions.zoteroaichat.prompts', true);
      const defaults = addon.prompts().length;
      Zotero.Prefs.set('extensions.zoteroaichat.prompts', ' One \n\nTwo ', true);
      Zotero.debug(`[zoteroaichat] self-test prompts: default ${defaults}, custom ${JSON.stringify(addon.prompts())}`);
      Zotero.Prefs.set('extensions.zoteroaichat.prompts', saved, true);

      const win = reader._internalReader._primaryView._iframeWindow;
      const canvas = [...win.document.querySelectorAll('.page .canvasWrapper canvas')]
        .find(c => { const r = c.getBoundingClientRect(); return r.bottom > 0 && r.top < win.innerHeight; });
      const r = canvas.getBoundingClientRect();
      const top = Math.max(r.top, 0), bottom = Math.min(r.bottom, win.innerHeight);
      const image = await addon.cropRegion(reader, { left: r.left + r.width * 0.1, right: r.right - r.width * 0.1, top: top + (bottom - top) * 0.2, bottom: top + (bottom - top) * 0.6 });
      addon.replaceConversation(current(), {
        messages: [{ role: 'user', text: 'Keep this image in mind.', images: [image] }, { role: 'assistant', text: 'OK.' }], archived: []
      });
      // The paper's text is in context too, so ask for something only the crop shows: where it starts.
      await addon.send(itemID, 'Self-test: did I send you an image earlier in this conversation? Answer yes or no, then quote exactly the first line of text visible at the very top of that image.');
      while (current().busy) await Zotero.Promise.delay(300);
      const reply = current().messages.at(-1);
      Zotero.debug(`[zoteroaichat] self-test history replay (image p.${image.page}): ${reply.error || reply.text}`);
      await IOUtils.remove(image.path, { ignoreAbsent: true });
      addon.save(addon.replaceConversation(current(), original));
      return;
    }
    if (mode === 'rerun') {
      // Ask, regenerate, then edit the question; each rerun must replace the last pair.
      // The test exchange is removed afterwards.
      const before = conv.messages.length;
      const idle = async () => { while (conv.busy) await Zotero.Promise.delay(200); };
      const chips = () => [...[...addon.sidebars.values()][0]?.chat?.document.querySelectorAll('.chip') || []].map(c => c.textContent).join(' | ');
      await addon.send(reader.itemID, 'Self-test: name one random colour, one word only.');
      await idle();
      const first = conv.messages.at(-1).text;
      Zotero.debug(`[zoteroaichat] self-test rerun ask: "${first}", messages +${conv.messages.length - before}, usage=${JSON.stringify(conv.usage)}`);
      await addon.rerun(reader.itemID);
      await idle();
      Zotero.debug(`[zoteroaichat] self-test rerun regenerate: "${conv.messages.at(-1).text}", messages +${conv.messages.length - before}, question kept=${conv.messages.at(-2).text.includes('random colour')}`);
      await addon.rerun(reader.itemID, 'Self-test: name one random animal, one word only.');
      await idle();
      await Zotero.Promise.delay(300);
      Zotero.debug(`[zoteroaichat] self-test rerun edit: "${conv.messages.at(-1).text}", messages +${conv.messages.length - before}, question=${JSON.stringify(conv.messages.at(-2).text)}, chips="${chips()}"`);
      conv.messages.splice(before);
      addon.changed(conv);
      await addon.save(conv);
      return;
    }
    if (mode === 'prefs') {
      // Open the settings pane, log what it shows, press "test connection", then close it.
      const win = Zotero.Utilities.Internal.openPreferences(await addon.prefPaneID);
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
        addon.startCapture(reader.itemID);
        const overlay = win.document.getElementById('zoteroaichat-capture');
        const from = { clientX: page.left + page.width * 0.1, clientY: top + (bottom - top) * y1 };
        const to = { clientX: page.left + page.width * 0.9, clientY: top + (bottom - top) * y2 };
        overlay.dispatchEvent(mouse('mousedown', from));
        overlay.dispatchEvent(mouse('mousemove', to));
        overlay.dispatchEvent(mouse('mouseup', to));
        for (let i = 0; i < 20 && (conv.images?.length || 0) === count && !conv.inputError; i++) await Zotero.Promise.delay(200);
      }
      const images = conv.images || [];
      Zotero.debug(`[zoteroaichat] self-test image: overlay removed=${!win.document.getElementById('zoteroaichat-capture')}, images=${images.length} ${JSON.stringify(images.map(i => [i.page, i.width, i.height]))}, error=${conv.inputError}`);
      if (images.length) {
        const threadId = await addon.codex.startThread('');
        let reply = '';
        const done = new Promise(resolve => addon.codex.listen(threadId, ({ method, params }) => {
          if (method === 'item/agentMessage/delta') reply += params.delta;
          if (method === 'turn/completed') resolve(params.turn.status);
        }));
        await addon.codex.startTurn(threadId, 'How many images did you receive? Describe each in one short sentence.', images.map(i => i.path));
        Zotero.debug(`[zoteroaichat] self-test image reply (${await done}): ${reply}`);
        addon.clearImage(reader.itemID);
      }
      return;
    }
    if (mode === 'note') {
      // Save a sample note through the real path, log it, then erase it and the temp messages.
      const start = conv.messages.length;
      conv.messages.push({ role: 'user', text: 'self-test' }, { role: 'assistant', text: 'self-test' });
      await addon.saveNote(reader.itemID, start + 1, '<h1>Ask GPT self-test</h1><p>See <a href="page:2">(p. 2)</a> and <span class="math">$x^2$</span>.</p><pre class="math">$$y = f(x)$$</pre>');
      const attachment = Zotero.Items.get(reader.itemID);
      const note = Zotero.Items.getByLibraryAndKey(attachment.libraryID, conv.messages[start + 1].note);
      Zotero.debug(`[zoteroaichat] self-test note: child of paper=${note?.parentID === attachment.parentID}, html=${note?.getNote()}`);
      await note?.eraseTx();
      conv.messages.splice(start);
      addon.changed(conv);
      await addon.save(conv);
      return;
    }
    // "nav" checks navigation only, without adding a message to the saved conversation.
    if (mode === 'nav') return;
    // Full mode: ask something that needs citations, follow the first one, then remove the
    // test exchange so the saved conversation is left as it was.
    const before = conv.messages.length;
    await addon.send(reader.itemID, 'Self-test: in two sentences, what taxonomy does the paper propose and what future challenges does it name? Cite pages.');
    while (conv.busy) await Zotero.Promise.delay(200);
    const reply = conv.messages[conv.messages.length - 1];
    Zotero.debug(`[zoteroaichat] self-test reply: ${reply.text} ${reply.error || ''}`);
    const citations = [...reply.text.matchAll(/\]\(page:(\d+) "([^"]+)"\)/g)];
    Zotero.debug(`[zoteroaichat] self-test citations: ${citations.length}`);
    for (const [, page, phrase] of citations.slice(0, 2)) await addon.locate(reader.itemID, { page: Number(page), text: phrase });
    await Zotero.Promise.delay(500);
    const chat = [...addon.sidebars.values()][0]?.chat;
    Zotero.debug(`[zoteroaichat] self-test render: ${chat?.document.querySelectorAll('.markdown .page-ref[data-quote]').length} quoted page links`);
    conv.messages.splice(before);
    addon.changed(conv);
    await addon.save(conv);
  } catch (error) {
    Zotero.debug('[zoteroaichat] self-test failed: ' + error.message);
  }
}
