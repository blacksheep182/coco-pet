'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const width = 640, height = 360;
const clamp = x => Math.max(0, Math.min(1, x));
const ease = x => x * x * (3 - 2 * x);

// Offsets and tilt at the head; motion falls away towards the planted feet.
// The plug has its own offset so that it can settle after the torso.
const motion = {
  idle: [[0,0,0,0,0],[.21,.8,-2.6,.55,-3],[.43,.4,.2,.28,2],[.58,-1.2,1.3,-.6,3],[.79,-.7,-2.1,-.3,-2],[1,0,0,0,0]],
  wave: [[0,0,0,0,0],[.12,-2,3,-1,-3],[.32,3,-3,1.5,3],[.48,5,-1,2,6],[.60,2,1,.4,2],[.77,-2,-1,-1,-4],[1,0,0,0,0]],
  stretch: [[0,0,0,0,0],[.18,-1,4,-.7,2],[.53,1,-7,1.4,-4],[.65,2,-5,1.7,-2],[.80,-1,2,-1,3],[1,0,0,0,0]],
  work: [[0,0,0,0,0],[.18,-1,2,-.4,0],[.36,2,4,.8,0],[.60,1,-2,.1,0],[.78,-1,.5,-.6,0],[1,0,0,0,0]],
  success: [[0,0,0,0,0],[.15,-2,4,-1,-3],[.36,3,-6,2,3],[.53,1,1,.8,4],[.72,2,-1,.4,-2],[1,0,0,0,0]],
  reaction: [[0,0,0,0,0],[.12,-1,3,-.5,-1],[.29,3,-4,1.5,3],[.48,1,2,.8,2],[.67,1,-1,.3,-1],[1,0,0,0,0]],
  tower: [[0,0,0,0,0],[.23,2,2,.8,0],[.44,1,-3,-.7,0],[.68,3,-2,.8,0],[1,0,0,0,0]],
  router: [[0,0,0,0,0],[.22,2,3,1.2,0],[.53,3,1,.8,0],[.72,-2,-3,-1,0],[1,0,0,0,0]],
  topology: [[0,0,0,0,0],[.29,2,2,.8,0],[.55,3,0,1,0],[.75,-1,-2,-.8,0],[1,0,0,0,0]],
  computer: [[0,0,0,0,0],[.24,2,1,.7,0],[.60,4,4,1.4,0],[.76,-2,-2,-.6,0],[1,0,0,0,0]],
};

function at(points, u) {
  const end = points.findIndex(k => k[0] >= u);
  if (end <= 0) return points[end === 0 ? 0 : points.length - 1].slice(1);
  const a = points[end - 1], b = points[end], t = ease((u - a[0]) / (b[0] - a[0]));
  return a.slice(1).map((v, i) => v + (b[i + 1] - v) * t);
}

function flowsFor(cels, timing, dir) {
  const pairs = new Map();
  for (let i = 0; i < timing.length; i++) {
    const a = timing[i][0], b = timing[(i+1) % timing.length][0];
    if (a !== b) { pairs.set(a+':'+b,[a,b]); pairs.set(b+':'+a,[b,a]); }
  }
  for (const [i, cel] of cels.entries()) fs.writeFileSync(path.join(dir,'key-'+i+'.rgba'),cel);
  execFileSync(process.env.PYTHON || 'python', [path.join(__dirname,'measure-motion.py'),dir,JSON.stringify([...pairs.values()])],{windowsHide:true});
  const maps = new Map();
  for (const [key,[a,b]] of pairs) {
    const buf = fs.readFileSync(path.join(dir,'flow-'+a+'-'+b+'.bin'));
    maps.set(key,new Float32Array(buf.buffer,buf.byteOffset,buf.length/4));
  }
  return maps;
}

// Work in premultiplied colour so interpolating across an outline never
// picks up the hidden matte colour in a transparent texel.
function premultiply(frame) {
  const result = Buffer.from(frame);
  for (let i = 0; i < frame.length; i += 4) {
    const a = frame[i+3] / 255;
    for (let c = 0; c < 3; c++) result[i+c] = Math.round(frame[i+c] * a);
  }
  return result;
}

function sample(frame, x, y, out) {
  const ix = Math.floor(x), iy = Math.floor(y);
  const i = 4 * (iy * width + ix), fx = x-ix, fy = y-iy;
  if (ix < 0 || iy < 0 || ix >= width-1 || iy >= height-1) { out.fill(0); return; }
  for (let c = 0; c < 4; c++) {
    const a = frame[i+c], b = frame[i+4+c], d = frame[i+4*width+c], e = frame[i+4*width+4+c];
    out[c] = (a + fx*(b-a))*(1-fy) + (d + fx*(e-d))*fy;
  }
}

function bodyWeights(name) {
  const propBoundary = {tower:336, router:366, topology:367, computer:364}[name];
  const weights = new Float32Array(width*height*2);
  for (let y=0; y<height; y++) for (let x=0; x<width; x++) {
    const i = (y*width+x)*2;
    let w = ease(clamp((305-y)/146));
    if (propBoundary) w *= ease(clamp((propBoundary-x)/32));
    if (name === 'work') w *= ease(clamp((205-y)/38));
    weights[i] = w;
    if (['idle','wave','success','stretch','reaction'].includes(name)) {
      weights[i+1] = ease(clamp((x-348)/35)) * ease(clamp((y-185)/37)) * ease(clamp((318-y)/37));
    }
  }
  return weights;
}

function render(a, b, forward, backward, t, pose, weights, cameraX = 0) {
  const frame = Buffer.alloc(width*height*4), p = new Float64Array(4);
  const [dx,dy,degrees,tail] = pose, angle=degrees*Math.PI/180;
  // At a disocclusion there is no matching ink in the other key. Expose a
  // single drawing at a time and move its lines along the measured flow.
  const source = t < .5 ? a : b;
  const flow = t < .5 ? forward : backward;
  const phase = t < .5 ? t : 1-t;
  for (let y=8; y<344; y++) for (let x=118; x<551; x++) {
    const i=y*width+x, w=weights[i*2], cable=weights[i*2+1];
    const sx=x - cameraX - w*(dx-angle*(y-196)) - cable*tail*.35;
    const sy=y - w*(dy+angle*(x-320)) - cable*tail;
    if (sx<2 || sx>=width-2) continue;
    if (!t) { sample(source,sx,sy,p); }
    else {
      const fi=(Math.floor(sy/2)*320+Math.floor(sx/2))*2;
      const step = 2*phase;
      const ix=Math.floor((sx-step*flow[fi])/2), iy=Math.floor((sy-step*flow[fi+1])/2);
      const j=(Math.max(0,Math.min(179,iy))*320+Math.max(0,Math.min(319,ix)))*2;
      const vx=Math.max(-12,Math.min(12,(flow[fi]+flow[j])*.5));
      const vy=Math.max(-12,Math.min(12,(flow[fi+1]+flow[j+1])*.5));
      sample(source,sx-step*vx,sy-step*vy,p);
    }
    const alpha=Math.round(p[3]);
    if (alpha<3) continue;
    const dest=i*4;
    frame[dest+3]=alpha;
    for (let c=0;c<3;c++) frame[dest+c]=Math.min(255,Math.round(p[c]*255/p[3]));
  }
  return frame;
}

function writeMotion(fd, name, cels, timing, dir) {
  const maps = name === 'idle' ? new Map() : flowsFor(cels,timing,dir);
  const keys = cels.map(premultiply), weights=bodyWeights(name);
  const total=timing.reduce((n,key)=>n+key[1],0);
  let frame=0;
  for (const [k,[a,count]] of timing.entries()) {
    const loop = name === 'work';
    const b = k === timing.length-1 && !loop ? a : timing[(k+1)%timing.length][0];
    const window = Math.min(count, 4);
    for (let j=0; j<count; j++,frame++) {
      const t = name === 'idle' || a === b ? 0 : ease(clamp((j-count+window)/window));
      const pose=at(motion[name],frame/(total-1));
      fs.writeFileSync(fd,render(keys[a],keys[b],maps.get(a+':'+b),maps.get(b+':'+a),t,pose,weights));
    }
  }
}

module.exports = { writeMotion, flowsFor, premultiply, sample, render };
