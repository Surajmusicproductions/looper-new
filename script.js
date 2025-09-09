/* Looper Pedal Board – Popups + Programmable FX Chains (Before + After)
   - Before-FX: popup with per-effect parameters
   - After-FX: menu popup to add/remove/reorder effects (series), second popup to tweak parameters
   - Up/Down reordering with numbers
   - Pitch (playbackRate) available in After-FX; live input pitch shifting is NOT implemented
   Date: 2025-08-09 (Corrected Version: 2025-09-04)
   Patched based on user feedback to fix live monitor echo and consolidate code.
*/

let audioCtx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });

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
  micSource.connect(reverbPreDelay); reverbPreDelay.connect(convolver); convolver.connect(reverbWet); reverbWet.connect(fxSumGain);

  // --- Delay path ---
  delayNode = audioCtx.createDelay(2.0);
  delayFeedback = audioCtx.createGain(); delayFeedback.gain.value = delayFeedbackAmt;
  delayWet = audioCtx.createGain(); delayWet.gain.value = 0; // CORRECT: Start wet gain at 0
  delayNode.connect(delayFeedback); delayFeedback.connect(delayNode);
  micSource.connect(delayNode); delayNode.connect(delayWet); delayWet.connect(fxSumGain);

  // --- Flanger path ---
  flangerDelay = audioCtx.createDelay(0.05);
  flangerWet = audioCtx.createGain(); flangerWet.gain.value = 0; // CORRECT: Start wet gain at 0
  flangerFeedback = audioCtx.createGain(); flangerFeedback.gain.value = flangerFeedbackAmt;
  flangerLFO = audioCtx.createOscillator(); flangerLFO.type='sine'; flangerLFO.frequency.value = flangerRateHz;
  flangerDepthGain = audioCtx.createGain(); flangerDepthGain.gain.value = flangerDepthMs/1000;
  flangerLFO.connect(flangerDepthGain); flangerDepthGain.connect(flangerDelay.delayTime);
  flangerDelay.connect(flangerWet); flangerWet.connect(fxSumGain);
  flangerDelay.connect(flangerFeedback); flangerFeedback.connect(flangerDelay);
  micSource.connect(flangerDelay); flangerLFO.start();

  // EQ (created when toggled on)
  eq = null;

  micSource.connect(dryGain);

  // Recording stream (for overdubs)
  mixDest = audioCtx.createMediaStreamDestination();
  dryGain.connect(mixDest);
  fxSumGain.connect(mixDest);
  processedStream = mixDest.stream;

  // MASTER BUS (final mix for export)
  masterBus = audioCtx.createGain();
  masterBus.gain.value = 1;

  // route dry and FX into the master mix so Before-FX is audible in the final output
  dryGain.connect(masterBus);
  fxSumGain.connect(masterBus);

  masterBus.connect(audioCtx.destination); // For listening
  masterDest = audioCtx.createMediaStreamDestination(); // For recording
  masterBus.connect(masterDest);
  masterStream = masterDest.stream;

  // Live monitor (start MUTED to avoid headphone echo)
  liveMicMonitorGain = audioCtx.createGain();
  liveMicMonitorGain.gain.value = 0; // keep muted by default

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
  // Toggle and open popup to tweak
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

    // MediaRecorder for overdubs, Worklet for main recording
    this.mediaRecorder = null;
    this.chunks = [];
    this.workletNode = null;

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
      // CORRECTED WIRING: wire audio into worklet only if creation succeeded — record DRY only to avoid capturing delayed/reverbed copies
      dryGain.connect(this.workletNode);
      // fxSumGain.connect(this.workletNode); // intentionally disabled — do not record processed before-FX
      this.workletNode.port.postMessage({ cmd: 'reset' });

      // keep previous behavior: schedule stop when time's up
      setTimeout(()=> this._stopWorkletRecording(), lenSec * 1000);
    } catch (err) {
      // Worklet failed — show a console warning and rely on visual-only fallback
      console.warn('AudioWorkletNode creation failed; running visual fallback for recording:', err);
      showMsg('⚠️ Recorder worklet failed — visual record will run, but audio capture may not work.', '#ffe066');
      // still schedule a fallback stop so the ring completes
      setTimeout(() => {
        // if we ever created part of the node, try to stop/cleanup
        try { if (this.workletNode) { dryGain.disconnect(this.workletNode); this.workletNode.disconnect(); } } catch (e) {}
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
      }
    };
    node.port.postMessage({ cmd:'dump' });

    try { dryGain.disconnect(node); node.disconnect(); } catch {}
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
    else if (this.state==='overdub') this.finishOverdub();
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
  setTimeout(()=>{ this._startPhaseLockedRecording(masterLoopDuration*this.divider); }, toNext*1000);
}

async _startPhaseLockedRecording(len){
  this._startWorkletRecording(len);
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
            dryGain.disconnect(this.workletNode);
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

  armOverdub(){
    if (this.state!=='playing') return;
    this.state='overdub'; this.updateUI();
    const now=audioCtx.currentTime; const elapsed=(now-this.loopStartTime)%this.loopDuration;
    setTimeout(()=>this.startOverdubRecording(), (this.loopDuration - elapsed)*1000);
  }

  startOverdubRecording(){
    this.overdubStartTime = audioCtx.currentTime;
    this.overdubChunks=[]; this.mediaRecorder=new MediaRecorder(processedStream);
    this.mediaRecorder.ondataavailable = e=>{ if (e.data.size>0) this.overdubChunks.push(e.data); };
    this.mediaRecorder.start();

    this._overdubAnimate(); // start overdub ring animation

    setTimeout(()=>this.finishOverdub(), this.loopDuration*1000);
  }

  finishOverdub(){
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
    } else { this.state='playing'; this.updateUI(); }
  }

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
  const now = audioCtx.currentTime;
  liveMicMonitorGain.gain.cancelScheduledValues(now);
  liveMicMonitorGain.gain.setValueAtTime(liveMicMonitorGain.gain.value, now);
  liveMicMonitorGain.gain.linearRampToValueAtTime(liveMicMonitoring ? 1.0 : 0.0, now + 0.03);

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
        micSource.disconnect(dryGain);
        micSource.connect(low);
        low.connect(mid);
        mid.connect(high);
        high.connect(dryGain);

        eq = { low, mid, high, connected: true };

    } else if (!enabled && eq && eq.connected) {
        // Disconnect EQ and restore direct path
        micSource.disconnect(eq.low);
        eq.high.disconnect(dryGain);
        micSource.connect(dryGain);
        eq.connected = false;
    }
}
