'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function readPreferences(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

function readPosition(value) {
  if (!Number.isFinite(value?.x) || !Number.isFinite(value?.y)) return null;
  const x = Math.round(value.x);
  const y = Math.round(value.y);
  if (Math.abs(x) > 0x7fffffff || Math.abs(y) > 0x7fffffff) return null;
  return { x, y };
}

function cocoPetPreferences(dataDir, log) {
  const positionFile = path.join(dataDir, 'coco-pet-position.json');

  function save(file, value) {
    const temp = `${file}.${randomUUID()}.tmp`;
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temp, file);
    } catch (error) {
      log(`保存小络设置失败: ${error.message}`);
      try { fs.unlinkSync(temp); } catch { /* The temporary file might not exist. */ }
    }
  }

  return {
    readPosition: () => readPosition(readPreferences(positionFile).position),
    writePosition: position => save(positionFile, { position }),
  };
}

module.exports = { cocoPetPreferences };
