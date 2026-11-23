'use strict';
const pet = document.getElementById('pet');
const media = document.getElementById('media');
const ctx = pet.getContext('2d', { willReadFrequently: true });
const probe = document.createElement('canvas');
probe.width = 32; probe.height = 18;
const probeCtx = probe.getContext('2d', { willReadFrequently: true });
const clips = new Set(['idle', 'work', 'success', 'wave', 'stretch', 'run', 'tower', 'router', 'topology', 'computer', 'reaction']);
const randomActions = ['wave', 'stretch', 'run', 'tower', 'router', 'topology', 'computer'];
const clipRetryVersions = new Map();
let activity = 'idle';
let current = '';
let timer = null;
let retryTimer = null;
let retryDelay = 1000;
let playbackVersion = 0;
let interactionId = 0;
let pointer = null;
let queuedAction = null;
let waitingRelease = false;
let flying = false;
let releaseTimer = null;
let lastHit = true;
let mousePosition = null;
let hasFrame = false;
let runStarted = false;
let runLeft = false;
let framePending = false;
let frameRequest = null;
let frameUsesVideo = false;
let lastFrameAt = Date.now();
let lastMediaTime = -1;

// Keep the last decoded frame on a canvas while clips load or the compositor
// temporarily returns an empty video frame. The initial image is the approved
// idle frame, so the window never depends on a successful first video frame.
const fallback = new Image();
fallback.onload = () => {
  if (!hasFrame && ctx) {
    ctx.drawImage(fallback, 0, 0, pet.width, pet.height);
    hitTest();
  }
};
fallback.src = 'idle-frame.png';
function paintFrame() {
  if (!ctx || !probeCtx || media.readyState < 2 || !media.videoWidth) return;
  try {
    probeCtx.clearRect(0, 0, probe.width, probe.height);
    probeCtx.drawImage(media, 0, 0, probe.width, probe.height);
    const pixels = probeCtx.getImageData(0, 0, probe.width, probe.height).data;
    let visible = false;
    for (let i = 3; i < pixels.length; i += 4) if (pixels[i] > 16) { visible = true; break; }
    if (!visible) return;
    // Replace pixels in one draw, including transparent pixels. Clearing first
    // would erase the fallback if drawImage itself fails during a GPU reset.
    ctx.globalCompositeOperation = 'copy';
    if (current === 'run' && runLeft) {
      ctx.save();
      try {
        ctx.translate(pet.width, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(media, 0, 0, pet.width, pet.height);
      } finally { ctx.restore(); }
    } else {
      ctx.drawImage(media, 0, 0, pet.width, pet.height);
    }
    hasFrame = true;
    if (current === 'run' && !runStarted && !busy()) {
      runStarted = true;
      window.coco.run(media.currentTime);
    }
    hitTest();
    retryDelay = 1000;
    if (media.currentTime !== lastMediaTime) {
      lastMediaTime = media.currentTime;
      lastFrameAt = Date.now();
    }
  } catch (_) { /* Keep the last visible frame and retry on the next frame. */ }
}
function requestFrame() {
  if (framePending) return;
  framePending = true;
  const done = () => { framePending = false; frameRequest = null; paintFrame(); if (!media.paused) requestFrame(); };
  frameUsesVideo = typeof media.requestVideoFrameCallback === 'function';
  frameRequest = frameUsesVideo ? media.requestVideoFrameCallback(done) : requestAnimationFrame(done);
}
function cancelFrame() {
  if (!framePending) return;
  if (frameUsesVideo) media.cancelVideoFrameCallback(frameRequest);
  else cancelAnimationFrame(frameRequest);
  framePending = false; frameRequest = null;
}

function schedule() {
  clearTimeout(timer);
  if (activity !== 'idle') return;
  timer = setTimeout(() => play(randomActions[Math.floor(Math.random() * randomActions.length)]), 20000 + Math.random() * 20000);
}
function scheduleRetry(name) {
  if (retryTimer !== null) return;
  clearTimeout(timer);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    if (current !== name || (busy() && queuedAction)) return;
    play(name === 'run' ? restingClip() : name, true);
  }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30000);
}
function restingClip() { return activity === 'working' ? 'work' : 'idle'; }
function busy() { return !!pointer || waitingRelease || flying; }
function play(name, retrying = false) {
  if (!clips.has(name)) return;
  // An idle timer or session update may arrive during a drag. Keep the exact
  // visible frame until the drag ends so a different-sized pose cannot flash in.
  if (busy()) { queuedAction = { name, retrying }; return; }
  clearTimeout(timer);
  if (retryTimer !== null) { clearTimeout(retryTimer); retryTimer = null; }
  if (!retrying) retryDelay = 1000;
  cancelFrame();
  current = name;
  runStarted = false;
  runLeft = false;
  const version = ++playbackVersion;
  lastFrameAt = Date.now(); lastMediaTime = -1;
  media.loop = name === 'idle' || (name === 'work' && activity === 'working');
  // Chromium can reuse the failed response for the same media URL.
  if (retrying) clipRetryVersions.set(name, version);
  const clipVersion = clipRetryVersions.get(name);
  media.src = clipVersion ? `${name}.webm?retry=${clipVersion}` : `${name}.webm`;
  void media.play().then(() => { if (version === playbackVersion) requestFrame(); }).catch(error => {
    if (version === playbackVersion && error?.name !== 'AbortError') scheduleRetry(name);
  });
  if (name === 'idle') schedule();
}
media.addEventListener('ended', () => play(restingClip()));
media.addEventListener('error', () => scheduleRetry(current));
setInterval(() => {
  if (!busy() && Date.now() - lastFrameAt >= 8000) scheduleRetry(current);
}, 3000);
window.coco.onPlay(play);
window.coco.onRunDirection(direction => { runLeft = direction === 'left'; });
window.coco.onActivity(value => {
  if (!['idle', 'working', 'waiting'].includes(value) || value === activity) return;
  const previous = activity; activity = value;
  if (value === 'working') play('work');
  else if (value === 'waiting') play('reaction');
  else play(previous === 'working' ? 'success' : 'idle');
});

function squash(speed = 500) {
  if (typeof pet.animate !== 'function' || window.matchMedia?.('(prefers-reduced-motion: reduce)')?.matches) return;
  const amount = Math.min(1, Math.max(0, (Math.abs(speed) - 150) / 1400));
  const scaleY = 0.8 - amount * 0.18;
  pet.animate([
    { transform: 'scale(1, 1)', offset: 0 },
    { transform: `scale(${1.08 + amount * 0.08}, ${scaleY})`, offset: 0.4 },
    { transform: 'scale(0.97, 1.07)', offset: 0.75 },
    { transform: 'scale(1, 1)', offset: 1 },
  ], { duration: 300, easing: 'ease-out' });
}
function resumeAfterInteraction(clicked = false) {
  const queued = queuedAction; queuedAction = null;
  if (clicked) { play('reaction'); squash(650); return; }
  if (queued) { play(queued.name, queued.retrying); return; }
  if (media.ended) { play(restingClip()); return; }
  lastFrameAt = Date.now();
  const version = playbackVersion;
  void media.play().then(() => { if (version === playbackVersion) requestFrame(); }).catch(error => {
    if (version === playbackVersion && error?.name !== 'AbortError') scheduleRetry(current);
  });
  if (current === 'idle') schedule();
}
window.coco.onPhysics(event => {
  if (!event || event.id !== interactionId || pointer) return;
  if (event.type === 'release' && waitingRelease) {
    clearTimeout(releaseTimer); releaseTimer = null; waitingRelease = false;
    pet.classList.remove('grabbed');
    if (event.flying) { flying = true; pet.classList.add('flying'); }
    else resumeAfterInteraction(!event.moved && !event.cancelled);
  } else if (event.type === 'impact' && flying) {
    squash(event.speed);
  } else if (event.type === 'settled' && flying) {
    flying = false; pet.classList.remove('flying');
    resumeAfterInteraction();
  }
});

// Make the transparent part of the window click-through, while forwarding mouse
// moves so a visible pixel can become interactive again (Windows/macOS).
function hitTest() {
  if (!mousePosition || pointer || waitingRelease || !ctx) return;
  try {
    const bounds = pet.getBoundingClientRect();
    const x = Math.floor((mousePosition.x - bounds.left) * pet.width / bounds.width);
    const y = Math.floor((mousePosition.y - bounds.top) * pet.height / bounds.height);
    const hit = x >= 0 && x < pet.width && y >= 0 && y < pet.height && ctx.getImageData(x, y, 1, 1).data[3] > 16;
    if (hit !== lastHit) { lastHit = hit; window.coco.interactive(hit); }
  } catch (_) { if (!lastHit) { lastHit = true; window.coco.interactive(true); } }
}
window.addEventListener('mousemove', event => {
  mousePosition = { x: event.clientX, y: event.clientY };
  hitTest();
});
window.addEventListener('mouseout', event => {
  if (event.relatedTarget === null &&
      (event.clientX < 0 || event.clientY < 0 || event.clientX >= innerWidth || event.clientY >= innerHeight)) {
    mousePosition = null;
  }
});
pet.addEventListener('contextmenu', event => { event.preventDefault(); window.coco.menu(); });
pet.addEventListener('pointerdown', event => {
  if (event.button !== 0 || pointer) return;
  try { pet.setPointerCapture(event.pointerId); } catch (_) { return; }
  const interrupted = waitingRelease || flying;
  clearTimeout(releaseTimer);
  releaseTimer = null;
  waitingRelease = false;
  flying = false;
  pet.classList.remove('flying'); pet.classList.add('grabbed');
  pointer = { id: event.pointerId, x: event.screenX, y: event.screenY, clientX: event.clientX, clientY: event.clientY, moved: false };
  if (!interrupted) queuedAction = null;
  clearTimeout(timer);
  cancelFrame();
  media.pause();
  window.coco.dragStart(++interactionId);
});
pet.addEventListener('pointermove', event => {
  if (!pointer || event.pointerId !== pointer.id) return;
  const screenDistance = Math.hypot(event.screenX - pointer.x, event.screenY - pointer.y) || 0;
  const clientDistance = Math.hypot(event.clientX - pointer.clientX, event.clientY - pointer.clientY) || 0;
  if (Math.max(screenDistance, clientDistance) > 5) pointer.moved = true;
});
function finishPointer(event, cancelled = false) {
  if (!pointer || event.pointerId !== pointer.id) return;
  const id = interactionId;
  const moved = pointer.moved; pointer = null; waitingRelease = true;
  window.coco.dragEnd({ id, moved, cancelled });
  // A renderer reload or shutdown can drop an IPC response; do not leave the
  // character permanently paused in that case.
  releaseTimer = setTimeout(() => {
    if (!waitingRelease || id !== interactionId) return;
    waitingRelease = false; releaseTimer = null; pet.classList.remove('grabbed');
    resumeAfterInteraction(!moved && !cancelled);
  }, 1000);
}
pet.addEventListener('pointerup', event => finishPointer(event));
pet.addEventListener('pointercancel', event => finishPointer(event, true));
pet.addEventListener('lostpointercapture', event => finishPointer(event, true));
play('idle');
