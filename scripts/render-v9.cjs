'use strict';

// Offline art build uses Node, FFmpeg/libvpx and Python with numpy + opencv-python.
// FFMPEG and PYTHON can point to local executables. The pet only needs the clips.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { writeMotion } = require('./animate-cels.cjs');
const { writeRun } = require('./render-jog.cjs');
const root = path.resolve(__dirname, '..');
const assets = path.join(root, 'assets', 'coco-pet');
const art = path.join(root, 'art', 'v9');
const width = 640;
const height = 360;
const fps = 24;

function transcode(args) {
  return execFileSync(process.env.FFMPEG || 'ffmpeg',
    ['-nostdin', '-y', '-hide_banner', '-loglevel', 'error', ...args],
    { maxBuffer: 32 * 1024 * 1024, windowsHide: true });
}

const grids = {
  front: [1, 1], blink: [1, 1], greeting: [4, 2], yawn: [4, 2], typing: [4, 2], states: [4, 3],
  tower: [4, 1], repair: [2, 2], hardware: [4, 2],
  'jog/stride-cels': [4, 2], 'jog/bookends': [4, 1],
};

// Scale and anchor are shared across a complete action so leaning, lifting
// a foot or reaching for a prop never causes the camera to move.
const actions = {
  wave: { sheet: 'greeting', first: 0, scale: 0.71, anchor: [221, 420], timing: [[0,5],[1,4],[2,4],[3,8],[4,5],[5,7],[6,6],[7,6]] },
  stretch: { sheet: 'yawn', first: 0, scale: 0.71, anchor: [220, 419], timing: [[0,5],[1,8],[2,7],[3,6],[4,14],[5,8],[6,7],[7,6]] },
  work: { sheet: 'typing', first: 0, scale: 0.63, anchor: [222, 425], timing: [[0,3],[1,3],[2,4],[1,3],[3,7],[0,3],[1,3],[4,9],[5,3],[6,6],[7,5]] },
  success: { sheet: 'states', first: 4, scale: 0.85, anchor: [181, 348], timing: [[0,5],[1,5],[2,11],[1,5],[3,6]] },
  reaction: { sheet: 'states', first: 8, scale: 0.85, anchor: [181, 348], timing: [[0,4],[1,4],[2,8],[1,4],[3,5],[0,3]] },
  tower: { sheet: 'tower', first: 0, scale: 0.52, anchor: [235, 641], timing: [[0,7],[1,6],[2,8],[3,12],[2,5],[1,5],[0,5]] },
  router: { sheet: 'repair', first: 0, scale: 0.45, anchor: [277, 610], timing: [[0,8],[1,13],[2,9],[3,12]] },
  topology: { sheet: 'hardware', first: 0, scale: 0.74, anchor: [141, 410], timing: [[0,6],[1,8],[2,10],[3,11]] },
  computer: { sheet: 'hardware', first: 4, scale: 0.74, anchor: [141, 412], timing: [[0,7],[1,7],[2,11],[3,11]] },
};

function renderCel(sheet, index, scale, [anchorX, baseline]) {
  const file = path.join(art, sheet + '.png');
  const png = fs.readFileSync(file);
  const [cols, rows] = grids[sheet];
  const iw = png.readUInt32BE(16), ih = png.readUInt32BE(20);
  const col = index % cols, row = Math.floor(index / cols);
  const x = Math.round(col * iw / cols), y = Math.round(row * ih / rows);
  const w = Math.round((col + 1) * iw / cols) - x;
  const h = Math.round((row + 1) * ih / rows) - y;
  const left = Math.round(width / 2 - anchorX * scale);
  const top = Math.round(324 - baseline * scale);
  // Position with an oversize pad and crop, allowing the clear margins of a
  // source cell to extend beyond the frame without shifting its anchor.
  const filters = ['format=rgba', `crop=${w}:${h}:${x}:${y}:exact=1`,
    "lutrgb=a='clip((val-18)*255/232,0,255)'",
    `scale=${Math.round(w*scale)}:${Math.round(h*scale)}:flags=lanczos`, 'format=rgba',
    `pad=960:560:${left+160}:${top+100}:color=black@0`, 'crop=640:360:160:100:exact=1'];
  const cel = transcode(['-i', file, '-vf', filters.join(','), '-frames:v', '1', '-pix_fmt', 'rgba', '-f', 'rawvideo', 'pipe:1']);
  if (cel.length !== width * height * 4) throw new Error('Incomplete cel: ' + sheet);
  return cel;
}

function idleCels() {
  const open = renderCel('front', 0, 0.229, [553, 1308]);
  const closedPortrait = renderCel('blink', 0, 0.226, [559, 1324]);
  const closed = Buffer.from(open);
  // Composite only the eye area from the registered closed-eye drawing.
  for (let y = 124; y < 160; y++) {
    for (let x = 271; x < 369; x++) {
      const blend = Math.min(1, (x-271)/3, (368-x)/3, (y-124)/3, (159-y)/3);
      const offset = (y*width+x)*4;
      for (let channel = 0; channel < 3; channel++) {
        const i = offset+channel;
        closed[i] = Math.round(open[i]*(1-blend) + closedPortrait[i]*blend);
      }
    }
  }
  return [open, closed];
}

function rawInput(file, rate = fps) {
  return ['-f','rawvideo','-pix_fmt','rgba','-s',width+'x'+height,'-r',String(rate),'-i',file];
}

function encode(name, temp, writeFrames, rate = fps) {
  const raw = path.join(temp, 'frames.rgba');
  const fd = fs.openSync(raw, 'w');
  try {
    writeFrames(fd);
  } finally { fs.closeSync(fd); }
  const output = path.join(temp, name + '.webm');
  transcode([...rawInput(raw, rate), '-an', '-c:v', 'libvpx-vp9', '-pix_fmt', 'yuva420p',
    '-lossless', '1', '-b:v','0', '-auto-alt-ref','0', '-threads','4', '-deadline','good', '-cpu-used','5', output]);
  fs.copyFileSync(output, path.join(assets, name + '.webm'));
  console.log(name, fs.statSync(raw).size / (width*height*4) + ' frames');
}

function writeIcons(raw) {
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map(size => transcode([...rawInput(raw), '-vf',
    `crop=184:184:228:27,scale=${size}:${size}:flags=lanczos`, '-frames:v','1','-c:v','png','-f','image2pipe','pipe:1']));
  fs.writeFileSync(path.join(root,'assets/tray.png'), frames[sizes.indexOf(64)]);
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

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'coco-v9-'));
try {
  encode('run', temp, fd => writeRun(fd, renderCel, temp), fps*2);
  if (process.argv.includes('--run-only')) return;
  const idle = idleCels();
  const raw = path.join(temp, 'open.rgba');
  fs.writeFileSync(raw, idle[0]);
  transcode([...rawInput(raw), '-frames:v','1', path.join(assets, 'idle-frame.png')]);
  writeIcons(raw);
  encode('idle', temp, fd => writeMotion(fd, 'idle', idle, [[0,48],[1,3],[0,77]], temp));
  for (const [name, { sheet, first, scale, anchor, timing }] of Object.entries(actions)) {
    const count = 1 + Math.max(...timing.map(([index]) => index));
    const cels = Array.from({length: count}, (_, i) => renderCel(sheet, first+i, scale, anchor));
    encode(name, temp, fd => writeMotion(fd, name, cels, timing, temp));
  }
} finally {
  for (const file of fs.readdirSync(temp)) fs.unlinkSync(path.join(temp, file));
  fs.rmdirSync(temp);
}
