// Rendering helpers shared by the chat page (chat.html) and the browser tests
// (test/render.test.html). Expects the vendored `marked` and `katex` globals.

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

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

function buildNote(conv, index, modelName, stamp) {
  const answer = conv.messages[index];
  const question = conv.messages.slice(0, index).reverse().find(m => m.role === 'user');
  const parts = [`<h1>${escapeHTML(question?.text || conv.title)}</h1>`];
  for (const image of question?.images || []) {
    parts.push(`<p>[截图${image.page ? `：<a href="page:${image.page}">p. ${image.page}</a>` : ''}]</p>`);
  }
  if (question?.quote) {
    parts.push(`<blockquote><p>${escapeHTML(question.quote.text)}</p></blockquote>`);
    if (question.quote.page) parts.push(`<p><a href="page:${question.quote.page}">p. ${question.quote.page}</a></p>`);
  }
  parts.push(noteMarkdownHTML(answer.text));
  parts.push(`<p>— Ask GPT · ${escapeHTML(modelName || '')} · ${escapeHTML(stamp)}</p>`);
  return parts.join('\n');
}
