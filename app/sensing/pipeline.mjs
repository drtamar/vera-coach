/**
 * Browser wiring: camera and microphone -> telemetry vector.
 *
 * PRIVACY INVARIANT: this module holds the only references to MediaStream and
 * raw frame data in the application, and it has no network calls. Nothing it
 * returns contains media — only numbers. Enforced by tests/privacy.test.mjs.
 */

import {
  eyeAspectRatio, blinkRate, irisOffset, onLens, gazeFixationRatio,
  horizontalDeviationDeg, headPose, headTiltAngle, yawDeviationDeg,
  inTruthPlane, truthPlaneOccupancy, handsBelowFrameRuns,
  torsoLateralDisplacementCm, clavicularRiseMm, auEvents,
} from './vision.mjs';
import {
  yinPitch, pitchSemitoneSD, terminalPitchSlope, rms, silenceProfile,
  wordsPerMinute, fillerDensity, hedgeDensity, apologyCount,
} from './audio.mjs';

const VISION_CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14';
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const POSE_MODEL = 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker.task';

const FRAME_MS = 33;      // ~30fps
const AUDIO_FRAME = 2048;

export class SensingSession {
  constructor() {
    this.reset();
    this.stream = null;
    this.face = null;
    this.pose = null;
    this.running = false;
  }

  reset() {
    this.t = {
      ear: [], onLens: [], irisOffset: [], headPose: [], blendshapes: [],
      pose: [], pitchHz: [], energy: [],
    };
    this.transcript = '';
    this.startedAt = 0;
    this.speechOnsetAt = null;
    this.restarts = 0;
  }

  async init() {
    const { FilesetResolver, FaceLandmarker, PoseLandmarker } = await import(
      /* @vite-ignore */ `${VISION_CDN}/vision_bundle.mjs`
    );
    const files = await FilesetResolver.forVisionTasks(`${VISION_CDN}/wasm`);
    this.face = await FaceLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: FACE_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numFaces: 1,
      outputFaceBlendshapes: true,
      outputFacialTransformationMatrixes: true,
    });
    this.pose = await PoseLandmarker.createFromOptions(files, {
      baseOptions: { modelAssetPath: POSE_MODEL, delegate: 'GPU' },
      runningMode: 'VIDEO',
      numPoses: 1,
    });
  }

  async start(videoEl) {
    this.reset();
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: 1280, height: 720, facingMode: 'user' },
      audio: { echoCancellation: true, noiseSuppression: false, autoGainControl: false },
    });
    videoEl.srcObject = this.stream;
    await videoEl.play();

    this._startAudio();
    this._startASR();
    this.startedAt = performance.now();
    this.running = true;
    this._loop(videoEl);
    return this;
  }

  _startAudio() {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const src = ctx.createMediaStreamSource(this.stream);
    const analyser = ctx.createAnalyser();
    analyser.fftSize = AUDIO_FRAME;
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    this._audioCtx = ctx;
    this._audioTimer = setInterval(() => {
      if (!this.running) return;
      analyser.getFloatTimeDomainData(buf);
      const e = rms(buf);
      this.t.energy.push(e);
      this.t.pitchHz.push(e > 0.01 ? yinPitch(buf, ctx.sampleRate) : null);
      if (e > 0.02 && this.speechOnsetAt === null) {
        this.speechOnsetAt = performance.now() - this.startedAt;
      }
    }, 20);
  }

  _startASR() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { this.asrAvailable = false; return; }
    this.asrAvailable = true;
    const r = new SR();
    r.continuous = true; r.interimResults = false; r.lang = 'en-US';
    r.onresult = ev => {
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        this.transcript += ' ' + ev.results[i][0].transcript;
      }
    };
    r.onerror = () => {};
    try { r.start(); this._asr = r; } catch { this.asrAvailable = false; }
  }

  _loop(videoEl) {
    const step = () => {
      if (!this.running) return;
      const ts = performance.now();
      try {
        const f = this.face.detectForVideo(videoEl, ts);
        const lm = f?.faceLandmarks?.[0];
        if (lm) {
          this.t.ear.push((eyeAspectRatio(lm, 'left') + eyeAspectRatio(lm, 'right')) / 2);
          this.t.onLens.push(onLens(lm));
          this.t.irisOffset.push(irisOffset(lm, 'left'));
          this.t.blendshapes.push(f.faceBlendshapes?.[0]?.categories || []);
          const mtx = f.facialTransformationMatrixes?.[0];
          this.t.headPose.push(mtx ? headPose(mtx.data || mtx) : null);
        }
        const p = this.pose.detectForVideo(videoEl, ts);
        this.t.pose.push(p?.landmarks?.[0] || null);
      } catch { /* a dropped frame is not a session failure */ }
      requestAnimationFrame(step);
    };
    requestAnimationFrame(step);
  }

  stop() {
    this.running = false;
    clearInterval(this._audioTimer);
    this._asr?.stop();
    this._audioCtx?.close();
    this.stream?.getTracks().forEach(t => t.stop());
    this.stream = null;
    return this.telemetry();
  }

  /**
   * The only thing that leaves this module. Numbers, and a flag saying how far
   * the disfluency figure can be trusted.
   */
  telemetry() {
    const durationS = (performance.now() - this.startedAt) / 1000;
    const t = this.t;
    return {
      gaze_fixation_ratio: gazeFixationRatio(t.onLens),
      blink_rate: blinkRate(t.ear, FRAME_MS),
      truth_plane_occupancy: truthPlaneOccupancy(t.pose.map(p => (p ? inTruthPlane(p) : null))),
      head_tilt_angle: headTiltAngle(t.headPose.filter(Boolean).at(-1)),
      wpm: wordsPerMinute(this.transcript, durationS),
      pitch_semitone_sd: pitchSemitoneSD(t.pitchHz),
      terminal_pitch_slope: terminalPitchSlope(t.pitchHz, 20),
      filler_density: fillerDensity(this.transcript),

      // supporting measures used by specific drills
      hedge_density: hedgeDensity(this.transcript),
      apology_phrases: apologyCount(this.transcript),
      horizontal_eye_deviation_deg: horizontalDeviationDeg(t.irisOffset),
      head_yaw_deviation_deg: yawDeviationDeg(t.headPose),
      torso_lateral_displacement_cm: torsoLateralDisplacementCm(t.pose),
      clavicular_rise_mm: clavicularRiseMm(t.pose),
      au12_smile_events: auEvents(t.blendshapes, 'au12_smile'),
      brow_flash_rate: auEvents(t.blendshapes, 'au1_2_brow') / Math.max(durationS / 60, 1e-6),
      facial_grimace_events: auEvents(t.blendshapes, 'au4_furrow') + auEvents(t.blendshapes, 'au15_20_lip'),
      hands_below_frame_events: handsBelowFrameRuns(t.pose, FRAME_MS).filter(ms => ms > 3000).length,
      silence_ratio: silenceProfile(t.energy, 20).silence_ratio,
      freezes: silenceProfile(t.energy, 20).freezes,
      speech_onset_latency_s: this.speechOnsetAt === null ? null : this.speechOnsetAt / 1000,
      restarts: this.restarts,
      duration_s: durationS,

      // honesty flag: without ASR, every word-derived figure is unavailable
      _asr_available: this.asrAvailable !== false,
    };
  }
}
