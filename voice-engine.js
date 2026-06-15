/* ============================================================================
 *  voice-engine.js — Hardened Voice Engine for AI Interview Prep Tool
 * ============================================================================
 *  Manages: VAD · ASR · TTS · FSM conversation flow
 *
 *  Original 5 Fixes (PRESERVED):
 *    1. Strict FSM gating — mic SUSPENDED during PROCESSING & AI_SPEAKING
 *    2. ASR event filtering — onresult discards events outside LISTENING/USER_SPEAKING
 *    3. COOLDOWN state — 350ms buffer after TTS ends
 *    4. Elevated barge-in threshold — 2.2x × 5 consecutive frames
 *    5. asrDesired flag — prevents ASR auto-restart when not wanted
 *
 *  Enhancements Added:
 *    1. TTS Chunking for Chrome (fixes 15s pause bug)
 *    2. Chrome TTS Keepalive (pause/resume heartbeat)
 *    3. Better Voice Selection (ranked quality preferences)
 *    4. Silence Timeout in LISTENING state (3-minute watchdog)
 *    5. Voice Orb Integration (global RMS + state export)
 *    6. ASR Abort for faster mic release
 *    7. Typing Mode Integration
 * ============================================================================ */

(function () {
  "use strict";

  /* ==========================================================================
   *  §1  EXTERNAL HOOK PLACEHOLDERS
   * ========================================================================== */

  /** Called every VAD frame with the current RMS energy value. */
  if (typeof window.updateVisualMeter !== "function") {
    window.updateVisualMeter = function (_rms) {};
  }

  /** Called with interim (partial) ASR transcript text. */
  if (typeof window.updateInterimUI !== "function") {
    window.updateInterimUI = function (_text) {};
  }

  /** Called to clear the interim transcript display. */
  if (typeof window.clearInterimUI !== "function") {
    window.clearInterimUI = function () {};
  }

  /** Called to add a transcript bubble to the chat UI. */
  if (typeof window.appendTranscriptBubble !== "function") {
    window.appendTranscriptBubble = function (_role, _text, _isInterrupted) {};
  }

  /** Called to start a countdown timer (seconds). */
  if (typeof window.runTimer !== "function") {
    window.runTimer = function (_seconds) {};
  }

  /** Called when final user speech is submitted for processing. */
  if (typeof window.onSpeechSubmitted !== "function") {
    window.onSpeechSubmitted = function (_text) {};
  }

  /** NEW: Called when 3-minute silence timeout fires in LISTENING state. */
  if (typeof window.onSilenceTimeout !== "function") {
    window.onSilenceTimeout = function () {};
  }

  /* ==========================================================================
   *  §2  FINITE STATE MACHINE — STATES & TRANSITIONS
   * ========================================================================== */

  /**
   * Conversation states. Each state defines what the engine is doing
   * and which subsystems (ASR, TTS, VAD) are active.
   *
   *   IDLE          → Engine dormant, nothing active
   *   LISTENING     → Mic hot, waiting for user to speak
   *   USER_SPEAKING → User is actively talking (VAD triggered)
   *   PROCESSING    → User speech submitted, waiting for AI response
   *   AI_SPEAKING   → TTS playing AI response
   *   COOLDOWN      → Brief 350ms buffer after TTS ends before re-listening
   */
  const STATES = Object.freeze({
    IDLE: "IDLE",
    LISTENING: "LISTENING",
    USER_SPEAKING: "USER_SPEAKING",
    PROCESSING: "PROCESSING",
    AI_SPEAKING: "AI_SPEAKING",
    COOLDOWN: "COOLDOWN",
  });

  /** Current FSM state. */
  let currentState = STATES.IDLE;

  /** Export current state to global for CSS data-attribute binding (Enhancement #5). */
  window.currentVoiceState = currentState;

  /** Export current RMS to global for voice orb CSS animation (Enhancement #5). */
  window.currentVoiceRMS = 0;

  /**
   * Transition the FSM to a new state.
   * Contains all side-effect logic for entering/leaving states.
   *
   * FIX #1 — Strict FSM gating: ASR is SUSPENDED during PROCESSING & AI_SPEAKING.
   * FIX #3 — COOLDOWN state: inserted after AI_SPEAKING before returning to LISTENING.
   */
  function transitionTo(newState) {
    if (newState === currentState) return;

    const prevState = currentState;
    console.log(`[VoiceEngine] FSM: ${prevState} → ${newState}`);
    currentState = newState;

    // Enhancement #5: update global state string
    window.currentVoiceState = newState;

    /* ---- Side effects on LEAVING a state ---- */

    if (prevState === STATES.AI_SPEAKING) {
      // Enhancement #2: stop TTS keepalive when leaving AI_SPEAKING
      stopTTSKeepAlive();
    }

    if (prevState === STATES.LISTENING) {
      // Enhancement #4: clear silence timeout when leaving LISTENING
      clearSilenceTimeout();
    }

    /* ---- Side effects on ENTERING a state ---- */

    switch (newState) {
      case STATES.IDLE:
        suspendASR();
        cancelAllTTS();
        break;

      case STATES.LISTENING:
        // FIX #1: Resume ASR only in LISTENING
        if (asrDesired && !isTypingMode) {
          resumeASR();
        }
        // Enhancement #4: start 3-minute silence watchdog
        startSilenceTimeout();
        break;

      case STATES.USER_SPEAKING:
        // ASR stays active; silence timeout not needed while user is talking
        clearSilenceTimeout();
        break;

      case STATES.PROCESSING:
        // FIX #1: Suspend ASR during processing — strict gating
        suspendASR();
        window.clearInterimUI();
        break;

      case STATES.AI_SPEAKING:
        // FIX #1: Suspend ASR during AI speech — strict gating
        suspendASR();
        // Enhancement #2: start keepalive heartbeat
        startTTSKeepAlive();
        break;

      case STATES.COOLDOWN:
        // FIX #3: 350ms cooldown buffer after TTS ends
        suspendASR();
        setTimeout(function () {
          if (currentState === STATES.COOLDOWN) {
            transitionTo(STATES.LISTENING);
          }
        }, 350);
        break;
    }
  }

  /* ==========================================================================
   *  §3  ASR — AUTOMATIC SPEECH RECOGNITION
   * ========================================================================== */

  /** Web Speech API recognition instance. */
  let recognition = null;

  /** FIX #5: Flag indicating whether ASR is desired (true = should be running). */
  let asrDesired = false;

  /** Whether ASR is currently running (active/started). */
  let asrRunning = false;

  /** Enhancement #7: Typing mode flag — when true, ASR is suppressed. */
  let isTypingMode = false;

  /** Accumulated final transcript fragments within a single speaking turn. */
  let finalTranscript = "";

  /** Guard against double-submission of the same speech turn. */
  let lastSubmittedText = "";

  /** Language code for ASR (settable from outside). */
  let asrLang = "en-IN";

  /**
   * Initialize the SpeechRecognition instance (once).
   */
  function initASR() {
    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn("[VoiceEngine] SpeechRecognition API not available.");
      return;
    }

    recognition = new SpeechRecognition();
    recognition.lang = asrLang;
    recognition.interimResults = true;
    recognition.continuous = true;
    recognition.maxAlternatives = 1;

    /**
     * FIX #2 — ASR event filtering:
     * Discard onresult events unless we are in LISTENING or USER_SPEAKING.
     * This prevents stale/phantom results from leaking into wrong states.
     */
    recognition.onresult = function (event) {
      // FIX #2: Strict state check
      if (
        currentState !== STATES.LISTENING &&
        currentState !== STATES.USER_SPEAKING
      ) {
        console.log(
          `[VoiceEngine] ASR result DISCARDED (state=${currentState})`
        );
        return;
      }

      let interim = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        if (result.isFinal) {
          finalTranscript += result[0].transcript;
        } else {
          interim += result[0].transcript;
        }
      }

      // Show interim text in UI
      if (interim) {
        window.updateInterimUI(interim);
      }

      // If we got final text and are USER_SPEAKING, transition to PROCESSING
      if (finalTranscript.trim() && currentState === STATES.USER_SPEAKING) {
        // The VAD silence detector will call submitSpeech() — we just accumulate here
      }
    };

    recognition.onerror = function (event) {
      console.warn("[VoiceEngine] ASR error:", event.error);
      asrRunning = false;

      // Auto-restart on transient errors, but only if ASR is desired
      if (
        asrDesired &&
        !isTypingMode &&
        (event.error === "network" || event.error === "aborted") &&
        (currentState === STATES.LISTENING ||
          currentState === STATES.USER_SPEAKING)
      ) {
        setTimeout(function () {
          resumeASR();
        }, 300);
      }
    };

    recognition.onend = function () {
      asrRunning = false;

      // FIX #5: Only auto-restart if asrDesired is true and state permits
      if (
        asrDesired &&
        !isTypingMode &&
        (currentState === STATES.LISTENING ||
          currentState === STATES.USER_SPEAKING)
      ) {
        setTimeout(function () {
          resumeASR();
        }, 100);
      }
    };

    recognition.onstart = function () {
      asrRunning = true;
    };
  }

  /**
   * Start/resume ASR recognition.
   * Only starts if asrDesired is true and recognition exists.
   */
  function resumeASR() {
    if (!recognition || asrRunning || isTypingMode) return;
    try {
      recognition.lang = asrLang;
      recognition.start();
    } catch (e) {
      // Already started — ignore
      console.warn("[VoiceEngine] ASR start error (benign):", e.message);
    }
  }

  /**
   * Suspend ASR recognition.
   * Enhancement #6: Uses abort() instead of stop() for immediate mic release.
   */
  function suspendASR() {
    if (!recognition || !asrRunning) return;
    try {
      // Enhancement #6: abort() releases mic immediately without pending results
      recognition.abort();
    } catch (e) {
      console.warn("[VoiceEngine] ASR abort error (benign):", e.message);
    }
    asrRunning = false;
  }

  /* ==========================================================================
   *  §4  SPEECH SUBMISSION — DOUBLE-TRIGGER GUARD
   * ========================================================================== */

  /**
   * Submit accumulated speech to the app for processing.
   * Contains a guard against accidental double-submission of the same text.
   */
  function submitSpeech() {
    const text = finalTranscript.trim();
    finalTranscript = "";
    window.clearInterimUI();

    // Guard: no empty or duplicate submissions
    if (!text) {
      // Nothing to submit — go back to listening
      if (currentState === STATES.USER_SPEAKING) {
        transitionTo(STATES.LISTENING);
      }
      return;
    }
    if (text === lastSubmittedText) {
      console.log("[VoiceEngine] Duplicate submission blocked:", text);
      if (currentState === STATES.USER_SPEAKING) {
        transitionTo(STATES.LISTENING);
      }
      return;
    }

    lastSubmittedText = text;
    transitionTo(STATES.PROCESSING);

    // Notify app
    window.appendTranscriptBubble("user", text, false);
    window.onSpeechSubmitted(text);
  }

  /* ==========================================================================
   *  §5  TTS — TEXT-TO-SPEECH WITH CHUNKING & KEEPALIVE
   * ========================================================================== */

  /** Cached best voice (Enhancement #3). */
  let cachedVoice = null;

  /** Flag to know if we already attempted voice selection. */
  let voiceSelectionAttempted = false;

  /** TTS keepalive interval handle (Enhancement #2). */
  let ttsKeepAliveInterval = null;

  /** Queue of remaining TTS utterance chunks (Enhancement #1). */
  let ttsChunkQueue = [];

  /** Whether TTS is currently playing (any chunk). */
  let ttsSpeaking = false;

  /** Callback to invoke after the LAST chunk finishes (Enhancement #1). */
  let ttsFinishCallback = null;

  /* ---- Enhancement #3: Better Voice Selection ---- */

  /**
   * Select the best available voice for a given language code.
   *
   * Ranking heuristic:
   *   Prefer names containing 'Google', 'Natural', 'Premium', 'Enhanced'.
   *
   * Language matching:
   *   - Hindi (hi-IN): voices whose lang starts with 'hi'
   *   - English: prefer en-IN → en-US → any en-*
   *   - Other: exact match on first two chars
   *
   * Caches the result so we don't re-scan every call.
   *
   * @param {string} lang — BCP-47 language tag (e.g. "en-IN", "hi-IN")
   * @returns {SpeechSynthesisVoice|null}
   */
  function selectBestVoice(lang) {
    // Return cached voice if we already found one
    if (voiceSelectionAttempted && cachedVoice) return cachedVoice;

    const voices = window.speechSynthesis.getVoices();
    if (!voices || voices.length === 0) return null;

    voiceSelectionAttempted = true;

    const langPrefix = lang.substring(0, 2).toLowerCase(); // 'en', 'hi', etc.

    // Quality keywords ranked by preference
    const qualityKeywords = ["Google", "Natural", "Premium", "Enhanced"];

    /**
     * Score a voice: higher is better.
     *   +100  exact lang match (e.g. en-IN === en-IN)
     *   +80   preferred fallback (en-US for English)
     *   +60   prefix match (any en-* for English, any hi-* for Hindi)
     *   +10 per quality keyword found in voice name
     */
    function scoreVoice(voice) {
      let score = 0;
      const vl = (voice.lang || "").toLowerCase();

      // Language matching
      if (langPrefix === "hi") {
        // Hindi: any voice whose lang starts with 'hi'
        if (vl.startsWith("hi")) score += vl === lang.toLowerCase() ? 100 : 60;
      } else if (langPrefix === "en") {
        // English: prefer en-IN → en-US → any en-*
        if (vl === lang.toLowerCase()) score += 100;
        else if (vl === "en-us") score += 80;
        else if (vl.startsWith("en")) score += 60;
      } else {
        // Other languages
        if (vl === lang.toLowerCase()) score += 100;
        else if (vl.startsWith(langPrefix)) score += 60;
      }

      // If the voice doesn't even match the language prefix, skip it
      if (score === 0) return 0;

      // Quality keywords
      const nameLower = (voice.name || "").toLowerCase();
      for (let k = 0; k < qualityKeywords.length; k++) {
        if (nameLower.includes(qualityKeywords[k].toLowerCase())) {
          score += 10;
        }
      }

      return score;
    }

    let bestVoice = null;
    let bestScore = 0;

    for (let i = 0; i < voices.length; i++) {
      const s = scoreVoice(voices[i]);
      if (s > bestScore) {
        bestScore = s;
        bestVoice = voices[i];
      }
    }

    cachedVoice = bestVoice; // may be null
    if (cachedVoice) {
      console.log(
        `[VoiceEngine] Selected voice: "${cachedVoice.name}" (${cachedVoice.lang}), score=${bestScore}`
      );
    } else {
      console.log("[VoiceEngine] No suitable voice found, using browser default.");
    }
    return cachedVoice;
  }

  /* ---- Enhancement #2: Chrome TTS Keepalive ---- */

  /**
   * Start a periodic pause/resume heartbeat to prevent Chrome from
   * silently pausing speechSynthesis after a few seconds.
   */
  function startTTSKeepAlive() {
    stopTTSKeepAlive(); // Ensure no duplicate intervals
    ttsKeepAliveInterval = setInterval(function () {
      if (window.speechSynthesis.speaking) {
        window.speechSynthesis.pause();
        window.speechSynthesis.resume();
      }
    }, 5000);
  }

  /**
   * Stop the TTS keepalive heartbeat.
   */
  function stopTTSKeepAlive() {
    if (ttsKeepAliveInterval) {
      clearInterval(ttsKeepAliveInterval);
    }
    ttsKeepAliveInterval = null;
  }

  /* ---- Enhancement #1: TTS Chunking for Chrome ---- */

  /**
   * Split text into sentence-level chunks for TTS.
   * Splits on sentence-ending punctuation (.?!) followed by whitespace or end-of-string.
   * Filters out empty chunks.
   *
   * @param {string} text — The full text to split
   * @returns {string[]} Array of sentence chunks
   */
  function splitIntoSentences(text) {
    if (!text) return [];
    // Split on . ? or ! followed by whitespace or end-of-string
    // Keep the punctuation with the preceding sentence
    var chunks = text.match(/[^.!?]*[.!?]+[\s]?|[^.!?]+$/g);
    if (!chunks) return [text]; // fallback: unsplittable
    return chunks
      .map(function (c) {
        return c.trim();
      })
      .filter(function (c) {
        return c.length > 0;
      });
  }

  /**
   * Speak the next chunk in the TTS queue.
   * Called recursively/sequentially after each chunk finishes.
   */
  function speakNextChunk() {
    // If queue is empty or we've been cancelled, invoke final callback
    if (ttsChunkQueue.length === 0) {
      ttsSpeaking = false;
      var cb = ttsFinishCallback;
      ttsFinishCallback = null;
      if (typeof cb === "function") cb();
      return;
    }

    var sentence = ttsChunkQueue.shift();
    var utterance = new SpeechSynthesisUtterance(sentence);

    // Apply best voice
    var voice = selectBestVoice(asrLang);
    if (voice) utterance.voice = voice;

    utterance.lang = asrLang;
    utterance.rate = 1.0;
    utterance.pitch = 1.0;

    utterance.onend = function () {
      // Speak the next chunk in sequence
      speakNextChunk();
    };

    utterance.onerror = function (ev) {
      console.warn("[VoiceEngine] TTS chunk error:", ev.error);
      // Attempt to continue with remaining chunks
      speakNextChunk();
    };

    window.speechSynthesis.speak(utterance);
  }

  /**
   * Primary speak function (backward-compatible name).
   *
   * Enhancement #1: Internally splits text into sentence chunks to work
   * around Chrome's ~15s TTS pause bug. Each sentence is a separate
   * utterance, played sequentially. The callback fires only after the
   * LAST chunk completes. Barge-in cancels all remaining chunks.
   *
   * @param {string} text     — Full text to speak
   * @param {Function} [callback] — Called when all speech finishes
   */
  function speak(text, callback) {
    // Cancel any ongoing speech first
    cancelAllTTS();

    if (!text || text.trim().length === 0) {
      if (typeof callback === "function") callback();
      return;
    }

    // Split into sentence chunks
    ttsChunkQueue = splitIntoSentences(text);
    ttsFinishCallback = callback || null;
    ttsSpeaking = true;

    console.log(
      "[VoiceEngine] TTS starting, " + ttsChunkQueue.length + " chunk(s)"
    );

    // Begin speaking the first chunk
    speakNextChunk();
  }

  /**
   * Cancel all TTS — current utterance and queued chunks.
   * Called during barge-in or state transitions to IDLE.
   */
  function cancelAllTTS() {
    ttsChunkQueue = [];
    ttsFinishCallback = null;
    ttsSpeaking = false;
    window.speechSynthesis.cancel();
  }

  /* ==========================================================================
   *  §6  VAD — VOICE ACTIVITY DETECTION
   * ========================================================================== */

  /** AudioContext and related nodes. */
  let audioCtx = null;
  let analyserNode = null;
  let micStream = null;
  let vadAnimationFrame = null;

  /** Adaptive noise floor for VAD. */
  let noiseFloor = 0;
  let noiseCalibrationFrames = 0;
  const NOISE_CALIBRATION_COUNT = 30; // ~0.5s of calibration at 60fps

  /** Speech detection thresholds. */
  const SPEECH_THRESHOLD_MULTIPLIER = 1.8; // Normal speech detection
  const BARGE_IN_THRESHOLD_MULTIPLIER = 2.2; // FIX #4: Elevated barge-in
  const BARGE_IN_CONSECUTIVE_FRAMES = 5; // FIX #4: Require 5 consecutive frames

  /** Barge-in frame counter. */
  let bargeInFrameCount = 0;

  /** Silence detection for end-of-utterance. */
  let silenceFrames = 0;
  const SILENCE_FRAMES_TO_SUBMIT = 45; // ~750ms of silence = end of utterance

  /**
   * Initialize the VAD pipeline: get mic, create AudioContext + analyser.
   *
   * @returns {Promise<void>}
   */
  async function initVAD() {
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const source = audioCtx.createMediaStreamSource(micStream);

      analyserNode = audioCtx.createAnalyser();
      analyserNode.fftSize = 2048;
      analyserNode.smoothingTimeConstant = 0.3;
      source.connect(analyserNode);

      console.log("[VoiceEngine] VAD initialized, starting analysis loop.");
      vadLoop();
    } catch (err) {
      console.error("[VoiceEngine] Microphone access denied:", err);
    }
  }

  /**
   * Compute RMS (Root Mean Square) energy from the analyser's time-domain data.
   * This gives a reliable measure of audio volume.
   *
   * @returns {number} RMS value (0..1 range approximately)
   */
  function computeRMS() {
    const data = new Float32Array(analyserNode.fftSize);
    analyserNode.getFloatTimeDomainData(data);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      sum += data[i] * data[i];
    }
    return Math.sqrt(sum / data.length);
  }

  /**
   * Main VAD loop — runs every animation frame.
   * Handles noise calibration, speech detection, barge-in, and silence detection.
   */
  function vadLoop() {
    vadAnimationFrame = requestAnimationFrame(vadLoop);

    if (!analyserNode) return;

    const rms = computeRMS();

    // Enhancement #5: Export RMS to global for voice orb animation
    window.currentVoiceRMS = rms;

    // Update visual meter via hook
    window.updateVisualMeter(rms);

    /* ---- Adaptive noise calibration ---- */
    if (noiseCalibrationFrames < NOISE_CALIBRATION_COUNT) {
      // During calibration, accumulate noise floor estimate
      noiseFloor =
        (noiseFloor * noiseCalibrationFrames + rms) /
        (noiseCalibrationFrames + 1);
      noiseCalibrationFrames++;
      return; // Don't process speech during calibration
    }

    // Continuously adapt noise floor (slow drift)
    // Only adapt when user is NOT speaking to avoid raising the floor
    if (
      currentState === STATES.LISTENING ||
      currentState === STATES.IDLE ||
      currentState === STATES.COOLDOWN
    ) {
      noiseFloor = noiseFloor * 0.995 + rms * 0.005;
    }

    const speechThreshold = noiseFloor * SPEECH_THRESHOLD_MULTIPLIER;
    const bargeInThreshold = noiseFloor * BARGE_IN_THRESHOLD_MULTIPLIER;

    /* ---- State-specific VAD behavior ---- */

    switch (currentState) {
      case STATES.LISTENING:
        if (rms > speechThreshold) {
          // User started speaking
          silenceFrames = 0;
          transitionTo(STATES.USER_SPEAKING);
        }
        break;

      case STATES.USER_SPEAKING:
        if (rms > speechThreshold) {
          // Still speaking — reset silence counter
          silenceFrames = 0;
        } else {
          // Silence detected — count frames
          silenceFrames++;
          if (silenceFrames >= SILENCE_FRAMES_TO_SUBMIT) {
            // User stopped speaking — submit their speech
            silenceFrames = 0;
            submitSpeech();
          }
        }
        break;

      case STATES.AI_SPEAKING:
        /*
         * FIX #4: Elevated barge-in threshold.
         * Require RMS > 2.2x noise floor for 5 CONSECUTIVE frames
         * before triggering barge-in. This prevents false barge-ins
         * from TTS audio bleeding into the mic.
         */
        if (rms > bargeInThreshold) {
          bargeInFrameCount++;
          if (bargeInFrameCount >= BARGE_IN_CONSECUTIVE_FRAMES) {
            console.log("[VoiceEngine] Barge-in detected!");
            bargeInFrameCount = 0;

            // Cancel all TTS (including queued chunks)
            cancelAllTTS();
            stopTTSKeepAlive();

            // Record that AI was interrupted
            window.appendTranscriptBubble("ai", "(interrupted)", true);

            // Go straight to LISTENING so user's speech is captured
            transitionTo(STATES.LISTENING);
          }
        } else {
          bargeInFrameCount = 0;
        }
        break;

      default:
        // IDLE, PROCESSING, COOLDOWN — no VAD action needed
        bargeInFrameCount = 0;
        break;
    }
  }

  /* ==========================================================================
   *  §7  SILENCE TIMEOUT — 3-MINUTE WATCHDOG IN LISTENING STATE
   * ========================================================================== */

  /** Handle for the silence timeout timer (Enhancement #4). */
  let silenceTimeoutHandle = null;

  /** Duration before silence timeout fires (3 minutes in ms). */
  const SILENCE_TIMEOUT_MS = 3 * 60 * 1000;

  /**
   * Start the silence timeout watchdog.
   * If the user doesn't speak for 3 minutes in LISTENING state,
   * the onSilenceTimeout hook fires so app.js can prompt the user.
   */
  function startSilenceTimeout() {
    clearSilenceTimeout();
    silenceTimeoutHandle = setTimeout(function () {
      if (currentState === STATES.LISTENING) {
        console.log("[VoiceEngine] 3-minute silence timeout reached.");
        window.onSilenceTimeout();
      }
    }, SILENCE_TIMEOUT_MS);
  }

  /**
   * Clear the silence timeout watchdog.
   */
  function clearSilenceTimeout() {
    if (silenceTimeoutHandle) {
      clearTimeout(silenceTimeoutHandle);
      silenceTimeoutHandle = null;
    }
  }

  /* ==========================================================================
   *  §8  TYPING MODE INTEGRATION
   * ========================================================================== */

  /**
   * Enhancement #7: Enable typing mode.
   * Suspends ASR so the mic is released while the user types.
   */
  function enableTypingMode() {
    isTypingMode = true;
    suspendASR();
    console.log("[VoiceEngine] Typing mode ENABLED — ASR suspended.");
  }

  /**
   * Enhancement #7: Disable typing mode.
   * Re-enables ASR if the FSM is in a state that expects mic input.
   */
  function disableTypingMode() {
    isTypingMode = false;
    console.log("[VoiceEngine] Typing mode DISABLED.");
    if (
      asrDesired &&
      (currentState === STATES.LISTENING ||
        currentState === STATES.USER_SPEAKING)
    ) {
      resumeASR();
    }
  }

  /* ==========================================================================
   *  §9  PUBLIC API — Exposed on window.VoiceEngine
   * ========================================================================== */

  /**
   * Initialize the entire voice engine.
   * Call this once on page load after user interaction (required for AudioContext).
   *
   * @param {Object} [options]
   * @param {string} [options.lang="en-IN"] — BCP-47 language code
   */
  async function init(options) {
    options = options || {};
    asrLang = options.lang || "en-IN";

    // Pre-load voices (some browsers need this)
    window.speechSynthesis.getVoices();
    // Chrome fires voiceschanged asynchronously
    if (window.speechSynthesis.onvoiceschanged !== undefined) {
      window.speechSynthesis.onvoiceschanged = function () {
        // Re-attempt voice selection when voices load
        voiceSelectionAttempted = false;
        cachedVoice = null;
        selectBestVoice(asrLang);
      };
    }

    initASR();
    await initVAD();

    console.log("[VoiceEngine] Initialized (lang=" + asrLang + ").");
  }

  /**
   * Start listening for user speech.
   * Transitions to LISTENING and sets asrDesired = true.
   */
  function startListening() {
    asrDesired = true;
    finalTranscript = "";
    lastSubmittedText = "";
    transitionTo(STATES.LISTENING);
  }

  /**
   * Stop listening and go to IDLE.
   * Sets asrDesired = false so ASR won't auto-restart.
   */
  function stopListening() {
    asrDesired = false;
    transitionTo(STATES.IDLE);
  }

  /**
   * Called by app.js when the AI response is ready to be spoken.
   * Transitions to AI_SPEAKING, speaks the text, then goes to COOLDOWN → LISTENING.
   *
   * @param {string} text — AI response text to speak
   */
  function speakResponse(text) {
    transitionTo(STATES.AI_SPEAKING);
    window.appendTranscriptBubble("ai", text, false);

    speak(text, function () {
      // After all TTS chunks finish, enter COOLDOWN (FIX #3)
      if (currentState === STATES.AI_SPEAKING) {
        transitionTo(STATES.COOLDOWN);
      }
    });
  }

  /**
   * Set the language for both ASR and TTS.
   * Clears the cached voice so the next TTS call re-selects.
   *
   * @param {string} lang — BCP-47 language tag
   */
  function setLanguage(lang) {
    asrLang = lang;
    voiceSelectionAttempted = false;
    cachedVoice = null;
    if (recognition) {
      recognition.lang = lang;
    }
    console.log("[VoiceEngine] Language set to " + lang);
  }

  /**
   * Get the current FSM state.
   * @returns {string}
   */
  function getState() {
    return currentState;
  }

  /**
   * Tear down the engine: stop everything, release mic.
   */
  function destroy() {
    asrDesired = false;
    suspendASR();
    cancelAllTTS();
    stopTTSKeepAlive();
    clearSilenceTimeout();

    if (vadAnimationFrame) {
      cancelAnimationFrame(vadAnimationFrame);
      vadAnimationFrame = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(function (t) {
        t.stop();
      });
      micStream = null;
    }
    if (audioCtx) {
      audioCtx.close();
      audioCtx = null;
    }

    transitionTo(STATES.IDLE);
    console.log("[VoiceEngine] Destroyed.");
  }

  /* ---- Expose public API on window.VoiceEngine ---- */

  window.VoiceEngine = {
    // Lifecycle
    init: init,
    destroy: destroy,

    // Conversation control
    startListening: startListening,
    stopListening: stopListening,
    speakResponse: speakResponse,

    // Configuration
    setLanguage: setLanguage,

    // State inspection
    getState: getState,
    STATES: STATES,

    // Enhancement #7: Typing mode
    enableTypingMode: enableTypingMode,
    disableTypingMode: disableTypingMode,

    // Direct TTS access (for custom use)
    speak: speak,
    cancelAllTTS: cancelAllTTS,

    // Direct ASR control
    resumeASR: resumeASR,
    suspendASR: suspendASR,

    // Direct state control (use with caution)
    transitionTo: transitionTo,
    submitSpeech: submitSpeech,

    // Voice selection (Enhancement #3)
    selectBestVoice: selectBestVoice,
  };

  console.log("[VoiceEngine] Module loaded. Call VoiceEngine.init() to start.");
})();
