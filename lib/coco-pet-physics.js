'use strict';

// Coordinates and velocities use Electron's device-independent pixels and seconds.
const TRAIL_MS = 150;
const STOPPED_MS = 65;
const MIN_THROW_SPEED = 320;
const MAX_THROW_SPEED = 2400;
const GRAVITY = 1400;
const RESTITUTION = 0.58;

function releaseVelocity(trail, now) {
  const recent = trail.filter(point => now - point.t <= TRAIL_MS && now >= point.t);
  if (recent.length < 2) return null;
  const first = recent[0], last = recent[recent.length - 1];
  const lastMovement = recent.findLastIndex(point => Math.hypot(point.x - last.x, point.y - last.y) >= 5);
  if (lastMovement < 0 || last.t - recent[lastMovement + 1].t >= STOPPED_MS) return null;
  const seconds = (last.t - first.t) / 1000;
  if (seconds < 0.02) return null;
  let vx = (last.x - first.x) / seconds, vy = (last.y - first.y) / seconds;
  const speed = Math.hypot(vx, vy);
  if (!Number.isFinite(speed) || speed < MIN_THROW_SPEED) return null;
  const scale = Math.min(1, MAX_THROW_SPEED / speed);
  vx *= scale; vy *= scale;
  return { vx, vy };
}

function throwStep(state, elapsed, area, size) {
  const dt = Math.max(0, Math.min(elapsed, 0.05));
  const minX = area.x, minY = area.y;
  const maxX = Math.max(minX, area.x + area.width - size.width);
  const maxY = Math.max(minY, area.y + area.height - size.height);
  let { x, y, vx, vy } = state;
  let impact = 0;
  vx *= Math.exp(-0.15 * dt);
  vy += GRAVITY * dt;
  x += vx * dt; y += vy * dt;
  if (x < minX) { x = minX; vx = Math.abs(vx) * RESTITUTION; }
  else if (x > maxX) { x = maxX; vx = -Math.abs(vx) * RESTITUTION; }
  if (y < minY) { y = minY; vy = Math.abs(vy) * RESTITUTION; }
  else if (y >= maxY) {
    y = maxY;
    impact = Math.max(0, vy);
    vy = impact > 100 ? -impact * RESTITUTION : 0;
    vx *= vy === 0 ? Math.exp(-5 * dt) : 0.72;
    if (Math.abs(vx) < 18 && vy === 0) vx = 0;
  }
  return { x, y, vx, vy, impact, atRest: y >= maxY && vx === 0 && vy === 0 };
}

module.exports = { releaseVelocity, throwStep, MIN_THROW_SPEED, MAX_THROW_SPEED };
