// Owns the single `codex app-server` child process shared by every chat.
var CodexService = class {
  constructor(version) {
    this.version = version;
    this.ready = null;
    this.proc = null;
    this.peer = null;
    this.threadListeners = new Map();
  }

  start() {
    if (!this.ready) this.ready = this.launch().catch(error => { this.ready = null; throw error; });
    return this.ready;
  }

  // The usual install locations; Zotero launched from the Dock has no shell PATH to search.
  async findCommand() {
    const home = Services.dirsvc.get('Home', Ci.nsIFile).path;
    for (const path of ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', PathUtils.join(home, '.local', 'bin', 'codex')])
      if (await IOUtils.exists(path)) return path;
    return null;
  }

  async launch() {
    const { Subprocess } = ChromeUtils.importESModule('resource://gre/modules/Subprocess.sys.mjs');
    const configured = Zotero.Prefs.get('extensions.zoteroaichat.codexPath', true)?.trim();
    if (configured && !(await IOUtils.exists(configured))) throw new Error(`设置里填写的 codex 路径不存在：${configured}`);
    const command = configured || await this.findCommand();
    if (!command) throw new Error('找不到 codex 命令。请先安装 Codex CLI，或在 Ask GPT 设置里填写 codex 路径。');

    // Zotero launched from the Dock has no shell PATH or proxy variables; codex is a
    // node script, so its own directory and Homebrew must be on PATH.
    const env = { PATH: [PathUtils.parent(command), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin'].join(':') };
    const proxy = Zotero.Prefs.get('extensions.zoteroaichat.proxy', true)?.trim() || await this.systemProxy();
    if (proxy) Object.assign(env, { HTTPS_PROXY: proxy, HTTP_PROXY: proxy, https_proxy: proxy, http_proxy: proxy });

    Zotero.debug(`[zoteroaichat] launching ${command} app-server, proxy=${proxy || 'none'}`);
    const workdir = PathUtils.join(Zotero.DataDirectory.dir, 'ai-chat');
    await IOUtils.makeDirectory(workdir, { ignoreExisting: true });
    const stderrLog = PathUtils.join(workdir, 'codex-stderr.log');
    await IOUtils.writeUTF8(stderrLog, '');
    // With stderr as a Subprocess pipe, codex is SIGKILLed ~50ms after launch with no
    // output; redirecting stderr to a file through sh avoids that and keeps the log.
    const proc = await Subprocess.call({
      command: '/bin/sh', arguments: ['-c', '"$0" "$@" 2>>"$ZOTEROAICHAT_STDERR"', command, 'app-server'],
      environment: { ...env, ZOTEROAICHAT_STDERR: stderrLog }, environmentAppend: true, workdir
    });
    const peer = new JsonRpcPeer(line => proc.stdin.write(line));
    peer.onNotification = message => this.threadListeners.get(message.params?.threadId)?.(message);
    this.proc = proc;
    this.peer = peer;

    (async () => {
      let chunk;
      try { while ((chunk = await proc.stdout.readString())) peer.feed(chunk); }
      catch (error) { Zotero.logError(error); }
      const { exitCode } = await proc.wait();
      const stderr = await IOUtils.readUTF8(stderrLog).catch(() => '');
      Zotero.debug(`[zoteroaichat] codex app-server exited with code ${exitCode}; stderr tail: ${stderr.slice(-2000)}`);
      if (this.peer === peer) { this.proc = null; this.peer = null; this.ready = null; }
      const detail = stderr.trim().split('\n').slice(-3).join('\n');
      const exited = new Error(`codex app-server 已退出（代码 ${exitCode}）` + (detail ? `：${detail}` : ''));
      peer.failAll(exited);
      for (const listener of this.threadListeners.values()) listener({ method: 'process/exited', params: { error: exited } });
    })();

    const init = await peer.request('initialize', { clientInfo: { name: 'zotero-ai-chat', title: 'Zotero AI Chat', version: this.version } });
    // userAgent looks like "zotero-ai-chat/0.167.0 (Mac OS …)"; the version is codex's.
    this.serverVersion = /\/(\d+\.\d+\.\d+)/.exec(init?.userAgent || '')?.[1] || '未知版本';
    peer.notify('initialized');
  }

  async systemProxy() {
    const pps = Cc['@mozilla.org/network/protocol-proxy-service;1'].getService(Ci.nsIProtocolProxyService);
    const info = await new Promise(resolve => pps.asyncResolve(Services.io.newURI('https://chatgpt.com/'), 0, {
      QueryInterface: ChromeUtils.generateQI(['nsIProtocolProxyCallback']),
      onProxyAvailable: (_request, _channel, proxyInfo) => resolve(proxyInfo)
    }));
    if (!info || info.type === 'direct') return '';
    const scheme = { http: 'http', https: 'http', socks: 'socks5h', socks4: 'socks4' }[info.type];
    return scheme ? `${scheme}://${info.host}:${info.port}` : '';
  }

  async request(method, params) {
    await this.start();
    return this.peer.request(method, params);
  }

  // Threads are ephemeral so they stay out of the Codex app's history; the plugin stores
  // conversations itself and replays them with `history` when a paper is reopened.
  async startThread(developerInstructions, history = []) {
    const result = await this.request('thread/start', {
      ephemeral: true, sandbox: 'read-only', approvalPolicy: 'never',
      serviceName: 'zotero-ai-chat',
      baseInstructions: Zotero.Prefs.get('extensions.zoteroaichat.baseInstructions', true) || CodexService.BASE_INSTRUCTIONS,
      developerInstructions
    });
    const threadId = result.thread.id;
    const items = history.filter(m => m.text).map(m => m.role === 'user'
      ? { type: 'message', role: 'user', content: [{ type: 'input_text', text: m.text }] }
      : { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: m.text }] });
    if (items.length) await this.request('thread/inject_items', { threadId, items });
    return threadId;
  }

  async startTurn(threadId, text, imagePaths = []) {
    const model = Zotero.Prefs.get('extensions.zoteroaichat.model', true);
    const effort = Zotero.Prefs.get('extensions.zoteroaichat.effort', true);
    const result = await this.request('turn/start', {
      threadId,
      input: [...imagePaths.map(path => ({ type: 'localImage', path })), { type: 'text', text, text_elements: [] }],
      ...(model && { model }), ...(effort && { effort })
    });
    return result.turn.id;
  }

  async listModels() {
    const result = await this.request('model/list', {});
    return result.data.filter(m => !m.hidden).map(m => ({
      id: m.id, name: m.displayName, description: m.description, isDefault: m.isDefault,
      efforts: m.supportedReasoningEfforts.map(e => e.reasoningEffort),
      defaultEffort: m.defaultReasoningEffort
    }));
  }

  interrupt(threadId, turnId) {
    return this.request('turn/interrupt', { threadId, turnId });
  }

  listen(threadId, listener) {
    this.threadListeners.set(threadId, listener);
  }

  stop() {
    this.threadListeners.clear();
    this.proc?.kill();
    this.proc = null;
    this.peer = null;
    this.ready = null;
  }
};

CodexService.BASE_INSTRUCTIONS = `You are a research reading assistant embedded in the Zotero PDF reader.
The user is reading an academic paper and asks questions about it, often about a quoted passage.
Answer directly and precisely. Ground claims in the paper when it is provided.
Say so when the paper does not contain the answer, then answer from general knowledge if useful.
Reply in the user's language. Use Markdown; write math in LaTeX with $...$ or $$...$$.

Citations: the paper text marks the start of PDF page N with [p.N]. Cite the page for every claim taken from the paper, written as a Markdown link:
[(p. 3)](page:3 "phrase copied from that page")
The link title must be 4 to 12 consecutive words copied exactly from the cited page in the paper's original language (never translated, even when you reply in another language), chosen from the passage that supports the claim, without the [p.N] marker and without quotation marks inside it. For a page range, link the first page, e.g. [(pp. 23–25)](page:23 "phrase from page 23").

Do not run shell commands, read files, or edit anything: you only converse.`;
