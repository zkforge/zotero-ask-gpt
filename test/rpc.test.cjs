const test = require('node:test');
const assert = require('node:assert/strict');
const { JsonRpcPeer } = require('../content/rpc.js');

test('resolves responses split across chunks', async () => {
  const sent = [];
  const peer = new JsonRpcPeer(line => sent.push(JSON.parse(line)));
  const result = peer.request('thread/start', { ephemeral: true });
  assert.deepEqual(sent[0], { id: 1, method: 'thread/start', params: { ephemeral: true } });
  peer.feed('{"id":1,"result":{"thr');
  peer.feed('ead":{"id":"t1"}}}\n');
  assert.deepEqual(await result, { thread: { id: 't1' } });
});

test('rejects error responses', async () => {
  const peer = new JsonRpcPeer(() => {});
  const result = peer.request('turn/start', {});
  peer.feed('{"id":1,"error":{"code":-32600,"message":"boom"}}\n');
  await assert.rejects(result, error => error.message === 'boom' && error.code === -32600);
});

test('dispatches several notifications in one chunk, including unicode', () => {
  const peer = new JsonRpcPeer(() => {});
  const seen = [];
  peer.onNotification = message => seen.push(message.params.delta);
  peer.feed('{"method":"item/agentMessage/delta","params":{"delta":"猫"}}\n\n{"method":"item/agentMessage/delta","params":{"delta":"🐱"}}\n');
  assert.deepEqual(seen, ['猫', '🐱']);
});

test('declines server-initiated requests instead of hanging them', () => {
  const sent = [];
  const peer = new JsonRpcPeer(line => sent.push(JSON.parse(line)));
  peer.feed('{"id":"s1","method":"item/commandExecution/requestApproval","params":{}}\n');
  assert.equal(sent[0].id, 's1');
  assert.equal(sent[0].error.code, -32601);
});

test('failAll rejects every pending request', async () => {
  const peer = new JsonRpcPeer(() => {});
  const a = peer.request('a');
  const b = peer.request('b');
  peer.failAll(new Error('exited'));
  await assert.rejects(a, /exited/);
  await assert.rejects(b, /exited/);
  assert.equal(peer.pending.size, 0);
});
