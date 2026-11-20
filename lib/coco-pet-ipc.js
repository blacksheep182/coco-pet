'use strict';

function isCocoActivity(value) {
  return value === 'idle' || value === 'working' || value === 'waiting';
}

module.exports = { isCocoActivity };
