'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('keeps the last visible frame through decoder errors and retries the working clip', async () => {
  let visible = true, failDraw = false, videoCallback, fallback, onPlay, onActivity, cleared = 0, drawn = 0, runs = 0;
  let pointerPixelAlpha = 255;
  const hitChanges = [];
  const windowEvents = {};
  const listeners = {};
  const scheduled = [];
  const displayContext = {
    clearRect() { cleared++; },
    drawImage() { if (failDraw) throw new Error('GPU reset'); drawn++; },
    getImageData() { return { data: new Uint8ClampedArray([0, 0, 0, pointerPixelAlpha]) }; },
  };
  const probeContext = {
    clearRect() {}, drawImage() {},
    getImageData() { return { data: new Uint8ClampedArray([0, 0, 0, visible ? 255 : 0]) }; },
  };
  const canvas = { width: 384, height: 216, getContext: () => displayContext,
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 384, height: 216 }),
    addEventListener() {}, setPointerCapture() {} };
  const media = { paused: false, readyState: 4, videoWidth: 640, currentTime: 0,
    addEventListener(name, fn) { listeners[name] = fn; },
    play() { return Promise.resolve(); },
    requestVideoFrameCallback(fn) { videoCallback = fn; return 1; },
    cancelVideoFrameCallback() {},
  };
  const window = {
    coco: {
      run() { runs++; }, onPlay(fn) { onPlay = fn; }, onActivity(fn) { onActivity = fn; },
      onPhysics() {}, interactive(hit) { hitChanges.push(hit); }, menu() {}, dragStart() {}, dragEnd() {},
    },
    addEventListener(name, fn) { windowEvents[name] = fn; },
  };
  const context = {
    document: { getElementById: id => id === 'pet' ? canvas : media,
      createElement: () => ({ width: 0, height: 0, getContext: () => probeContext }) },
    window, Image: class { constructor() { fallback = this; } },
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    setTimeout(fn, delay) { const timer = { fn, delay, cancelled: false }; scheduled.push(timer); return timer; },
    setInterval() {}, requestAnimationFrame() {}, cancelAnimationFrame() {},
    Date, Math, Uint8ClampedArray,
  };
  const script = fs.readFileSync(path.join(__dirname, '../assets/coco-pet/pet.js'), 'utf8');
  vm.runInNewContext(script, context);
  fallback.onload();
  assert.equal(drawn, 1, 'idle fallback should appear before video frames');
  await Promise.resolve();
  media.currentTime = 0.1; videoCallback();
  assert.equal(cleared, 0); assert.equal(drawn, 2);
  visible = false; media.currentTime = 0.2; videoCallback();
  assert.equal(cleared, 0, 'an empty decoder frame must not clear the last visible frame');
  assert.equal(drawn, 2);
  visible = true; failDraw = true; media.currentTime = 0.3; videoCallback();
  assert.equal(cleared, 0, 'a failed draw must leave the last visible frame intact');
  assert.equal(drawn, 2);
  onActivity('working');
  assert.equal(media.src, 'work.webm');
  listeners.error();
  assert.equal(media.src, 'work.webm', 'a decode error should not leave a working pet idle');
  assert.equal(drawn, 2);
  const retry = scheduled.find(timer => timer.delay === 1000 && !timer.cancelled);
  assert.ok(retry, 'decoder errors should schedule a retry');
  retry.fn();
  assert.match(media.src, /^work\.webm\?retry=\d+$/, 'retry should request fresh bytes for the working animation');
  assert.equal(media.loop, true);
  const recoveredUrl = media.src;
  onActivity('waiting');
  onActivity('working');
  assert.equal(media.src, recoveredUrl, 'later playback must avoid the original cached failure');

  failDraw = false;
  onPlay('run');
  await Promise.resolve();
  assert.equal(runs, 0, 'roaming must wait for a visible frame');
  windowEvents.mousemove({ clientX: 110, clientY: 75 });
  pointerPixelAlpha = 0;
  videoCallback();
  assert.equal(runs, 1);
  assert.deepEqual(hitChanges, [false], 'a transparent pixel becomes click-through without moving the mouse');
  pointerPixelAlpha = 255;
  videoCallback();
  assert.equal(runs, 1);
  assert.deepEqual(hitChanges, [false, true], 'an opaque pixel restores input without moving the mouse');
});

test('holds the current pose while dragging and only applies queued actions after release', async () => {
  const events = {};
  let onPlay, onActivity, onPhysics, starts = 0, ends = 0, squashes = 0, dragId, releaseTimeout;
  const ctx = { drawImage() {}, clearRect() {}, getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }) };
  const canvas = { width: 384, height: 216, getContext: () => ctx,
    addEventListener(name, fn) { events[name] = fn; }, setPointerCapture() {}, classList: { add() {}, remove() {} },
    animate() { squashes++; } };
  const media = { paused: false, ended: false, readyState: 4, videoWidth: 640, currentTime: 1,
    addEventListener() {}, play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; }, requestVideoFrameCallback() { return 1; }, cancelVideoFrameCallback() {} };
  const window = { coco: { run() {}, onPlay(fn) { onPlay = fn; }, onActivity(fn) { onActivity = fn; }, onPhysics(fn) { onPhysics = fn; },
    interactive() {}, menu() {}, dragStart(id) { starts++; dragId = id; }, dragEnd() { ends++; } }, addEventListener() {} };
  const context = { document: { getElementById: id => id === 'pet' ? canvas : media,
    createElement: () => ({ getContext: () => ctx }) }, window, Image: class {},
    clearTimeout(timer) { if (timer) timer.cancelled = true; },
    setTimeout(fn, delay) {
      const timer = { fn, cancelled: false };
      if (delay === 1000) releaseTimeout = timer;
      return timer;
    },
    setInterval() {}, requestAnimationFrame() {}, cancelAnimationFrame() {},
    Date, Math, Uint8ClampedArray };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../assets/coco-pet/pet.js'), 'utf8'), context);
  await Promise.resolve();
  assert.equal(media.src, 'idle.webm');
  events.pointerdown({ button: 0, screenX: 100, screenY: 100, pointerId: 1 });
  assert.equal(media.paused, true);
  onPlay('tower');
  onActivity('working');
  assert.equal(media.src, 'idle.webm', 'actions must not change the pose mid-drag');
  events.pointerdown({ button: 0, screenX: 400, screenY: 100, pointerId: 2 });
  events.pointerup({ pointerId: 2 });
  assert.equal(ends, 0, 'another pointer cannot cancel the first drag');
  events.pointermove({ screenX: 160, screenY: 100, pointerId: 1 });
  events.pointerup({ pointerId: 1 });
  onPhysics({ id: dragId, type: 'release', flying: false, moved: true, cancelled: false });
  assert.equal(media.src, 'work.webm', 'the latest session state should apply after release');
  assert.equal(starts, 1); assert.equal(ends, 1);
  events.pointerdown({ button: 0, screenX: 100, screenY: 100, pointerId: 1 });
  events.pointercancel({ pointerId: 1 });
  onPhysics({ id: dragId, type: 'release', flying: false, moved: false, cancelled: true });
  assert.equal(media.src, 'work.webm', 'a cancelled pointer must not count as a click');
  events.pointerdown({ button: 0, screenX: 100, screenY: 100, pointerId: 1 });
  events.lostpointercapture({ pointerId: 1 });
  onPhysics({ id: dragId, type: 'release', flying: false, moved: false, cancelled: true });
  assert.equal(media.src, 'work.webm', 'lost pointer capture must not count as a click');
  assert.equal(media.paused, false, 'animation should resume after lost capture');
  assert.equal(ends, 3);
  events.pointerdown({ button: 0, screenX: 100, screenY: 100, pointerId: 1 });
  events.pointermove({ screenX: 160, screenY: 100, pointerId: 1 });
  events.pointerup({ pointerId: 1 });
  onPhysics({ id: dragId, type: 'release', flying: true, moved: true });
  onActivity('waiting');
  assert.equal(media.src, 'work.webm', 'activity changes wait until the throw ends');
  onPhysics({ id: dragId, type: 'impact', speed: 600 });
  assert.equal(squashes, 1, 'a landing squashes the character');
  events.pointerdown({ button: 0, screenX: 100, screenY: 100, pointerId: 1 });
  events.pointerup({ pointerId: 1 });
  onPhysics({ id: dragId, type: 'release', flying: false, moved: true });
  assert.equal(media.src, 'reaction.webm', 'grabbing in flight preserves the pending session state');

  const mouse = { button: 0, screenX: 100, screenY: 100, pointerId: 1 };
  for (let i = 0; i < 50; i++) {
    const priorStarts = starts;
    events.pointerdown(mouse);
    const previousId = dragId;
    events.pointerup(mouse);
    const previousTimeout = releaseTimeout;
    onActivity('working');
    events.pointerdown(mouse);
    assert.equal(starts, priorStarts + 2, 'a new grab starts before the previous acknowledgement');
    assert.notEqual(dragId, previousId);
    assert.equal(previousTimeout.cancelled, true, 'the old release timer cannot affect the new grab');
    events.pointerup(mouse);
    onPhysics({ id: previousId, type: 'release', flying: true, moved: true });
    assert.equal(media.paused, true);
    onPhysics({ id: dragId, type: 'release', flying: false, moved: true });
    assert.equal(media.src, 'work.webm');
    assert.equal(media.paused, false, 'an old acknowledgement must not block playback');
    onActivity('waiting');
  }
  events.pointerdown(mouse);
  events.pointerup(mouse);
  onActivity('working');
  releaseTimeout.fn();
  assert.equal(media.paused, false, 'missing IPC must eventually release the paused animation');
  onPhysics({ id: dragId, type: 'release', flying: true, moved: true });
  onActivity('idle');
  assert.equal(media.src, 'success.webm', 'a reply after timeout cannot return the pet to flying');
});
