'use strict';

const DEFAULT_PORT = 17926;
const APP_ID = 'com.netlive-cowork.desktop';
const STALE_MS = 10 * 60_000;

function activityOf(sessions, pending, now = Date.now()) {
  if (pending.length) return 'waiting';
  const running = sessions.some(row => {
    if (row?.status !== 'RUNNING' && row?.status !== 'QUEUED') return false;
    const timestamp = row.last_activity_at || row.updated_at;
    if (!timestamp) return false;
    const lastActive = Date.parse(timestamp);
    return Number.isNaN(lastActive) || now - lastActive <= STALE_MS;
  });
  if (running) return 'working';
  return sessions.some(row => row?.status === 'WAITING_INPUT' || row?.status === 'PAUSED_HITL')
    ? 'waiting' : 'idle';
}

function localOrigin(port = String(DEFAULT_PORT)) {
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535) return null;
  return 'http://127.0.0.1:' + Number(port);
}

async function readActivity(origin, signal) {
  async function get(path) {
    const res = await fetch(origin + path, { signal, redirect: 'error' });
    if (!res.ok) throw new Error('CoWork HTTP ' + res.status);
    return res.json();
  }
  const health = await get('/health');
  if (health?.status !== 'ok' || health.runtime !== true || health.app_id !== APP_ID) {
    throw new Error('CoWork is not ready');
  }
  const [sessions, pending] = await Promise.all([
    get('/api/v1/sessions'), get('/api/v1/hitl/pending'),
  ]);
  if (!Array.isArray(sessions) || !Array.isArray(pending)) throw new Error('Invalid CoWork response');
  return activityOf(sessions, pending);
}

// Schedule after completion so a sleeping computer or slow backend cannot queue polls.
function watchCowork(origin, onState) {
  const lifecycle = new AbortController();
  let timer;
  async function poll() {
    let activity = 'idle';
    let connected = false;
    try {
      activity = await readActivity(origin, AbortSignal.any([lifecycle.signal, AbortSignal.timeout(4000)]));
      connected = true;
    } catch { /* CoWork can start, stop or update while the pet stays open. */ }
    if (lifecycle.signal.aborted) return;
    onState({ connected, activity });
    timer = setTimeout(poll, connected ? 3000 : 10000);
  }
  if (origin) void poll();
  return () => { lifecycle.abort(); clearTimeout(timer); };
}

module.exports = { activityOf, localOrigin, readActivity, watchCowork };
