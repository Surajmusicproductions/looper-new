/* Looper Pedal Board – Popups + Programmable FX Chains (Before + After)
   - Before-FX: popup with per-effect parameters
   - After-FX: menu popup to add/remove/reorder effects (series), second popup to tweak parameters
   - Up/Down reordering with numbers
   - Pitch (playbackRate) available in After-FX; live input pitch shifting is NOT implemented
   Date: 2025-08-09 (Corrected Version: 2025-09-04)
   Patched for Sample-Accurate Overdubbing: 2025-09-12
*/

// pick latencyHint based on platform (reduce underruns on weaker mobile devices)
const _isMobile = /Mobi|Android/i.test(navigator.userAgent);
let audioCtx = new (window.AudioContext || window.webkitAudioContext)({
  latencyHint: _isMobile ? 'playback' : 'interactive'
});

// allow a short preroll to capture button latency; adjust 50..120ms per device testing
const OVERDUB_PREROLL_MS = 80;


// Recommend serving via localhost/https — file:// will usually fail for Worklets
if (window.location.protocol === 'file:') {
  console.warn('Page loaded via file:// — AudioWorklet modules often fail. Serve via http://localhost or HTTPS.');
  showMsg('⚠️ Detected file:// URL — run a local server (e.g. `python -m http.server` or VSCode Live Server) and reload the page.', '#ffb86b');
}

// STEP 2: Load the AudioWorklet (robust loader with diagnostics)
(async ()=>{
  try {
    if (!audioCtx || !audioCtx.audioWorklet) {
      console.error('AudioWorklet API is not available on audioCtx.');
      showMsg('❌ AudioWorklet not supported in this browser/context. Use latest Chrome/Edge or run on http://localhost or https.', '#ff4444');
      return;
    }

    // Build a robust URL for the module so relative paths work when served from different bases
    // Use new URL(...) to resolve relative to the current page location.
    const moduleURL = new URL('recorder-processor.js', window.location.href).href;

    // Helpful debug: log the exact URL we will fetch
    console.log('Loading AudioWorklet module from:', moduleURL);

    // Try load and expose any underlying error message to console + UI
    await audioCtx.audioWorklet.addModule(moduleURL);
    console.log('AudioWorklet processor loaded successfully.');
  } catch (e) {
    console.error('Failed to load recorder-processor.js — full error:', e);

    // Provide a helpful message to the user with the underlying error text (escaped)
    const detail = e && e.message ? e.message : String(e);
    showMsg(`❌ Could not load audio recorder component:<br><small>${detail}</small>`, '#ff4444');

    // Extra console hints for debugging common causes
    console.warn('Check: 1) Are you serving the page over http://localhost or https? 2) Is recorder-processor.js reachable (Network tab)? 3) Is MIME type application/javascript? 4) Is there a syntax error inside recorder-processor.js? 5) Is the browser up-to-date and supports AudioWorklet?');
  }
})();


let micStream = null, micSource = null;

// ======= GLOBAL (Before-FX) GRAPH =======
let dryGain, fxSumGain, mixDest, processedStream, recorderSum;
let isRecorderSumConnectedToWorklet = new WeakMap(); // Bookkeeping for worklet connections


// Reverb (Before)
let convolver, reverbPreDelay, reverbWet;
let reverbMix = 0.25, reverbRoomSeconds = 1.2, reverbDecay = 1.8, reverbPreDelayMs = 20;

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
// Gate that controls whether mic is allowed into the master mix (keeps mic silent until user enables)
let micToMasterGain = null;

// Master timing from track 1
let masterLoopDuration = null, masterBPM = null, masterIsSet = false;

// ADDITION: Master Bus Globals
let masterBus = null, masterDest = null, masterStream = null;

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
function addTap(btn, fn){ if(!btn) return; btn.addEventListener('click', fn); btn.addEventListener('touchstart', e=>{e.preventDefault();fn(e);},{passive:false}); }
function addHold(btn, onStart, onEnd){
  let hold=false;
  btn.addEventListener('mousedown', e=>{ hold=true; onStart(e); });
  btn.addEventListener('touchstart', e=>{ hold=true; onStart(e); }, {passive:false});
  ['mouseup','mouseleave'].forEach(ev=>btn.addEventListener(ev, e=>{ if(hold) onEnd(e); hold=false; }));
  ['touchend','touchcancel'].forEach(ev=>btn.addEventListener(ev, e=>{ if(hold) onEnd(e); hold=false; }, {passive:false}));
}
function clamp(v, lo, hi){ return Math.min(hi, Math.max(lo, v)); }
function debounce(fn, ms=130){ let t; return (...a)=>{ clearTimeout(t); t=setTimeout(()=>fn(...a), ms); }; }

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

// ======= AUDIO SETUP =======
async function ensureMic(){
  if (micStream) return;
  if (audioCtx.state === 'suspended') {
    try { await audioCtx.resume(); } catch {}
  }
  if (!navigator.mediaDevices?.getUserMedia) { showMsg('❌ Microphone not supported'); throw new Error('gUM'); }
  try {
    // Use browser echo cancellation & noise suppression for cleaner live monitoring tests.
    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: false
      }
    });
  } catch(e){ showMsg('❌ Microphone access denied'); throw e; }

  micSource = audioCtx.createMediaStreamSource(micStream);

  dryGain = audioCtx.createGain();   dryGain.gain.value = 1;
  fxSumGain = audioCtx.createGain(); fxSumGain.gain.value = 1;

  // --- Reverb path ---
  reverbPreDelay = audioCtx.createDelay(1.0); reverbPreDelay.delayTime.value = reverbPreDelayMs/1000;
  convolver = audioCtx.createConvolver(); convolver.normalize = true; convolver.buffer = makeReverbImpulse(reverbRoomSeconds, reverbDecay);
  reverbWet = audioCtx.createGain(); reverbWet.gain.value = 0; // CORRECT: Start wet gain at 0
  // Note: connection happens on-demand in wireBeforeFX

  // --- Delay path ---
  delayNode = audioCtx.createDelay(2.0);
  delayFeedback = audioCtx.createGain(); delayFeedback.gain.value = delayFeedbackAmt;
  delayWet = audioCtx.createGain(); delayWet.gain.value = 0; // CORRECT: Start wet gain at 0
  delayNode.connect(delayFeedback); delayFeedback.connect(delayNode);
  // Note: connection happens on-demand in wireBeforeFX

  // --- Flanger path ---
  flangerDelay = audioCtx.createDelay(0.05);
  flangerWet = audioCtx.createGain(); flangerWet.gain.value = 0; // CORRECT: Start wet gain at 0
  flangerFeedback = audioCtx.createGain(); flangerFeedback.gain.value = flangerFeedbackAmt;
  // Note: LFO created/connected on-demand in wireBeforeFX

  // EQ (created when toggled on)
  eq = null;

  micSource.connect(dryGain);

  // ** START: RECORDER BUS WIRING **
  // create a stable recorder bus that worklets can connect to for deterministic capture
  recorderSum = audioCtx.createGain();
  recorderSum.gain.value = 1;

  // route both dry & fx sum into the recorderSum so whatever is heard can be recorded
  try {
    dryGain.connect(recorderSum);
    fxSumGain.connect(recorderSum);
  } catch (e) {
    console.warn('recorderSum wiring failed:', e);
  }
  // ** END: RECORDER BUS WIRING **

  // Recording stream (for MediaRecorder fallback)
  mixDest = audioCtx.createMediaStreamDestination();
  dryGain.connect(mixDest);
  fxSumGain.connect(mixDest);
  processedStream = mixDest.stream;

  // MASTER BUS (final mix for export)
  masterBus = audioCtx.createGain();
  masterBus.gain.value = 1;

  // create mic->master gate and keep it muted by default
  micToMasterGain = audioCtx.createGain();
  micToMasterGain.gain.value = 0; // safety: don't route mic to master until user explicitly enables

  // route dry into the gate, then into masterBus (so we can open/close mic->master without changing other wiring)
  dryGain.connect(micToMasterGain);
  micToMasterGain.connect(masterBus);

  // keep FX summed into master as before
  if (micToMasterGain) fxSumGain.connect(micToMasterGain);
else fxSumGain.connect(masterBus); // fallback for older builds

  masterBus.connect(audioCtx.destination); // For listening
  masterDest = audioCtx.createMediaStreamDestination(); // For recording
  masterBus.connect(masterDest);
  masterStream = masterDest.stream;

  // Live monitor (start MUTED to avoid headphone echo)
  liveMicMonitorGain = audioCtx.createGain();
  liveMicMonitorGain.gain.value = 0; // keep muted by default

  // === Start: monitor safety guard ===
  // MONITOR_GUARD: only monitorBtn should change liveMicMonitorGain via safeSetGain()
  // Prevent accidental programmatic unmute elsewhere in the code.
  // Only the monitor button handler should ramp the monitor gain.
  liveMicMonitorGain._monitorControlOnly = true;

  // helper to safely set/ramp the monitor gain (used by monitor button only)
  liveMicMonitorGain.safeSetGain = (value, when = audioCtx.currentTime, rampTime = 0.03) => {
    // cancel any scheduled values and ramp smoothly
    liveMicMonitorGain.gain.cancelScheduledValues(when);
    liveMicMonitorGain.gain.setValueAtTime(liveMicMonitorGain.gain.value, when);
    liveMicMonitorGain.gain.linearRampToValueAtTime(value, when + rampTime);
  };
  // === End: monitor safety guard ===

  // DEV WARNING: detect direct setValue attempts (non-blocking)
  try {
    const origSet = liveMicMonitorGain.gain.setValueAtTime.bind(liveMicMonitorGain.gain);
    liveMicMonitorGain.gain.setValueAtTime = (v, when) => {
      if (!liveMicMonitorGain._monitorControlOnly) {
        console.warn('Monitor gain setValueAtTime called from unexpected code path', v, when);
      }
      return origSet(v, when);
    };
  } catch(e){ /* ignore in production */ }


  // CORRECTED WIRING: Monitor ONLY the dry mic to avoid hearing delay/reverb/flanger
  try {
    // connect only the dry (unprocessed) mic to monitor to deliver a single clean signal
    dryGain.connect(liveMicMonitorGain);
    // NOTE: intentional — do NOT connect fxSumGain into the live monitor.
    // fxSumGain.connect(liveMicMonitorGain); // intentionally disabled
  } catch (e) {
    console.warn('Monitor routing: connection failed', e);
  }

  // route monitor to output (silent until gain > 0)
  liveMicMonitorGain.connect(audioCtx.destination);


  hideMsg();
}

// ======= BEFORE-FX BUTTONS + POPUP =======
const beforeFXBtns = {
  delay:  $('#fxBeforeBtn_delay'),
  reverb: $('#fxBeforeBtn_reverb'),
  flanger:$('#fxBeforeBtn_flanger'),
  eq5:    $('#fxBeforeBtn_eq5'),
  pitch:  $('#fxBeforeBtn_pitch') // live pitch shifting not implemented
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
    <p style="max-width:32ch;line-height:1.3;">Live input pitch shifting needs advanced DSP (AudioWorklet / phase vocoder). This build doesn’t include it. Use per-track <b>After-FX → Pitch (PlaybackRate)</b> for ±12 semitones on loops.</p>
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
    $('#flRate').addEventListener('input', e=>{ flangerRateHz = parseFloat(e.target.value); if(flangerLFO) flangerLFO.frequency.value = flangerRateHz; $('#flRateVal').textContent = flangerRateHz.toFixed(2)+' Hz'; });
    $('#flDepth').addEventListener('input', e=>{ flangerDepthMs = parseFloat(e.target.value); if(flangerDepthGain) flangerDepthGain.gain.value = flangerDepthMs/1000; $('#flDepthVal').textContent = flangerDepthMs.toFixed(2)+' ms'; });
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
  // Toggle and open popup to tweak
  if (beforeFXBtns.reverb){
    addTap(beforeFXBtns.reverb, async ()=>{
      await ensureMic();
      beforeState.reverb = !beforeState.reverb;
      beforeFXBtns.reverb.classList.toggle('active', beforeState.reverb);

      if (beforeState.reverb) {
        // enable reverb: ensure path connected and set wet level
        try {
          micSource.connect(reverbPreDelay);
          reverbPreDelay.connect(convolver);
          convolver.connect(reverbWet);
          reverbWet.connect(fxSumGain);
        } catch (e) { console.warn('Reverb connect failed', e); }
        reverbWet.gain.setValueAtTime(reverbMix, audioCtx.currentTime);
      } else {
        // disable reverb: mute wet and disconnect input to save CPU
        try { reverbWet.gain.setTargetAtTime(0, audioCtx.currentTime, 0.01); } catch {}
        try { micSource.disconnect(reverbPreDelay); } catch(e){/* ignore */ }
      }

      openBeforeFxPopup('reverb');
    });
  }
  if (beforeFXBtns.delay){
    addTap(beforeFXBtns.delay, async ()=>{
      await ensureMic();
      beforeState.delay = !beforeState.delay;
      beforeFXBtns.delay.classList.toggle('active', beforeState.delay);

      if (beforeState.delay) {
        try {
          micSource.connect(delayNode);
          delayNode.connect(delayWet);
          delayWet.connect(fxSumGain);
          delayFeedback.connect(delayNode); // ensure feedback loop present
        } catch(e){ console.warn('Delay connect failed', e); }
        delayWet.gain.setValueAtTime(delayMix, audioCtx.currentTime);
      } else {
        try { delayWet.gain.setTargetAtTime(0, audioCtx.currentTime, 0.01); } catch {}
        try { micSource.disconnect(delayNode); } catch(e){}
      }

      openBeforeFxPopup('delay');
    });
  }
  if (beforeFXBtns.flanger){
    addTap(beforeFXBtns.flanger, async ()=>{
      await ensureMic();
      beforeState.flanger = !beforeState.flanger;
      beforeFXBtns.flanger.classList.toggle('active', beforeState.flanger);

      if (beforeState.flanger) {
        // create and start an oscillator for LFO each enable (clean lifecycle)
        try {
          flangerLFO = audioCtx.createOscillator();
          flangerLFO.type = 'sine';
          flangerLFO.frequency.value = flangerRateHz;
          flangerDepthGain = audioCtx.createGain();
          flangerDepthGain.gain.value = flangerDepthMs/1000;
          flangerLFO.connect(flangerDepthGain);
          flangerDepthGain.connect(flangerDelay.delayTime);

          micSource.connect(flangerDelay);
          flangerDelay.connect(flangerWet);
          flangerWet.connect(fxSumGain);
          flangerDelay.connect(flangerFeedback);
          flangerFeedback.connect(flangerDelay);

          flangerLFO.start();
        } catch (e) { console.warn('Flanger enable failed', e); }
        flangerWet.gain.setValueAtTime(flangerMix, audioCtx.currentTime);
      } else {
        try { flangerWet.gain.setTargetAtTime(0, audioCtx.currentTime, 0.01); } catch {}
        try { micSource.disconnect(flangerDelay); } catch(e){}
        // stop and disconnect LFO
        try { flangerLFO.stop(); flangerLFO.disconnect(); } catch (e) {}
        flangerLFO = null;
      }

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

// ======= LOOPER (core) =======
class Looper {
  constructor(index, recordKey, stopKey){
    this.index = index;
    this.mainBtn = $('#mainLooperBtn'+index);
    this.stopBtn = $('#stopBtn'+index);
    this.clearBtn = $('#clearBtn' + index); // New button reference
    this.looperIcon = $('#looperIcon'+index);
    this.ledRing = $('#progressBar'+index);
    this.stateDisplay = $('#stateDisplay'+index);
    this.recordKey = recordKey; this.stopKey = stopKey;
    this.state = 'ready';

    // MediaRecorder for overdubs (FALLBACK ONLY), Worklet for main recording & overdub
    this.mediaRecorder = null;
    this.chunks = [];
    this.workletNode = null;
    this.overdubWorklet = null;

    this.loopBuffer = null; this.sourceNode = null;
    this.loopStartTime = 0; this.loopDuration = 0;
    this.overdubChunks = [];
    this.divider = 1; this.uiDisabled = false;

    // Track output gain
    this.gainNode = audioCtx.createGain();
    const volSlider = $('#volSlider'+index), volValue = $('#volValue'+index);
    this.gainNode.gain.value = 0.9;
    if (volSlider && volValue){
      volSlider.value = 90; volValue.textContent = '90%';
      volSlider.addEventListener('input', ()=>{ const v=parseInt(volSlider.value,10); this.gainNode.gain.value=v/100; volValue.textContent=v+'%'; });
    }

    // ===== After-FX chain state =====
    this.pitchSemitones = 0;
    this.fx = { chain: [], nextId: 1 };

    this.updateUI();
    this.setRing(0);
    if (index >= 2 && dividerSelectors[index]) {
      this.divider = parseFloat(dividerSelectors[index].value);
      dividerSelectors[index].addEventListener('change', e => { this.divider = parseFloat(e.target.value); });
      this.disable(true);
    }

    // Stop button logic (single click)
    if (this.stopBtn) {
      addTap(this.stopBtn, () => {
        if (this.state === 'playing' || this.state === 'overdub') this.stopPlayback();
        else if (this.state === 'stopped') this.resumePlayback();
        else if (this.state === 'recording') this.abortRecording();
      });
    }

    // Clear button logic (single click)
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

  async _startWorkletRecording(lenSec){
    // set state & UI first
    this.state = 'recording';
    this.updateUI();
    this.loopBuffer = null;
    this.targetLenSec = lenSec;

    // Start the visual recorder animation IMMEDIATELY (guaranteed)
    const start = audioCtx.currentTime;
    const animate = () => {
      if (this.state === 'recording'){
        const pct = (audioCtx.currentTime - start) / lenSec;
        this.setRing(Math.min(pct, 1));
        if (pct < 1) requestAnimationFrame(animate);
      }
    };
    // call animate before attempting worklet creation so visuals won't be blocked by JS errors
    animate();

    // Try to create the AudioWorkletNode (safe, but don't block visuals if it fails)
    try {
      this.workletNode = new AudioWorkletNode(audioCtx, 'recorder-processor', { numberOfInputs: 1, channelCount: 2 });
      
      // Always connect from the unified recorderSum bus
      if (recorderSum) {
        recorderSum.connect(this.workletNode);
      } else {
        // Fallback for safety, though recorderSum should exist
        dryGain.connect(this.workletNode);
      }

      this.workletNode.port.postMessage({ cmd: 'reset' });
      
      // --- PATCH: ARM the worklet so it captures the upcoming window (start at 0 relative to reset) ---
      const sr = audioCtx.sampleRate;
      const lengthSamples = Math.round(lenSec * sr);
      this.workletNode.port.postMessage({ cmd: 'arm', startSample: 0, lengthSamples });
      console.log(`Armed recorder worklet for ${lengthSamples} samples (${lenSec}s)`);
      // -----------------------------------------------------------------------------------------

      // keep previous behavior: schedule stop when time's up
      setTimeout(()=> this._stopWorkletRecording(), lenSec * 1000);
    } catch (err) {
      // Worklet failed — show a console warning and rely on visual-only fallback
      console.warn('AudioWorkletNode creation failed; running visual fallback for recording:', err);
      showMsg('⚠️ Recorder worklet failed — visual record will run, but audio capture may not work.', '#ffe066');
      // still schedule a fallback stop so the ring completes
      setTimeout(() => {
        // if we ever created part of the node, try to stop/cleanup
        try { if (this.workletNode) { recorderSum.disconnect(this.workletNode); this.workletNode.disconnect(); } } catch (e) {}
        // move to 'playing' state so UI updates (playback won't start because there's no buffer)
        this.state = 'playing';
        this.updateUI();
      }, lenSec * 1000);
    }
  }

  async _stopWorkletRecording(){
    if (!this.workletNode) return;
    this.state='playing'; this.updateUI();

    const node = this.workletNode;
    node.port.onmessage = (e)=>{
      if (e.data?.cmd==='dump'){
        const { channels, length, sampleRate } = e.data;
        if (length===0){ return; }
        const buffer = audioCtx.createBuffer(channels.length, length, sampleRate);
        channels.forEach((data, ch)=> buffer.getChannelData(ch).set(data));

        // FIX: Use actual recorded length for track 1 (don't pad to original maximum)
        const sr = sampleRate;
        let targetSamples;
        if (this.index === 1) {
          // Use the worklet-reported frames length when available (don't force the
          // buffer to the originally requested max duration). This prevents short
          // manual stops from being padded to the full 60s.
          const maxSamples = Math.round(this.targetLenSec * sr);
          targetSamples = Math.min(length, maxSamples);
        } else {
          // tracks 2..4 are tied to masterLoopDuration — preserve existing behavior
          targetSamples = Math.round(masterLoopDuration * sr * this.divider);
        }

        if (buffer.length !== targetSamples) {
          const out = audioCtx.createBuffer(buffer.numberOfChannels, targetSamples, sr);
          for (let ch = 0; ch < buffer.numberOfChannels; ch++) {
            out.getChannelData(ch).set(buffer.getChannelData(ch).subarray(0, targetSamples));
          }
          this.loopBuffer = out;
          this.loopDuration = out.duration;
        } else {
          this.loopBuffer = buffer;
          this.loopDuration = buffer.duration;
        }

        if (this.index===1){
          masterLoopDuration=this.loopDuration;
          masterBPM = Math.round((60/this.loopDuration)*4);
          updateDelayFromTempo(); // keep delay in sync with BPM
          masterIsSet=true; bpmLabel.textContent = `BPM: ${masterBPM}`;
          for (let k=2;k<=4;k++) loopers[k].disable(false);
        }
        this.startPlayback();

        // --- PATCH: Re-sync other tracks to the new master anchor time ---
        if (this.index === 1) {
          // guarantee master anchor
          this.loopStartTime = audioCtx.currentTime;
          // force re-sync of playing tracks (safe no-op if they are not playing)
          for (let k = 2; k <= 4; k++) {
            if (window.loopers && loopers[k] && loopers[k].state === 'playing') {
              loopers[k].startPlayback(); // recomputes off using master.loopStartTime
            }
          }
          console.log('Master anchor set — re-synced tracks 2..4 to', this.loopStartTime);
        }
        // -----------------------------------------------------------------
      }
    };
    node.port.postMessage({ cmd:'dump' });

    try { recorderSum.disconnect(node); } catch(e) {}
    try { node.disconnect(); } catch(e) {}
    this.workletNode = null;
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
    else if (this.state==='overdub') this.finishOverdub(); // This will now be handled by worklet dump
  }

  async phaseLockedRecord(){
    if (this.index===1 || !masterIsSet){
      await this.startRecording();
      return;
    }
    this.state='waiting'; this.updateUI();
    const now = audioCtx.currentTime, master = loopers[1];
    const elapsed = (now - master.loopStartTime) % masterLoopDuration;
    const toNext = masterLoopDuration - elapsed;
    const scheduledStartTime = now + toNext;

    // schedule UI to show waiting but ARM sample-accurately immediately
    // We'll compute the len (seconds) and let _startPhaseLockedRecording accept scheduledStartTime
    this._startPhaseLockedRecording(masterLoopDuration * this.divider, scheduledStartTime);
  }

  async _startPhaseLockedRecording(lenSec, scheduledStartTime){
    // scheduledStartTime is an absolute audioCtx.currentTime value — pass it down
    // we create a sample-accurate recording using the same pattern as armOverdub if desired
    // for simplicity reuse _startWorkletRecording when index==1, otherwise arm with startSample computed vs resetTime
    if (this.index === 1) {
      // master recording: just start immediate worklet for lenSec (previous behavior)
      this._startWorkletRecording(lenSec);
      return;
    }

    // For tracks 2..4: create worklet and arm to capture scheduledStartTime for lenSec
    try {
      this.state = 'recording'; this.updateUI();
      this.workletNode = new AudioWorkletNode(audioCtx, 'recorder-processor', { numberOfInputs: 1, channelCount: 2 });
      if (recorderSum) recorderSum.connect(this.workletNode); else dryGain.connect(this.workletNode);
      this.workletNode.port.postMessage({ cmd: 'reset' });

      const sr = audioCtx.sampleRate;
      const preRollSamples = Math.round((OVERDUB_PREROLL_MS / 1000) * sr);
      const resetTime = audioCtx.currentTime;
      const startSampleAtBoundary = Math.max(0, Math.round((scheduledStartTime - resetTime) * sr));
      const armStartSample = Math.max(0, startSampleAtBoundary - preRollSamples);
      const lengthSamples = preRollSamples + Math.round(lenSec * sr);

      this._rp_preroll = preRollSamples;
      this._rp_scheduledStart = scheduledStartTime;

      this.workletNode.port.postMessage({ cmd: 'arm', startSample: armStartSample, lengthSamples });

      // schedule stop based on wall clock for safety (UI); the worklet will dump when samples complete
      setTimeout(()=> this._stopWorkletRecording(), (scheduledStartTime - audioCtx.currentTime + lenSec) * 1000 + 200);

      // handle dump as existing _stopWorkletRecording handler does (it will fill this.loopBuffer)
      this.workletNode.port.onmessage = (e) => {
        // reuse _stopWorkletRecording's logic: we let that function call .port.onmessage = handler etc
        // no extra code needed here; _stopWorkletRecording will handle the dump message
      };
    } catch (err) {
      console.warn('phase-locked worklet arm failed, fallback to setTimeout UI path:', err);
      // fallback to original behaviour (only UI timer) — but worklet-based is preferred
      setTimeout(()=>{ this._startWorkletRecording(lenSec); }, (scheduledStartTime - audioCtx.currentTime) * 1000 );
    }
  }

  async startRecording(){
    if (this.index>=2 && !masterIsSet) return;
    const max = (this.index===1) ? 60 : (masterLoopDuration? masterLoopDuration*this.divider : 12);
    this._startWorkletRecording(max);
  }

  async stopRecordingAndPlay(){
    this._stopWorkletRecording();
  }

  abortRecording(){
    if (this.workletNode) {
        try {
            this.workletNode.port.postMessage({ cmd:'reset' });
            recorderSum.disconnect(this.workletNode);
            this.workletNode.disconnect();
        } catch {}
        this.workletNode = null;
    }
    if (this.mediaRecorder && this.state==='recording'){
      try {
        this.mediaRecorder.ondataavailable = null;
        this.mediaRecorder.onstop = null;
        this.mediaRecorder.stop();
      } catch {}
      this.mediaRecorder=null; this.chunks=[];
    }
    this.state='ready';
    this.loopBuffer=null;
    this.loopDuration=0;
    this.setRing(0);
    this.updateUI();
  }

  _applyPitchIfAny(){
    const fxPitch = this.fx.chain.find(e=>e.type==='Pitch');
    const semis = fxPitch ? fxPitch.params.semitones : this.pitchSemitones;
    const rate = Math.pow(2, (semis||0)/12);
    if (this.sourceNode) this.sourceNode.playbackRate.setValueAtTime(rate, audioCtx.currentTime);
  }

  _buildEffectNodes(effect){
    if (effect.nodes?.dispose){ try{ effect.nodes.dispose(); }catch{} }
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
    for (const fx of this.fx.chain){ if (fx.type!=='Pitch') this._buildEffectNodes(fx); }
    for (const fx of this.fx.chain){
      if (fx.type==='Pitch' || !fx.nodes) continue;
      if (!fx.bypass){ try{ head.connect(fx.nodes.input); }catch{}; head = fx.nodes.output; }
    }
    try{ head.connect(this.gainNode); }catch{}
    this.gainNode.connect(masterBus);
  }

  startPlayback(){
    if (!this.loopBuffer) return;
    if (this.sourceNode){ try{ this.sourceNode.stop(); this.sourceNode.disconnect(); }catch{} }
    this.sourceNode = audioCtx.createBufferSource();
    this.sourceNode.buffer = this.loopBuffer; this.sourceNode.loop = true;
    let off=0;
    if (this.index!==1 && masterIsSet && loopers[1].sourceNode && masterLoopDuration>0){
      const master = loopers[1]; const now = audioCtx.currentTime - master.loopStartTime;
      off = now % masterLoopDuration; if (isNaN(off)||off<0||off>this.loopBuffer.duration) off=0;
    }
    this.loopStartTime = audioCtx.currentTime - off;
    this._rebuildChainWiring();
    try{ this.sourceNode.start(0, off); }catch{ try{ this.sourceNode.start(0,0); }catch{} }
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

  // *******************************************************************
  // ** START: Patched SAMPLE-ACCURATE armOverdub AND HELPER METHODS
  // *******************************************************************
  // --- replaced armOverdub() for sample-accurate pre-roll, trim + offset insert
  async armOverdub(){
    if (this.state !== 'playing') return;
    this.state = 'overdub'; this.updateUI();

    // compute absolute audio time of next loop boundary
    const now = audioCtx.currentTime;
    const elapsed = (now - this.loopStartTime) % this.loopDuration;
    const toNext = this.loopDuration - elapsed;
    const scheduledStartTime = now + toNext; // exact audio time to start overdub

    try {
      // create recorder worklet
      this.overdubWorklet = new AudioWorkletNode(audioCtx, 'recorder-processor', { numberOfInputs: 1, channelCount: 2 });

      // deterministic capture bus
      if (typeof recorderSum !== 'undefined' && recorderSum !== null) {
        recorderSum.connect(this.overdubWorklet);
        try { isRecorderSumConnectedToWorklet.set(this.overdubWorklet, true); } catch(e){}
      } else {
        dryGain.connect(this.overdubWorklet);
      }

      // reset and arm with preroll
      const resetTime = audioCtx.currentTime;
      this.overdubWorklet.port.postMessage({ cmd: 'reset' });

      const sr = audioCtx.sampleRate;
      const preRollSamples = Math.round((OVERDUB_PREROLL_MS / 1000) * sr);

      // startSample is samples from resetTime where the *loop boundary* occurs
      const startSampleAtBoundary = Math.max(0, Math.round((scheduledStartTime - resetTime) * sr));

      // arm earlier so we capture pre-roll; record preRoll + loopLength
      const armStartSample = Math.max(0, startSampleAtBoundary - preRollSamples);
      const lengthSamples = preRollSamples + Math.round(this.loopDuration * sr);

      // remember pre-roll for later trimming and remember scheduledStartTime as anchor
      this._od_prerollSamples = preRollSamples;
      this.overdubStartTime = scheduledStartTime;

      this.overdubWorklet.port.postMessage({ cmd: 'arm', startSample: armStartSample, lengthSamples });

      // animate UI based on scheduled start time (overdubStartTime)
      this._overdubAnimate();

      // on dump: trim the preroll and mix at sample-accurate offset
      this.overdubWorklet.port.onmessage = async (e) => {
        if (!e.data) return;
        if (e.data.cmd === 'dump') {
          const { channels, length, sampleRate } = e.data;
          if (!length || !channels || !channels.length) {
            cleanupOverdub.call(this);
            this.state = 'playing'; this.updateUI();
            return;
          }

          // reconstruct buffer from transferred arrays
          const recBuf = audioCtx.createBuffer(channels.length, length, sampleRate);
          channels.forEach((arr, ch) => recBuf.getChannelData(ch).set(arr));

          // Trim preroll (we armed earlier to capture it)
          const preRollSamplesLocal = this._od_prerollSamples || 0;
          let trimmedBuf = recBuf;
          if (preRollSamplesLocal > 0) {
            const trimmedLen = Math.max(0, recBuf.length - preRollSamplesLocal);
            const out = audioCtx.createBuffer(recBuf.numberOfChannels, trimmedLen, recBuf.sampleRate);
            for (let ch = 0; ch < recBuf.numberOfChannels; ch++) {
              out.getChannelData(ch).set(recBuf.getChannelData(ch).subarray(preRollSamplesLocal));
            }
            trimmedBuf = out;
          }

          // resample if loopBuffer has different sampleRate
          let workBuf = trimmedBuf;
          if (this.loopBuffer && workBuf.sampleRate !== this.loopBuffer.sampleRate) {
            const targetSR = this.loopBuffer.sampleRate;
            const off = new OfflineAudioContext(workBuf.numberOfChannels, Math.ceil(workBuf.duration * targetSR), targetSR);
            const src = off.createBufferSource();
            src.buffer = workBuf;
            src.connect(off.destination);
            src.start(0);
            workBuf = await off.startRendering();
          }

          // compute sample-accurate insertion offset relative to loop start
          // offsetSeconds = (overdubStartTime - this.loopStartTime) mod loopDuration
          let offsetSeconds = (this.overdubStartTime - this.loopStartTime) % this.loopDuration;
          if (offsetSeconds < 0) offsetSeconds += this.loopDuration;
          const insertOffsetSamples = Math.round(offsetSeconds * (this.loopBuffer ? this.loopBuffer.sampleRate : audioCtx.sampleRate));
          
          console.log(`Overdub insert offset (samples): ${insertOffsetSamples}`); // Diagnostic log

          // call updated mix that accepts offset
          this.mixBuffersCircularIntoLoop(workBuf, insertOffsetSamples);

          cleanupOverdub.call(this);
          this.state = 'playing';
          this.updateUI();
        }
      };

      // cleanup helper
      function cleanupOverdub(){
        try { if (isRecorderSumConnectedToWorklet.get(this.overdubWorklet) && recorderSum) recorderSum.disconnect(this.overdubWorklet); } catch(_) {}
        try { this.overdubWorklet.disconnect(); } catch(_) {}
        try { this.overdubWorklet.port.close?.(); } catch(_) {}
        try { isRecorderSumConnectedToWorklet.delete(this.overdubWorklet); } catch(_) {}
        this.overdubWorklet = null;
        delete this._od_prerollSamples;
      }

    } catch (err) {
      console.warn('Overdub worklet creation failed — falling back to MediaRecorder (less accurate):', err);
      showMsg('⚠️ AudioWorklet unavailable — overdub will use fallback encoder and timing will not be sample-accurate.', '#ffcc66');
      const now = audioCtx.currentTime;
      const elapsed = (now - this.loopStartTime) % this.loopDuration;
      const toNext = this.loopDuration - elapsed;
      setTimeout(()=> this.startOverdubRecording(), Math.round(toNext*1000));
    }
  }
  
  // mix newBuffer into this.loopBuffer starting at insertOffsetSamples (wraps around).
  mixBuffersCircularIntoLoop(newBuffer, insertOffsetSamples = 0) {
    if (!this.loopBuffer || !newBuffer) return;

    const oldBuf = this.loopBuffer;
    const oldLen = oldBuf.length;
    const newLen = newBuffer.length;
    const numCh = Math.max(oldBuf.numberOfChannels, newBuffer.numberOfChannels);
    const sampleRate = oldBuf.sampleRate;

    // small edge crossfade to avoid clicks (10ms)
    const fadeMs = 10;
    const fadeSamples = Math.min(Math.round((fadeMs/1000) * sampleRate), Math.floor(newLen/4));

    for (let ch = 0; ch < numCh; ch++) {
      const oldData = oldBuf.getChannelData(ch < oldBuf.numberOfChannels ? ch : 0);
      const newData = (ch < newBuffer.numberOfChannels) ? newBuffer.getChannelData(ch) : new Float32Array(newLen);
      let writePos = insertOffsetSamples % oldLen;
      for (let i = 0; i < newLen; i++) {
        // apply small fade in/out on edges of the newData to prevent clicks
        let s = newData[i];
        if (i < fadeSamples) s *= (i / fadeSamples);
        if (i >= newLen - fadeSamples) s *= ((newLen - i) / fadeSamples);
        const mixed = oldData[writePos] + s;
        // soft clip / limit
        oldData[writePos] = Math.max(-1.0, Math.min(1.0, mixed));
        writePos++; if (writePos >= oldLen) writePos = 0;
      }
    }
  }

  // Fallback for older browsers (less accurate)
  startOverdubRecording(){
    this.overdubStartTime = audioCtx.currentTime;
    this.overdubChunks=[]; this.mediaRecorder=new MediaRecorder(processedStream);
    this.mediaRecorder.ondataavailable = e=>{ if (e.data.size>0) this.overdubChunks.push(e.data); };
    this.mediaRecorder.start();

    this._overdubAnimate(); // start overdub ring animation

    setTimeout(()=>this.finishOverdub(), this.loopDuration*1000);
  }

  finishOverdub(){
      // This function is now primarily for the MediaRecorder FALLBACK path.
      // The sample-accurate worklet path handles its own completion and mixing.
    if (this.mediaRecorder && this.mediaRecorder.state==='recording'){
      this.mediaRecorder.onstop = async ()=>{
        const od=new Blob(this.overdubChunks,{type:'audio/webm'}), arr=await od.arrayBuffer();
        audioCtx.decodeAudioData(arr, newBuf=>{
          const oC=this.loopBuffer.numberOfChannels, nC=newBuf.numberOfChannels;
          const outC=Math.max(oC,nC), length=Math.max(this.loopBuffer.length,newBuf.length);
          const out=audioCtx.createBuffer(outC, length, this.loopBuffer.sampleRate);
          for (let ch=0; ch<outC; ch++){
            const outD=out.getChannelData(ch), o=oC>ch?this.loopBuffer.getChannelData(ch):null, n=nC>ch?newBuf.getChannelData(ch):null;
            for (let i=0;i<length;i++) outD[i]=(o?o[i]||0:0)+(n?n[i]||0:0);
          }
          this.loopBuffer=out; this.loopDuration=out.duration; this.startPlayback();
          this._animate(); // return to playback ring animation
        });
      };
      this.mediaRecorder.stop();
    } else if (this.state === 'overdub') { 
        // If finishOverdub is called but there's no active MediaRecorder,
        // it likely means the worklet is handling it or something was cancelled.
        // We just transition the state back to playing.
        this.state='playing'; 
        this.updateUI();
    }
  }

  // *******************************************************************
  // ** END: Patched SAMPLE-ACCURATE armOverdub AND HELPER METHODS
  // *******************************************************************
  
  clearLoop(){
    if (this.sourceNode){ try{ this.sourceNode.stop(); this.sourceNode.disconnect(); }catch{} }
    this.loopBuffer=null; this.loopDuration=0; this.state='ready'; this.updateUI();
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
  _overdubAnimate(){
    if (this.state==='overdub' && this.loopDuration>0){
      const now = audioCtx.currentTime;
      const pos = (now - this.overdubStartTime) % this.loopDuration;
      this.setRing(pos / this.loopDuration);
      requestAnimationFrame(this._overdubAnimate.bind(this));
    }
  }
}

// ======= BUILD LOOPERS + KEYBINDS =======
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

// ======= AFTER-FX: MENU + PARAM POPUPS + REORDER =======
const fxMenuPopup   = $('#fxMenuPopup');
const fxParamsPopup = $('#fxParamsPopup');

const AFTER_FX_CATALOG = [
  { type:'Pitch',      name:'Pitch (PlaybackRate)', defaults:{ semitones:0 } },
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
  try{ fx.nodes?.dispose?.(); }catch{}
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
    case 'LowPass': return `<label>Cutoff <span id="lpCutVal">${Math.round(fx.params.cutoff)} Hz</span><input id="lpCut" type="range" min="200" max="12000" step="10" value="${fx.params.cutoff}"></label><label>Q <span id="lpQVal">${fx.params.q.toFixed(2)}</span><input id="lpQ" type="range" min="0.3" max="12" step="0.01" value="${fx.params.q}"></label>`;
    case 'HighPass': return `<label>Cutoff <span id="hpCutVal">${Math.round(fx.params.cutoff)} Hz</span><input id="hpCut" type="range" min="20" max="2000" step="5" value="${fx.params.cutoff}"></label><label>Q <span id="hpQVal">${fx.params.q.toFixed(2)}</span><input id="hpQ" type="range" min="0.3" max="12" step="0.01" value="${fx.params.q}"></label>`;
    case 'Pan': return `<label>Pan <span id="panVal">${fx.params.pan.toFixed(2)}</span><input id="pan" type="range" min="-1" max="1" step="0.01" value="${fx.params.pan}"></label>`;
    case 'Delay': return `<label>Time <span id="dTimeVal">${(fx.params.timeSec*1000)|0} ms</span><input id="dTime" type="range" min="1" max="2000" step="1" value="${(fx.params.timeSec*1000)|0}"></label><label>Feedback <span id="dFbVal">${Math.round(fx.params.feedback*100)}%</span><input id="dFb" type="range" min="0" max="95" step="1" value="${Math.round(fx.params.feedback*100)}"></label><label>Mix <span id="dMixVal">${Math.round(fx.params.mix*100)}%</span><input id="dMix" type="range" min="0" max="100" step="1" value="${Math.round(fx.params.mix*100)}"></label>`;
    case 'Compressor': return `<label>Threshold <span id="cThVal">${fx.params.threshold} dB</span><input id="cTh" type="range" min="-60" max="0" step="1" value="${fx.params.threshold}"></label><label>Ratio <span id="cRaVal">${fx.params.ratio}:1</span><input id="cRa" type="range" min="1" max="20" step="0.1" value="${fx.params.ratio}"></label><label>Knee <span id="cKnVal">${fx.params.knee} dB</span><input id="cKn" type="range" min="0" max="40" step="1" value="${fx.params.knee}"></label><label>Attack <span id="cAtVal">${(fx.params.attack*1000).toFixed(1)} ms</span><input id="cAt" type="range" min="0" max="100" step="0.5" value="${(fx.params.attack*1000).toFixed(1)}"></label><label>Release <span id="cRlVal">${(fx.params.release*1000).toFixed(0)} ms</span><input id="cRl" type="range" min="10" max="2000" step="10" value="${(fx.params.release*1000).toFixed(0)}"></label>`;
  }
  return `<div class="small">No params.</div>`;
}

function wireFxParams(lp, fx){
  if (fx.type==='Pitch'){ $('#pSem').addEventListener('input', e=>{ fx.params.semitones = parseInt(e.target.value,10); $('#pSemVal').textContent = fx.params.semitones; lp.pitchSemitones = fx.params.semitones; if (lp.state==='playing') lp._applyPitchIfAny(); renderTrackFxSummary(lp.index); }); }
  if (fx.type==='LowPass'){ $('#lpCut').addEventListener('input', e=>{ fx.params.cutoff = parseFloat(e.target.value); $('#lpCutVal').textContent = Math.round(fx.params.cutoff)+' Hz'; if (fx.nodes?.biq) fx.nodes.biq.frequency.setTargetAtTime(fx.params.cutoff, audioCtx.currentTime, 0.01); renderTrackFxSummary(lp.index); }); $('#lpQ').addEventListener('input', e=>{ fx.params.q = parseFloat(e.target.value); $('#lpQVal').textContent = fx.params.q.toFixed(2); if (fx.nodes?.biq) fx.nodes.biq.Q.setTargetAtTime(fx.params.q, audioCtx.currentTime, 0.01); }); }
  if (fx.type==='HighPass'){ $('#hpCut').addEventListener('input', e=>{ fx.params.cutoff = parseFloat(e.target.value); $('#hpCutVal').textContent = Math.round(fx.params.cutoff)+' Hz'; if (fx.nodes?.biq) fx.nodes.biq.frequency.setTargetAtTime(fx.params.cutoff, audioCtx.currentTime, 0.01); renderTrackFxSummary(lp.index); }); $('#hpQ').addEventListener('input', e=>{ fx.params.q = parseFloat(e.target.value); $('#hpQVal').textContent = fx.params.q.toFixed(2); if (fx.nodes?.biq) fx.nodes.biq.Q.setTargetAtTime(fx.params.q, audioCtx.currentTime, 0.01); }); }
  if (fx.type==='Pan'){ $('#pan').addEventListener('input', e=>{ fx.params.pan = parseFloat(e.target.value); $('#panVal').textContent = fx.params.pan.toFixed(2); if (fx.nodes?.panner) fx.nodes.panner.pan.setTargetAtTime(fx.params.pan, audioCtx.currentTime, 0.01); renderTrackFxSummary(lp.index); }); }
  if (fx.type==='Delay'){ $('#dTime').addEventListener('input', e=>{ fx.params.timeSec = parseInt(e.target.value,10)/1000; $('#dTimeVal').textContent = `${parseInt(e.target.value,10)} ms`; if (fx.nodes?.d) fx.nodes.d.delayTime.setTargetAtTime(fx.params.timeSec, audioCtx.currentTime, 0.01); renderTrackFxSummary(lp.index); }); $('#dFb').addEventListener('input', e=>{ fx.params.feedback = parseInt(e.target.value,10)/100; $('#dFbVal').textContent = `${parseInt(e.target.value,10)}%`; if (fx.nodes?.fb) fx.nodes.fb.gain.setTargetAtTime(clamp(fx.params.feedback,0,0.95), audioCtx.currentTime, 0.01); }); $('#dMix').addEventListener('input', e=>{ fx.params.mix = parseInt(e.target.value,10)/100; $('#dMixVal').textContent = `${parseInt(e.target.value,10)}%`; if (fx.nodes?.wet) fx.nodes.wet.gain.setTargetAtTime(clamp(fx.params.mix,0,1), audioCtx.currentTime, 0.01); }); }
  if (fx.type==='Compressor'){ $('#cTh').addEventListener('input', e=>{ fx.params.threshold = parseInt(e.target.value,10); $('#cThVal').textContent = fx.params.threshold+' dB'; if (fx.nodes?.comp) fx.nodes.comp.threshold.setTargetAtTime(fx.params.threshold, audioCtx.currentTime, 0.01); }); $('#cRa').addEventListener('input', e=>{ fx.params.ratio = parseFloat(e.target.value); $('#cRaVal').textContent = fx.params.ratio+':1'; if (fx.nodes?.comp) fx.nodes.comp.ratio.setTargetAtTime(fx.params.ratio, audioCtx.currentTime, 0.01); }); $('#cKn').addEventListener('input', e=>{ fx.params.knee = parseInt(e.target.value,10); $('#cKnVal').textContent = fx.params.knee+' dB'; if (fx.nodes?.comp) fx.nodes.comp.knee.setTargetAtTime(fx.params.knee, audioCtx.currentTime, 0.01); }); $('#cAt').addEventListener('input', e=>{ fx.params.attack = parseFloat(e.target.value)/1000; $('#cAtVal').textContent = (fx.params.attack*1000).toFixed(1)+' ms'; if (fx.nodes?.comp) fx.nodes.comp.attack.setTargetAtTime(fx.params.attack, audioCtx.currentTime, 0.01); }); $('#cRl').addEventListener('input', e=>{ fx.params.release = parseFloat(e.target.value)/1000; $('#cRlVal').textContent = (fx.params.release*1000).toFixed(0)+' ms'; if (fx.nodes?.comp) fx.nodes.comp.release.setTargetAtTime(fx.params.release, audioCtx.currentTime, 0.01); }); }
}

// ======= BEFORE-FX WIRING & AUDIO UNLOCK =======
wireBeforeFX();

// The single, safer monitor button handler.
const monitorBtn = $('#monitorBtn');
monitorBtn.addEventListener('click', async ()=>{
  await ensureMic();

  liveMicMonitoring = !liveMicMonitoring;

  // Smoothly ramp monitor gain for click-free change
  // replace direct gain scheduling with safe helper
  const now = audioCtx.currentTime;
  // use safeSetGain to ensure consistent ramping
  if (liveMicMonitorGain && typeof liveMicMonitorGain.safeSetGain === 'function') {
    liveMicMonitorGain.safeSetGain(liveMicMonitoring ? 1.0 : 0.0, now, 0.03);
  } else {
    // fallback to direct ramp if safe helper is missing
    liveMicMonitorGain.gain.cancelScheduledValues(now);
    liveMicMonitorGain.gain.setValueAtTime(liveMicMonitorGain.gain.value, now);
    liveMicMonitorGain.gain.linearRampToValueAtTime(liveMicMonitoring ? 1.0 : 0.0, now + 0.03);
  }

  // Also ramp the mic->master gate in sync with the monitor toggle
  if (micToMasterGain && micToMasterGain.gain) {
    try {
      micToMasterGain.gain.cancelScheduledValues(now);
      micToMasterGain.gain.setValueAtTime(micToMasterGain.gain.value, now);
      micToMasterGain.gain.linearRampToValueAtTime(liveMicMonitoring ? 1.0 : 0.0, now + 0.03);
    } catch (e) { console.warn('micToMasterGain ramp failed', e); }
  }

  // If enabling monitor, force before-FX wet gains to 0 to guarantee a clean mic signal
  if (liveMicMonitoring) {
    try { if (reverbWet) reverbWet.gain.setValueAtTime(0, now); } catch {}
    try { if (delayWet) delayWet.gain.setValueAtTime(0, now); } catch {}
    try { if (flangerWet) flangerWet.gain.setValueAtTime(0, now); } catch {}
    // Also ensure beforeState flags reflect that the user shouldn't expect FX in the monitor
    beforeState.reverb = false; beforeState.delay = false; beforeState.flanger = false;
  }

  monitorBtn.classList.toggle('active', liveMicMonitoring);
  monitorBtn.textContent = liveMicMonitoring ? 'Live MIC ON 🎤' : 'Live MIC OFF';
});

// ---------- Startup hint (show initial instruction) ----------
window.addEventListener('DOMContentLoaded', () => {
  // Show a friendly instruction so users know to press a Record button to allow microphone access
  showMsg('🎤 Click any Record button (or the top "Record Mix") to allow microphone access.', '#22ff88');

  // Small visual hint under the mix record area if present
  const hintEl = document.getElementById('mixRecHint');
  if (hintEl) hintEl.textContent = 'Tip: Click Record to allow mic access and start recording.';

  // Remove the hint after a short time (but leave it if user interacts)
  setTimeout(() => { try { hideMsg(); } catch (e){} }, 3500);
});

function resumeAudio(){ if (audioCtx.state==='suspended'){ audioCtx.resume(); hideMsg(); } }
window.addEventListener('click', resumeAudio, { once:true });
window.addEventListener('touchstart', resumeAudio, { once:true });
if (audioCtx.state==='suspended'){
  showMsg("👆 Tap anywhere to start audio!<br>Then toggle Before-FX and tweak in the popup. For per-track FX: use 🎛 FX Menu.", "#22ff88");
}


// ======= MASTER MIX RECORDER =======
let mixRecorder = null, mixChunks = [], mixRecording = false;

function setMixButton(on){
  const b = document.getElementById('mixRecBtn');
  if (!b) return;
  mixRecording = on;
  b.textContent = on ? '■ Stop & Save' : '● Record Mix';
  b.classList.toggle('active', on);
}

async function startMasterRecording(){
  await ensureMic(); // make sure masterStream exists
  if (!masterStream){
    showMsg('❌ Master stream not available'); return;
  }
  try {
    mixChunks = [];
    mixRecorder = new MediaRecorder(masterStream);
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

async function encodeMp3FromWebm(webmBlob){
  function loadLame(){
    return new Promise((resolve,reject)=>{
      if (window.lamejs) return resolve();
      const s = document.createElement('script');
      s.src = 'https://cdn.jsdelivr.net/npm/lamejs@1.2.0/lame.min.js';
      s.onload = ()=>resolve();
      s.onerror = ()=>reject(new Error('lamejs load failed'));
      document.head.appendChild(s);
    });
  }

  try{
    await loadLame();
  }catch{
    return null;
  }

  const arr = await blobToArrayBuffer(webmBlob);
  const audioBuf = await audioCtx.decodeAudioData(arr);

  const numCh = audioBuf.numberOfChannels;
  const sr = audioBuf.sampleRate;
  const left = audioBuf.getChannelData(0);
  const right = numCh > 1 ? audioBuf.getChannelData(1) : null;

  const mp3enc = new lamejs.Mp3Encoder(numCh, sr, 128);
  const blockSize = 1152;
  let mp3Data = [];

  function floatTo16BitPCM(input){
    const out = new Int16Array(input.length);
    for (let i=0;i<input.length;i++){
      const s = Math.max(-1, Math.min(1, input[i]));
      out[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
    }
    return out;
  }

  const left16 = floatTo16BitPCM(left);
  const right16 = right ? floatTo16BitPCM(right) : null;

  for (let i=0;i<left16.length;i+=blockSize){
    const l = left16.subarray(i, i+blockSize);
    const r = right16 ? right16.subarray(i, i+blockSize) : null;
    const enc = numCh===2 ? mp3enc.encodeBuffer(l, r) : mp3enc.encodeBuffer(l);
    if (enc.length) mp3Data.push(enc);
  }
  const end = mp3enc.flush();
  if (end.length) mp3Data.push(end);
  return new Blob(mp3Data, { type: 'audio/mpeg' });
}

async function saveMasterRecording(){
  const webmBlob = new Blob(mixChunks, { type:'audio/webm' });

  const wantMp3 = confirm('Stop recorded. Export as MP3?\n(OK = MP3, Cancel = WebM)');

  if (wantMp3){
    showMsg('⏳ Encoding MP3...', '#a7ffed');
    const mp3 = await encodeMp3FromWebm(webmBlob);
    if (mp3){
      const a = document.createElement('a');
      a.href = URL.createObjectURL(mp3);
      a.download = `looper-mix-${Date.now()}.mp3`;
      a.click();
      URL.revokeObjectURL(a.href);
      showMsg('✅ Saved MP3 to downloads', '#a7ffed');
      setTimeout(hideMsg, 1500);
      return;
    } else {
      showMsg('⚠️ MP3 encoder unavailable, saving WebM instead', '#ffe066');
      setTimeout(hideMsg, 1600);
    }
  }

  const a = document.createElement('a');
  a.href = URL.createObjectURL(webmBlob);
  a.download = `looper-mix-${Date.now()}.webm`;
  a.click();
  URL.revokeObjectURL(a.href);
  showMsg('✅ Saved WebM to downloads', '#a7ffed');
  setTimeout(hideMsg, 1500);
}

const mixBtn = document.getElementById('mixRecBtn');
if (mixBtn){
  addTap(mixBtn, async () => {
    // Ensure mic is requested within the user gesture
    try {
      await ensureMic();
    } catch (e) {
      // ensureMic already shows error messages; abort if user denied
      return;
    }

    if (!mixRecording) startMasterRecording();
    else stopMasterRecording();
  });
}

function updateDelayFromTempo() {
    if (!masterBPM || delaySyncMode !== 'note') return;
    const quarter = quarterSecForBPM(masterBPM);
    const mult = NOTE_MULT[delayDivision] || 0.5;
    const finalMult = applyVariant(mult, delayVariant);
    const delayTime = quarter * finalMult;
    if (delayNode) {
        delayNode.delayTime.value = clamp(delayTime, 0, 2.0);
    }
}

function toggleEQ(enabled) {
    if (enabled && !eq) {
        // Create EQ nodes and connect them
        const low = audioCtx.createBiquadFilter();
        low.type = 'lowshelf';
        low.frequency.value = 250;
        low.gain.value = eqLowGain;

        const mid = audioCtx.createBiquadFilter();
        mid.type = 'peaking';
        mid.frequency.value = eqMidFreq;
        mid.Q.value = eqMidQ;
        mid.gain.value = eqMidGain;

        const high = audioCtx.createBiquadFilter();
        high.type = 'highshelf';
        high.frequency.value = 4000;
        high.gain.value = eqHighGain;

        // Disconnect direct path and insert EQ
        try { micSource.disconnect(dryGain); } catch(e){}
        micSource.connect(low);
        low.connect(mid);
        mid.connect(high);
        high.connect(dryGain);

        eq = { low, mid, high, connected: true };

    } else if (!enabled && eq && eq.connected) {
        // Disconnect EQ and restore direct path
        try { micSource.disconnect(eq.low); } catch(e){}
        try { eq.high.disconnect(dryGain); } catch(e){}
        micSource.connect(dryGain);
        eq.connected = false;
    }
}
