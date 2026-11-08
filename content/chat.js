// Chat view. Registers with the sidebar that owns this frame, which then calls
// `window.render(conversation)`; `host` carries the actions back.
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
  note: '<path d="M4.5 2.5h5l2.5 2.5v8.5h-7.5z"/><path d="M6.5 7.5h3.5M6.5 10h3.5"/>'
};
const icon = (name, className = '') => `<svg class="${className}" viewBox="0 0 16 16" aria-hidden="true">${ICONS[name]}</svg>`;
const SUGGESTIONS = ['总结这篇论文的问题、方法和结论', '这篇论文的主要贡献是什么？', '这篇论文有哪些局限？'];
const EFFORTS = {
  minimal: ['极低', '几乎不推理，最快'],
  low: ['低', '响应快，推理较轻'],
  medium: ['中', '速度与推理深度兼顾'],
  high: ['高', '更深入的推理，适合复杂问题'],
  xhigh: ['超高', '非常深入的推理'],
  max: ['极高', '最大推理深度，适合最难的问题'],
  ultra: ['极限', '最大推理深度，并自动分派子任务']
};

// This page runs with chrome privileges, so model output must never become live markup:
// raw HTML is escaped, only http(s) links survive (opened in the system browser), and
// images are reduced to their alt text.
const escapeHTML = text => text.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const markdown = new marked.Marked({ gfm: true, breaks: true });
markdown.use({
  renderer: {
    html: ({ text }) => escapeHTML(text),
    image: ({ text, href }) => escapeHTML(text || href || ''),
    link({ href, title, tokens }) {
      const label = this.parser.parseInline(tokens);
      // Citations arrive as [(p. 3)](page:3 "verbatim phrase from that page").
      const page = /^page:(\d{1,4})$/i.exec(href || '')?.[1];
      if (page) return `<a href="#" class="page-ref" data-page="${page}" data-quote="${escapeHTML(title || '')}" title="跳到第 ${page} 页">${label}</a>`;
      return /^https?:\/\//i.test(href) ? `<a href="${escapeHTML(href)}" data-external="">${label}</a>` : label;
    }
  }
});

// Pull math out before Markdown sees it (so `_` and `*` inside formulas survive),
// skipping code spans and fenced blocks. Returns the text with @@MATHn@@ placeholders.
function extractMath(source) {
  const math = [];
  const stash = (tex, display) => `@@MATH${math.push({ tex, display }) - 1}@@`;
  const prepared = source.split(/(```[\s\S]*?(?:```|$)|`[^`\n]+`)/).map((part, i) => i % 2 ? part : part
    .replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (_, a, b) => stash(a ?? b, true))
    .replace(/\\\((.+?)\\\)|(?<![\\$\w])\$(?![\s$])([^$\n]+?)(?<!\s)\$(?![\w$])/g, (_, a, b) => stash(a ?? b, false))
  ).join('');
  return { prepared, math };
}

function renderMarkdown(source) {
  const { prepared, math } = extractMath(source);
  return markdown.parse(prepared).replace(/@@MATH(\d+)@@/g, (_, i) =>
    katex.renderToString(math[i].tex, { displayMode: math[i].display, throwOnError: false, output: 'html' }));
}

// The same reply as Zotero note HTML: math as the note editor's math nodes, citations as
// page:N links (the plugin turns those into zotero://open-pdf links), raw HTML escaped.
const noteMarkdown = new marked.Marked({ gfm: true, breaks: true });
noteMarkdown.use({
  renderer: {
    html: ({ text }) => escapeHTML(text),
    image: ({ text, href }) => escapeHTML(text || href || ''),
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      const page = /^page:(\d{1,4})$/i.exec(href || '')?.[1];
      if (page) return `<a href="page:${page}">${label}</a>`;
      return /^https?:\/\//i.test(href) ? `<a href="${escapeHTML(href)}">${label}</a>` : label;
    }
  }
});

function noteMarkdownHTML(source) {
  const { prepared, math } = extractMath(source);
  const mathNode = i => math[i].display
    ? `<pre class="math">$$${escapeHTML(math[i].tex)}$$</pre>`
    : `<span class="math">$${escapeHTML(math[i].tex)}$</span>`;
  const box = document.createElement('div');
  box.innerHTML = noteMarkdown.parse(prepared)
    .replace(/<p>@@MATH(\d+)@@<\/p>/g, (match, i) => math[i].display ? mathNode(i) : match)
    .replace(/@@MATH(\d+)@@/g, (_, i) => mathNode(i));
  linkPages(box);
  for (const link of box.querySelectorAll('a.page-ref')) {
    const plain = document.createElement('a');
    plain.href = `page:${link.dataset.page}`;
    plain.textContent = link.textContent;
    link.replaceWith(plain);
  }
  return box.innerHTML;
}

function buildNote(conv, index) {
  const answer = conv.messages[index];
  const question = conv.messages.slice(0, index).reverse().find(m => m.role === 'user');
  const parts = [`<h1>${escapeHTML(question?.text || conv.title)}</h1>`];
  if (question?.quote) {
    parts.push(`<blockquote><p>${escapeHTML(question.quote.text)}</p></blockquote>`);
    if (question.quote.page) parts.push(`<p><a href="page:${question.quote.page}">p. ${question.quote.page}</a></p>`);
  }
  parts.push(noteMarkdownHTML(answer.text));
  const stamp = new Date().toLocaleString('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
  parts.push(`<p>— Ask GPT · ${escapeHTML(currentModel()?.name || picker.model || '')} · ${escapeHTML(stamp)}</p>`);
  return parts.join('\n');
}

// Page citations in replies — (p. 3), p.3, (pp. 23–25), 第 3 页, 第 23–25 页 — become
// links that jump the reader to that PDF page. Pages match the [p.N] markers in the
// paper context; a range jumps to its first page.
const PAGE_REF = /\bpp?\.\s?(\d{1,4})(?:\s?[–—-]\s?\d{1,4})?|第\s?(\d{1,4})(?:\s?[–—-]\s?\d{1,4})?\s?页/g;

function pageLink(text, page, quote) {
  const link = element('a', 'page-ref', text);
  link.href = '#';
  link.dataset.page = page;
  if (quote) {
    link.dataset.quote = quote.text;
    if (quote.position) link.dataset.position = JSON.stringify(quote.position);
  }
  link.title = `跳到第 ${page} 页`;
  return link;
}

function locateFrom(node) {
  const page = Number(node.dataset.page);
  if (!page) return;
  window.host?.locate({
    page,
    text: node.dataset.quote || '',
    position: node.dataset.position ? JSON.parse(node.dataset.position) : null
  });
}

function linkPages(root) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: node => node.parentElement.closest('code, pre, a, .katex, .math') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT
  });
  const nodes = [];
  // search() ignores lastIndex; matchAll gets a fresh copy so no state carries between nodes.
  while (walker.nextNode()) if (walker.currentNode.data.search(PAGE_REF) >= 0) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parts = [];
    let last = 0;
    for (const match of node.data.matchAll(new RegExp(PAGE_REF))) {
      parts.push(node.data.slice(last, match.index), pageLink(match[0], match[1] || match[2]));
      last = match.index + match[0].length;
    }
    parts.push(node.data.slice(last));
    node.replaceWith(...parts.filter(part => part !== ''));
  }
}

function autosize() {
  input.style.height = 'auto';
  input.style.height = Math.min(input.scrollHeight, 220) + 'px';
  send.disabled = !busy && !hasQuote && !input.value.trim();
}

function submit(text = input.value) {
  if (busy) { window.host?.stop(); return; }
  if (!text.trim() && !hasQuote) return;
  input.value = '';
  autosize();
  window.host?.send(text);
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function quoteBlock(quote) {
  const block = element('blockquote', 'quote-text', quote.text);
  if (quote.page) block.prepend(pageLink(`p.${quote.page}`, quote.page, quote));
  return block;
}

function messageNode(message, index) {
  const node = element('div', `msg ${message.role}${message.pending ? ' pending' : ''}`);
  if (message.quote) node.append(quoteBlock(message.quote));
  if (message.role === 'assistant') {
    if (message.text) {
      const body = element('div', 'markdown');
      body.innerHTML = renderMarkdown(message.text);
      linkPages(body);
      node.append(body);
    } else if (message.pending) {
      node.append(element('span', 'thinking', '思考中…'));
    }
    if (!message.pending && message.text) {
      const actions = element('div', 'actions');
      const copy = element('button');
      copy.innerHTML = `${icon('copy')}<span>复制</span>`;
      copy.addEventListener('click', () => {
        navigator.clipboard.writeText(message.text);
        copy.innerHTML = `${icon('check')}<span>已复制</span>`;
        setTimeout(() => { copy.innerHTML = `${icon('copy')}<span>复制</span>`; }, 1200);
      });
      const note = element('button');
      note.innerHTML = `${icon('note')}<span>${message.note ? '查看笔记' : '存为笔记'}</span>`;
      note.title = message.note ? '在新窗口打开这条笔记' : '把这轮问答存为这篇论文的子笔记';
      note.addEventListener('click', () => {
        if (message.note) window.host?.openNote(index);
        else {
          note.disabled = true;
          window.host?.saveNote(index, buildNote(lastConv, index));
        }
      });
      actions.append(copy, note);
      node.append(actions);
    }
  } else {
    node.append(element('span', 'text', message.text));
  }
  if (message.error) {
    const error = element('span', message.error === '已停止' ? 'error stopped' : 'error', message.error);
    node.insertBefore(error, node.querySelector('.actions'));
  }
  return node;
}

function greeting() {
  const hour = new Date().getHours();
  return hour < 5 ? '夜深了' : hour < 11 ? '早上好' : hour < 13 ? '中午好' : hour < 18 ? '下午好' : '晚上好';
}

let lastConv = null;

window.render = conv => {
  lastConv = conv;
  $('title').textContent = conv.title;
  $('title').title = conv.title;
  $('notice-text').textContent = conv.notice || '';
  if (conv.notice) $('notice').dataset.level = conv.noticeLevel || 'ok';
  else delete $('notice').dataset.level;
  busy = conv.busy;
  send.classList.toggle('stop', busy);
  send.title = busy ? '停止生成' : '发送';
  send.setAttribute('aria-label', send.title);

  hasQuote = !!conv.quote;
  $('quote').hidden = !hasQuote;
  if (hasQuote) {
    $('quote-page').textContent = conv.quote.page ? `引用 · 第 ${conv.quote.page} 页` : '引用';
    const label = $('quote-page');
    label.dataset.page = conv.quote.page || '';
    label.dataset.quote = conv.quote.text;
    label.dataset.position = conv.quote.position ? JSON.stringify(conv.quote.position) : '';
    $('quote-body').replaceChildren(element('div', 'quote-text', conv.quote.text));
  }
  input.placeholder = hasQuote ? '针对这段文字提问，直接发送即解释' : '问问这篇论文…';

  const stick = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
  if (!conv.messages.length) {
    const empty = element('div', 'empty');
    const title = element('h2', 'greeting', greeting());
    const list = element('div', 'suggestions');
    for (const text of SUGGESTIONS) {
      const chip = element('button', 'suggestion', text);
      chip.addEventListener('click', () => submit(text));
      list.append(chip);
    }
    empty.append(title, element('p', '', conv.noticeLevel === 'warn'
      ? 'AI 只能看到题录信息。也可以在 PDF 中选中文字，点「问 AI」引用它。'
      : 'AI 会结合整篇论文回答。也可以在 PDF 中选中文字，点「问 AI」引用它。'), list);
    messages.replaceChildren(empty);
  } else {
    messages.replaceChildren(...conv.messages.map((message, i) => messageNode(message, i)));
  }
  if (stick) messages.scrollTop = messages.scrollHeight;
  autosize();
};

window.focusInput = () => input.focus();

// Model and effort pickers: two buttons, each opening its own card above it.

const effortButton = $('effort-button');
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
  const button = kind === 'model' ? modelButton : effortButton;
  const list = element('div', 'menu-list');
  if (kind === 'model') {
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
  menu.hidden = false;
  modelButton.setAttribute('aria-expanded', String(kind === 'model'));
  effortButton.setAttribute('aria-expanded', String(kind === 'effort'));
  // Right-align the card with its button, kept inside the composer.
  const composerWidth = menu.offsetParent.clientWidth;
  const left = button.offsetLeft + button.offsetWidth - menu.offsetWidth;
  menu.style.left = Math.max(0, Math.min(left, composerWidth - menu.offsetWidth)) + 'px';
  const selected = list.querySelector('[aria-checked="true"]') || list.querySelector('.menu-item');
  selected?.scrollIntoView({ block: 'nearest' });
  selected?.focus();
}

function closeMenu() {
  picker.open = null;
  menu.hidden = true;
  modelButton.setAttribute('aria-expanded', 'false');
  effortButton.setAttribute('aria-expanded', 'false');
}

async function loadModels() {
  try {
    Object.assign(picker, await window.host.models());
    updatePickerButtons();
  } catch (error) {
    window.host?.logError(error);
  }
}

for (const [button, kind] of [[modelButton, 'model'], [effortButton, 'effort']]) {
  button.addEventListener('click', event => {
    event.stopPropagation();
    if (picker.open === kind) closeMenu(); else openMenu(kind);
  });
}
document.addEventListener('click', event => {
  if (!menu.hidden && !menu.contains(event.target)) closeMenu();
});
document.addEventListener('keydown', event => {
  if (menu.hidden) return;
  if (event.key === 'Escape') {
    event.preventDefault();
    const button = picker.open === 'model' ? modelButton : effortButton;
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
for (const button of document.querySelectorAll('[data-prompt]'))
  button.addEventListener('click', () => submit(button.dataset.prompt));
$('reset').addEventListener('click', () => window.host?.reset());
$('close').addEventListener('click', () => window.host?.close());
window.addEventListener('error', event => window.host?.logError(event.error || event.message));
autosize();
window.host = window.frameElement?.aiChatSidebar?.attach(window) || window.host;
if (window.host) loadModels();
