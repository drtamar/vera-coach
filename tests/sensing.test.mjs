import {
  yinPitch, pitchSemitoneSD, terminalPitchSlope, hzToSemitones,
  silenceProfile, wordsPerMinute, fillerDensity, hedgeDensity, apologyCount,
  negativeEchoes, rms,
} from '../app/sensing/audio.mjs';
import {
  eyeAspectRatio, blinkRate, irisOffset, onLens, gazeFixationRatio,
  horizontalDeviationDeg, headPose, headTiltAngle, yawDeviationDeg,
  inTruthPlane, truthPlaneOccupancy, handsBelowFrameRuns,
  torsoLateralDisplacementCm, clavicularRiseMm, auEvents, auScore, POSE, EYE,
} from '../app/sensing/vision.mjs';

const pass = [], fail = [];
const t = (n, c, extra='') => (c ? pass : fail).push(n + (c ? '' : `  ${extra}`));
const near = (a, b, e) => Math.abs(a - b) < e;

/* ========== AUDIO: known-ground-truth signals ========== */

function sine(hz, sr, n) {
  const b = new Float32Array(n);
  for (let i = 0; i < n; i++) b[i] = Math.sin(2 * Math.PI * hz * i / sr);
  return b;
}

for (const hz of [110, 200, 330]) {
  const got = yinPitch(sine(hz, 44100, 2048), 44100);
  t(`YIN: recovers a ${hz}Hz tone`, got !== null && near(got, hz, hz * 0.03), `got ${got}`);
}
t('YIN: rejects white noise as unvoiced', (() => {
  const b = new Float32Array(2048).map(() => Math.random() * 2 - 1);
  const p = yinPitch(b, 44100);
  return p === null || p < 50 || p > 500;
})());
t('YIN: rejects a sub-audible frequency', yinPitch(sine(20, 44100, 2048), 44100) === null);
t('YIN: handles a too-short buffer without throwing', yinPitch(new Float32Array(2), 44100) === null);

t('semitones: an octave is 12', near(hzToSemitones(220) - hzToSemitones(110), 12, 1e-9));
t('pitch SD: a monotone track is ~0', near(pitchSemitoneSD([200, 200, 200, 200]), 0, 1e-9));
t('pitch SD: a varied track is non-trivial', pitchSemitoneSD([150, 200, 250, 180, 300]) > 2);
t('pitch SD: needs two points', pitchSemitoneSD([200]) === null);

t('terminal slope: a rising tail is positive (uptalk)',
  terminalPitchSlope([180,180,180,180,190,200,215,230], 20, 500) > 0);
t('terminal slope: a falling tail is negative (decisive)',
  terminalPitchSlope([230,215,200,190,180,175,170,165], 20, 500) < 0);
t('terminal slope: a flat tail is ~0',
  near(terminalPitchSlope([200,200,200,200,200,200], 20, 500), 0, 1e-6));

t('rms: silence is 0', rms(new Float32Array(100)) === 0);
t('rms: unit signal is 1', near(rms(new Float32Array(100).fill(1)), 1, 1e-9));

{
  // 10 frames of 100ms: 6 loud, then 4 quiet = 400ms trailing pause
  const track = [1,1,1,1,1,1,0,0,0,0].map(v => v * 0.5);
  const s = silenceProfile(track, 100);
  t('silence: ratio computed', near(s.silence_ratio, 0.4, 1e-9));
  t('silence: pause detected', s.pauses.length === 1 && s.pauses[0] === 400);
  t('silence: short pause is not a freeze', s.freezes === 0);
  const long = silenceProfile(new Array(40).fill(0), 100);
  t('silence: a 4s gap counts as a freeze', long.freezes === 1);
}

{
  const text = 'one two three four five six seven eight nine ten';
  t('WPM: 10 words in 6s is 100', near(wordsPerMinute(text, 6), 100, 1e-9));
  t('WPM: 10 words in 4.286s is ~140', near(wordsPerMinute(text, 60/14), 140, 0.1));
  t('WPM: zero duration is null', wordsPerMinute(text, 0) === null);
}

{
  // 3 fillers ('um','like','uh') in 19 words
  const script = 'um so the thing is like we shipped it and uh it went out on friday morning ok fine';
  const d = fillerDensity(script);
  t('filler density: matches the scripted count', near(d, 3/19, 0.001), `got ${d}`);
  t('filler density: clean speech is 0', fillerDensity('we shipped it on friday') === 0);
  t('filler density: empty transcript is null', fillerDensity('') === null);
  t('filler density: "right" as an adjective is not a disfluency',
    fillerDensity('that is the right call and we turn right') === 0);
}

{
  const hedged = 'i think maybe this is kind of the right call does that make sense';
  t('hedge density: detects hedges fillers would miss', hedgeDensity(hedged) > 0);
  t('hedge density: a fluent hedge still registers',
    fillerDensity('i think maybe this is kind of right') === 0 &&
    hedgeDensity('i think maybe this is kind of right') > 0);
  t('hedge density: an assertion is 0', hedgeDensity('this is the right call') === 0);
}

t('apologies: counted', apologyCount('sorry let me start again') === 2);
t('apologies: none in clean delivery', apologyCount('we shipped on friday') === 0);
t('negative echo: repeating the loaded term is caught',
  negativeEchoes('the delay was caused by staffing', ['delay']) === 1);
t('negative echo: avoiding it scores 0',
  negativeEchoes('our timeline shifted because of staffing', ['delay']) === 0);

/* ========== VISION: synthetic landmark fixtures ========== */

function face({ open = 0.3, irisX = 0, irisY = 0 } = {}) {
  const lm = [];
  const put = (i, x, y) => { lm[i] = { x, y, z: 0 }; };
  for (const side of ['left', 'right']) {
    const e = EYE[side];
    const cx = side === 'left' ? 0.4 : 0.6;
    put(e.outer, cx - 0.05, 0.5);
    put(e.inner, cx + 0.05, 0.5);
    put(e.top[0], cx - 0.02, 0.5 - open * 0.05);
    put(e.top[1], cx + 0.02, 0.5 - open * 0.05);
    put(e.bottom[0], cx - 0.02, 0.5 + open * 0.05);
    put(e.bottom[1], cx + 0.02, 0.5 + open * 0.05);
    put(e.iris[0], cx + irisX * 0.05, 0.5 + irisY * open * 0.05);
  }
  return lm;
}

{
  const openEye = eyeAspectRatio(face({ open: 1.0 }), 'left');
  const shutEye = eyeAspectRatio(face({ open: 0.02 }), 'left');
  t('EAR: open eye scores higher than shut', openEye > shutEye, `${openEye} vs ${shutEye}`);
  t('EAR: shut eye falls below the blink threshold', shutEye < 0.21, `${shutEye}`);
  t('EAR: open eye is above the blink threshold', openEye > 0.21, `${openEye}`);
}

{
  // 600 frames at 50ms = 30s. Blink = 2 frames closed. 10 blinks -> 20/min.
  const track = [];
  for (let i = 0; i < 600; i++) track.push(i % 60 < 2 ? 0.1 : 0.3);
  const r = blinkRate(track, 50);
  t('blink rate: 10 blinks in 30s reads as 20/min', near(r, 20, 0.5), `got ${r}`);
  t('blink rate: no blinks reads 0', blinkRate(new Array(600).fill(0.3), 50) === 0);
  const staring = new Array(600).fill(0.1);
  t('blink rate: sustained closure is not counted as blinks', blinkRate(staring, 50) === 0);
}

{
  t('gaze: centred iris reads as on-lens', onLens(face({ irisX: 0, irisY: 0 })) === true);
  t('gaze: far-off iris reads as off-lens', onLens(face({ irisX: 1.2, irisY: 0 })) === false);
  t('gaze: missing iris landmarks returns null', onLens([]) === null);
  t('gaze: ratio over a track', near(gazeFixationRatio([true,true,true,false,null]), 0.75, 1e-9));
  t('gaze: all-null track is null', gazeFixationRatio([null, null]) === null);
  const steady = new Array(20).fill(0).map(() => irisOffset(face({ irisX: 0 }), 'left'));
  const scanning = new Array(20).fill(0).map((_, i) => irisOffset(face({ irisX: i % 2 ? 1 : -1 }), 'left'));
  t('gaze: horizontal scanning exceeds steady fixation',
    horizontalDeviationDeg(scanning) > horizontalDeviationDeg(steady));
  t('gaze: steady fixation is within the 1.2deg teleprompter bar',
    horizontalDeviationDeg(steady) <= 1.2, `${horizontalDeviationDeg(steady)}`);
}

{
  const I = [1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1];
  const p = headPose(I);
  t('head pose: identity matrix is level', near(p.yaw,0,1e-9) && near(p.roll,0,1e-9) && near(p.pitch,0,1e-9));
  const th = 8 * Math.PI/180, c = Math.cos(th), s = Math.sin(th);
  const rollM = [1,0,0,0, 0,c,-s,0, 0,s,c,0, 0,0,0,1];
  t('head pose: an 8-degree tilt is recovered', near(headTiltAngle(headPose(rollM)), 8, 0.01));
  t('head pose: null matrix is handled', headPose({ data: null }) === null);
  t('yaw deviation: a still head is ~0',
    near(yawDeviationDeg(new Array(10).fill({ yaw: 3, pitch: 0, roll: 0 })), 0, 1e-9));
  t('yaw deviation: a swivelling head is large',
    yawDeviationDeg([{yaw:-20},{yaw:20},{yaw:-20},{yaw:20}]) > 5);
}

function body({ wristY = 0.55, x = 0.5, shoulderY = 0.4 } = {}) {
  const p = [];
  p[POSE.leftShoulder]  = { x: x - 0.1, y: shoulderY };
  p[POSE.rightShoulder] = { x: x + 0.1, y: shoulderY };
  p[POSE.leftHip]       = { x: x - 0.08, y: 0.7 };
  p[POSE.rightHip]      = { x: x + 0.08, y: 0.7 };
  p[POSE.leftWrist]     = { x: x - 0.15, y: wristY };
  p[POSE.rightWrist]    = { x: x + 0.15, y: wristY };
  return p;
}

{
  t('TruthPlane: hands between navel and sternum count', inTruthPlane(body({ wristY: 0.55 })) === true);
  t('TruthPlane: hands below the navel do not', inTruthPlane(body({ wristY: 0.9 })) === false);
  t('TruthPlane: hands above the sternum do not', inTruthPlane(body({ wristY: 0.2 })) === false);
  t('TruthPlane: occupancy over a track',
    near(truthPlaneOccupancy([true,true,false,false]), 0.5, 1e-9));
  const off = new Array(8).fill(0).map(() => body({ wristY: 1.4 }));
  const runs = handsBelowFrameRuns(off, 500);
  t('TruthPlane: a sustained out-of-frame run is measured', runs.length === 1 && runs[0] === 4000);
  t('TruthPlane: 4s out of frame breaches the 3s operational limit', runs[0] > 3000);
}

{
  const still = new Array(30).fill(0).map(() => body({ x: 0.5 }));
  const swaying = new Array(30).fill(0).map((_, i) => body({ x: 0.5 + Math.sin(i / 3) * 0.05 }));
  const s1 = torsoLateralDisplacementCm(still), s2 = torsoLateralDisplacementCm(swaying);
  t('sway: a still torso is under the 2cm bar', s1 < 2.0, `${s1}`);
  t('sway: a swaying torso exceeds it', s2 > 2.0, `${s2}`);
  const breathing = new Array(20).fill(0).map((_, i) => body({ shoulderY: 0.4 - (i % 10) * 0.004 }));
  t('clavicle: shoulder travel is measured in mm', clavicularRiseMm(breathing) > 0);
  t('clavicle: a still upper torso is under the 5mm bar',
    clavicularRiseMm(new Array(10).fill(0).map(() => body())) < 5);
}

{
  const bs = v => [{ categoryName: 'mouthSmileLeft', score: v }, { categoryName: 'mouthSmileRight', score: v }];
  t('AU: smile score read from blendshapes', near(auScore(bs(0.8), 'au12_smile'), 0.8, 1e-9));
  t('AU: absent blendshapes return null', auScore([], 'au12_smile') === null);
  const track = [bs(0.1), bs(0.8), bs(0.9), bs(0.1), bs(0.7), bs(0.1)];
  t('AU: counts discrete activations, not frames', auEvents(track, 'au12_smile') === 2);
  t('AU: a flat low track is zero events', auEvents([bs(0.1), bs(0.1)], 'au12_smile') === 0);
}

console.log(pass.map(s => '  PASS  ' + s).join('\n'));
if (fail.length) console.log('\n' + fail.map(s => '  FAIL  ' + s).join('\n'));
console.log(`\n${pass.length} passed, ${fail.length} failed`);
process.exit(fail.length ? 1 : 0);
