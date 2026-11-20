'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('node:http');
const { activityOf, localOrigin, readActivity } = require('../lib/cowork-activity');

test('pending questions win even if another session is working; stale sessions do not keep Coco busy', () => {
  const now = Date.now();
  const fresh = { status: 'RUNNING', last_activity_at: new Date(now).toISOString() };
  const stale = { status: 'RUNNING', updated_at: new Date(now - 660000).toISOString() };
  const waiting = { status: 'PAUSED_HITL' };
  assert.equal(activityOf([fresh], [{ id: 'question' }], now), 'waiting');
  assert.equal(activityOf([fresh, waiting], [], now), 'working');
  assert.equal(activityOf([stale, waiting], [], now), 'waiting');
  assert.equal(activityOf([stale], [], now), 'idle');
});

test('connects only to the chosen loopback port and verifies the ordinary desktop backend before reading sessions', async t => {
  assert.equal(localOrigin(), 'http://127.0.0.1:17926');
  assert.equal(localOrigin('65536'), null);
  assert.equal(localOrigin('80/other'), null);
  let appId = 'other.desktop';
  const seen = [];
  const server = createServer((req, res) => {
    seen.push([req.method, req.url]);
    res.setHeader('Content-Type', 'application/json');
    const values = {
      '/health': { status: 'ok', runtime: true, app_id: appId },
      '/api/v1/sessions': [{ status: 'QUEUED', updated_at: new Date().toISOString() }],
      '/api/v1/hitl/pending': [],
    };
    res.end(JSON.stringify(values[req.url]));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const origin = localOrigin(String(server.address().port));
  await assert.rejects(readActivity(origin));
  assert.deepEqual(seen.splice(0), [['GET', '/health']]);
  appId = 'com.netlive-cowork.desktop';
  assert.equal(await readActivity(origin), 'working');
  assert.deepEqual(seen.sort(), [['GET','/api/v1/hitl/pending'], ['GET','/api/v1/sessions'], ['GET','/health']]);
});
