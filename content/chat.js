// Chat view. Registers with the sidebar that owns this frame, which then calls
// `window.render(conversation, paperTexts)`; `host` carries the actions back.
const $ = id => document.getElementById(id);
const input = $('input');
const send = $('send');
const messages = $('messages');
const menu = $('menu');
const modelButton = $('model-button');
let busy = false;
let hasQuote = false;

const ICONS = {
  copy: '<rect x="5.5" y="5.5" width="7" height="7" rx="1.5"/><path d="M10.5 5.5V4.5A1 1 0 0 0 9.5 3.5h-5a1 1 0 0 0-1 1v5a1 1 0 0 0 1 1h1"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  note: '<path d="M4.5 2.5h5l2.5 2.5v8.5h-7.5z"/><path d="M6.5 7.5h3.5M6.5 10h3.5"/>',
  retry: '<path d="M12.8 6.5A5 5 0 1 0 13 9.2"/><path d="M13 3v3.5H9.5"/>',
  edit: '<path d="M10.5 3.5l2 2-6.5 6.5H4v-2z"/><path d="M9 5l2 2"/>',
  doc: '<path d="M4.5 2.5h5l2.5 2.5v8.5h-7.5z"/><path d="M9.5 2.5V5H12"/>',
  close: '<path d="M5 5l6 6M11 5l-6 6"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>'
};
const icon = (name, className = '') => `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
const EFFORTS = {
  minimal: ['极低', '几乎不推理，最快'],
  low: ['低', '响应快，推理较轻'],
  medium: ['中', '速度与推理深度兼顾'],
  high: ['高', '更深入的推理，适合复杂问题'],
  xhigh: ['超高', '非常深入的推理'],
  max: ['极高', '最大推理深度，适合最难的问题'],
  ultra: ['极限', '最大推理深度，并自动分派子任务']
};

function locateFrom(node) {
  const page = Number(node.dataset.page);
  if (!page) return;
  window.host?.locate({
    page,
    text: node.dataset.quote || '',
    position: node.dataset.position ? JSON.parse(node.dataset.position) : null,
    paper: node.dataset.paper || null
  });
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  send.disabled = !busy && !hasQuote && !input.value.trim();
}

// Sends the input, or a quick prompt given as `text`, which leaves a half-typed input alone.
function submit(text = input.value) {
  if (busy) { window.host?.stop(); return; }
  if (!text.trim() && !hasQuote) return;
  if (text === input.value) {
    input.value = '';
    autosize();
  }
  window.host?.send(text);
}

function quoteBlock(quote) {
  const block = element('blockquote', 'quote-text', quote.text);
  if (quote.page) block.prepend(pageLink(`p.${quote.page}`, quote.page, quote));
  return block;
}

function actionButton(iconName, label, title, onClick) {
  const button = element('button');
  button.innerHTML = `${icon(iconName)}<span>${label}</span>`;
  button.title = title;
  button.addEventListener('click', () => onClick(button));
  return button;
}

// Swap the question text for an inline editor; sending re-asks it on a fresh thread.
function startEdit(node, message) {
  const text = node.querySelector('.bubble > .text');
  const box = element('textarea', 'edit-box');
  box.value = message.text;
  const cancel = element('button', '', '取消');
  const save = element('button', 'primary-action', '发送');
  const actions = element('div', 'edit-actions');
  actions.append(cancel, save);
  const finish = () => { renderedMessages.delete(message); window.render(lastConv, lastPaperTexts); };
  cancel.addEventListener('click', finish);
  save.addEventListener('click', () => window.host?.rerun(box.value));
  box.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); save.click(); }
    else if (event.key === 'Escape') { event.preventDefault(); finish(); }
  });
  text.replaceWith(box, actions);
  node.classList.add('editing');
  node.querySelector(':scope > .actions')?.remove();
  box.style.height = Math.min(box.scrollHeight, 220) + 'px';
  box.focus();
  box.setSelectionRange(box.value.length, box.value.length);
}

// `last` marks the final question/answer pair, which can be edited or regenerated when idle.
function messageNode(message, index, last) {
  const node = element('div', `msg ${message.role}${message.pending ? ' pending' : ''}`);
  const content = message.role === 'user' ? element('div', 'bubble') : node;
  if (content !== node) node.append(content);
  if (message.images?.length) {
    const grid = element('div', message.images.length === 1 ? 'msg-images single' : 'msg-images');
    for (const item of message.images) {
      const image = element('img', 'msg-image');
      image.src = item.url;
      image.alt = '框选的截图';
      image.title = item.page ? `跳到第 ${item.page} 页` : '';
      image.dataset.page = item.page || '';
      image.addEventListener('click', () => locateFrom(image));
      grid.append(image);
    }
    content.append(grid);
  }
  if (message.papers?.length) {
    const list = element('div', 'msg-papers');
    for (const paper of message.papers) {
      const chip = element('span', 'paper-chip');
      chip.innerHTML = icon('doc');
      chip.append(element('span', 'title', paper.title));
      chip.title = `打开《${paper.title}》`;
      chip.dataset.page = '1';
      chip.dataset.paper = `${paper.libraryID}/${paper.attachmentKey}`;
      chip.addEventListener('click', () => locateFrom(chip));
      list.append(chip);
    }
    content.append(list);
  }
  if (message.quote) content.append(quoteBlock(message.quote));
  if (message.role === 'assistant') {
    if (message.text) {
      const body = element('div', 'markdown');
      body.innerHTML = renderMarkdown(message.text);
      linkPages(body);
      node.append(body);
    } else if (message.pending) {
      node.append(element('span', 'thinking', '思考中…'));
    }
    const actions = element('div', 'actions');
    if (!message.pending && message.text) {
      actions.append(actionButton('copy', '复制', '复制回答', button => {
        navigator.clipboard.writeText(message.text);
        button.innerHTML = `${icon('check')}<span>已复制</span>`;
        setTimeout(() => { button.innerHTML = `${icon('copy')}<span>复制</span>`; }, 1200);
      }));
      actions.append(actionButton('note', message.note ? '查看笔记' : '存为笔记',
        message.note ? '在新窗口打开这条笔记' : '把这轮问答存为这篇论文的子笔记', button => {
          if (message.note) { window.host?.openNote(index); return; }
          // On success this node is replaced; on failure the button must come back.
          button.disabled = true;
          const stamp = new Date().toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
          Promise.resolve(window.host?.saveNote(index, buildNote(lastConv, index, currentModel()?.name || picker.model, stamp)))
            .finally(() => { button.disabled = false; });
        }));
    }
    if (last && !message.pending) actions.append(actionButton('retry', '重新生成', '用同一个问题重新回答', () => window.host?.rerun()));
    if (actions.children.length) node.append(actions);
  } else {
    content.append(element('span', 'text', message.text));
    if (last) {
      const actions = element('div', 'actions');
      actions.append(actionButton('edit', '编辑', '修改这个问题后重新发送', () => startEdit(node, message)));
      node.append(actions);
    }
  }
  if (message.error) {
    const error = element('span', message.error === '已停止' ? 'error stopped' : 'error', message.error);
    node.insertBefore(error, node.querySelector('.actions'));
  }
  return node;
}

// Short status items under the title: how much of the paper the model has, and how full the
// context was on the last request (an estimate of the paper's size before the first one).
function statusChips(conv, paperTexts) {
  const chip = (text, kind = '', title = '') => {
    const node = element('span', `chip ${kind}`.trim(), text);
    if (title) node.title = title;
    return node;
  };
  const tokens = n => n >= 1000 ? `${Math.round(n / 1000)}k` : String(n);
  const { state, pages, readPages } = conv.status || {};
  const chips = [];
  if (state === 'loading') chips.push(chip('读取全文…', 'loading'));
  else if (state === 'full') chips.push(chip(`${pages} 页`, '', 'AI 已读取全文'));
  else if (state === 'truncated') chips.push(chip(`已读 ${readPages}/${pages} 页`, 'warn', '论文太长，后面的页没有放进上下文'));
  else if (state === 'scanned') chips.push(chip('无可提取文字', 'warn', '可能是扫描件，AI 只能看到题录信息'));
  else if (state === 'failed') chips.push(chip('全文读取失败', 'warn', 'AI 只能看到题录信息'));
  if (conv.usage?.window) {
    const percent = Math.round(conv.usage.used / conv.usage.window * 100);
    chips.push(chip(`上下文 ${percent}%`, percent >= 80 ? 'warn' : '',
      `上一次请求约用了 ${tokens(conv.usage.used)} / ${tokens(conv.usage.window)} tokens${percent >= 80 ? '，快满了，可以开新对话' : ''}`));
  } else if (conv.paperTokens && state !== 'loading') {
    chips.push(chip(`约 ${tokens(conv.paperTokens)} tokens`, '', '论文放进上下文后的估计大小'));
  }
  const papers = new Map((conv.messages || []).flatMap(m => (m.papers || []).map(p => [`${p.libraryID}/${p.attachmentKey}`, p.title])));
  if (papers.size) {
    let warn = false;
    const lines = [];
    for (const [id, title] of papers) {
      const { state, pages, readPages } = paperTexts.get(id)?.status || {};
      const detail = {
        full: `已读取全文（${pages} 页）`,
        truncated: `正文截断（读至第 ${readPages}/${pages} 页）`,
        scanned: '无可提取文字，仅题录',
        failed: '正文读取失败，仅题录'
      }[state] || '正文尚未载入';
      if (state && state !== 'full') warn = true;
      lines.push(`${title} · ${detail}`);
    }
    chips.push(chip(`+${papers.size} 篇论文`, warn ? 'warn' : '', lines.join('\n')));
  }
  return chips;
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
}

let lastConv = null;
let lastPaperTexts = null;
const renderedMessages = new WeakMap();
const restoredDrafts = new WeakSet();

window.render = (conv, paperTexts = new Map()) => {
  if (lastConv && lastConv.itemID !== conv.itemID) { closePaperMenu(); closeHistory(); }
  lastConv = conv;
  lastPaperTexts = paperTexts;
  $('title').textContent = conv.title;
  $('title').title = conv.title;
  $('status').replaceChildren(...statusChips(conv, paperTexts));
  busy = conv.busy;
  send.classList.toggle('stop', busy);
  send.title = busy ? '停止生成' : '发送';
  send.setAttribute('aria-label', send.title);
  historyButton.hidden = !conv.archived?.length;
  if (!historyMenu.hidden && (historyShown.archived !== conv.archived || historyShown.busy !== busy)) renderHistory();

  const images = conv.images || [];
  $('image-card').hidden = !images.length;
  $('image-card').replaceChildren(...images.map((item, i) => {
    const thumb = element('div', 'thumb');
    const image = element('img');
    image.src = item.url;
    image.alt = '框选的截图';
    image.title = item.page ? `跳到第 ${item.page} 页` : '';
    image.dataset.page = item.page || '';
    image.addEventListener('click', () => locateFrom(image));
    thumb.append(image);
    if (item.page) thumb.append(element('span', 'page', `p.${item.page}`));
    const remove = element('button', 'remove');
    remove.title = '移除这张截图';
    remove.setAttribute('aria-label', remove.title);
    remove.innerHTML = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M5 5l6 6M11 5l-6 6"/></svg>';
    remove.addEventListener('click', () => window.host?.clearImage(i));
    thumb.append(remove);
    return thumb;
  }));
  $('input-error').hidden = !conv.inputError;
  $('input-error').textContent = conv.inputError || '';
  // A question that was not sent comes back once, unless the user has typed something since.
  if (conv.draft && !restoredDrafts.has(conv.draft)) {
    restoredDrafts.add(conv.draft);
    if (!input.value.trim()) input.value = conv.draft.text;
  }

  const papers = conv.papers || [];
  $('paper-card').hidden = !papers.length;
  $('paper-card').replaceChildren(...papers.map((paper, i) => {
    const chip = element('span', 'paper-chip');
    chip.innerHTML = icon('doc');
    chip.append(element('span', 'title', paper.title));
    chip.title = [paper.title, paper.meta].filter(Boolean).join(' · ');
    const remove = element('button', 'icon small');
    remove.title = '移除这篇论文';
    remove.setAttribute('aria-label', remove.title);
    remove.innerHTML = icon('close');
    remove.addEventListener('click', () => window.host?.removePaper(i));
    chip.append(remove);
    return chip;
  }));
  hasQuote = !!conv.quote || images.length > 0 || papers.length > 0;
  $('quote').hidden = !conv.quote;
  if (conv.quote) {
    $('quote-page').textContent = conv.quote.page ? `引用 · 第 ${conv.quote.page} 页` : '引用';
    const label = $('quote-page');
    label.dataset.page = conv.quote.page || '';
    label.dataset.quote = conv.quote.text;
    label.dataset.position = conv.quote.position ? JSON.stringify(conv.quote.position) : '';
    $('quote-body').replaceChildren(element('div', 'quote-text', conv.quote.text));
  }
  input.placeholder = papers.length && !images.length && !conv.quote ? '结合附加的论文提问…'
    : images.length > 1 ? `针对这 ${images.length} 张图提问，直接发送即比较解释`
    : images.length ? '针对这张图提问，直接发送即解释'
    : conv.quote ? '针对这段文字提问，直接发送即解释' : '问问这篇论文…';

  const stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
  if (!conv.messages.length) {
    const empty = element('div', 'empty');
    const title = element('h2', 'greeting', greeting());
    const list = element('div', 'suggestions');
    for (const text of (window.host?.prompts() || []).slice(0, 3)) {
      const chip = element('button', 'suggestion', text);
      chip.addEventListener('click', () => submit(text));
      list.append(chip);
    }
    empty.append(title, element('p', '', conv.noticeLevel === 'warn'
      ? 'AI 只能看到题录信息。也可以在 PDF 中选中文字，点「问 AI」引用它。'
      : 'AI 会结合整篇论文回答。也可以在 PDF 中选中文字，点「问 AI」引用它。'), list);
    messages.replaceChildren(empty);
  } else {
    // Rebuild only messages whose visible content changed — while streaming that is just
    // the reply being written — and patch the list in place so other nodes stay put.
    const lastUser = conv.messages.map(m => m.role).lastIndexOf('user');
    const nodes = conv.messages.map((message, i) => {
      const last = !conv.busy && i >= lastUser;
      const signature = JSON.stringify([i, last, message.text, message.pending, message.error, message.note, message.quote, message.images, message.papers]);
      const cached = renderedMessages.get(message);
      if (cached?.signature === signature) return cached.node;
      const node = messageNode(message, i, last);
      renderedMessages.set(message, { signature, node });
      return node;
    });
    messages.querySelector(':scope > .empty')?.remove();
    nodes.forEach((node, i) => {
      const current = messages.children[i];
      if (current !== node) current ? messages.replaceChild(node, current) : messages.append(node);
    });
    while (messages.children.length > nodes.length) messages.lastElementChild.remove();
  }
  if (stick) messages.scrollTop = messages.scrollHeight;
  autosize();
};

window.focusInput = () => input.focus();

// Quick prompts and the model and effort pickers: buttons in the input bar, each opening the
// shared menu card above it.

const effortButton = $('effort-button');
const menuButtons = { prompts: $('prompts-button'), model: modelButton, effort: effortButton };
const picker = { models: [], model: '', effort: '', open: null };
const effortLabel = effort => EFFORTS[effort]?.[0] || effort;

function currentModel() {
  return picker.models.find(m => m.id === picker.model);
}

function updatePickerButtons() {
  modelButton.textContent = currentModel()?.name || picker.model || '模型';
  effortButton.textContent = picker.effort ? effortLabel(picker.effort) : '';
  modelButton.hidden = !picker.models.length;
  effortButton.hidden = !picker.models.length || !currentModel()?.efforts.length;
}

function choose(model, effort) {
  picker.model = model;
  const supported = currentModel()?.efforts || [];
  picker.effort = supported.includes(effort) ? effort : (currentModel()?.defaultEffort || effort);
  window.host?.setModel(picker.model, picker.effort);
  updatePickerButtons();
  closeMenu();
}

function menuItem({ name, tag, key, checked, onClick }) {
  const item = element('button', 'menu-item');
  item.setAttribute('role', 'menuitemradio');
  item.setAttribute('aria-checked', String(!!checked));
  const label = element('span', 'name', name);
  if (tag) label.append(element('span', 'tag', tag));
  item.append(label);
  if (checked) item.insertAdjacentHTML('beforeend', icon('check', 'check'));
  else if (key) item.append(element('span', 'key', key));
  item.addEventListener('click', event => { event.stopPropagation(); onClick(); });
  return item;
}

function openMenu(kind) {
  closePaperMenu();
  const button = menuButtons[kind];
  const list = element('div', 'menu-list');
  if (kind === 'prompts') {
    // Each prompt can be removed (except the last one, since an empty list means the
    // built-in prompts), and new ones are typed into the row under the list and go first.
    const prompts = window.host?.prompts() || [];
    const save = next => { window.host?.setPrompts(next); openMenu('prompts'); };
    list.append(...prompts.map((text, i) => {
      const item = menuItem({ name: text, onClick: () => { closeMenu(); if (!busy) submit(text); } });
      item.setAttribute('role', 'menuitem');
      item.removeAttribute('aria-checked');
      const row = element('div', 'prompt-entry');
      row.append(item);
      if (prompts.length > 1) {
        const remove = element('button', 'icon small delete');
        remove.innerHTML = icon('close');
        remove.title = '移除';
        remove.setAttribute('aria-label', '移除这条快捷提问');
        remove.addEventListener('click', event => { event.stopPropagation(); save(prompts.filter((_, j) => j !== i)); });
        row.append(remove);
      }
      return row;
    }));
    const add = element('label', 'prompt-add');
    add.innerHTML = icon('plus');
    const field = element('input');
    field.placeholder = '添加快捷提问，回车保存';
    add.append(field);
    add.addEventListener('click', event => event.stopPropagation());
    field.addEventListener('keydown', event => {
      if (event.key !== 'Enter' || event.isComposing) return;
      event.preventDefault();
      const text = field.value.replace(/\s+/g, ' ').trim();
      if (!text) return;
      save([text, ...prompts.filter(p => p !== text)]);
      menu.querySelector('.prompt-add input')?.focus();
    });
    menu.replaceChildren(element('div', 'menu-label', '快捷提问'), list, add);
  } else if (kind === 'model') {
    list.append(...picker.models.map((model, i) => menuItem({
      name: model.name, key: i < 9 ? String(i + 1) : '', checked: model.id === picker.model,
      onClick: () => choose(model.id, picker.effort)
    })));
    menu.replaceChildren(element('div', 'menu-label', '模型'), list);
  } else {
    const model = currentModel();
    list.append(...model.efforts.map(effort => menuItem({
      name: effortLabel(effort), tag: effort === model.defaultEffort ? '推荐' : '', checked: effort === picker.effort,
      onClick: () => choose(picker.model, effort)
    })));
    menu.replaceChildren(element('div', 'menu-intro', '思考强度越高，回答越深入，但耗时更长，也会更快消耗额度。'), list);
  }
  picker.open = kind;
  menu.classList.toggle('prompts', kind === 'prompts');
  menu.hidden = false;
  for (const [name, other] of Object.entries(menuButtons)) other.setAttribute('aria-expanded', String(name === kind));
  // Align the card with its button (left edge for the prompts button on the left, right
  // edge for the pickers on the right), kept inside the composer.
  const composerWidth = menu.offsetParent.clientWidth;
  const left = kind === 'prompts' ? button.offsetLeft : button.offsetLeft + button.offsetWidth - menu.offsetWidth;
  menu.style.left = Math.max(0, Math.min(left, composerWidth - menu.offsetWidth)) + 'px';
  const selected = list.querySelector('[aria-checked="true"]') || list.querySelector('.menu-item');
  selected?.scrollIntoView({ block: 'nearest' });
  selected?.focus();
}

function closeMenu() {
  picker.open = null;
  menu.hidden = true;
  for (const button of Object.values(menuButtons)) button.setAttribute('aria-expanded', 'false');
}

async function loadModels() {
  try {
    Object.assign(picker, await window.host.models());
    updatePickerButtons();
  } catch (error) {
    window.host?.logError(error);
  }
}

for (const [kind, button] of Object.entries(menuButtons)) {
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (picker.open === kind) closeMenu(); else openMenu(kind);
  });
}
document.addEventListener('click', event => {
  if (!menu.hidden && !menu.contains(event.target)) closeMenu();
  if (!paperMenu.hidden && !paperMenu.contains(event.target) && event.target.closest('#add-paper') !== addPaperButton) closePaperMenu();
});
document.addEventListener('keydown', event => {
  if (menu.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    const button = menuButtons[picker.open];
    closeMenu();
    button.focus();
  } else if (picker.open === 'model' && /^[1-9]$/.test(event.key)) {
    const model = picker.models[Number(event.key) - 1];
    if (model) { event.preventDefault(); choose(model.id, picker.effort); }
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const items = [...menu.querySelectorAll('.menu-item')];
    const next = items[(items.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    event.preventDefault();
    next?.focus();
  }
});

// Paper picker: search the library and add papers to the next message ----------

const paperMenu = $('paper-menu');
const paperSearch = $('paper-search');
const paperResults = $('paper-results');
const addPaperButton = $('add-paper');
let paperQuery = 0;
let paperTimer = null;

async function refreshPapers() {
  const query = paperSearch.value;
  const ticket = ++paperQuery;
  let groups;
  try { groups = await window.host.searchPapers(query); }
  catch (error) {
    window.host?.logError(error);
    if (ticket === paperQuery) {
      paperResults.replaceChildren(element('div', 'empty-note', '暂时无法搜索文库，请重新打开菜单再试。'));
    }
    return;
  }
  if (ticket !== paperQuery) return;
  const added = new Set((lastConv?.papers || []).map(p => `${p.libraryID}/${p.key}`));
  const nodes = [];
  for (const group of groups) {
    const papers = group.papers.filter(p => !added.has(`${p.libraryID}/${p.key}`));
    if (!papers.length) continue;
    nodes.push(element('div', 'menu-label', group.label));
    for (const paper of papers) {
      const option = element('button', 'paper-option');
      option.setAttribute('role', 'option');
      option.innerHTML = icon('doc');
      const text = element('span', 'text');
      text.append(element('span', 'title', paper.title));
      if (paper.meta) text.append(element('span', 'meta', paper.meta));
      option.append(text);
      option.title = paper.title;
      option.addEventListener('click', event => {
        event.stopPropagation();
        window.host?.addPaper(paper);
        closePaperMenu();
        input.focus();
      });
      nodes.push(option);
    }
  }
  if (!nodes.length) nodes.push(element('div', 'empty-note', query.trim() ? '没有找到带 PDF 的论文' : '文库里还没有其他带 PDF 的论文'));
  paperResults.replaceChildren(...nodes);
  paperResults.querySelector('.paper-option')?.classList.add('active');
}

function openPaperMenu() {
  closeMenu();
  paperSearch.value = '';
  paperResults.replaceChildren(element('div', 'empty-note', '正在读取文库…'));
  paperMenu.hidden = false;
  addPaperButton.setAttribute('aria-expanded', 'true');
  paperSearch.focus();
  refreshPapers();
}

function closePaperMenu() {
  paperMenu.hidden = true;
  addPaperButton.setAttribute('aria-expanded', 'false');
  paperQuery++;
  clearTimeout(paperTimer);
}

addPaperButton.addEventListener('click', event => {
  event.stopPropagation();
  if (paperMenu.hidden) openPaperMenu(); else closePaperMenu();
});
paperSearch.addEventListener('input', () => {
  paperQuery++;
  clearTimeout(paperTimer);
  paperResults.replaceChildren(element('div', 'empty-note', '正在搜索…'));
  paperTimer = setTimeout(refreshPapers, 150);
});
paperMenu.addEventListener('keydown', event => {
  const options = [...paperResults.querySelectorAll('.paper-option')];
  const current = options.findIndex(o => o.classList.contains('active'));
  if (event.key === 'Escape') {
    event.preventDefault();
    event.stopPropagation();
    closePaperMenu();
    addPaperButton.focus();
  } else if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && options.length) {
    event.preventDefault();
    const next = (current + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
    options[current]?.classList.remove('active');
    options[next].classList.add('active');
    options[next].scrollIntoView({ block: 'nearest' });
  } else if (event.key === 'Enter' && !event.isComposing && current >= 0) {
    event.preventDefault();
    options[current].click();
  }
});

// Wiring ----------------------------------------------------------------------

input.addEventListener('input', autosize);
input.addEventListener('keydown', event => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});
send.addEventListener('click', () => submit());
messages.addEventListener('click', event => {
  const link = event.target.closest('a');
  if (!link) return;
  event.preventDefault();
  if (link.dataset.page) locateFrom(link);
  else if (link.hasAttribute('data-external')) window.host?.openURL(link.href);
});
$('quote-clear').addEventListener('click', () => window.host?.clearQuote());
$('quote-page').addEventListener('click', event => locateFrom(event.currentTarget));
$('capture').addEventListener('click', () => window.host?.capture());
for (const button of document.querySelectorAll('[data-prompt]'))
  button.addEventListener('click', () => submit(button.dataset.prompt));
$('reset').addEventListener('click', () => window.host?.reset());

// History: this paper's earlier conversations, newest first ---------------------

const historyButton = $('history');
const historyMenu = $('history-menu');
const historyShown = { archived: null, busy: false };

function historyTime(time) {
  const date = new Date(time);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return `今天 ${date.toTimeString().slice(0, 5)}`;
  const day = `${date.getMonth() + 1}月${date.getDate()}日`;
  return date.getFullYear() === now.getFullYear() ? day : `${date.getFullYear()}年${day}`;
}

function renderHistory() {
  const entries = lastConv?.archived || [];
  Object.assign(historyShown, { archived: lastConv?.archived, busy });
  if (!entries.length) { closeHistory(); return; }
  const list = element('div', 'menu-list');
  for (const entry of entries) {
    const row = element('div', 'history-entry');
    const open = element('button', 'open');
    open.setAttribute('role', 'menuitem');
    const question = entry.messages.find(m => m.role === 'user')?.text || '（空对话）';
    const rounds = entry.messages.filter(m => m.role === 'user').length;
    open.append(element('span', 'title', question), element('span', 'meta', `${historyTime(entry.updated || entry.created)} · ${rounds} 轮`));
    open.title = question;
    open.disabled = busy;
    open.addEventListener('click', event => {
      event.stopPropagation();
      closeHistory();
      window.host?.openArchived(entry.id);
    });
    // Deleting is permanent, so the first click only asks.
    const remove = element('button', 'icon small delete');
    remove.innerHTML = icon('close');
    remove.title = '删除这段对话';
    remove.setAttribute('aria-label', remove.title);
    remove.addEventListener('click', event => {
      event.stopPropagation();
      if (remove.classList.contains('confirm')) { window.host?.deleteArchived(entry.id); return; }
      remove.classList.add('confirm');
      remove.textContent = '删除';
      remove.title = '再点一次永久删除这段对话和其中的截图';
    });
    row.append(open, remove);
    list.append(row);
  }
  historyMenu.replaceChildren(element('div', 'menu-label', busy ? '回答生成中，完成后才能切换' : '这篇论文的历史对话'), list);
}

function openHistory() {
  if (!lastConv?.archived?.length) return;
  closeMenu();
  closePaperMenu();
  renderHistory();
  historyMenu.hidden = false;
  historyButton.setAttribute('aria-expanded', 'true');
  historyMenu.querySelector('.open:not(:disabled)')?.focus();
}

// The list is rebuilt on every open, so it is cleared here and can never show another paper's.
function closeHistory() {
  historyMenu.replaceChildren();
  historyMenu.hidden = true;
  historyButton.setAttribute('aria-expanded', 'false');
}

historyButton.addEventListener('click', event => {
  event.stopPropagation();
  if (historyMenu.hidden) openHistory(); else closeHistory();
});
document.addEventListener('click', event => {
  if (!historyMenu.hidden && !historyMenu.contains(event.target)) closeHistory();
});
document.addEventListener('keydown', event => {
  if (historyMenu.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    closeHistory();
    historyButton.focus();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    const items = [...historyMenu.querySelectorAll('.open:not(:disabled)')];
    const next = items[(items.indexOf(document.activeElement) + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
    event.preventDefault();
    next?.focus();
  }
});
$('settings').addEventListener('click', () => window.host?.openSettings());
$('close').addEventListener('click', () => window.host?.close());
window.addEventListener('error', event => window.host?.logError(event.error || event.message));
autosize();
window.host = window.frameElement?.aiChatSidebar?.attach(window) || window.host;
if (window.host) loadModels();
