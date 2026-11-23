'use strict';

// Shared by desktop roaming and the offline animator. The integral of the
// velocity ramps gives the distance travelled at any point in the clip.
const RUN_FRAMES = 72;
const RUN_MS = 3000;
const RUN_DISTANCE = 150;
function rampIntegral(t, duration) {
  const ramp = Math.max(0, Math.min(duration, t));
  return ramp*ramp/(2*duration) + Math.max(0, t-duration);
}
function runProgress(fraction) {
  const frame = Math.max(0, Math.min(1, fraction))*RUN_FRAMES;
  return (rampIntegral(frame-2, 12) - rampIntegral(frame-55, 14))/54;
}
module.exports = { RUN_FRAMES, RUN_MS, RUN_DISTANCE, runProgress };
