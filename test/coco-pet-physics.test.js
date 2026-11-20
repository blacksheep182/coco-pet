'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { releaseVelocity, throwStep, MAX_THROW_SPEED } = require('../lib/coco-pet-physics');

test('only a recent fast flick produces a bounded release velocity', () => {
  assert.equal(releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 5, y: 0, t: 100 }], 100), null);
  assert.equal(releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 200, y: 0, t: 100 }, { x: 200, y: 0, t: 300 }], 300), null);
  const velocity = releaseVelocity([{ x: 0, y: 0, t: 0 }, { x: 500, y: -500, t: 100 }], 100);
  assert.ok(velocity.vx > 0 && velocity.vy < 0);
  assert.ok(Math.abs(Math.hypot(velocity.vx, velocity.vy) - MAX_THROW_SPEED) < 0.001);
});

test('holding the cursor still before release cancels an earlier flick', () => {
  const trail = [
    { x: 0, y: 0, t: 0 },
    { x: 160, y: 0, t: 30 },
    { x: 160, y: 0, t: 60 },
    { x: 162, y: 0, t: 95 },
    { x: 161, y: 0, t: 120 },
  ];
  assert.equal(releaseVelocity(trail, 120), null);
});

test('throw bounces off walls and floor, stays on screen, and eventually settles', () => {
  const area = { x: 100, y: 50, width: 1000, height: 700 };
  const size = { width: 384, height: 216 };
  let state = { x: 110, y: 250, vx: -1500, vy: 0 };
  state = throwStep(state, 0.05, area, size);
  assert.equal(state.x, area.x);
  assert.ok(state.vx > 0, 'wall collision reverses horizontal velocity');
  let bounced = false;
  for (let i = 0; i < 1000 && !state.atRest; i++) {
    state = throwStep(state, 0.016, area, size);
    assert.ok(state.x >= 100 && state.x <= 716 && state.y >= 50 && state.y <= 534);
    if (state.impact > 100 && state.vy < 0) bounced = true;
  }
  assert.ok(bounced, 'the floor produces a bounce');
  assert.ok(state.atRest, 'friction eventually brings the pet to rest');
  assert.equal(state.y, 534);
});

test('250 throws with jittered ticks settle inside different work areas', () => {
  let seed = 0xC0C0;
  function random() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  }
  const size = { width: 384, height: 216 };
  for (let scenario = 0; scenario < 250; scenario++) {
    const area = {
      x: Math.round(random() * 4000) - 2000,
      y: Math.round(random() * 2000) - 1000,
      width: 300 + Math.round(random() * 1400),
      height: 170 + Math.round(random() * 900),
    };
    const maxX = Math.max(area.x, area.x + area.width - size.width);
    const maxY = Math.max(area.y, area.y + area.height - size.height);
    const angle = random() * Math.PI * 2;
    const speed = 320 + random() * (MAX_THROW_SPEED - 320);
    let state = {
      x: area.x + random() * (maxX - area.x),
      y: area.y + random() * (maxY - area.y),
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed,
    };
    const label = 'trajectory ' + scenario;
    for (let step = 0; step < 800 && !state.atRest; step++) {
      state = throwStep(state, 0.004 + random() * 0.08, area, size);
      assert.ok(state.x >= area.x && state.x <= maxX && state.y >= area.y && state.y <= maxY, label);
    }
    assert.ok(state.atRest, label + ' failed to settle');
  }
});
