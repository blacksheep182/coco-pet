'use strict';

const fs = require('node:fs');
const { RUN_FRAMES, RUN_DISTANCE, runProgress } = require('../lib/coco-pet-run');
const { flowsFor, premultiply, sample, render } = require('./animate-cels.cjs');

const width = 640, height = 360;
const distance = RUN_DISTANCE * width / 384;
const travel = frame => distance * runProgress(frame / RUN_FRAMES);
const smooth = value => {
  const t = Math.max(0, Math.min(1, value));
  return t * t * (3 - 2 * t);
};

// 0–7 are the eight finished drawings. 0 and 4 are opposite footfalls,
// 3 and 7 are airborne. 8 prepares the launch, 9 brakes, 10 is the approved
// front portrait. The times use the desktop movement's 24 fps design clock.
const exposure = [
  [0,10],[3,8],[6,8],
  [8,0],[11,1],[14,2],[17,3],
  [20,4],[23,5],[26,6],[28,7],
  [30,0],[32.5,1],[35,2],[38,3],
  [40,4],[42.5,5],[45,6],[48,7],
  [51,0],[53.5,1],[56,2],[59,3],
  [62,4],[65,5],[68,9],[71,10],[72,10],
];

function soleContact(frame) {
  // Use the centre of the actual ink touching the ground. Some drawings
  // land on the heel, while the passing poses roll onto the front sole.
  let bottom = 0, total = 0, count = 0;
  for (let y=220; y<height; y++) for (let x=180; x<475; x++) {
    if (frame[(y*width+x)*4+3] > 170) bottom = y;
  }
  for (let y=bottom-2; y<=bottom; y++) for (let x=180; x<475; x++) {
    if (frame[(y*width+x)*4+3] > 170) { total += x; count++; }
  }
  if (!count) throw new Error('Running drawing has no visible shoe');
  return {x:total/count,y:bottom};
}

function plantFeet(keys) {
  for (let i=0; i<keys.length; i++) {
    const lead=keys[i].cel;
    if (lead!==0 && lead!==4) continue;
    const stance=[keys[i]];
    for (let offset=1; offset<=2 && keys[i+offset]?.cel===lead+offset; offset++) stance.push(keys[i+offset]);
    const footprint=stance.reduce((sum,k)=>sum+k.pin.x+k.worldX,0)/stance.length;
    for (const k of stance) {
      k.dx=footprint-k.pin.x-k.worldX;
      k.dy=323-k.pin.y;
    }
  }
}

function desktopKey(key, source) {
  const frame=Buffer.alloc(width*height*4), p=new Float64Array(4);
  const {dx,dy,pin,worldX}=key;
  // Make the in-betweens in desktop space: a planted shoe is drawn at the
  // same point in successive keys while the head and hips travel past it.
  for (let y=9; y<343; y++) for (let x=50; x<593; x++) {
    const localX=x-worldX;
    const w=smooth((y-237)/60)*smooth((75-Math.abs(localX-pin.x-dx))/34);
    sample(source,localX-w*dx,y-w*dy,p);
    const a=Math.round(p[3]);
    if (a<2) continue;
    const dest=(y*width+x)*4;
    frame[dest+3]=a;
    for (let c=0; c<3; c++) frame[dest+c]=Math.min(255,Math.round(p[c]*255/p[3]));
  }
  return frame;
}

function writeRun(fd, renderCel, dir) {
  const raw=Array.from({length:8},(_,i)=>renderCel('jog/stride-cels',i,.735,[230,434]));
  raw.push(renderCel('jog/bookends',1,.46,[266,670]),renderCel('jog/bookends',2,.46,[266,670]),
    renderCel('front',0,.229,[553,1308]));
  const pins=raw.map(soleContact);
  const source=raw.map(premultiply);
  const keys=exposure.map(([time,cel])=>({time,cel,pin:pins[cel],worldX:travel(time)-distance/2,dx:0,dy:0}));
  plantFeet(keys);
  const drawings=keys.map(key=>desktopKey(key,source[key.cel]));
  const maps=flowsFor(drawings,keys.map((_,i)=>[i,1]),dir);
  const textures=drawings.map(premultiply);
  const weights=new Float32Array(width*height*2);
  let key=0;
  for (let i=0; i<RUN_FRAMES*2; i++) {
    const time=i/2;
    while (time>=keys[key+1].time) key++;
    const a=keys[key], b=keys[key+1];
    let phase=(time-a.time)/(b.time-a.time);
    // The plug changes sides as she turns towards the viewer. Expose the
    // drawn angles on twos here instead of warping one face into the other.
    if (a.cel===10 || b.cel===10) phase=phase<.5 ? 0 : 1;
    const frame=render(textures[key],textures[key+1],maps.get(key+':'+(key+1)),maps.get((key+1)+':'+key),
      phase,[0,0,0,0],weights,distance/2-travel(time));
    fs.writeFileSync(fd,frame);
  }
}
module.exports={ writeRun };
