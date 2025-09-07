/* Looper Pedal Board – RC-505 style behaviour + After-FX offline pitch (granular)
   - Overdub recording uses raw mic stream (no master mix) to avoid re-recording playback
   - Muting master/monitor during overdub to avoid acoustic bleed (optionally toggleable)
   - After-FX Pitch replaced by offline granular pitch-shift (preserve duration)
   - Phase-locked recording / quantize behavior retained for master + dependent tracks
   Date: 2025-09-06 (user requested RC-505 behavior + phase-vocoder-style pitch replacement)
*/

let audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
let micStream = null, micSource = null;

// === Robustness / performance parameters ===
const GLOBALS = {
  WORKER_POOL_SIZE: Math.max(1, (navigator.hardwareConcurrency || 2) - 1), // pitch worker pool
  PITCH_GRAIN_SIZE: 2048,
  PITCH_HOP_RATIO: 0.25,          // hop = grainSize * hop_ratio
  PITCH_JOB_TIMEOUT_MS: 45_000,   // timeout per pitch job (45s)
  UNDO_STACK_LIMIT: 6,            // per-track undo slots
  RECORDER_GLOBAL_TIMEOUT_MS: 120_000, // fallback guard for long recordings (2 mins)
  RECORDER_POLL_INTERVAL_MS: 40,  // UI poll interval for progress
};

// ======= GLOBAL (Before-FX) GRAPH =======
let dryGain, fxSumGain, mixDest, processedStream;

// Reverb (Before)
let convolver, reverbPreDelay, reverbWet;
let reverbMix = 0.25, reverbRoomSeconds = 2.5, reverbDecay = 2.0, reverbPreDelayMs = 20;

// Delay (Before)
let delayNode, delayFeedback, delayWet;
let delayMix = 0.25, delayFeedbackAmt = 0.35;
let delaySyncMode = 'note';     // 'note' | 'ms'
let delayDivision = '1/8';      // tempo divisions
let delayVariant = 'straight';  // straight | dotted | triplet
let delayMs = 250;

// Flanger (Before)
let flangerDelay, flangerWet, flangerFeedback, flangerLFO, flangerDepthGain;
let flangerMix = 0.22, flangerRateHz = 0.25, flangerDepthMs = 2.0, flangerFeedbackAmt = 0.0;

// EQ (created when toggled on)
let eq = null;
let eqLowGain = 3, eqMidGain = 2, eqMidFreq = 1200, eqMidQ = 0.9, eqHighGain = 3;

// Before-FX state (ON/OFF)
const beforeState = { delay:false, reverb:false, flanger:false, eq5:false };

// Live monitor
let liveMicMonitorGain = null, liveMicMonitoring = false;

// Master timing from track 1
let masterLoopDuration = null, masterBPM = null, masterIsSet = false;

// ADDITION: Master Bus Globals
let masterBus = null, masterDest = null, masterStream = null;

// Option: automatically mute master/monitor while overdubbing (recommended for clean overdub)
const AUTO_MUTE_MONITOR_ON_OVERDUB = true;
const ALLOW_FREE_OVERDUB = false; // set to true to allow overdub to exceed loop length
const ALLOW_WRAP_OVERDUB = false; // set to true to wrap overdub audio if shorter than loop

// ======= DOM SHORTCUTS =======
const $ = s => document.querySelector(s);
const bpmLabel = $('#bpmLabel');
const dividerSelectors = [ null, null, $('#divider2'), $('#divider3'), $('#divider4') ];

// ======= HELPERS =======
function showMsg(msg, color='#ff4444'){
  let el = $('#startMsg');
  if (!el){ el = document.createElement('div'); el.id='startMsg'; document.body.prepend(el); }
  Object.assign(el.style, {
    display:'block', color, background:'#111a22cc', fontWeight:'bold', borderRadius:'12px',
    padding:'12px 22px', position:'fixed', left:'50%', top:'8%', transform:'translate(-50%,0)',
    zIndex:1000, textAlign:'center'
  });
  el.innerHTML = msg;
}
function hideMsg(){ const el = $('#startMsg'); if (el) el.style.display='none'; }
function addTap(btn, fn){
  if(!btn) return;
  const isTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (isTouch) btn.addEventListener('touchstart', e => { e.preventDefault(); fn(e); }, {passive:false});
  else btn.addEventListener('click', fn);
}
function addHold(btn, onStart, onEnd){
  let hold=false;
  btn.addEventListener('mousedown', e=>{ hold=true; onStart(e); });
  btn.addEventListener('touchstart', e=>{ hold=true; onStart(e); }, {passive:false});
  ['mouseup','mouseleave'].forEach(ev=>btn.addEventListener(ev, e=>{ if(hold) onEnd(e); hold=false; }));
  ['touchend','touchcancel'].forEach(ev=>btn.addEventListener(ev, e=>{ if(hold) onEnd(e); hold=false; }, {passive:false}));
}
function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }
function debounce(fn, ms=130){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; };

// Reverb IR (simple algorithmic room)
function makeReverbImpulse(seconds, decay){
  const sr = audioCtx.sampleRate, len = Math.max(1, Math.floor(sr*seconds));
  const buf = audioCtx.createBuffer(2, len, sr);
  for (let ch=0; ch<2; ch++){
    const d = buf.getChannelData(ch);
    for (let i=0;i<len;i++){
      const t = i/len;
      d[i] = (Math.random()*2-1) * Math.pow(1 - t, decay);
    }
  }
  return buf;
}

// Tempo helpers
const NOTE_MULT = { '1/1':4, '1/2':2, '1/4':1, '1/8':0.5, '1/16':0.25, '1/32':0.125 };
function quarterSecForBPM(bpm){ return 60/(bpm||120); }
function applyVariant(mult, v){ return v==='dotted' ? mult*1.5 : v==='triplet' ? mult*(2/3) : mult; }

// ======= RECORDING STREAM HELPERS =======
function isMicStreamAlive(ms){
  if (!ms) return false;
  if (typeof ms.active === 'boolean' && !ms.active) return false;
  const tracks = ms.getAudioTracks ? ms.getAudioTracks() : [];
  if (!tracks.length) return false;
  // track must be enabled and live
  return tracks.some(t => t.enabled && t.readyState === 'live');
}

// Re-implemented to be strict and explicit
function getRecordingStream(){
  if (!isMicStreamAlive(micStream)) return null;
  // Create a new MediaStream comprised of mic audio tracks only (avoid sharing mixed destinations)
  const ms = new MediaStream();
  try {
    const tracks = micStream.getAudioTracks ? micStream.getAudioTracks() : [];
    tracks.forEach(t => {
      if (t.enabled && t.readyState === 'live') {
        const tr = typeof t.clone === 'function' ? t.clone() : t;
        tr.enabled = true;
        ms.addTrack(tr);
      }
    });
  } catch (e) {
    return micStream;
  }
  return ms;
}

// Global recorder lock & safe factory
let _globalRecordingLock = false;
let _globalRecordingLockTimestamp = 0;
function tryClaimRecLock(){
  if (_globalRecordingLock) {
    if (Date.now() - _globalRecordingLockTimestamp > GLOBALS.RECORDER_GLOBAL_TIMEOUT_MS + 3000) {
      _globalRecordingLock = false;
    } else return false;
  }
  _globalRecordingLock = true;
  _globalRecordingLockTimestamp = Date.now();
  return true;
}
function releaseRecLock(){
  _globalRecordingLock = false;
  _globalRecordingLockTimestamp = 0;
}
function pickAudioMime(){
  if (MediaRecorder.isTypeSupported('audio/webm;codecs=opus')) return 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported('audio/webm')) return 'audio/webm';
  if (MediaRecorder.isTypeSupported('audio/ogg;codecs=opus')) return 'audio/ogg;codecs=opus';
  return '';
}
function makeMediaRecorderSafe(stream){
  const mime = pickAudioMime();
  try {
    return mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream);
  } catch (err) {
    console.warn('MediaRecorder ctor failed with mime, trying without mime', err);
    try { return new MediaRecorder(stream); } catch (err2) { throw err2; }
  }
}
async function startRecordingWithSafety(lp, stream, options = {}){
  if (!tryClaimRecLock()) { showMsg('Recorder busy', '#ffcc00'); throw new Error('rec-lock'); }
  let mr = null, guardTimer = null, aborted = false;
  try {
    mr = makeMediaRecorderSafe(stream);
  } catch(e){
    releaseRecLock();
    throw e;
  }
  mr.ondataavailable = e => { try { if (options.onData && e.data && e.data.size) options.onData(e.data); } catch(e){} };
  mr.onerror = e => {
    console.error('MediaRecorder error', e);
    try { options.onError?.(e); } catch(_) {}
    try { if (mr && mr.state !== 'inactive') mr.stop(); } catch(_) {}
    releaseRecLock();
  };
  mr.onstop = async () => {
    try { options.onStop?.(); } catch(e) {}
    clearTimeout(guardTimer);
    releaseRecLock();
  };
  try {
    mr.start();
  } catch (err){
    releaseRecLock();
    throw err;
  }
  if (options.expectedMs && options.expectedMs > 0) {
    guardTimer = setTimeout(() => {
      try {
        if (mr && mr.state === 'recording') { mr.stop(); }
      } catch (e) {}
    }, Math.min(options.expectedMs + 2000, GLOBALS.RECORDER_GLOBAL_TIMEOUT_MS));
  } else {
    guardTimer = setTimeout(() => {
      try { if (mr && mr.state === 'recording') mr.stop(); } catch(e){}
    }, GLOBALS.RECORDER_GLOBAL_TIMEOUT_MS);
  }
  return mr;
}

// Centralize mute/unmute for overdub with atomic changes
function muteForOverdub(lp){
  try {
    lp._prevMasterGain = masterBus ? masterBus.gain.value : 1;
    lp._prevLiveMonGain = liveMicMonitorGain ? liveMicMonitorGain.gain.value : 0;
    if (AUTO_MUTE_MONITOR_ON_OVERDUB){
      if (masterBus) { masterBus.gain.cancelScheduledValues(audioCtx.currentTime); masterBus.gain.setValueAtTime(0, audioCtx.currentTime); }
      if (liveMicMonitorGain) {
        try { liveMicMonitorGain.disconnect(audioCtx.destination); } catch(e){}
      }
    }
  } catch(e){ console.warn('muteForOverdub failed', e); }
}
function restoreAfterOverdub(lp){
  try {
    if (AUTO_MUTE_MONITOR_ON_OVERDUB){
      if (masterBus) masterBus.gain.cancelScheduledValues(audioCtx.currentTime);
      if (masterBus) masterBus.gain.setValueAtTime((lp? (lp._prevMasterGain ?? 1) : 1), audioCtx.currentTime);
      if (liveMicMonitorGain) {
        try { liveMicMonitorGain.connect(audioCtx.destination); liveMicMonitorGain.gain.setValueAtTime((lp? (lp._prevLiveMonGain ?? 0) : 0), audioCtx.currentTime); } catch(e){}
      }
    }
  } catch(e){ console.warn('restoreAfterOverdub failed', e); }
}

// use audioCtx.currentTime for phase-locked scheduling
function scheduleAtNextBar(masterDuration, divider=1){
  const now = audioCtx.currentTime;
  const master = loopers[1];
  if (!master || !master.loopStartTime || !masterDuration) return { startAt: now, waitMs: 0 };
  const masterElapsed = (now - master.loopStartTime) % masterDuration;
  let toNext = masterDuration - masterElapsed;
  if (toNext < 1e-6) toNext = 0;
  const startAt = now + (toNext * divider);
  return { startAt, waitMs: Math.round(Math.max(0, (startAt - now) * 1000)) };
}

// Thorough AudioNode disposal helpers
function safeDisconnect(node){
  try { if (node && typeof node.disconnect === 'function') node.disconnect(); } catch(e){ }
}
function disposeEffectNodes(effect){
  if (!effect || !effect.nodes) return;
  try {
    if (typeof effect.nodes.dispose === 'function') { effect.nodes.dispose(); }
    else {
      for (const k in effect.nodes) {
        const n = effect.nodes[k];
        if (n && typeof n.disconnect === 'function') n.disconnect();
      }
    }
    if (effect.type === 'Flanger' && effect.nodes.flangerLFO) {
        try { effect.nodes.flangerLFO.stop(); } catch(e){}
    }
  } catch(err){ console.warn('dispose effect nodes failed', err); }
  effect.nodes = null;
}
function disposeEffectNodesList(chain){
  if (!Array.isArray(chain)) return;
  for (const fx of chain) disposeEffectNodes(fx);
}
function disposeTrackNodes(lp){
  try {
    disposeEffectNodesList(lp.fx.chain);
    safeDisconnect(lp.gainNode);
    if (lp.sourceNode) { try { lp.sourceNode.stop(); } catch(e){}; safeDisconnect(lp.sourceNode); lp.sourceNode = null; }
  } catch(e){ console.warn('disposeTrackNodes failed', e); }
}

// Reschedule other tracks when Track 1 changes
function resyncAllTracksFromMaster(){
  if (!masterIsSet || !loopers[1] || !loopers[1].loopBuffer) return;
  const master = loopers[1];
  masterLoopDuration = master.loopDuration;
  master.loopStartTime = audioCtx.currentTime;
  for (let i=2; i<=4; i++){
    const lp = loopers[i];
    if (!lp || !lp.loopBuffer) continue;
    if (lp.state === 'playing' || lp.state === 'overdub'){
      const relPos = ((audioCtx.currentTime - (lp.loopStartTime || audioCtx.currentTime)) % (lp.loopDuration || masterLoopDuration));
      try { lp.stopPlayback(); } catch(_) {}
      const now = audioCtx.currentTime;
      const off = relPos % lp.loopDuration;
      lp.loopStartTime = now - off;
      lp.startPlayback();
    }
  }
}

// Per-track undo stack & helpers
function pushUndoSnapshot(lp){
  lp._undoStack = lp._undoStack || [];
  const snapshot = {
    buffer: lp.loopBuffer ? copyAudioBuffer(lp.loopBuffer) : null,
    fxChain: JSON.parse(JSON.stringify(lp.fx.chain || [])),
    timestamp: Date.now()
  };
  lp._undoStack.unshift(snapshot);
  while (lp._undoStack.length > GLOBALS.UNDO_STACK_LIMIT) lp._undoStack.pop();
}
function undoLast(lp){
  if (!lp._undoStack || !lp._undoStack.length) return false;
  const snap = lp._undoStack.shift();
  if (snap.buffer) lp.loopBuffer = snap.buffer;
  lp.fx.chain = snap.fxChain;
  if (lp.state === 'playing') lp.startPlayback();
  renderTrackFxSummary(lp.index);
  return true;
}

// Copy audio buffer (deep copy)
function copyAudioBuffer(src){
  if (!src) return null;
  const out = audioCtx.createBuffer(src.numberOfChannels, src.length, src.sampleRate);
  for (let ch=0; ch<src.numberOfChannels; ch++){
    out.copyToChannel(src.getChannelData(ch).slice(0), ch, 0);
  }
  return out;
}

// Resample buffer to target sample rate
async function resampleAudioBuffer(buf, targetSampleRate){
  if (buf.sampleRate === targetSampleRate) return buf;
  const offline = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(buf.duration * targetSampleRate), targetSampleRate);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

// WAV encoder (no CDN dependency)
function encodeWavFromAudioBuffer(buf){
  const numChannels = buf.numberOfChannels;
  const sampleRate = buf.sampleRate;
  const length = buf.length * numChannels * 2 + 44;
  const ab = new ArrayBuffer(length);
  const dv = new DataView(ab);
  let offset = 0;
  function writeString(s){ for (let i=0;i<s.length;i++) dv.setUint8(offset++, s.charCodeAt(i)); }
  function writeInt16(v){ dv.setInt16(offset, v, true); offset += 2; }
  function writeInt32(v){ dv.setUint32(offset, v, true); offset += 4; }

  writeString('RIFF');
  writeInt32(length - 8);
  writeString('WAVE');
  writeString('fmt ');
  writeInt32(16); // PCM chunk size
  writeInt16(1);  // PCM
  writeInt16(numChannels);
  writeInt32(sampleRate);
  writeInt32(sampleRate * numChannels * 2);
  writeInt16(numChannels * 2);
  writeInt16(16);
  writeString('data');
  writeInt32(length - offset - 4);
  const interleaved = new Float32Array(buf.length * numChannels);
  let idx = 0;
  for (let i=0;i<buf.length;i++){
    for (let ch=0; ch<numChannels; ch++){
      interleaved[idx++] = buf.getChannelData(ch)[i] || 0;
    }
  }
  for (let i=0;i<interleaved.length;i++){
    let s = Math.max(-1, Math.min(1, interleaved[i]));
    dv.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  return new Blob([dv], { type: 'audio/wav' });
}

// Loopback detection
async function detectLoopback(threshold = 0.02, testDurationMs = 800) {
  const isEnabled = liveMicMonitoring;
  if (!isEnabled) {
    if (liveMicMonitorGain) liveMicMonitorGain.gain.setValueAtTime(1, audioCtx.currentTime);
  }
  
  const analyser = audioCtx.createAnalyser(); analyser.fftSize = 2048;
  const micSrc = audioCtx.createMediaStreamSource(micStream);
  micSrc.connect(analyser);

  const data = new Float32Array(analyser.fftSize);

  const tone = audioCtx.createOscillator();
  const g = audioCtx.createGain(); g.gain.value = 0.12;
  tone.connect(g); g.connect(masterBus);
  tone.start();

  await new Promise(r => setTimeout(r, testDurationMs));
  
  analyser.getFloatTimeDomainData(data);
  tone.stop(); tone.disconnect(); g.disconnect();
  micSrc.disconnect(analyser);

  if (!isEnabled) {
    if (liveMicMonitorGain) liveMicMonitorGain.gain.setValueAtTime(0, audioCtx.currentTime);
  }

  let sum=0; for(const v of data) sum += v*v;
  const rms = Math.sqrt(sum/data.length);
  return rms > threshold;
}

// ======= AUDIO SETUP =======
async function ensureMic(){
  if (micStream && micSource) return;

  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch {}
  }
  if (!navigator.mediaDevices?.getUserMedia) { showMsg('❌ Microphone not supported'); throw new Error('gUM'); }
  
  const sel = document.getElementById('inputDeviceSelect');
  const deviceId = sel ? sel.value : '';
  const constraints = { audio:{
    echoCancellation:false, noiseSuppression:false, autoGainControl:false,
    deviceId: deviceId ? { exact: deviceId } : undefined
  }};

  try {
    micStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch(e){ showMsg('❌ Microphone access denied'); throw e; }

  // Apply sample rate constraint if supported
  try {
    const track = micStream.getAudioTracks()[0];
    if (track) {
      await track.applyConstraints({ sampleRate: audioCtx.sampleRate });
    }
  } catch(e) {
    console.warn('Could not apply sample rate constraints', e);
  }

  micSource = audioCtx.createMediaStreamSource(micStream);

  micStream.getAudioTracks().forEach(t => {
    t.addEventListener('ended', () => {
      showMsg('⚠️ Microphone disconnected', '#ffb4a2');
      try{ micSource.disconnect(); }catch{}; micSource = null;
      micStream = null;
    });
  });

  dryGain = audioCtx.createGain();   dryGain.gain.value = 1;
  fxSumGain = audioCtx.createGain(); fxSumGain.gain.value = 1;

  reverbPreDelay = audioCtx.createDelay(1.0); reverbPreDelay.delayTime.value = reverbPreDelayMs/1000;
  convolver = audioCtx.createConvolver(); convolver.normalize = true; convolver.buffer = makeReverbImpulse(reverbRoomSeconds, reverbDecay);
  reverbWet = audioCtx.createGain(); reverbWet.gain.value = 0;
  micSource.connect(reverbPreDelay); reverbPreDelay.connect(convolver); convolver.connect(reverbWet); reverbWet.connect(fxSumGain);

  delayNode = audioCtx.createDelay(2.0);
  delayFeedback = audioCtx.createGain(); delayFeedback.gain.value = delayFeedbackAmt;
  delayWet = audioCtx.createGain(); delayWet.gain.value = 0;
  delayNode.connect(delayFeedback); delayFeedback.connect(delayNode);
  micSource.connect(delayNode); delayNode.connect(delayWet); delayWet.connect(fxSumGain);

  flangerDelay = audioCtx.createDelay(0.05);
  flangerWet = audioCtx.createGain(); flangerWet.gain.value = 0;
  flangerFeedback = audioCtx.createGain(); flangerFeedback.gain.value = flangerFeedbackAmt;
  flangerLFO = audioCtx.createOscillator(); flangerLFO.type='sine'; flangerLFO.frequency.value = flangerRateHz;
  flangerDepthGain = audioCtx.createGain(); flangerDepthGain.gain.value = flangerDepthMs/1000;
  flangerLFO.connect(flangerDepthGain); flangerDepthGain.connect(flangerDelay.delayTime);
  flangerDelay.connect(flangerWet); flangerWet.connect(fxSumGain);
  flangerDelay.connect(flangerFeedback); flangerFeedback.connect(flangerDelay);
  micSource.connect(flangerDelay); flangerLFO.start();

  eq = null;

  micSource.connect(dryGain);
  mixDest = audioCtx.createMediaStreamDestination();
  dryGain.connect(mixDest); fxSumGain.connect(mixDest);
  processedStream = mixDest.stream;

  masterBus = audioCtx.createGain();
  masterBus.gain.value = 1;
  masterBus.connect(audioCtx.destination);
  masterDest = audioCtx.createMediaStreamDestination();
  masterBus.connect(masterDest);
  masterStream = masterDest.stream;

  liveMicMonitorGain = audioCtx.createGain(); liveMicMonitorGain.gain.value = 0;
  dryGain.connect(liveMicMonitorGain); fxSumGain.connect(liveMicMonitorGain); liveMicMonitorGain.connect(audioCtx.destination);

  hideMsg();
  
  // Detect loopback once on startup
  if (loopers[1]) {
    loopers[1].isLoopbackDetected = await detectLoopback();
    if (loopers[1].isLoopbackDetected) {
      showMsg('⚠️ Warning: Hardware loopback detected. Overdubs may re-record playback. Consider disabling monitor in your audio interface settings.', '#ffcc00');
    }
  }
}

function ensureMasterBus(){
  if (masterBus && masterDest && masterStream) return;
  try {
    masterBus = masterBus || audioCtx.createGain();
    if (masterBus.gain.value === undefined || masterBus.gain.value === null) masterBus.gain.value = 1;
    try { masterBus.connect(audioCtx.destination); } catch(e){ }
    masterDest = masterDest || audioCtx.createMediaStreamDestination();
    try { masterBus.connect(masterDest); } catch(e){ }
    masterStream = masterDest.stream;
  } catch (err) {
    console.warn('ensureMasterBus failed', err);
  }
}

function toggleEQ(enable){
  if (!micSource) return;
  if (enable && !eq){
    eq = {
      low: audioCtx.createBiquadFilter(), mid: audioCtx.createBiquadFilter(), high: audioCtx.createBiquadFilter()
    };
    eq.low.type='lowshelf'; eq.low.frequency.value=180; eq.low.gain.value=eqLowGain;
    eq.mid.type='peaking';  eq.mid.frequency.value=eqMidFreq; eq.mid.Q.value=eqMidQ; eq.mid.gain.value=eqMidGain;
    eq.high.type='highshelf'; eq.high.frequency.value=4500; eq.high.gain.value=eqHighGain;

    try{ micSource.disconnect(); }catch{}
    micSource.connect(eq.low); eq.low.connect(eq.mid); eq.mid.connect(eq.high);
    eq.high.connect(dryGain); eq.high.connect(delayNode); eq.high.connect(reverbPreDelay); eq.high.connect(flangerDelay);
  } else if (!enable && eq){
    try{ eq.low.disconnect(); eq.mid.disconnect(); eq.high.disconnect(); }catch{}
    try{ micSource.disconnect(); }catch{}
    micSource.connect(dryGain); micSource.connect(delayNode); micSource.connect(reverbPreDelay); micSource.connect(flangerDelay);
    eq=null;
  }
}

function updateDelayFromTempo(){
  if (delaySyncMode !== 'note') return;
  const q = quarterSecForBPM(masterBPM || 120);
  const mult = applyVariant(NOTE_MULT[delayDivision]||0.5, delayVariant);
  delayNode.delayTime.value = clamp(q*mult, 0.001, 2.0);
}

// ======= BEFORE-FX BUTTONS + POPUP =======
const beforeFXBtns = {
  delay:  $('#fxBeforeBtn_delay'),
  reverb: $('#fxBeforeBtn_reverb'),
  flanger:$('#fxBeforeBtn_flanger'),
  eq5:    $('#fxBeforeBtn_eq5'),
  pitch:  $('#fxBeforeBtn_pitch')
};
const fxBeforeParamsPopup = $('#fxBeforeParamsPopup');

function openBeforeFxPopup(tab='reverb'){
  fxBeforeParamsPopup.classList.remove('hidden');
  fxBeforeParamsPopup.innerHTML = `
    <div class="fx-popup-inner">
      <h3>Before FX – ${tab.toUpperCase()}</h3>
      <div id="beforeFxBody">${renderBeforeFxTab(tab)}</div>
      <div style="margin-top:8px;">
        <button id="closeBeforeFx">Close</button>
      </div>
    </div>`;
  $('#closeBeforeFx').addEventListener('click', ()=>fxBeforeParamsPopup.classList.add('hidden'));
  wireBeforeFxTab(tab);
}

function renderBeforeFxTab(tab){
  if (tab==='reverb') return `
    <label>Mix <span id="rvMixVal">${Math.round(reverbMix*100)}%</span>
      <input id="rvMix" type="range" min="0" max="100" value="${Math.round(reverbMix*100)}"></label>
    <label>Room Size <span id="rvRoomVal">${reverbRoomSeconds.toFixed(2)} s</span>
      <input id="rvRoom" type="range" min="0.3" max="6.0" step="0.05" value="${reverbRoomSeconds}"></label>
    <label>Decay <span id="rvDecayVal">${reverbDecay.toFixed(2)}</span>
      <input id="rvDecay" type="range" min="0.5" max="4.0" step="0.05" value="${reverbDecay}"></label>
    <label>Pre-delay <span id="rvPreVal">${reverbPreDelayMs} ms</span>
      <input id="rvPre" type="range" min="0" max="200" step="1" value="${reverbPreDelayMs}"></label>
  `;
  if (tab==='delay') return `
    <label>Mode
      <select id="dlMode"><option value="note" ${delaySyncMode==='note'?'selected':''}>Tempo-sync</option><option value="ms" ${delaySyncMode==='ms'?'selected':''}>Milliseconds</option></select>
    </label>
    <div id="dlNoteRow">
      <label>Division
        <select id="dlDiv">${['1/1','1/2','1/4','1/8','1/16','1/32'].map(x=>`<option ${x===delayDivision?'selected':''}>${x}</option>`).join('')}</select>
      </label>
      <label>Variant
        <select id="dlVar">
          <option value="straight" ${delayVariant==='straight'?'selected':''}>Straight</option>
          <option value="dotted" ${delayVariant==='dotted'?'selected':''}>Dotted</option>
          <option value="triplet" ${delayVariant==='triplet'?'selected':''}>Triplet</option>
        </select>
      </label>
    </div>
    <div id="dlMsRow" style="display:none;">
      <label>Delay Time <span id="dlMsVal">${delayMs} ms</span>
        <input id="dlMs" type="range" min="1" max="2000" value="${delayMs}"></label>
    </div>
    <label>Feedback <span id="dlFbVal">${Math.round(delayFeedbackAmt*100)}%</span>
      <input id="dlFb" type="range" min="0" max="95" value="${Math.round(delayFeedbackAmt*100)}"></label>
    <label>Mix <span id="dlMixVal">${Math.round(delayMix*100)}%</span>
      <input id="dlMix" type="range" min="0" max="100" value="${Math.round(delayMix*100)}"></label>
  `;
  if (tab==='flanger') return `
    <label>Rate <span id="flRateVal">${flangerRateHz.toFixed(2)} Hz</span>
      <input id="flRate" type="range" min="0.05" max="5" step="0.01" value="${flangerRateHz}"></label>
    <label>Depth <span id="flDepthVal">${flangerDepthMs.toFixed(2)} ms</span>
      <input id="flDepth" type="range" min="0" max="5" step="0.01" value="${flangerDepthMs}"></label>
    <label>Feedback <span id="flFbVal">${Math.round(flangerFeedbackAmt*100)}%</span>
      <input id="flFb" type="range" min="-95" max="95" value="${Math.round(flangerFeedbackAmt*100)}"></label>
    <label>Mix <span id="flMixVal">${Math.round(flangerMix*100)}%</span>
      <input id="flMix" type="range" min="0" max="100" value="${Math.round(flangerMix*100)}"></label>
  `;
  if (tab==='eq') return `
    <label>Low Shelf Gain <span id="eqLowVal">${eqLowGain} dB</span>
      <input id="eqLow" type="range" min="-12" max="12" value="${eqLowGain}"></label>
    <label>Mid Gain <span id="eqMidGainVal">${eqMidGain} dB</span>
      <input id="eqMidGain" type="range" min="-12" max="12" value="${eqMidGain}"></label>
    <label>Mid Freq <span id="eqMidFreqVal">${eqMidFreq} Hz</span>
      <input id="eqMidFreq" type="range" min="300" max="5000" step="10" value="${eqMidFreq}"></label>
    <label>Mid Q <span id="eqMidQVal">${eqMidQ.toFixed(2)}</span>
      <input id="eqMidQ" type="range" min="0.3" max="4.0" step="0.01" value="${eqMidQ}"></label>
    <label>High Shelf Gain <span id="eqHighVal">${eqHighGain} dB</span>
      <input id="eqHigh" type="range" min="-12" max="12" value="${eqHighGain}"></label>
  `;
  if (tab==='pitch') return `
    <p style="max-width:48ch;line-height:1.3;">
      Offline pitch shifting: this replaces the old playbackRate method.
      When you add a <b>Pitch</b> After-FX and set semitones, the loop's audio buffer
      will be processed (granular overlap-add) to shift pitch while preserving duration.
      Large buffers or big shifts may take a noticeable moment to process.
    </p>
  `;
  return '';
}

function wireBeforeFxTab(tab){
  if (tab==='reverb'){
    $('#rvMix').addEventListener('input', e=>{ reverbMix = parseFloat(e.target.value)/100; reverbWet.gain.value = beforeState.reverb ? reverbMix : 0; $('#rvMixVal').textContent = Math.round(reverbMix*100)+'%'; });
    const regen = debounce(()=>{ convolver.buffer = makeReverbImpulse(reverbRoomSeconds, reverbDecay); }, 180);
    $('#rvRoom').addEventListener('input', e=>{ reverbRoomSeconds = parseFloat(e.target.value); $('#rvRoomVal').textContent = reverbRoomSeconds.toFixed(2)+' s'; regen(); });
    $('#rvDecay').addEventListener('input', e=>{ reverbDecay = parseFloat(e.target.value); $('#rvDecayVal').textContent = reverbDecay.toFixed(2); regen(); });
    $('#rvPre').addEventListener('input', e=>{ reverbPreDelayMs = parseInt(e.target.value,10); reverbPreDelay.delayTime.value = reverbPreDelayMs/1000; $('#rvPreVal').textContent = reverbPreDelayMs+' ms'; });
  }
  if (tab==='delay'){
    const syncUI = ()=>{ const noteRow=$('#dlNoteRow'), msRow=$('#dlMsRow'); if (delaySyncMode==='note'){ noteRow.style.display='block'; msRow.style.display='none'; updateDelayFromTempo(); } else { noteRow.style.display='none'; msRow.style.display='block'; delayNode.delayTime.value = clamp(delayMs/1000,0,2);} };
    $('#dlMode').addEventListener('change', e=>{ delaySyncMode = e.target.value; syncUI(); });
    $('#dlDiv').addEventListener('change', e=>{ delayDivision = e.target.value; updateDelayFromTempo(); });
    $('#dlVar').addEventListener('change', e=>{ delayVariant = e.target.value; updateDelayFromTempo(); });
    $('#dlMs').addEventListener('input', e=>{ delayMs = parseInt(e.target.value,10); if (delaySyncMode==='ms') delayNode.delayTime.value = clamp(delayMs/1000,0,2); $('#dlMsVal').textContent = delayMs+' ms'; });
    $('#dlFb').addEventListener('input', e=>{ delayFeedbackAmt = parseFloat(e.target.value)/100; delayFeedback.gain.value = clamp(delayFeedbackAmt,0,0.95); $('#dlFbVal').textContent = Math.round(delayFeedbackAmt*100)+'%'; });
    $('#dlMix').addEventListener('input', e=>{ delayMix = parseFloat(e.target.value)/100; delayWet.gain.value = beforeState.delay ? delayMix : 0; $('#dlMixVal').textContent = Math.round(delayMix*100)+'%'; });
    syncUI();
  }
  if (tab==='flanger'){
    $('#flRate').addEventListener('input', e=>{ flangerRateHz = parseFloat(e.target.value); flangerLFO.frequency.value = flangerRateHz; $('#flRateVal').textContent = flangerRateHz.toFixed(2)+' Hz'; });
    $('#flDepth').addEventListener('input', e=>{ flangerDepthMs = parseFloat(e.target.value); flangerDepthGain.gain.value = flangerDepthMs/1000; $('#flDepthVal').textContent = flangerDepthMs.toFixed(2)+' ms'; });
    $('#flFb').addEventListener('input', e=>{ flangerFeedbackAmt = parseFloat(e.target.value)/100; flangerFeedback.gain.value = clamp(flangerFeedbackAmt, -0.95, 0.95); $('#flFbVal').textContent = Math.round(flangerFeedbackAmt*100)+'%'; });
    $('#flMix').addEventListener('input', e=>{ flangerMix = parseFloat(e.target.value)/100; flangerWet.gain.value = beforeState.flanger ? flangerMix : 0; $('#flMixVal').textContent = Math.round(flangerMix*100)+'%'; });
  }
  if (tab==='eq'){
    $('#eqLow').addEventListener('input', e=>{ eqLowGain=parseInt(e.target.value,10); if(eq?.low) eq.low.gain.value=eqLowGain; $('#eqLowVal').textContent = eqLowGain+' dB'; });
    $('#eqMidGain').addEventListener('input', e=>{ eqMidGain=parseInt(e.target.value,10); if(eq?.mid) eq.mid.gain.value=eqMidGain; $('#eqMidGainVal').textContent = eqMidGain+' dB'; });
    $('#eqMidFreq').addEventListener('input', e=>{ eqMidFreq=parseInt(e.target.value,10); if(eq?.mid) eq.mid.frequency.value=eqMidFreq; $('#eqMidFreqVal').textContent = eqMidFreq+' Hz'; });
    $('#eqMidQ').addEventListener('input', e=>{ eqMidQ=parseFloat(e.target.value); if(eq?.mid) eq.mid.Q.value=eqMidQ; $('#eqMidQVal').textContent = eqMidQ.toFixed(2); });
    $('#eqHigh').addEventListener('input', e=>{ eqHighGain=parseInt(e.target.value,10); if(eq?.high) eq.high.gain.value=eqHighGain; $('#eqHighVal').textContent = eqHighGain+' dB'; });
  }
}

function wireBeforeFX(){
  if (beforeFXBtns.reverb){
    addTap(beforeFXBtns.reverb, async ()=>{
      await ensureMic();
      beforeState.reverb = !beforeState.reverb;
      beforeFXBtns.reverb.classList.toggle('active', beforeState.reverb);
      reverbWet.gain.value = beforeState.reverb ? reverbMix : 0;
      openBeforeFxPopup('reverb');
    });
  }
  if (beforeFXBtns.delay){
    addTap(beforeFXBtns.delay, async ()=>{
      await ensureMic();
      beforeState.delay = !beforeState.delay;
      beforeFXBtns.delay.classList.toggle('active', beforeState.delay);
      delayWet.gain.value = beforeState.delay ? delayMix : 0;
      openBeforeFxPopup('delay');
    });
  }
  if (beforeFXBtns.flanger){
    addTap(beforeFXBtns.flanger, async ()=>{
      await ensureMic();
      beforeState.flanger = !beforeState.flanger;
      beforeFXBtns.flanger.classList.toggle('active', beforeState.flanger);
      flangerWet.gain.value = beforeState.flanger ? flangerMix : 0;
      openBeforeFxPopup('flanger');
    });
  }
  if (beforeFXBtns.eq5){
    addTap(beforeFXBtns.eq5, async ()=>{
      await ensureMic();
      beforeState.eq5 = !beforeState.eq5;
      beforeFXBtns.eq5.classList.toggle('active', beforeState.eq5);
      toggleEQ(beforeState.eq5);
      openBeforeFxPopup('eq');
    });
  }
  if (beforeFXBtns.pitch){
    addTap(beforeFXBtns.pitch, ()=> openBeforeFxPopup('pitch'));
  }
}

// ======= OFFLINE PITCH (worker-enabled) =======
// Worker source for cooperative cancellation
const _pitchWorkerSrc = (grainSize) => `
  const cancelled = {};
  self.onmessage = function(e){
    const data = e.data;
    if (data.cmd === 'cancel'){ cancelled[data.id] = true; return; }
    if (data.cmd === 'process') {
      const { id, channels, sr, len, semitones, grainSize, hop } = data;
      
      const ratio = Math.pow(2, semitones/12);
      const win = new Float32Array(grainSize);
      for (let i=0;i<grainSize;i++) win[i] = 0.5*(1 - Math.cos(2*Math.PI*i/(grainSize-1)));
      const outLen = len;
      const results = [];
      
      for (let ch=0; ch<channels.length; ch++){
        if (cancelled[id]) { self.postMessage({cmd:'cancelled', id}); return; }
        const inData = channels[ch];
        const outData = new Float32Array(outLen);
        for (let i=0;i<outLen;i++) outData[i]=0;
        let readPos = 0;
        let steps = Math.ceil((outLen + hop) / hop);
        let stepIdx = 0;
        for (let outPos = 0; outPos < outLen + hop; outPos += hop){
          if (cancelled[id]) { self.postMessage({cmd:'cancelled', id}); return; }
          const rStart = Math.floor(readPos - grainSize/2);
          for (let i=0;i<grainSize;i++){
            const inIdx = rStart + i;
            let s = 0;
            if (inIdx >= 0 && inIdx < inData.length) s = inData[inIdx];
            const w = win[i];
            const target = outPos + i - Math.floor(grainSize/2);
            if (target >= 0 && target < outLen){
              outData[target] += s * w;
            }
          }
          readPos += ratio * hop;
          if (readPos > inData.length + grainSize) readPos = readPos % inData.length;
          stepIdx++;
          if (stepIdx % 32 === 0) {
            self.postMessage({ cmd:'progress', id, pct: Math.min(1, outPos / outLen) });
          }
        }
        if (cancelled[id]) { self.postMessage({cmd:'cancelled', id}); return; }
        const envelope = new Float32Array(outLen);
        for (let i=0;i<outLen;i++) envelope[i]=0;
        for (let outPos = 0; outPos < outLen + hop; outPos += hop){
          for (let i=0;i<grainSize;i++){
            const target = outPos + i - Math.floor(grainSize/2);
            if (target >= 0 && target < outLen) envelope[target] += win[i];
          }
        }
        for (let i=0;i<outLen;i++){
          const env = envelope[i] || 1e-8;
          outData[i] = outData[i] / env;
        }
        results.push(outData.buffer);
      }
      self.postMessage({ cmd:'done', id, sr, outLen, channels: results }, results);
    }
  };
`;

function replaceWorkerAt(index){
  try {
    _pitchWorkerPool[index].worker.terminate();
  } catch(e){}
  const blob = new Blob([_pitchWorkerSrc(GLOBALS.PITCH_GRAIN_SIZE)], { type: 'application/javascript' });
  const url = URL.createObjectURL(blob);
  const w = new Worker(url); URL.revokeObjectURL(url);
  _pitchWorkerPool[index] = { worker: w, busy: false };
  w.onerror = (ev) => { console.error('pitch worker error', ev); try { replaceWorkerAt(index); } catch(e){} };
}
function createPitchWorkerPool(poolSize = GLOBALS.WORKER_POOL_SIZE){
  const workers = [];
  for (let i=0;i<poolSize;i++){
    const blob = new Blob([_pitchWorkerSrc(GLOBALS.PITCH_GRAIN_SIZE)], { type: 'application/javascript' });
    const url = URL.createObjectURL(blob);
    const w = new Worker(url);
    URL.revokeObjectURL(url);
    workers.push({ worker: w, busy: false });
  }
  workers.forEach((p, idx) => p.worker.onerror = ()=> replaceWorkerAt(idx));
  return workers;
}

const _pitchWorkerPool = createPitchWorkerPool();

function submitPitchJobToPool(inputBuffer, semitones, onProgress = ()=>{}, timeoutMs = GLOBALS.PITCH_JOB_TIMEOUT_MS, grainSize = GLOBALS.PITCH_GRAIN_SIZE, hop = Math.max(1, Math.floor(grainSize * GLOBALS.PITCH_HOP_RATIO))){
  const id = Math.random().toString(36).slice(2);
  const channelsArrays = [];
  for (let ch=0; ch<inputBuffer.numberOfChannels; ch++) channelsArrays.push(inputBuffer.getChannelData(ch).slice(0));
  const poolItem = _pitchWorkerPool.find(w => !w.busy) || _pitchWorkerPool[0];
  poolItem.busy = true;
  const worker = poolItem.worker;

  let finished = false;
  let listener = null;
  let timer = null;
  let _cancelled = false;

  const promise = new Promise((resolve, reject) => {
    listener = (ev) => {
      const d = ev.data || {};
      if (d.id !== id && d.id !== undefined) return;
      if (d.cmd === 'progress') onProgress(d.pct);
      if (d.cmd === 'done') {
        if (_cancelled) {
          finished = true;
          worker.removeEventListener('message', listener);
          poolItem.busy = false;
          clearTimeout(timer);
          reject(new Error('cancelled'));
          return;
        }
        try {
          const { channels: chBuffers, outLen, sr: outSR } = d;
          const outBuf = audioCtx.createBuffer(chBuffers.length, outLen, outSR || audioCtx.sampleRate);
          for (let c=0; c<chBuffers.length; c++){
            const fa = new Float32Array(chBuffers[c]);
            outBuf.copyToChannel(fa, c, 0);
          }
          finished = true;
          worker.removeEventListener('message', listener);
          poolItem.busy = false;
          clearTimeout(timer);
          resolve(outBuf);
        } catch (err) {
          poolItem.busy = false;
          worker.removeEventListener('message', listener);
          clearTimeout(timer);
          reject(err);
        }
      } else if (d.cmd === 'cancelled') {
        finished = true;
        poolItem.busy = false;
        worker.removeEventListener('message', listener);
        clearTimeout(timer);
        reject(new Error('cancelled'));
      }
    };
    worker.addEventListener('message', listener);

    timer = setTimeout(async ()=> {
      if (finished) return;
      worker.removeEventListener('message', listener);
      poolItem.busy = false;
      try {
        const fallback = await inlinePitchShift(inputBuffer, semitones, grainSize, hop);
        if (_cancelled) return reject(new Error('cancelled'));
        resolve(fallback);
      } catch (e){
        reject(e);
      }
    }, timeoutMs);

    try {
      const transfer = channelsArrays.map(a => a.buffer);
      worker.postMessage({ cmd:'process', id, channels: channelsArrays, sr: inputBuffer.sampleRate, len: inputBuffer.length, semitones, grainSize, hop }, transfer);
    } catch (err) {
      clearTimeout(timer);
      worker.removeEventListener('message', listener);
      poolItem.busy = false;
      inlinePitchShift(inputBuffer, semitones, grainSize, hop).then(out => {
        if (_cancelled) return reject(new Error('cancelled'));
        resolve(out);
      }).catch(reject);
    }
  });

  const cancel = () => {
    try {
      _cancelled = true;
      worker.postMessage({ cmd:'cancel', id });
    } catch(e){ /* ignore */ }
  };

  return { promise, cancel, _isCancelled: ()=> _cancelled };
}

async function inlinePitchShift(inputBuffer, semitones, grainSize=2048, hop=Math.floor(2048*0.25)){
  if (!inputBuffer) return inputBuffer;
  const ratio = Math.pow(2, semitones/12);
  const sr = inputBuffer.sampleRate;
  const channels = inputBuffer.numberOfChannels;
  const len = inputBuffer.length;
  const outLen = len;
  const output = audioCtx.createBuffer(channels, outLen, sr);
  const win = new Float32Array(grainSize);
  for (let i=0;i<grainSize;i++) win[i] = 0.5*(1 - Math.cos(2*Math.PI*i/(grainSize-1)));
  for (let ch=0; ch<channels; ch++){
    const inData = inputBuffer.getChannelData(ch);
    const outData = output.getChannelData(ch);
    for (let i=0;i<outLen;i++) outData[i] = 0;
    let readPos = 0;
    for (let outPos = 0; outPos < outLen + hop; outPos += hop){
      const rStart = Math.floor(readPos - grainSize/2);
      for (let i=0;i<grainSize;i++){
        const inIdx = rStart + i;
        let s = 0;
        if (inIdx >= 0 && inIdx < len) s = inData[inIdx];
        const w = win[i];
        const target = outPos + i - Math.floor(grainSize/2);
        if (target >= 0 && target < outLen){
          outData[target] += s * w;
        }
      }
      readPos += ratio * hop;
      if (readPos > len + grainSize) readPos = readPos % len;
    }
    const envelope = new Float32Array(outLen);
    for (let i=0;i<outLen;i++) envelope[i]=0;
    for (let outPos = 0; outPos < outLen + hop; outPos += hop){
      for (let i=0;i<grainSize;i++){
        const target = outPos + i - Math.floor(grainSize/2);
        if (target >= 0 && target < outLen) envelope[target] += win[i];
      }
    }
    for (let i=0;i<outLen;i++){
      const env = envelope[i] || 1e-8;
      outData[i] = outData[i] / env;
    }
  }
  return output;
}

async function applyPitchAfterFxToLoop(lp, semitones){
  if (!lp.loopBuffer) return;
  pushUndoSnapshot(lp);
  lp.cancelPitchJob();
  lp.uiDisabled = true;
  lp.updateUI();
  showMsg(`⏳ Applying pitch ${semitones} st to Track ${lp.index}...`, '#ffd166');
  
  const bufLen = lp.loopBuffer.length;
  let grain = GLOBALS.PITCH_GRAIN_SIZE;
  if (bufLen < 22050) grain = 1024;
  if (Math.abs(semitones) > 8) grain = Math.min(4096, grain * 2);
  const hop = Math.max(1, Math.floor(grain * GLOBALS.PITCH_HOP_RATIO));

  const jobHandle = submitPitchJobToPool(lp.loopBuffer, semitones, pct => { showOfflineProgress(lp.index, pct); }, undefined, grain, hop);
  lp._pitchJob = jobHandle;
  try {
    const newBuf = await jobHandle.promise;
    lp._lastUnprocessedBuffer = lp.loopBuffer;
    lp.loopBuffer = newBuf;
    lp.loopDuration = newBuf.duration;
    if (lp.state === 'playing' || lp.state === 'overdub') lp.startPlayback();
    renderTrackFxSummary(lp.index);
    showMsg(`✅ Pitch applied (${semitones} st) to Track ${lp.index}`, '#a7ffed');
    setTimeout(hideMsg, 900);
  } catch (e){
    if (e && e.message === 'cancelled') {
      showMsg('⚠️ Pitch cancelled', '#ffe066');
      setTimeout(hideMsg, 700);
    } else {
      console.error('Pitch processing failed', e);
      showMsg('❌ Pitch processing failed', '#ff6b6b');
      setTimeout(hideMsg, 1300);
    }
  } finally {
    lp._pitchJob = null;
    lp.uiDisabled = false;
    lp.updateUI();
  }
}

function showOfflineProgress(lpIndex, pct){
  let el = document.getElementById('offlineProgress');
  if (!el){
    el = document.createElement('div'); el.id='offlineProgress';
    Object.assign(el.style, { position:'fixed', left:'50%', bottom:'8%', transform:'translateX(-50%)', padding:'8px 12px', background:'#112', color:'#fff', borderRadius:'8px', zIndex:10001});
    document.body.appendChild(el);
  }
  el.innerHTML = `Track ${lpIndex} processing: ${(pct*100).toFixed(0)}% <button id="cancelPitchJobBtn">Cancel</button>`;
  document.getElementById('cancelPitchJobBtn').onclick = ()=> {
    const lp = loopers[lpIndex];
    if (lp) lp.cancelPitchJob();
    el.remove();
  };
  if (pct >= 0.999) setTimeout(()=>el.remove(), 800);
}

// ======= LOOPER (core) =======
class Looper {
  constructor(index, recordKey, stopKey){
    this.index = index;
    this.mainBtn = $('#mainLooperBtn'+index);
    this.stopBtn = $('#stopBtn'+index);
    this.clearBtn = $('#clearBtn' + index);
    this.looperIcon = $('#looperIcon'+index);
    this.ledRing = $('#progressBar'+index);
    this.stateDisplay = $('#stateDisplay'+index);
    this.recordKey = recordKey; this.stopKey = stopKey;
    this.state = 'ready';
    this.mediaRecorder = null; this.chunks = [];
    this.loopBuffer = null; this.sourceNode = null;
    this.loopStartTime = 0; this.loopDuration = 0;
    this.overdubChunks = [];
    this.divider = 1; this.uiDisabled = false;
    this._pitchJob = null;
    this._lastUnprocessedBuffer = null;
    this._undoStack = [];
    this.isLoopbackDetected = false;

    this.gainNode = audioCtx.createGain();
    const volSlider = $('#volSlider'+index), volValue = $('#volValue'+index);
    this.gainNode.gain.value = 0.9;
    if (volSlider && volValue){
      volSlider.value = 90; volValue.textContent = '90%';
      volSlider.addEventListener('input', ()=>{ const v=parseInt(volSlider.value,10); this.gainNode.gain.value=v/100; volValue.textContent=v+'%'; });
    }

    this.pitchSemitones = 0;
    this.fx = { chain: [], nextId: 1 };

    this.updateUI();
    this.setRing(0);
    if (index >= 2 && dividerSelectors[index]) {
      this.divider = parseFloat(dividerSelectors[index].value);
      dividerSelectors[index].addEventListener('change', e => { this.divider = parseFloat(e.target.value); });
      this.disable(true);
    }
    if (this.stopBtn) {
      addTap(this.stopBtn, () => {
        if (this.state === 'playing' || this.state === 'overdub') this.stopPlayback();
        else if (this.state === 'stopped') this.resumePlayback();
        else if (this.state === 'recording') this.abortRecording();
      });
    }
    if (this.clearBtn) {
      addTap(this.clearBtn, () => this.clearLoop());
    }
    addTap(this.mainBtn, async () => {
      await ensureMic();
      await this.handleMainBtn();
    });
    const fxBtn = $('#fxMenuBtn' + index);
    if (fxBtn) fxBtn.addEventListener('click', () => openTrackFxMenu(this.index));
  }
  cancelPitchJob(){
    if (this._pitchJob){
      try { this._pitchJob.cancel(); } catch(e){}
      this._pitchJob = null;
    }
  }
  setLED(color){
    const map={green:'#22c55e', red:'#e11d48', orange:'#f59e0b', gray:'#6b7280'};
    this.ledRing.style.stroke=map[color]||'#fff';
    this.ledRing.style.filter=(color==='gray' ?'none' :'drop-shadow(0 0 8px '+(map[color]+'88')+')');
  }
  setRing(r){
    const R=42,C=2*Math.PI*R;
    this.ledRing.style.strokeDasharray=C;
    this.ledRing.style.strokeDashoffset=C*(1-r);
  }
  setIcon(s,c){ this.looperIcon.textContent=s; if(c) this.looperIcon.style.color=c; }
  setDisplay(t){ this.stateDisplay.textContent=t; }
  updateUI(){
    switch(this.state){
      case 'ready':     this.setLED('green'); this.setRing(0); this.setIcon('▶'); this.setDisplay('Ready'); break;
      case 'recording': this.setLED('red'); this.setIcon('⦿','#e11d48'); this.setDisplay('Recording...'); break;
      case 'playing':   this.setLED('green'); this.setIcon('▶'); this.setDisplay('Playing'); break;
      case 'overdub':   this.setLED('orange'); this.setIcon('⦿','#f59e0b'); this.setDisplay('Overdubbing'); break;
      case 'stopped':   this.setLED('gray'); this.setRing(0); this.setIcon('▶','#aaa'); this.setDisplay('Stopped'); break;
      case 'waiting':   this.setLED('gray'); this.setRing(0); this.setIcon('⏳','#aaa'); this.setDisplay('Waiting...'); break;
    }
    if (this.uiDisabled){
      this.mainBtn.disabled = true;
      if (this.stopBtn) this.stopBtn.disabled = true;
      if (this.clearBtn) this.clearBtn.disabled = true;
      this.mainBtn.classList.add('disabled-btn');
      if (this.stopBtn) this.stopBtn.classList.add('disabled-btn');
      if (this.clearBtn) this.clearBtn.classList.add('disabled-btn');
      this.setDisplay('WAIT: Set Track 1');
    } else {
      this.mainBtn.disabled = false;
      if (this.stopBtn) this.stopBtn.disabled = false;
      if (this.clearBtn) this.clearBtn.disabled = false;
      this.mainBtn.classList.remove('disabled-btn');
      if (this.stopBtn) this.stopBtn.classList.remove('disabled-btn');
      if (this.clearBtn) this.clearBtn.classList.remove('disabled-btn');
    }
  }
  disable(v){ this.uiDisabled=v; this.updateUI(); }
  async handleMainBtn(){
    if (this.state==='ready') await this.phaseLockedRecord();
    else if (this.state==='recording') await this.stopRecordingAndPlay();
    else if (this.state==='playing') this.armOverdub();
    else if (this.state==='overdub') this.finishOverdub();
  }
  async phaseLockedRecord(){
    await ensureMic();
    if (this.index===1 || !masterIsSet){ await this.startRecording(); return; }
    this.state='waiting'; this.updateUI();
    const { startAt, waitMs } = scheduleAtNextBar(masterLoopDuration, this.divider);
    setTimeout(()=>{ this._startPhaseLockedRecording(masterLoopDuration*this.divider, startAt); }, waitMs);
  }
  async _startPhaseLockedRecording(len, startAt){
    this.state='recording'; this.updateUI();
    this.chunks=[];
    const recStream = getRecordingStream();
    if (!recStream) {
      showMsg('❌ Microphone not available for recording', '#ff6b6b');
      this.state = 'ready'; this.updateUI();
      return;
    }
    try {
      this.mediaRecorder = await startRecordingWithSafety(this, recStream, {
        expectedMs: len * 1000,
        onData: e => this.chunks.push(e.data),
        onStop: async () => {
          await this.stopRecordingAndPlay();
        },
        onError: e => {
          this.state = 'ready'; this.updateUI();
          this.setRing(0);
        }
      });
      const self=this;
      (function anim(){
        if (self.state==='recording'){
          const now = audioCtx.currentTime;
          const pct = (now - startAt) / len;
          self.setRing(Math.min(pct, 1));
          if (pct < 1) requestAnimationFrame(anim);
        }
      })();
    } catch(e){
      console.error('Recording start failed', e);
      this.state = 'ready'; this.updateUI();
      this.setRing(0);
    }
  }
  async startRecording(){
    await ensureMic();
    if (this.index>=2 && !masterIsSet) return;
    this.state='recording'; this.updateUI();
    this.chunks=[];
    const recStream = getRecordingStream();
    if (!recStream) {
      showMsg('❌ Microphone not available for recording', '#ff6b6b');
      this.state = 'ready'; this.updateUI();
      return;
    }
    const maxDur = (this.index===1)?60000:(masterLoopDuration? masterLoopDuration*this.divider*1000 : 12000);
    try {
      this.mediaRecorder = await startRecordingWithSafety(this, recStream, {
        expectedMs: maxDur,
        onData: e => this.chunks.push(e.data),
        onStop: async () => {
          await this.stopRecordingAndPlay();
        },
        onError: e => {
          this.state = 'ready'; this.updateUI();
          this.setRing(0);
        }
      });
      const start = Date.now(), self=this;
      (function anim(){
        if (self.state==='recording'){
          const pct = (Date.now() - start) / maxDur;
          self.setRing(Math.min(pct, 1));
          if (pct < 1) requestAnimationFrame(anim);
        }
      })();
    } catch(e){
      console.error('Recording start failed', e);
      this.state = 'ready'; this.updateUI();
      this.setRing(0);
    }
  }
  async stopRecordingAndPlay(){
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') return;
    this.state='playing'; this.updateUI();
    this.mediaRecorder.onstop = async ()=>{
      const blob=new Blob(this.chunks,{type:'audio/webm'}); const buf=await blob.arrayBuffer();
      try {
        const buffer = await decodeAudioBuffer(buf);
        this.loopBuffer=buffer; this.loopDuration=buffer.duration;
        if (this.index===1){
          masterLoopDuration=this.loopDuration;
          masterBPM = Math.round((60/this.loopDuration)*4);
          updateDelayFromTempo();
          masterIsSet=true; bpmLabel.textContent = `BPM: ${masterBPM}`;
          for (let k=2;k<=4;k++) loopers[k].disable(false);
          resyncAllTracksFromMaster();
        }
        this.startPlayback();
      } catch (e) {
        console.error('decodeAudioData failed', e);
        showMsg('❌ Cannot decode recorded audio', '#ff6b6b');
        this.state = 'ready'; this.updateUI();
      }
    };
    this.mediaRecorder.stop();
  }
  abortRecording(){
    if (this.mediaRecorder && this.state==='recording'){
      try {
        this.mediaRecorder.ondataavailable = null;
        this.mediaRecorder.onstop = null;
        if (this.mediaRecorder.state === 'recording') this.mediaRecorder.stop();
      } catch {}
      try { releaseRecLock(); } catch {}
      this.mediaRecorder=null; this.chunks=[]; this.state='ready'; this.loopBuffer=null; this.loopDuration=0; this.setRing(0); this.updateUI();
    }
  }
  _applyPitchIfAny(){
  }
  _buildEffectNodes(effect){
    disposeEffectNodes(effect);
    if (effect.type==='LowPass'){
      const input = audioCtx.createGain(), biq = audioCtx.createBiquadFilter(), output = audioCtx.createGain();
      biq.type='lowpass'; input.connect(biq); biq.connect(output); biq.frequency.value = effect.params.cutoff; biq.Q.value = effect.params.q;
      effect.nodes = { input, output, biq, dispose(){ try{input.disconnect(); biq.disconnect(); output.disconnect();}catch{} } };
    } else if (effect.type==='HighPass'){
      const input = audioCtx.createGain(), biq = audioCtx.createBiquadFilter(), output = audioCtx.createGain();
      biq.type='highpass'; input.connect(biq); biq.connect(output); biq.frequency.value = effect.params.cutoff; biq.Q.value = effect.params.q;
      effect.nodes = { input, output, biq, dispose(){ try{input.disconnect(); biq.disconnect(); output.disconnect();}catch{} } };
    } else if (effect.type==='Pan'){
      const input = audioCtx.createGain(), output = audioCtx.createGain();
      const panner = (typeof audioCtx.createStereoPanner==='function') ? audioCtx.createStereoPanner() : null;
      if (panner){ input.connect(panner); panner.connect(output); panner.pan.value = effect.params.pan; } else { input.connect(output); }
      effect.nodes = { input, output, panner, dispose(){ try{input.disconnect(); panner?.disconnect(); output.disconnect();}catch{} } };
    } else if (effect.type==='Delay'){
      const input = audioCtx.createGain(), output = audioCtx.createGain();
      const dry = audioCtx.createGain(), wet = audioCtx.createGain(), d = audioCtx.createDelay(2.0), fb = audioCtx.createGain();
      input.connect(dry); dry.connect(output); input.connect(d); d.connect(wet); wet.connect(output); d.connect(fb); fb.connect(d);
      d.delayTime.value = effect.params.timeSec; fb.gain.value = clamp(effect.params.feedback, 0, 0.95); wet.gain.value = clamp(effect.params.mix, 0, 1);
      effect.nodes = { input, output, dry, wet, d, fb, dispose(){ try{input.disconnect(); dry.disconnect(); wet.disconnect(); d.disconnect(); fb.disconnect(); output.disconnect();}catch{} } };
    } else if (effect.type==='Compressor'){
      const input = audioCtx.createGain(), comp = audioCtx.createDynamicsCompressor(), output = audioCtx.createGain();
      input.connect(comp); comp.connect(output);
      comp.threshold.value = effect.params.threshold; comp.knee.value = effect.params.knee; comp.ratio.value = effect.params.ratio; comp.attack.value = effect.params.attack; comp.release.value = effect.params.release;
      effect.nodes = { input, output, comp, dispose(){ try{input.disconnect(); comp.disconnect(); output.disconnect();}catch{} } };
    } else if (effect.type==='Pitch'){
      effect.nodes = { input:null, output:null, dispose(){} };
    }
  }
  _rebuildChainWiring(){
    if (!this.sourceNode) return;
    try{ this.sourceNode.disconnect(); }catch{}
    try{ this.gainNode.disconnect(); }catch{}
    this._applyPitchIfAny();
    let head = this.sourceNode;
    disposeEffectNodesList(this.fx.chain);
    for (const fx of this.fx.chain){
      if (fx.type!=='Pitch') this._buildEffectNodes(fx);
    }
    for (const fx of this.fx.chain){
      if (fx.type==='Pitch' || !fx.nodes) continue;
      if (!fx.bypass){ try{ head.connect(fx.nodes.input); }catch{}; head = fx.nodes.output; }
    }
    try{ head.connect(this.gainNode); }catch{}
    if (!masterBus){
      console.warn('masterBus missing; creating on demand');
      ensureMasterBus();
    }
    this.gainNode.connect(masterBus);
  }
  startPlayback(){
    if (!this.loopBuffer) return;
    if (this.sourceNode){ try{ this.sourceNode.stop(); this.sourceNode.disconnect(); }catch{} }
    this.sourceNode = audioCtx.createBufferSource();
    this.sourceNode.buffer = this.loopBuffer; this.sourceNode.loop = true;
    let off=0;
    if (this.index!==1 && masterIsSet && loopers[1].sourceNode && masterLoopDuration>0){
      const master = loopers[1]; const now = audioCtx.currentTime;
      off = (now - master.loopStartTime)%masterLoopDuration;
      if (isNaN(off)||off<0||off>this.loopBuffer.duration) off=0;
    }
    this.loopStartTime = audioCtx.currentTime - off;
    this._rebuildChainWiring();
    try{ this.sourceNode.start(audioCtx.currentTime, off); } catch { try{ this.sourceNode.start(audioCtx.currentTime, 0); } catch {} }
    this.state='playing'; this.updateUI(); this._animate();
    renderTrackFxSummary(this.index);
  }
  resumePlayback(){
    if (this.index===1){
      this.startPlayback();
      for (let k=2;k<=4;k++) if (loopers[k].state==='playing') loopers[k].startPlayback();
    } else { this.startPlayback(); }
  }
  stopPlayback(){ if (this.sourceNode){ try{ this.sourceNode.stop(); this.sourceNode.disconnect(); }catch{} } this.state='stopped'; this.updateUI(); }
  armOverdub(){
    if (this.state!=='playing') return;
    if (!this.loopDuration || this.loopDuration <= 0){
      showMsg('❌ Loop duration invalid — cannot overdub', '#ff6b6b');
      setTimeout(hideMsg, 1000);
      return;
    }
    
    // Loopback detection before arming overdub
    if (this.isLoopbackDetected){
      showMsg(`⚠️ Loopback detected on your device. Disable monitor/loopback in your audio interface settings to prevent re-recording playback.`, '#ffcc00');
      // Option to force overdub
      const forceOverdub = confirm('Loopback detected. Continue overdub anyway?');
      if (!forceOverdub) return;
    }

    this.state='overdub'; this.updateUI();
    const now = audioCtx.currentTime;
    const elapsed = isFinite(now - this.loopStartTime) ? (now - this.loopStartTime) % this.loopDuration : 0;
    let toNext = this.loopDuration - elapsed;
    if (!isFinite(toNext) || toNext < 0) toNext = 0;
    setTimeout(()=>this.startOverdubRecording(), toNext * 1000);
  }
  async startOverdubRecording(){
    muteForOverdub(this);
    this.overdubChunks = [];
    
    // This part is crucial - only record from raw mic stream
    const recStream = getRecordingStream();
    if (!recStream) {
      restoreAfterOverdub(this);
      showMsg('❌ Microphone not available for overdub. Aborting.', '#ff6b6b');
      this.state = 'playing'; this.updateUI();
      return;
    }

    try {
      this.mediaRecorder = await startRecordingWithSafety(this, recStream, {
        expectedMs: this.loopDuration * 1000,
        onData: e => this.overdubChunks.push(e.data),
        onStop: async () => {
          await this.finishOverdub();
        },
        onError: e => {
          restoreAfterOverdub(this);
          this.state = 'playing'; this.updateUI();
        }
      });
      const d = (this.loopDuration && this.loopDuration > 0) ? this.loopDuration : 0.001;
    } catch(e){
      console.error('Overdub recorder start failed', e);
      restoreAfterOverdub(this);
      showMsg('❌ Cannot start overdub recorder', '#ff6b6b');
      this.state = 'playing'; this.updateUI();
      return;
    }
  }
  async finishOverdub(){
    if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        this.state='playing'; this.updateUI();
        restoreAfterOverdub(this);
        return;
    }
    this.mediaRecorder.onstop = async ()=>{
      pushUndoSnapshot(this);
      try {
        const od=new Blob(this.overdubChunks,{type:'audio/webm'}), arr=await od.arrayBuffer();
        let newBuf = await decodeAudioBuffer(arr);
        
        // Resample new buffer if sample rates don't match
        if (newBuf.sampleRate !== this.loopBuffer.sampleRate) {
          newBuf = await resampleAudioBuffer(newBuf, this.loopBuffer.sampleRate);
        }

        if (!this.loopBuffer){
          this.loopBuffer = newBuf; this.loopDuration = newBuf.duration; restoreAfterOverdub(this); this.startPlayback(); return;
        }

        const oC=this.loopBuffer.numberOfChannels, nC=newBuf.numberOfChannels;
        const outC=Math.max(oC,nC);
        
        const baseLen = this.loopBuffer.length;
        const overdubBuffer = audioCtx.createBuffer(nC, baseLen, newBuf.sampleRate);
        for(let ch=0; ch < nC; ch++){
          const odData = overdubBuffer.getChannelData(ch);
          const newBufData = newBuf.getChannelData(ch);
          for(let i=0; i < baseLen; i++){
            if (ALLOW_WRAP_OVERDUB) {
              odData[i] = newBufData[i % newBuf.length] || 0;
            } else {
              odData[i] = (i < newBufData.length) ? newBufData[i] : 0;
            }
          }
        }
        
        const out=audioCtx.createBuffer(outC, baseLen, this.loopBuffer.sampleRate);
        for (let ch=0; ch<outC; ch++){
          const outD=out.getChannelData(ch), o=oC>ch?this.loopBuffer.getChannelData(ch):null, n=nC>ch?overdubBuffer.getChannelData(ch):null;
          for (let i=0;i<baseLen;i++){
            const ov = o ? (o[i] || 0) : 0;
            const nv = n ? (n[i] || 0) : 0;
            outD[i] = ov + nv;
            // Apply soft limiter to prevent clipping
            if (outD[i] > 1) outD[i] = 1;
            if (outD[i] < -1) outD[i] = -1;
          }
        }

        this.loopBuffer = out; this.loopDuration = out.duration;
        restoreAfterOverdub(this);
        this.startPlayback();
      } catch (e){
        console.error('Overdub decode error', e);
        restoreAfterOverdub(this);
        this.state='playing'; this.updateUI();
      }
    };
    this.mediaRecorder.stop();
  }
  clearLoop(){
    disposeTrackNodes(this);
    this.loopBuffer=null; this.loopDuration=0; this.state='ready'; this.updateUI();
    this.cancelPitchJob();
    if (this.index===1){
      masterLoopDuration=null; masterBPM=null; masterIsSet=false; bpmLabel.textContent='BPM: --';
      for (let k=2;k<=4;k++) loopers[k].disable(true);
      for (let k=2;k<=4;k++) loopers[k].clearLoop();
      updateDelayFromTempo();
    }
  }
  _animate(){
    if (this.state==='playing' && this.loopDuration>0 && this.sourceNode){
      const now = audioCtx.currentTime; const pos=(now - this.loopStartTime)%this.loopDuration;
      this.setRing(pos/this.loopDuration); requestAnimationFrame(this._animate.bind(this));
    } else { this.setRing(0); }
  }
}

// Resample buffer to target sample rate
async function resampleAudioBuffer(buf, targetSampleRate){
  if (buf.sampleRate === targetSampleRate) return buf;
  const offline = new OfflineAudioContext(buf.numberOfChannels, Math.ceil(buf.duration * targetSampleRate), targetSampleRate);
  const src = offline.createBufferSource();
  src.buffer = buf;
  src.connect(offline.destination);
  src.start(0);
  return offline.startRendering();
}

window.addEventListener('beforeunload', () => {
  try {
    for (const p of _pitchWorkerPool) try { p.worker.terminate(); } catch(e){}
  } catch(e){}
  try { releaseRecLock(); } catch(e){}
});
const keyMap = [{rec:'w',stop:'s'},{rec:'e',stop:'d'},{rec:'r',stop:'f'},{rec:'t',stop:'g'}];
window.loopers = [];
for (let i=1;i<=4;i++) loopers[i] = new Looper(i, keyMap[i-1].rec, keyMap[i-1].stop);
document.addEventListener('keydown', e=>{
  const k=e.key.toLowerCase();
  loopers.forEach((lp, idx)=>{
    if (idx===0) return;
    if (k===keyMap[idx-1].rec){ lp.mainBtn.click(); e.preventDefault(); }
    if (k===keyMap[idx-1].stop){
      if (lp.state==='playing'||lp.state==='overdub') lp.stopBtn.click();
      else if (lp.state==='stopped') lp.stopBtn.click();
      else if (lp.state==='recording') lp.stopBtn.click();
      e.preventDefault();
    }
  });
});
const fxMenuPopup   = $('#fxMenuPopup');
const fxParamsPopup = $('#fxParamsPopup');
const AFTER_FX_CATALOG = [
  { type:'Pitch',      name:'Pitch (Offline)', defaults:{ semitones:0 } },
  { type:'LowPass',    name:'Low-pass Filter',      defaults:{ cutoff:12000, q:0.7 } },
  { type:'HighPass',   name:'High-pass Filter',     defaults:{ cutoff:120, q:0.7 } },
  { type:'Pan',        name:'Pan',                  defaults:{ pan:0 } },
  { type:'Delay',      name:'Delay (Insert)',       defaults:{ timeSec:0.25, feedback:0.25, mix:0.25 } },
  { type:'Compressor', name:'Compressor',           defaults:{ threshold:-18, knee:6, ratio:3, attack:0.003, release:0.25 } },
];
function addEffectToTrack(lp, type){
  const meta = AFTER_FX_CATALOG.find(x=>x.type===type);
  if (!meta) return;
  const eff = { id: lp.fx.nextId++, type, name: meta.name, params: {...meta.defaults}, bypass:false, nodes:null };
  if (type==='Pitch') eff.params.semitones = lp.pitchSemitones || 0;
  lp.fx.chain.push(eff);
  if (lp.state==='playing') lp._rebuildChainWiring();
  renderTrackFxSummary(lp.index);
  if (type==='Pitch' && lp.loopBuffer) applyPitchAfterFxToLoop(lp, eff.params.semitones);
}
function moveEffect(lp, id, dir){
  const i = lp.fx.chain.findIndex(e=>e.id===id); if (i<0) return;
  const j = i + (dir==='up'?-1:+1);
  if (j<0 || j>=lp.fx.chain.length) return;
  const [x] = lp.fx.chain.splice(i,1);
  lp.fx.chain.splice(j,0,x);
  if (lp.state==='playing') lp._rebuildChainWiring();
  openTrackFxMenu(lp.index);
}
function removeEffect(lp, id){
  const i = lp.fx.chain.findIndex(e=>e.id===id); if (i<0) return;
  const [ fx ] = lp.fx.chain.splice(i,1);
  disposeEffectNodes(fx);
  if (fx.type==='Pitch') lp.pitchSemitones = 0;
  if (lp.state==='playing') lp._rebuildChainWiring();
  openTrackFxMenu(lp.index);
}
function toggleBypass(lp, id){
  const fx = lp.fx.chain.find(e=>e.id===id); if (!fx) return;
  fx.bypass = !fx.bypass;
  if (lp.state==='playing') lp._rebuildChainWiring();
  openTrackFxMenu(lp.index);
}
function renderTrackFxSummary(idx){
  const lp = loopers[idx]; const el = $('#trackFxLabels'+idx); if (!lp || !el) return;
  if (!lp.fx.chain.length){ el.textContent=''; return; }
  el.textContent = lp.fx.chain.map((e,i)=> `${i+1}.${e.type === 'Pitch' ? `Pitch ${e.params.semitones>0?'+':''}${e.params.semitones}` : e.name}`).join(' → ');
}
function openTrackFxMenu(idx){
  const lp = loopers[idx]; if (!lp) return;
  fxMenuPopup.classList.remove('hidden');
  fxMenuPopup.innerHTML = `
    <div class="fx-popup-inner">
      <h3>Track ${idx} – After FX</h3>
      <div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:10px;">
        ${AFTER_FX_CATALOG.map(m=>`<button class="addFxBtn" data-type="${m.type}">+ ${m.name}</button>`).join('')}
      </div>
      <div><strong>Chain (series order):</strong></div>
      <div id="chainList" style="margin-top:8px;">
        ${lp.fx.chain.length? lp.fx.chain.map((e,i)=>`
          <div class="fx-row" style="display:flex;align-items:center;gap:8px;margin:8px 0;">
            <div style="width:28px;text-align:right;">${i+1}</div>
            <div style="flex:1">${e.name}${e.type==='Pitch' ? ` — ${e.params.semitones>0?'+':''}${e.params.semitones} st` : ''}</div>
            <button class="upBtn" data-id="${e.id}">▲</button>
            <button class="downBtn" data-id="${e.id}">▼</button>
            <button class="editBtn" data-id="${e.id}">Edit</button>
            <button class="bypassBtn ${e.bypass?'active':''}" data-id="${e.id}">${e.bypass?'Bypassed':'Bypass'}</button>
            <button class="removeBtn" data-id="${e.id}">✖</button>
          </div>`).join('') : `<div class="small" style="margin:6px 0 0 0;">No effects yet. Add from above.</div>`}
      </div>
      <div style="margin-top:10px;">
        <button id="closeFxMenu">Close</button>
      </div>
    </div>`;
  fxMenuPopup.querySelectorAll('.addFxBtn').forEach(b=> b.addEventListener('click', ()=>{ addEffectToTrack(lp, b.dataset.type); openTrackFxMenu(idx); }));
  fxMenuPopup.querySelectorAll('.upBtn').forEach(b=> b.addEventListener('click', ()=> moveEffect(lp, parseInt(b.dataset.id,10), 'up')));
  fxMenuPopup.querySelectorAll('.downBtn').forEach(b=> b.addEventListener('click', ()=> moveEffect(lp, parseInt(b.dataset.id,10), 'down')));
  fxMenuPopup.querySelectorAll('.removeBtn').forEach(b=> b.addEventListener('click', ()=> removeEffect(lp, parseInt(b.dataset.id,10))));
  fxMenuPopup.querySelectorAll('.bypassBtn').forEach(b=> b.addEventListener('click', ()=> toggleBypass(lp, parseInt(b.dataset.id,10))));
  fxMenuPopup.querySelectorAll('.editBtn').forEach(b=> b.addEventListener('click', ()=> openFxParamsPopup(lp.index, parseInt(b.dataset.id,10))));
  $('#closeFxMenu').addEventListener('click', ()=> fxMenuPopup.classList.add('hidden'));
  renderTrackFxSummary(idx);
}
function openFxParamsPopup(idx, id){
  const lp = loopers[idx]; if (!lp) return;
  const fx = lp.fx.chain.find(e=>e.id===id); if (!fx) return;
  fxParamsPopup.classList.remove('hidden');
  fxParamsPopup.innerHTML = `
    <div class="fx-popup-inner">
      <h3>${fx.name} – Parameters</h3>
      <div id="fxParamsBody">${renderFxParamsBody(fx)}</div>
      <div style="margin-top:10px;">
        <button id="closeFxParams">Close</button>
      </div>
    </div>`;
  wireFxParams(lp, fx);
  $('#closeFxParams').addEventListener('click', ()=> fxParamsPopup.classList.add('hidden'));
}
function renderFxParamsBody(fx){
  switch(fx.type){
    case 'Pitch': return `<label>Semi-tones <span id="pSemVal">${fx.params.semitones}</span><input id="pSem" type="range" min="-12" max="12" step="1" value="${fx.params.semitones}"></label>`;
    case 'LowPass': return `<label>Cutoff <span id="lpCutVal">${Math.round(fx.params.cutoff)} Hz</span><input id="lpCut" type="range" min="200" max="12000" step="10" value="${Math.round(fx.params.cutoff)}"></label><label>Q <span id="lpQVal">${fx.params.q.toFixed(2)}</span><input id="lpQ" type="range" min="0.3" max="12" step="0.01" value="${fx.params.q}"></label>`;
    case 'HighPass': return `<label>Cutoff <span id="hpCutVal">${Math.round(fx.params.cutoff)} Hz</span><input id="hpCut" type="range" min="20" max="2000" step="5" value="${Math.round(fx.params.cutoff)}"></label><label>Q <span id="hpQVal">${fx.params.q.toFixed(2)}</span><input id="hpQ" type="range" min="0.3" max="12" step="0.01" value="${fx.params.q}"></label>`;
    case 'Pan': return `<label>Pan <span id="panVal">${fx.params.pan.toFixed(2)}</span><input id="pan" type="range" min="-1" max="1" step="0.01" value="${fx.params.pan}"></label>`;
    case 'Delay': return `<label>Time <span id="dTimeVal">${(fx.params.timeSec*1000)|0} ms</span><input id="dTime" type="range" min="1" max="2000" step="1" value="${(fx.params.timeSec*1000)|0}"></label><label>Feedback <span id="dFbVal">${Math.round(fx.params.feedback*100)}%</span><input id="dFb" type="range" min="0" max="95" step="1" value="${Math.round(fx.params.feedback*100)}"></label><label>Mix <span id="dMixVal">${Math.round(fx.params.mix*100)}%</span><input id="dMix" type="range" min="0" max="100" step="1" value="${Math.round(fx.params.mix*100)}"></label>`;
    case 'Compressor': return `<label>Threshold <span id="cThVal">${fx.params.threshold} dB</span><input id="cTh" type="range" min="-60" max="0" step="1" value="${fx.params.threshold}"></label><label>Ratio <span id="cRaVal">${fx.params.ratio}:1</span><input id="cRa" type="range" min="1" max="20" step="0.1" value="${fx.params.ratio}"></label><label>Knee <span id="cKnVal">${fx.params.knee} dB</span><input id="cKn" type="range" min="0" max="40" step="1" value="${fx.params.knee}"></label><label>Attack <span id="cAtVal">${(fx.params.attack*1000).toFixed(1)} ms</span><input id="cAt" type="range" min="0" max="100" step="0.5" value="${(fx.params.attack*1000).toFixed(1)}"></label><label>Release <span id="cRlVal">${(fx.params.release*1000).toFixed(0)} ms</span><input id="cRl" type="range" min="10" max="2000" step="10" value="${(fx.params.release*1000).toFixed(0)}"></label>`;
  }
  return `<div class="small">No params.</div>`;
}
function wireFxParams(lp, fx){
  if (fx.type==='Pitch'){
    $('#pSem').addEventListener('input', e=>{
      fx.params.semitones = parseInt(e.target.value,10);
      $('#pSemVal').textContent = fx.params.semitones;
      lp.pitchSemitones = fx.params.semitones;
      renderTrackFxSummary(lp.index);
      if (lp.loopBuffer) {
        applyPitchAfterFxToLoop(lp, fx.params.semitones);
      }
    });
  }
  if (fx.type==='LowPass'){ $('#lpCut').addEventListener('input', e=>{ fx.params.cutoff = parseFloat(e.target.value); $('#lpCutVal').textContent = Math.round(fx.params.cutoff)+' Hz'; if (fx.nodes?.biq) fx.nodes.biq.frequency.setTargetAtTime(fx.params.cutoff, audioCtx.currentTime, 0.01); renderTrackFxSummary(lp.index); }); $('#lpQ').addEventListener('input', e=>{ fx.params.q = parseFloat(e.target.value); $('#lpQVal').textContent = fx.params.q.toFixed(2); if (fx.nodes?.biq) fx.nodes.biq.Q.setTargetAtTime(fx.params.q, audioCtx.currentTime, 0.01); }); }
  if (fx.type==='HighPass'){ $('#hpCut').addEventListener('input', e=>{ fx.params.cutoff = parseFloat(e.target.value); $('#hpCutVal').textContent = Math.round(fx.params.cutoff)+' Hz'; if (fx.nodes?.biq) fx.nodes.biq.frequency.setTargetAtTime(fx.params.cutoff, audioCtx.currentTime, 0.01); renderTrackFxSummary(lp.index); }); $('#hpQ').addEventListener('input', e=>{ fx.params.q = parseFloat(e.target.value); $('#hpQVal').textContent = fx.params.q.toFixed(2); if (fx.nodes?.biq) fx.nodes.biq.Q.setTargetAtTime(fx.params.q, audioCtx.currentTime, 0.01); }); }
  if (fx.type==='Pan'){ $('#pan').addEventListener('input', e=>{ fx.params.pan = parseFloat(e.target.value); $('#panVal').textContent = fx.params.pan.toFixed(2); if (fx.nodes?.panner) fx.nodes.panner.pan.setTargetAtTime(fx.params.pan, audioCtx.currentTime, 0.01); renderTrackFxSummary(lp.index); }); }
  if (fx.type==='Delay'){ $('#dTime').addEventListener('input', e=>{ fx.params.timeSec = parseInt(e.target.value,10)/1000; $('#dTimeVal').textContent = `${parseInt(e.target.value,10)} ms`; if (fx.nodes?.d) fx.nodes.d.delayTime.setTargetAtTime(fx.params.timeSec, audioCtx.currentTime, 0.01); renderTrackFxSummary(lp.index); }); $('#dFb').addEventListener('input', e=>{ fx.params.feedback = parseInt(e.target.value,10)/100; $('#dFbVal').textContent = `${parseInt(e.target.value,10)}%`; if (fx.nodes?.fb) fx.nodes.fb.gain.setTargetAtTime(clamp(fx.params.feedback,0,0.95), audioCtx.currentTime, 0.01); }); $('#dMix').addEventListener('input', e=>{ fx.params.mix = parseInt(e.target.value,10)/100; $('#dMixVal').textContent = `${parseInt(e.target.value,10)}%`; if (fx.nodes?.wet) fx.nodes.wet.gain.setTargetAtTime(clamp(fx.params.mix,0,1), audioCtx.currentTime, 0.01); }); }
  if (fx.type==='Compressor'){ $('#cTh').addEventListener('input', e=>{ fx.params.threshold = parseInt(e.target.value,10); $('#cThVal').textContent = fx.params.threshold+' dB'; if (fx.nodes?.comp) fx.nodes.comp.threshold.setTargetAtTime(fx.params.threshold, audioCtx.currentTime, 0.01); }); $('#cRa').addEventListener('input', e=>{ fx.params.ratio = parseFloat(e.target.value); $('#cRaVal').textContent = fx.params.ratio+':1'; if (fx.nodes?.comp) fx.nodes.comp.ratio.setTargetAtTime(fx.params.ratio, audioCtx.currentTime, 0.01); }); $('#cKn').addEventListener('input', e=>{ fx.params.knee = parseInt(e.target.value,10); $('#cKnVal').textContent = fx.params.knee+' dB'; if (fx.nodes?.comp) fx.nodes.comp.knee.setTargetAtTime(fx.params.knee, audioCtx.currentTime, 0.01); }); $('#cAt').addEventListener('input', e=>{ fx.params.attack = parseFloat(e.target.value)/1000; $('#cAtVal').textContent = (fx.params.attack*1000).toFixed(1)+' ms'; if (fx.nodes?.comp) fx.nodes.comp.attack.setTargetAtTime(fx.params.attack, audioCtx.currentTime, 0.01); }); $('#cRl').addEventListener('input', e=>{ fx.params.release = parseFloat(e.target.value)/1000; $('#cRlVal').textContent = (fx.params.release*1000).toFixed(0)+' ms'; if (fx.nodes?.comp) fx.nodes.comp.release.setTargetAtTime(fx.params.release, audioCtx.currentTime, 0.01); }); }
}
const monitorBtn = $('#monitorBtn');
if (monitorBtn){
  monitorBtn.addEventListener('click', async ()=>{
    await ensureMic();
    liveMicMonitoring = !liveMicMonitoring;
    if (liveMicMonitoring) {
        liveMicMonitorGain.gain.value = 1;
    } else {
        liveMicMonitorGain.gain.value = 0;
    }
    monitorBtn.textContent = liveMicMonitoring ? 'Live MIC ON 🎤' : 'Live MIC OFF';
    monitorBtn.classList.toggle('active', liveMicMonitoring);
  });
  monitorBtn.textContent='Live MIC OFF';
}
wireBeforeFX();
function resumeAudio(){ if (audioCtx.state==='suspended'){ audioCtx.resume(); hideMsg(); } }
window.addEventListener('click', resumeAudio, { once:true });
window.addEventListener('touchstart', resumeAudio, { once:true });
if (audioCtx.state==='suspended'){
  showMsg("👆 Tap anywhere to start audio!<br>Then toggle Before-FX and tweak in the popup. For per-track FX: use 🎛 FX Menu.", "#22ff88");
}
let mixRecorder = null, mixChunks = [], mixRecording = false;
function setMixButton(on){
  const b = document.getElementById('mixRecBtn');
  if (!b) return;
  mixRecording = on;
  b.textContent = on ? '■ Stop & Save' : '● Record Mix';
  b.classList.toggle('active', on);
}
async function startMasterRecording(){
  await ensureMic();
  if (!masterStream){
    showMsg('❌ Master stream not available'); return;
  }
  try {
    mixChunks = [];
    mixRecorder = new MediaRecorder(masterStream, { mimeType: pickAudioMime() });
    mixRecorder.ondataavailable = (e)=>{ if (e.data?.size) mixChunks.push(e.data); };
    mixRecorder.onstop = async ()=>{ await saveMasterRecording(); };
    mixRecorder.start();
    setMixButton(true);
    showMsg('⦿ Recording master mix...', '#a7ffed');
    setTimeout(hideMsg, 1200);
  } catch(e){
    showMsg('❌ Cannot start master recording'); console.error(e);
  }
}
async function stopMasterRecording(){
  if (mixRecorder && mixRecorder.state !== 'inactive'){
    try { mixRecorder.stop(); } catch {}
  }
  setMixButton(false);
}
async function blobToArrayBuffer(blob){
  return await new Response(blob).arrayBuffer();
}
async function saveMasterRecording(){
  const webmBlob = new Blob(mixChunks, { type:'audio/webm' });
  const wantWav = confirm('Save master mix as WAV? OK = WAV (uncompressed), Cancel = WebM');
  if (wantWav){
    try {
      const arr = await blobToArrayBuffer(webmBlob);
      const audioBuf = await decodeAudioBuffer(arr);
      const wavBlob = encodeWavFromAudioBuffer(audioBuf);
      const a = document.createElement('a');
      a.href = URL.createObjectURL(wavBlob);
      a.download = `looper-mix-${Date.now()}.wav`;
      a.click();
      URL.revokeObjectURL(a.href);
      showMsg('✅ Saved WAV mix to downloads', '#a7ffed');
      setTimeout(hideMsg, 1500);
      return;
    } catch(e){
      console.warn('WAV export failed, falling back to WebM', e);
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(webmBlob);
  a.download = `looper-mix-${Date.now()}.webm`;
  a.click();
  URL.revokeObjectURL(a.href);
  showMsg('✅ Saved WebM mix to downloads', '#a7ffed');
  setTimeout(hideMsg, 1500);
}
const mixBtn = document.getElementById('mixRecBtn');
if (mixBtn){
  mixBtn.addEventListener('click', async () => {
    if (!mixRecording) await startMasterRecording();
    else await stopMasterRecording();
  });
}
function decodeAudioBuffer(arrayBuffer){
  return new Promise((resolve, reject) => {
    try {
      const p = audioCtx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve).catch(reject);
    } catch (err) {
      audioCtx.decodeAudioData(arrayBuffer, resolve, reject);
    }
  });
}
