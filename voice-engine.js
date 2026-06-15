// ============================================================
// CONVERSATIONAL VOICE ENGINE — CORRECTED & DEBUGGED
// ============================================================

// === STATES (Finite State Machine) ===
const STATES = {
  IDLE: 'IDLE',
  LISTENING: 'LISTENING',
  USER_SPEAKING: 'USER_SPEAKING',
  PROCESSING: 'PROCESSING',
  AI_SPEAKING: 'AI_SPEAKING',
  COOLDOWN: 'COOLDOWN'
};

let currentState = STATES.IDLE;

// SpeechRecognition & Synthesis Buffers
let accumulatedSpeech = '';
let currentInterim = '';
let countdownInterval = null;
let autoSubmitEnabled = true;
let asrDesired = false;  // KEY FIX: controls whether ASR should auto-restart

// VAD & Web Audio API Globals
let audioCtx = null;
let analyser = null;
let micStream = null;
let animationFrameId = null;
let lastSpeechTime = 0;
let consecutiveSpeechFrames = 0;
let consecutiveSilenceFrames = 0;

// Adaptive Noise Calibration Params
let noiseFloor = 0.005;
let speechThreshold = 0.015;
let isCalibrating = false;
let calibrationSamples = [];

// Barge-in Params
let bargeInTriggered = false;
let consecutiveBargeInFrames = 0;

// Typing mode
let isTypingMode = false;

// Language
let preferredLanguage = "en-IN";

// External UI Hooks (to be defined in app.js or here as placeholders)
if (typeof updateVisualMeter !== 'function') window.updateVisualMeter = (rms) => {};
if (typeof updateInterimUI !== 'function') window.updateInterimUI = (text) => {};
if (typeof clearInterimUI !== 'function') window.clearInterimUI = () => {};
if (typeof appendTranscriptBubble !== 'function') window.appendTranscriptBubble = (role, text, isInterrupted) => {};
if (typeof runTimer !== 'function') window.runTimer = (seconds) => {};

// ============================================================
// 1. FINITE STATE MACHINE — Conversational Controller
// ============================================================

function transitionTo(newState) {
  if (currentState === newState) return;
  console.log(`[FSM] ${currentState} -> ${newState}`);
  currentState = newState;

  switch (newState) {
    case STATES.LISTENING:
      bargeInTriggered = false;
      consecutiveSpeechFrames = 0;
      consecutiveSilenceFrames = 0;
      resumeASR();           // OPEN mic only here
      runTimer(180);         // 3-minute answer window
      break;

    case STATES.USER_SPEAKING:
      consecutiveSilenceFrames = 0;
      // ASR stays active (already resumed in LISTENING)
      break;

    case STATES.PROCESSING:
      clearInterval(countdownInterval);
      suspendASR();          // CLOSE mic — prevents AI thinking noises from being captured
      clearInterimUI();
      break;

    case STATES.AI_SPEAKING:
      clearInterval(countdownInterval);
      suspendASR();          // CLOSE mic — KEY FIX: prevents TTS audio leaking into ASR
      clearInterimUI();
      break;

    case STATES.COOLDOWN:
      clearInterval(countdownInterval);
      suspendASR();          // CLOSE mic during cooldown
      setTimeout(() => {
        if (currentState === STATES.COOLDOWN) {
          transitionTo(STATES.LISTENING);
        }
      }, 350);
      break;

    case STATES.IDLE:
      clearInterval(countdownInterval);
      suspendASR();
      stopVADEngine();
      break;
  }
}


// ============================================================
// 2. ASR (Speech Recognition) — With Strict Gating
// ============================================================

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
let recognition = null;

if (SpeechRecognition) {
  recognition = new SpeechRecognition();
  recognition.lang = preferredLanguage;
  recognition.interimResults = true;
  recognition.continuous = true;

  recognition.onresult = (event) => {
    if (currentState !== STATES.LISTENING && currentState !== STATES.USER_SPEAKING) {
      console.warn("[Gating] ASR event discarded — wrong state: " + currentState);
      return;
    }

    let interim = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      if (event.results[i].isFinal) {
        accumulatedSpeech += event.results[i][0].transcript + ' ';
      } else {
        interim += event.results[i][0].transcript;
      }
    }
    currentInterim = interim;
    updateInterimUI(interim);
  };

  recognition.onend = () => {
    if (asrDesired && (currentState === STATES.LISTENING || currentState === STATES.USER_SPEAKING)) {
      try {
        recognition.start();
      } catch (e) {
        // already running
      }
    }
  };

  recognition.onerror = (e) => {
    console.error("[ASR Error]:", e.error);
    if (e.error === 'network' || e.error === 'no-speech') {
      suspendASR();
      setTimeout(() => {
        if (currentState === STATES.LISTENING || currentState === STATES.USER_SPEAKING) resumeASR();
      }, 500);
    }
  };
}

function resumeASR() {
  if (!recognition) return;
  if (isTypingMode) return;
  asrDesired = true;
  recognition.lang = preferredLanguage;
  try {
    recognition.start();
  } catch (e) { /* already started */ }
}

function suspendASR() {
  if (!recognition) return;
  asrDesired = false;
  try {
    recognition.stop();
  } catch (e) { /* already stopped */ }
}


// ============================================================
// 3. VAD ENGINE (Voice Activity Detection) — Web Audio API
// ============================================================

async function startVADEngine() {
  try {
    if (audioCtx) return;
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();

    micStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
        sampleRate: 16000
      }
    });

    const source = audioCtx.createMediaStreamSource(micStream);
    analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    source.connect(analyser);

    calibrateNoiseFloor();
    lastSpeechTime = Date.now();
    startVADLoop();
  } catch (err) {
    console.error("[VAD] Mic connection failed:", err);
    alert("Microphone access denied. Please enable mic permissions.");
  }
}

function calibrateNoiseFloor() {
  isCalibrating = true;
  calibrationSamples = [];
  const buffer = new Float32Array(analyser.fftSize);
  let count = 0;

  const calInterval = setInterval(() => {
    if (!analyser) { clearInterval(calInterval); return; }
    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    calibrationSamples.push(Math.sqrt(sum / buffer.length));

    count++;
    if (count >= 30) {
      clearInterval(calInterval);
      const avg = calibrationSamples.reduce((a, b) => a + b, 0) / calibrationSamples.length;
      noiseFloor = Math.max(avg, 0.003);
      speechThreshold = noiseFloor * 2.5;
      isCalibrating = false;
      console.log(`[VAD] Noise Floor: ${noiseFloor.toFixed(5)}, Threshold: ${speechThreshold.toFixed(5)}`);
    }
  }, 50);
}

function startVADLoop() {
  const buffer = new Float32Array(analyser.fftSize);

  function analyzeFrame() {
    if (!analyser || currentState === STATES.IDLE) return;

    analyser.getFloatTimeDomainData(buffer);
    let sum = 0;
    for (let i = 0; i < buffer.length; i++) sum += buffer[i] * buffer[i];
    const rms = Math.sqrt(sum / buffer.length);

    updateVisualMeter(rms);

    if (rms < speechThreshold && !isCalibrating) {
      noiseFloor = noiseFloor * 0.999 + rms * 0.001;
      speechThreshold = Math.max(noiseFloor * 2.5, 0.008);
    }

    const isUserVoicing = rms > speechThreshold;

    if (isTypingMode) {
      consecutiveSpeechFrames = 0;
      consecutiveSilenceFrames = 0;
      animationFrameId = requestAnimationFrame(analyzeFrame);
      return;
    }

    if (currentState === STATES.LISTENING) {
      if (isUserVoicing) {
        consecutiveSpeechFrames++;
        if (consecutiveSpeechFrames >= 3) {
          transitionTo(STATES.USER_SPEAKING);
          lastSpeechTime = Date.now();
        }
      } else {
        consecutiveSpeechFrames = 0;
      }
    }
    else if (currentState === STATES.USER_SPEAKING) {
      if (isUserVoicing) {
        lastSpeechTime = Date.now();
        consecutiveSilenceFrames = 0;
      } else {
        consecutiveSilenceFrames++;
        const silenceElapsed = Date.now() - lastSpeechTime;
        if (silenceElapsed >= 800 && consecutiveSilenceFrames >= 10) {
          if (autoSubmitEnabled) {
            submitSpeech();
          } else {
            transitionTo(STATES.LISTENING);
          }
        }
      }
    }
    else if (currentState === STATES.AI_SPEAKING) {
      const bargeInEnabled = document.getElementById('bargein-toggle')?.checked;
      if (bargeInEnabled) {
        const isBargeVoiced = rms > Math.max(speechThreshold * 2.2, 0.025);
        if (isBargeVoiced) {
          consecutiveBargeInFrames++;
          if (consecutiveBargeInFrames >= 5) {
            executeBargeIn();
          }
        } else {
          consecutiveBargeInFrames = 0;
        }
      }
    }

    animationFrameId = requestAnimationFrame(analyzeFrame);
  }

  animationFrameId = requestAnimationFrame(analyzeFrame);
}

function stopVADEngine() {
  if (animationFrameId) cancelAnimationFrame(animationFrameId);
  if (micStream) micStream.getTracks().forEach(t => t.stop());
  if (audioCtx) audioCtx.close();
  audioCtx = null;
  analyser = null;
  micStream = null;
}


// ============================================================
// 4. BARGE-IN (Interruption Handler)
// ============================================================

function executeBargeIn() {
  bargeInTriggered = true;
  window.speechSynthesis.cancel();

  // transcript variable should be defined in app.js
  if (typeof transcript !== 'undefined') transcript += "\n[Candidate Interrupted AI Speech]\n";
  appendTranscriptBubble("AI", "[Interrupted]", true);

  transitionTo(STATES.USER_SPEAKING);
  accumulatedSpeech = '';
  currentInterim = '';
  resumeASR();
}


// ============================================================
// 5. TTS (Text-to-Speech) — With Gated Output
// ============================================================

function speak(text, callback) {
  transitionTo(STATES.AI_SPEAKING);

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  const voices = window.speechSynthesis.getVoices();

  const containsDevanagari = /[\u0900-\u097F]/.test(text);

  if (containsDevanagari || preferredLanguage === "hi-IN") {
    utterance.lang = "hi-IN";
    const hindiVoice = voices.find(v => v.lang.startsWith("hi") || v.name.toLowerCase().includes("hindi"));
    if (hindiVoice) utterance.voice = hindiVoice;
  } else {
    utterance.lang = "en-IN";
    const premiumVoice = voices.find(v => v.name.includes("Google") || v.name.includes("Natural") || v.lang.startsWith("en-"));
    if (premiumVoice) utterance.voice = premiumVoice;
  }

  utterance.onend = () => {
    if (currentState === STATES.AI_SPEAKING && !bargeInTriggered) {
      transitionTo(STATES.COOLDOWN); // Move to cooldown before listening
      callback();
    }
  };

  utterance.onerror = (e) => {
    console.error("[TTS Error]:", e);
    if (currentState === STATES.AI_SPEAKING) {
      transitionTo(STATES.COOLDOWN);
      callback();
    }
  };

  window.speechSynthesis.speak(utterance);
}

window.speechSynthesis.onvoiceschanged = () => {
  console.log("[TTS] Voices loaded:", window.speechSynthesis.getVoices().length);
};


// ============================================================
// 6. SPEECH SUBMISSION — With Double-Trigger Guard
// ============================================================

function submitSpeech() {
  if (currentState === STATES.PROCESSING) return;

  const typedText = document.getElementById('text-input-box')?.value.trim() || '';
  const totalSpeech = typedText || (accumulatedSpeech + currentInterim).trim();

  if (!totalSpeech && !bargeInTriggered) {
    transitionTo(STATES.LISTENING);
    return;
  }

  transitionTo(STATES.PROCESSING);

  if (document.getElementById('text-input-box')) document.getElementById('text-input-box').value = "";

  if (totalSpeech) {
    appendTranscriptBubble("Candidate", totalSpeech);
    if (typeof transcript !== 'undefined') transcript += "Candidate: " + totalSpeech + "\n\n";
  }

  accumulatedSpeech = '';
  currentInterim = '';

  // This will be handled in app.js by monitoring state or direct call
  if (typeof onSpeechSubmitted === 'function') {
    onSpeechSubmitted(totalSpeech);
  }
}
