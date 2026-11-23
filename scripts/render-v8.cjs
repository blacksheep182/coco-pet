'use strict';

// Rebuild the runtime assets from the approved transparent V8 animation sheets.
// Run with Node and FFmpeg (libvpx-vp9); FFMPEG may name a local binary.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets/coco-pet');
const width = 640, height = 360, fps = 24;

function ffmpeg(args, input) {
  const run = spawnSync(process.env.FFMPEG || 'ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', ...args], {
    input, maxBuffer: 192 * 1024 * 1024, windowsHide: true,
  });
  if (run.error) throw new Error(run.error.message + ': ' + run.stderr?.toString());
  if (run.status !== 0) throw new Error(run.stderr.toString());
  return run.stdout;
}

// Shared anchors within each row retain foot placement and moving limbs. Props
// stay in their own space; the character's body sits near the window center.
const sheets = {
  poses: [4, 3], states: [4, 3], run: [3, 2],
  repair: [2, 2], hardware: [4, 2], tower: [4, 1],
};
// Each timing pair is [local cel, display frames at 24 fps].
const actions = {
  idle:     ['poses', 0, .84, 183, 344, [[0,67],[1,1],[2,2],[3,1],[0,25]]],
  wave:     ['poses', 4, .84, 183, 344, [[0,6],[1,4],[2,4],[3,4],[1,4],[2,5],[3,4],[0,6]]],
  stretch:  ['poses', 8, .84, 183, 344, [[0,8],[1,7],[2,21],[3,9],[0,9]]],
  work:     ['states',0, .76, 195, 346, [[0,5],[1,4],[2,4],[1,4],[3,5],[2,4],[1,4],[0,4]]],
  success:  ['states',4, .84, 183, 344, [[0,5],[1,7],[2,20],[1,7],[3,6]]],
  reaction: ['states',8, .84, 183, 344, [[0,3],[1,6],[2,17],[1,5],[3,7],[0,4]]],
  run:      ['run',   0, .62, 267, 484, Array.from({length:36}, (_,i) => [i % 6, 2])],
  tower:    ['tower', 0, .66, 178, 466, [[0,8],[1,8],[2,10],[3,18],[2,7],[1,7],[0,5]]],
  router:   ['repair',0, .45, 305, 606, [[0,10],[1,8],[2,12],[3,20]]],
  topology: ['hardware',0,.74,131, 410, [[0,8],[1,10],[2,12],[3,17]]],
  computer: ['hardware',4,.74,131, 412, [[0,8],[1,9],[2,13],[3,15]]],
};

function loadCels([sheet, first, scale, anchorX, baseline, timing]) {
  const file = path.join(root, 'art/v8', sheet + '.png');
  const header = fs.readFileSync(file);
  const [cols, rows] = sheets[sheet];
  const iw = header.readUInt32BE(16), ih = header.readUInt32BE(20);
  const cellW = Math.floor(iw / cols), cellH = Math.floor(ih / rows);
  const x = Math.round(320 - anchorX * scale), y = Math.round(323 - baseline * scale);
  return Array.from({length: Math.max(...timing.map(pair => pair[0])) + 1}, (_, i) => {
    const index = first + i;
    const cx = Math.round((index % cols) * iw / cols);
    const cy = Math.round(Math.floor(index / cols) * ih / rows);
    const filter = [
      'format=rgba', `crop=${cellW}:${cellH}:${cx}:${cy}:exact=1`,
      // Discard near-transparent matte flecks before downsampling.
      "lutrgb=a='clip((val-30)*255/213,0,255)'",
      `scale=${Math.round(cellW * scale)}:${Math.round(cellH * scale)}:flags=lanczos`,
      'format=rgba', `pad=${width}:${height}:${x}:${y}:color=black@0`,
    ].join(',');
    return ffmpeg(['-i', file, '-vf', filter, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgba', 'pipe:1']);
  });
}

function stabilizeBlink(cels) {
  // The idle blink is the only moving part. Keep the approved silhouette on
  // every idle frame instead of letting small redraw differences move the feet.
  for (let i = 1; i < cels.length; i++) {
    const eyes = cels[i];
    cels[i] = Buffer.from(cels[0]);
    for (let y = 122; y < 157; y++) {
      const start = (y * width + 278) * 4;
      eyes.copy(cels[i], start, start, start + 84 * 4);
    }
  }
}

function rawInput() {
  return ['-f','rawvideo','-pixel_format','rgba','-video_size', width+'x'+height, '-framerate',String(fps),'-i','pipe:0'];
}

function writeIcons(idle) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map(size => ffmpeg([...rawInput(), '-vf',
    `crop=184:184:227:25,scale=${size}:${size}:flags=lanczos`, '-frames:v','1','-c:v','png','-f','image2pipe','pipe:1'], idle));
  fs.writeFileSync(path.join(root,'assets/tray.png'), frames[sizes.indexOf(64)]);
  // ICO accepts PNG-compressed images. Use native sizes for both the tray and Explorer.
  const header = Buffer.alloc(6 + sizes.length * 16);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(sizes.length, 4);
  let offset = header.length;
  sizes.forEach((size, i) => {
    const entry = 6 + i * 16;
    header[entry] = header[entry+1] = size % 256;
    header.writeUInt16LE(1, entry+4);
    header.writeUInt16LE(32, entry+6);
    header.writeUInt32LE(frames[i].length, entry+8);
    header.writeUInt32LE(offset, entry+12);
    offset += frames[i].length;
  });
  fs.writeFileSync(path.join(root,'build/icon.ico'), Buffer.concat([header, ...frames]));
}

for (const [name, action] of Object.entries(actions)) {
  const cels = loadCels(action);
  if (name === 'idle') {
    stabilizeBlink(cels);
    ffmpeg([...rawInput(), '-frames:v','1', path.join(assets,'idle-frame.png')], cels[0]);
    writeIcons(cels[0]);
  }
  const frames = action[5].flatMap(([index, count]) => Array(count).fill(cels[index]));
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-encode-'));
  const source = path.join(tmp, 'frames.rgba');
  const output = path.join(assets, '.' + name + '.tmp.webm');
  try {
    const fd = fs.openSync(source, 'w');
    try { for (const frame of frames) fs.writeFileSync(fd, frame); } finally { fs.closeSync(fd); }
    ffmpeg([...rawInput().slice(0,-1), source, '-an','-c:v','libvpx-vp9','-b:v','0','-lossless','1',
      '-auto-alt-ref','0','-threads','4','-deadline','good','-cpu-used','5',
      '-pix_fmt','yuva420p', output]);
    fs.renameSync(output, path.join(assets, name+'.webm'));
  } finally {
    fs.rmSync(output, { force: true });
    fs.rmSync(source, { force: true });
    fs.rmdirSync(tmp);
  }
  console.log(name, frames.length + ' frames');
}
