// Newline-delimited JSON-RPC peer for `codex app-server`.
// Loaded into the plugin scope by bootstrap.js and required directly by Node tests.
var JsonRpcPeer = class {
  constructor(write) {
    this.write = write;
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.onNotification = () => {};
  }

  request(method, params) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  notify(method, params) {
    this.write(JSON.stringify(params === undefined ? { method } : { method, params }) + '\n');
  }

  feed(chunk) {
    this.buffer += chunk;
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (!line) continue;
      const message = JSON.parse(line);
      if (message.method && message.id !== undefined) {
        // Server-initiated request (e.g. an approval prompt). The reading assistant
        // runs with approvalPolicy "never", so decline anything that still arrives.
        this.write(JSON.stringify({ id: message.id, error: { code: -32601, message: `Unsupported request: ${message.method}` } }) + '\n');
      } else if (message.method) {
        this.onNotification(message);
      } else {
        const waiter = this.pending.get(message.id);
        if (!waiter) continue;
        this.pending.delete(message.id);
        if (message.error) waiter.reject(new Error(message.error.message || JSON.stringify(message.error)));
        else waiter.resolve(message.result);
      }
    }
  }

  failAll(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
};

if (typeof module === 'object') module.exports = { JsonRpcPeer };
