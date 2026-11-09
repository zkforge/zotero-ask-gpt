// Settings pane script. Zotero loads it in a sandbox before inserting prefs.xhtml, then
// dispatches `load` on the pane's top-level element; wire the controls up at that point.
// Plain fields are bound to prefs by their `preference` attribute. Zotero parses plugin
// panes as XUL, so XUL buttons report activation through `command`.
document.addEventListener('load', event => {
  const root = event.target;
  if (root.id !== 'zoteroaichat-prefs' || root.dataset.ready) return;
  root.dataset.ready = 'true';
  const addon = Zotero.AIChat;
  const $ = id => root.querySelector('#zoteroaichat-' + id);

  // Show what auto-detection would use as placeholders.
  addon.codex.findCommand().then(path => { $('codex-path').placeholder = path ? `自动检测：${path}` : '未找到 codex，请填写完整路径'; });
  addon.codex.systemProxy().then(proxy => { $('proxy').placeholder = proxy ? `跟随系统：${proxy}` : '跟随系统：直连'; });

  $('test').addEventListener('command', async () => {
    const status = $('test-status');
    status.className = 'status';
    status.textContent = '正在连接…';
    try {
      const { version, models } = await addon.testConnection();
      status.className = 'status ok';
      status.textContent = `已连接 · codex ${version} · ${models} 个模型可用`;
    } catch (error) {
      status.className = 'status error';
      status.textContent = error.message;
    }
  });

  // The prompt field shows the built-in default until edited; matching it clears the pref.
  const prompt = $('prompt');
  const defaultPrompt = addon.defaultInstructions();
  prompt.value = Zotero.Prefs.get('extensions.zoteroaichat.baseInstructions', true) || defaultPrompt;
  prompt.addEventListener('change', () => {
    const value = prompt.value.trim();
    Zotero.Prefs.set('extensions.zoteroaichat.baseInstructions', value && value !== defaultPrompt.trim() ? value : '', true);
  });
  $('prompt-reset').addEventListener('click', () => {
    prompt.value = defaultPrompt;
    Zotero.Prefs.set('extensions.zoteroaichat.baseInstructions', '', true);
  });

  // Same pattern for quick prompts: the built-in list is shown until edited.
  const prompts = $('prompts');
  const defaultPrompts = addon.defaultPrompts().join('\n');
  prompts.value = Zotero.Prefs.get('extensions.zoteroaichat.prompts', true) || defaultPrompts;
  prompts.addEventListener('change', () => {
    const value = prompts.value.split('\n').map(line => line.trim()).filter(Boolean).join('\n');
    Zotero.Prefs.set('extensions.zoteroaichat.prompts', value && value !== defaultPrompts ? value : '', true);
  });
  $('prompts-reset').addEventListener('click', () => {
    prompts.value = defaultPrompts;
    Zotero.Prefs.set('extensions.zoteroaichat.prompts', '', true);
  });

  const refreshUsage = async () => {
    const { dir, conversations, images, bytes } = await addon.storageUsage();
    $('data-path').textContent = dir;
    const size = bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`;
    $('data-usage').textContent = `${conversations} 个对话 · ${images} 张截图 · ${size}`;
  };
  refreshUsage();
  $('reveal').addEventListener('command', () => addon.revealData());
  $('clear').addEventListener('command', async () => {
    const ok = Services.prompt.confirm(window, '清除所有对话和截图',
      '将永久删除所有论文的 Ask GPT 对话记录和截图，无法恢复。已存为 Zotero 笔记的内容不受影响。确定继续吗？');
    if (!ok) return;
    await addon.clearAllData();
    refreshUsage();
  });
}, true);
