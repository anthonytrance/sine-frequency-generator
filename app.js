(() => {
  "use strict";

  const MIN_FREQUENCY = 0;
  const MAX_FREQUENCY = 22000;
  const LOG_SLIDER_MIN_FREQUENCY = 1;
  const FREQUENCY_SLIDER_STEPS = 1000;
  const MIN_VOLUME_DB = -80;
  const MAX_VOLUME_DB = 0;
  const EDGE_FADE_SECONDS = 0.008;
  const LIVE_ANNOUNCEMENTS_ENABLED = true;
  const LIVE_THROTTLE_MS = 3500;
  const SETTINGS_STORAGE_KEY = "sine-frequency-generator.settings.v1";
  const PLAYBACK_LOG_STORAGE_KEY = "sine-frequency-generator.playback-log.v1";
  const APP_VERSION = "2026-10-20.3";
  const MAX_PLAYBACK_EVENTS = 40;
  const MAJOR_SCALE_STEPS = [2, 2, 1, 2, 2, 2, 1];

  const state = {
    frequency: 1000,
    volumeDb: -6,
    mode: "continuous",
    pulseOnMs: 230,
    pulseOffMs: 230,
    sweepStart: 20,
    sweepEnd: 20000,
    sweepDuration: 10,
    sweepLoop: false,
    scaleDegree: 0,
    isPlaying: false
  };

  const els = {};
  let audioContext = null;
  let oscillator = null;
  let gateGain = null;
  let outputGain = null;
  let pulseTimer = null;
  let pulseCursor = 0;
  let sweepTimer = null;
  let activeSweep = null;
  let isFrequencyPointerActive = false;
  let liveTimer = null;
  let pendingLiveText = "";
  let lastLiveAt = 0;
  let liveWriteToken = 0;
  let liveInteractionActive = false;
  let startInProgress = false;
  let playbackRequestId = 0;
  let resumeAttemptContext = null;
  let browserAudioSession = null;
  let useMediaControlHelper = true;
  let playbackEvents = [];

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindElements();
    restorePlaybackLog();
    restoreSettings();
    syncSavedSettingsControls();
    bindEvents();
    updateModePanels();
    syncFrequencyControls();
    syncVolumeControls();
    updatePlaybackButtons();
    updateStatus();
    if (els.appVersion) {
      els.appVersion.textContent = `App version ${APP_VERSION}`;
    }
    tracePlayback("ready");
  }

  function bindElements() {
    els.playButton = document.getElementById("playButton");
    els.stopButton = document.getElementById("stopButton");
    els.status = document.getElementById("status");
    els.mediaControlAudio = document.getElementById("mediaControlAudio");
    els.appVersion = document.getElementById("appVersion");
    els.lastPlaybackStop = document.getElementById("lastPlaybackStop");
    els.copyPlaybackReport = document.getElementById("copyPlaybackReport");
    els.playbackReport = document.getElementById("playbackReport");
    els.playbackReportStatus = document.getElementById("playbackReportStatus");
    els.liveStatus = document.getElementById("liveStatus");
    els.error = document.getElementById("error");
    els.frequencyInput = document.getElementById("frequencyInput");
    els.frequencySlider = document.getElementById("frequencySlider");
    els.volumeInput = document.getElementById("volumeInput");
    els.volumeSlider = document.getElementById("volumeSlider");
    els.pulseSettings = document.getElementById("pulseSettings");
    els.pulseOnInput = document.getElementById("pulseOnInput");
    els.pulseOffInput = document.getElementById("pulseOffInput");
    els.sweepSettings = document.getElementById("sweepSettings");
    els.sweepStartInput = document.getElementById("sweepStartInput");
    els.sweepEndInput = document.getElementById("sweepEndInput");
    els.sweepDurationInput = document.getElementById("sweepDurationInput");
    els.sweepLoopInput = document.getElementById("sweepLoopInput");
    els.modeInputs = Array.from(document.querySelectorAll('input[name="mode"]'));
    els.frequencyShiftButtons = Array.from(document.querySelectorAll("[data-frequency-ratio]"));
    els.scaleStepButtons = Array.from(document.querySelectorAll("[data-scale-step]"));
    els.volumeShiftButtons = Array.from(document.querySelectorAll("[data-volume-shift]"));
  }

  function restorePlaybackLog() {
    try {
      const saved = JSON.parse(localStorage.getItem(PLAYBACK_LOG_STORAGE_KEY));
      if (Array.isArray(saved)) {
        playbackEvents = saved.filter((entry) => entry && typeof entry === "object" && typeof entry.event === "string").slice(-MAX_PLAYBACK_EVENTS);
      }
    } catch {
      // Diagnostics must never prevent playback or settings restoration.
    }
    updateLastPlaybackStop();
  }

  function tracePlayback(event, details = {}) {
    try {
      playbackEvents.push({
        at: new Date().toISOString(),
        version: APP_VERSION,
        event,
        request: playbackRequestId,
        playing: state.isPlaying,
        starting: startInProgress,
        context: audioContext?.state || "none",
        clock: audioContext ? roundNumber(audioContext.currentTime, 3) : null,
        session: browserAudioSession?.state || "unavailable",
        sessionType: browserAudioSession?.type || "unavailable",
        helper: useMediaControlHelper,
        helperPaused: els.mediaControlAudio?.paused ?? true,
        visibility: document.visibilityState,
        ...details
      });
      playbackEvents = playbackEvents.slice(-MAX_PLAYBACK_EVENTS);
      updateLastPlaybackStop();
      try {
        localStorage.setItem(PLAYBACK_LOG_STORAGE_KEY, JSON.stringify(playbackEvents));
      } catch {
        // The current report remains available in memory if storage is blocked.
      }
    } catch {
      // Playback must also work when diagnostics cannot read browser state.
    }
  }

  function updateLastPlaybackStop() {
    if (!els.lastPlaybackStop) {
      return;
    }
    const lastStop = [...playbackEvents].reverse().find((entry) => entry.event === "stop" || entry.event === "start-error");
    const text = lastStop
      ? `Last stop: ${lastStop.source || lastStop.event}${lastStop.message ? `. ${lastStop.message}` : ""}.`
      : "No playback stop recorded yet.";
    if (els.lastPlaybackStop.textContent !== text) {
      els.lastPlaybackStop.textContent = text;
    }
  }

  function playbackReportText() {
    const header = [
      `Sine Frequency Generator ${APP_VERSION}`,
      `Browser: ${navigator.userAgent.slice(0, 500)}`,
      `Settings: ${state.frequency} Hz, ${state.volumeDb} dB, ${state.mode}`,
      els.lastPlaybackStop?.textContent || "Stop details are available after refreshing the page.",
      "Events oldest first. P/S=playing/starting; C=context; A=audio session; H=helper."
    ].join("\n");
    const lines = [];
    let length = header.length;
    for (const entry of [...playbackEvents].reverse()) {
      const details = [entry.source, entry.key, entry.reason, entry.value, entry.message].filter(Boolean).map(String);
      if (entry.event === "button-activation") {
        details.push(`clicks=${entry.clicks} trusted=${entry.trusted} pointer=${entry.pointer}`);
      }
      const helper = entry.helper ? (entry.helperPaused ? "paused" : "playing") : "off";
      const version = entry.version === APP_VERSION ? "" : ` v${entry.version}`;
      const line = `${String(entry.at).slice(11, 23)} ${entry.event}${version} r${entry.request} P/S=${Number(entry.playing)}/${Number(entry.starting)} C=${entry.context}@${entry.clock} A=${entry.session}/${entry.sessionType} H=${helper} ${entry.visibility}${details.length ? ` ${details.join("; ").slice(0, 180)}` : ""}`;
      // Keep a report short enough to paste into one Telegram message. Drop
      // oldest whole events first, preserving the most recent stop sequence.
      if (length + line.length + 1 > 3800) {
        break;
      }
      lines.unshift(line);
      length += line.length + 1;
    }
    return `${header}\n${lines.join("\n")}`;
  }

  async function copyPlaybackReport() {
    els.playbackReport.value = playbackReportText();
    try {
      await navigator.clipboard.writeText(els.playbackReport.value);
      els.playbackReportStatus.textContent = "Playback report copied. You can paste it into your message.";
    } catch {
      els.playbackReport.hidden = false;
      els.playbackReport.focus();
      els.playbackReport.select();
      els.playbackReportStatus.textContent = "Copying was unavailable. The playback report is selected in the text field.";
    }
  }

  function restoreSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_STORAGE_KEY));
      if (!saved || typeof saved !== "object" || Array.isArray(saved)) {
        return;
      }

      const numbers = [
        ["frequency", MIN_FREQUENCY, MAX_FREQUENCY, 4],
        ["volumeDb", MIN_VOLUME_DB, MAX_VOLUME_DB, 1],
        ["pulseOnMs", 10, 60000, 0],
        ["pulseOffMs", 10, 60000, 0],
        ["sweepStart", MIN_FREQUENCY, MAX_FREQUENCY, 4],
        ["sweepEnd", MIN_FREQUENCY, MAX_FREQUENCY, 4],
        ["sweepDuration", 0.05, 3600, 2]
      ];
      for (const [key, min, max, decimals] of numbers) {
        if (typeof saved[key] === "number" && Number.isFinite(saved[key]) && saved[key] >= min && saved[key] <= max) {
          state[key] = roundNumber(saved[key], decimals);
        }
      }
      if (["continuous", "pulse", "sweep-up", "sweep-down"].includes(saved.mode)) {
        state.mode = saved.mode;
      }
      if (typeof saved.sweepLoop === "boolean") {
        state.sweepLoop = saved.sweepLoop;
      }
    } catch {
      // Storage may be unavailable, or an old saved value may be invalid.
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify({
        frequency: state.frequency,
        volumeDb: state.volumeDb,
        mode: state.mode,
        pulseOnMs: state.pulseOnMs,
        pulseOffMs: state.pulseOffMs,
        sweepStart: state.sweepStart,
        sweepEnd: state.sweepEnd,
        sweepDuration: state.sweepDuration,
        sweepLoop: state.sweepLoop
      }));
    } catch {
      // Keep the controls usable if the browser refuses local storage.
    }
  }

  function syncSavedSettingsControls() {
    els.modeInputs.forEach((input) => { input.checked = input.value === state.mode; });
    els.pulseOnInput.value = String(state.pulseOnMs);
    els.pulseOffInput.value = String(state.pulseOffMs);
    els.sweepStartInput.value = formatNumber(state.sweepStart);
    els.sweepEndInput.value = formatNumber(state.sweepEnd);
    els.sweepDurationInput.value = formatNumber(state.sweepDuration);
    els.sweepLoopInput.checked = state.sweepLoop;
  }

  function bindEvents() {
    els.playButton.addEventListener("click", (event) => {
      tracePlayback("button-activation", { source: "Play/Pause button", clicks: event.detail, trusted: event.isTrusted, pointer: event.pointerType || "none" });
      togglePlayback("Play/Pause button");
    });
    els.stopButton.addEventListener("click", () => stopPlayback({ source: "Stop button" }));
    els.copyPlaybackReport?.addEventListener("click", copyPlaybackReport);
    document.addEventListener("keydown", handleGlobalKeys, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handlePageReturn);
    window.addEventListener("pageshow", handlePageReturn);
    setupAudioSession();
    setupMediaSession();
    ["play", "pause", "ended", "error"].forEach((event) => {
      els.mediaControlAudio.addEventListener(event, () => tracePlayback(`helper-${event}`));
    });

    els.frequencyInput.addEventListener("input", () => setFrequency(els.frequencyInput.value, { announce: "frequency" }));
    els.frequencySlider.addEventListener("input", () => {
      if (!isFrequencyPointerActive) {
        setFrequency(sliderPositionToFrequency(els.frequencySlider.value), { announce: "frequency", throttle: true });
      }
    });
    els.frequencySlider.addEventListener("pointerdown", handleFrequencyPointerDown);
    els.frequencySlider.addEventListener("pointermove", handleFrequencyPointerMove);
    els.frequencySlider.addEventListener("pointerup", handleFrequencyPointerEnd);
    els.frequencySlider.addEventListener("pointercancel", handleFrequencyPointerEnd);
    els.frequencySlider.addEventListener("touchstart", handleFrequencyTouch, { passive: false });
    els.frequencySlider.addEventListener("touchmove", handleFrequencyTouch, { passive: false });
    els.frequencySlider.addEventListener("touchend", handleFrequencyTouchEnd);
    els.frequencySlider.addEventListener("touchcancel", handleFrequencyTouchEnd);

    els.frequencyShiftButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const ratio = Number(button.dataset.frequencyRatio);
        shiftFrequency(ratio, button.textContent.trim());
      });
    });

    els.scaleStepButtons.forEach((button) => {
      button.addEventListener("click", () => {
        shiftMajorScale(Number(button.dataset.scaleStep));
      });
    });

    els.volumeInput.addEventListener("input", () => setVolumeDb(els.volumeInput.value, { announce: "volume" }));
    els.volumeSlider.addEventListener("input", () => {
      const requestedDb = Number(els.volumeSlider.value);
      const change = requestedDb - state.volumeDb;
      // A fractional value entered in the number field must not make the next
      // accessibility adjustment smaller than 1 dB (except at a range limit).
      const nextDb = change !== 0 && Math.abs(change) < 1
        ? state.volumeDb + Math.sign(change)
        : requestedDb;
      setVolumeDb(nextDb);
    });

    els.volumeShiftButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const shift = Number(button.dataset.volumeShift);
        setVolumeDb(state.volumeDb + shift, { announce: "volume" });
      });
    });

    els.modeInputs.forEach((input) => {
      input.addEventListener("change", () => {
        setMode(input.value);
      });
    });

    els.pulseOnInput.addEventListener("change", () => updatePulseSettings("pulseOn"));
    els.pulseOffInput.addEventListener("change", () => updatePulseSettings("pulseOff"));

    els.sweepStartInput.addEventListener("change", () => updateSweepSettings("sweepStart"));
    els.sweepEndInput.addEventListener("change", () => updateSweepSettings("sweepEnd"));
    els.sweepDurationInput.addEventListener("change", () => updateSweepSettings("sweepDuration"));
    els.sweepLoopInput.addEventListener("change", () => updateSweepSettings("sweepLoop"));
  }

  async function startPlayback(source = "play request") {
    tracePlayback("play-request", { source });
    if (startInProgress) {
      tracePlayback("play-ignored", { source, reason: "start already in progress" });
      return;
    }

    if (isEngineHealthy()) {
      tracePlayback("play-ignored", { source, reason: "already playing" });
      return;
    }

    if (state.isPlaying) {
      stopPlayback({ immediate: true, silent: true, source: "Restarting an unhealthy audio engine" });
    } else if (oscillator || gateGain) {
      disposeToneNodes({ immediate: true });
    }

    const requestId = ++playbackRequestId;
    startInProgress = true;
    tracePlayback("start-pending", { source });
    updatePlaybackButtons();

    try {
      clearError();
      configureAudioPlayback();
      await ensureAudioContext({ requestId });
      if (requestId !== playbackRequestId) {
        tracePlayback("start-cancelled", { source });
        return;
      }

      const now = audioContext.currentTime;
      oscillator = audioContext.createOscillator();
      gateGain = audioContext.createGain();

      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(state.frequency, now);
      gateGain.gain.setValueAtTime(0, now);

      oscillator.connect(gateGain);
      gateGain.connect(outputGain);
      oscillator.start(now);

      state.isPlaying = true;
      updatePlaybackButtons();
      // A browser media callback can run synchronously while playbackState is
      // updated. Do not continue or announce Playing after that callback stops us.
      if (requestId !== playbackRequestId || !state.isPlaying) {
        return;
      }
      startCurrentMode();
      startMediaControlAudio();
      updateStatus();
      announce("Playing");
      tracePlayback("playing", { source });
    } catch (error) {
      if (requestId !== playbackRequestId) {
        tracePlayback("start-cancelled", { source });
        return;
      }
      tracePlayback("start-error", { source: "Audio failed to start", message: error.message || String(error) });
      disposeToneNodes({ immediate: true });
      state.isPlaying = false;
      updatePlaybackButtons();
      showError(error.message || "Could not start audio.");
    } finally {
      if (requestId === playbackRequestId) {
        startInProgress = false;
        updatePlaybackButtons();
      }
    }
  }

  function togglePlayback(source = "play/pause request") {
    if (state.isPlaying || startInProgress) {
      stopPlayback({ source });
    } else {
      startPlayback(source);
    }
  }

  function stopPlayback(options = {}) {
    tracePlayback("stop", { source: options.source || "Unspecified stop request", silent: Boolean(options.silent) });
    const cancelledStart = startInProgress && !state.isPlaying;
    playbackRequestId += 1;
    resumeAttemptContext = null;
    clearModeTimers();

    state.isPlaying = false;
    startInProgress = false;
    updatePlaybackButtons();
    disposeToneNodes(options);
    if (cancelledStart && audioContext) {
      const cancelledContext = audioContext;
      audioContext = null;
      outputGain = null;
      cancelledContext.close?.().catch?.(() => {});
    }
    pauseMediaControlAudio();
    updateStatus();

    if (!options.silent) {
      announce("Stopped");
    }
  }

  function disposeToneNodes(options = {}) {
    if (!oscillator && !gateGain) {
      return;
    }

    const oldOscillator = oscillator;
    const oldGate = gateGain;
    oscillator = null;
    gateGain = null;

    try {
      if (oldGate && audioContext && !options.immediate) {
        const now = audioContext.currentTime;
        oldGate.gain.cancelScheduledValues(now);
        oldGate.gain.setValueAtTime(Math.max(0, oldGate.gain.value), now);
        oldGate.gain.linearRampToValueAtTime(0, now + EDGE_FADE_SECONDS);
        if (oldOscillator) {
          oldOscillator.stop(now + EDGE_FADE_SECONDS + 0.04);
        }
        window.setTimeout(() => disconnectToneNodes(oldOscillator, oldGate), 90);
      } else {
        if (oldOscillator) {
          oldOscillator.stop();
        }
        disconnectToneNodes(oldOscillator, oldGate);
      }
    } catch {
      disconnectToneNodes(oldOscillator, oldGate);
    }
  }

  function disconnectToneNodes(oldOscillator, oldGate) {
    try {
      oldOscillator?.disconnect();
      oldGate?.disconnect();
    } catch {
      // The browser may have already disconnected a stopped node.
    }
  }

  async function ensureAudioContext(options = {}) {
    const ContextClass = window.AudioContext || window.webkitAudioContext;
    if (!ContextClass) {
      throw new Error("This browser does not support Web Audio.");
    }

    if (!audioContext || audioContext.state === "closed") {
      createAudioContext(ContextClass);
    }

    await resumeAudioContext();
    if (options.requestId !== playbackRequestId) {
      return;
    }

    if (!isAudioContextRunning()) {
      createAudioContext(ContextClass);
      await resumeAudioContext();
    }
    if (options.requestId !== playbackRequestId) {
      return;
    }

    if (!isAudioContextRunning()) {
      throw new Error("Audio did not start. Press Play again.");
    }
  }

  function createAudioContext(ContextClass) {
    const oldContext = audioContext;

    audioContext = new ContextClass();
    tracePlayback("context-created");
    audioContext.addEventListener?.("statechange", handleAudioContextStateChange);
    outputGain = audioContext.createGain();
    outputGain.gain.value = dbToGain(state.volumeDb);
    outputGain.connect(audioContext.destination);

    if (oldContext && oldContext !== audioContext && oldContext.state !== "closed") {
      oldContext.close?.().catch?.(() => {});
    }
  }

  async function resumeAudioContext() {
    if (!audioContext || audioContext.state === "running") {
      return;
    }

    try {
      await audioContext.resume?.();
    } catch {
      // A fresh context is attempted by ensureAudioContext after this.
    }
  }

  function isAudioContextRunning() {
    return Boolean(audioContext && audioContext.state === "running");
  }

  function isEngineHealthy() {
    return Boolean(state.isPlaying && oscillator && gateGain && isAudioContextRunning());
  }

  function handleAudioContextStateChange(event) {
    if (event.target !== audioContext) {
      return;
    }

    tracePlayback("context-statechange");
    recoverAudioContext();
  }

  function handleVisibilityChange() {
    tracePlayback("visibility-change");
    if (document.visibilityState !== "hidden") {
      handlePageReturn();
    }
  }

  function handlePageReturn(event) {
    tracePlayback("page-return", { source: event?.type || "visibility" });
    recoverAudioContext();
  }

  function setupAudioSession() {
    try {
      browserAudioSession = navigator.audioSession || null;
      browserAudioSession?.addEventListener("statechange", () => {
        tracePlayback("audio-session-statechange");
        if (state.isPlaying || startInProgress) {
          if (browserAudioSession.state === "interrupted") {
            updateStatus("Audio interrupted. Waiting to resume.");
          } else {
            recoverAudioContext();
          }
        }
      });
    } catch {
      browserAudioSession = null;
    }
  }

  function configureAudioPlayback() {
    useMediaControlHelper = true;
    try {
      if (browserAudioSession) {
        browserAudioSession.type = "playback";
        useMediaControlHelper = browserAudioSession.type !== "playback";
      }
    } catch {
      // Older browsers can still use the media-control helper.
    }
    tracePlayback("audio-session-configured");
  }

  function isSystemAudioInterruption() {
    return browserAudioSession?.state === "interrupted" || audioContext?.state === "interrupted";
  }

  async function recoverAudioContext() {
    if (!state.isPlaying || !audioContext || document.visibilityState === "hidden") {
      return;
    }

    if (browserAudioSession?.state === "interrupted") {
      updateStatus("Audio interrupted. Waiting to resume.");
      return;
    }

    if (isAudioContextRunning()) {
      clearError();
      updateStatus();
      return;
    }

    if (audioContext.state === "closed") {
      stopPlayback({ immediate: true, silent: true, source: "Audio context closed" });
      showError("Audio stopped. Press Play to restart.");
      return;
    }

    const context = audioContext;
    const requestId = playbackRequestId;
    if (resumeAttemptContext === context) {
      return;
    }

    resumeAttemptContext = context;
    tracePlayback("recovery-request");
    updateStatus("Audio interrupted. Waiting to resume.");
    try {
      // Safari can suspend or interrupt Web Audio temporarily. Keep the user's
      // playback request and tone nodes instead of turning this into a Stop.
      await context.resume();
      if (requestId === playbackRequestId && context === audioContext && state.isPlaying && isAudioContextRunning()) {
        clearError();
        updateStatus();
        tracePlayback("recovery-complete");
      }
    } catch {
      tracePlayback("recovery-failed");
      if (requestId === playbackRequestId && context === audioContext && state.isPlaying) {
        showError("Audio could not resume. Press Pause, then Play to restart.");
      }
    } finally {
      if (resumeAttemptContext === context) {
        resumeAttemptContext = null;
      }
    }
  }

  function startCurrentMode() {
    if (!state.isPlaying || !oscillator || !gateGain || !audioContext) {
      return;
    }

    clearModeTimers();

    if (state.mode === "continuous") {
      startContinuousMode();
    } else if (state.mode === "pulse") {
      startPulseMode();
    } else {
      startSweepMode();
    }
  }

  function startContinuousMode() {
    const now = audioContext.currentTime;
    oscillator.frequency.cancelScheduledValues(now);
    oscillator.frequency.setTargetAtTime(state.frequency, now, 0.01);
    setGateTarget(1);
  }

  function startPulseMode() {
    const now = audioContext.currentTime;
    oscillator.frequency.cancelScheduledValues(now);
    oscillator.frequency.setTargetAtTime(state.frequency, now, 0.01);
    gateGain.gain.cancelScheduledValues(now);
    gateGain.gain.setValueAtTime(0, now);
    pulseCursor = now + 0.02;
    schedulePulseBlocks();
    pulseTimer = window.setInterval(schedulePulseBlocks, 50);
  }

  function schedulePulseBlocks() {
    if (!audioContext || !gateGain) {
      return;
    }

    const onSeconds = Math.max(0.01, state.pulseOnMs / 1000);
    const offSeconds = Math.max(0.01, state.pulseOffMs / 1000);
    const scheduleAhead = 4;

    while (pulseCursor < audioContext.currentTime + scheduleAhead) {
      scheduleOnePulse(pulseCursor, onSeconds, offSeconds);
      pulseCursor += onSeconds + offSeconds;
    }
  }

  function scheduleOnePulse(startTime, onSeconds, offSeconds) {
    const fade = Math.min(EDGE_FADE_SECONDS, onSeconds / 4);
    const onEnd = startTime + onSeconds;
    const cycleEnd = onEnd + offSeconds;
    const gain = gateGain.gain;

    gain.setValueAtTime(0, startTime);
    gain.linearRampToValueAtTime(1, startTime + fade);

    if (onSeconds > fade * 2) {
      gain.setValueAtTime(1, onEnd - fade);
    }

    gain.linearRampToValueAtTime(0, onEnd);
    gain.setValueAtTime(0, cycleEnd);
  }

  function startSweepMode() {
    const isUp = state.mode === "sweep-up";
    const start = isUp ? state.sweepStart : state.sweepEnd;
    const end = isUp ? state.sweepEnd : state.sweepStart;
    beginSweep(start, end);
  }

  function beginSweep(start, end) {
    if (!state.isPlaying || !audioContext || !oscillator || !gateGain) {
      return;
    }

    const duration = Math.max(0.05, state.sweepDuration);
    const now = audioContext.currentTime;
    activeSweep = {
      start,
      end,
      duration,
      startedAt: now
    };
    oscillator.frequency.cancelScheduledValues(now);
    oscillator.frequency.setValueAtTime(start, now);
    setGateTarget(1);

    updateSweepFrequency();
    sweepTimer = window.setInterval(updateSweepFrequency, 30);
  }

  function updateSweepFrequency() {
    if (!activeSweep || !state.isPlaying || !audioContext || !oscillator) {
      return;
    }

    const elapsed = audioContext.currentTime - activeSweep.startedAt;
    const progress = Math.min(1, Math.max(0, elapsed / activeSweep.duration));
    const frequency = interpolateSweepFrequency(activeSweep.start, activeSweep.end, progress);
    const now = audioContext.currentTime;
    oscillator.frequency.cancelScheduledValues(now);
    oscillator.frequency.setTargetAtTime(frequency, now, 0.01);

    if (progress < 1) {
      return;
    }

    if (state.sweepLoop) {
      activeSweep.startedAt = now;
      oscillator.frequency.cancelScheduledValues(now);
      oscillator.frequency.setValueAtTime(activeSweep.start, now);
      return;
    }

    if (sweepTimer !== null) {
      window.clearInterval(sweepTimer);
      sweepTimer = null;
    }

    const end = activeSweep.end;
    activeSweep = null;
        setFrequency(end, { applyToAudio: false, announce: false, keepScaleDegree: true });
    updateStatus();
  }

  function clearModeTimers() {
    if (pulseTimer !== null) {
      window.clearInterval(pulseTimer);
      pulseTimer = null;
    }

    if (sweepTimer !== null) {
      window.clearInterval(sweepTimer);
      sweepTimer = null;
    }
    activeSweep = null;

    if (gateGain && audioContext) {
      const now = audioContext.currentTime;
      gateGain.gain.cancelScheduledValues(now);
    }
  }

  function setFrequency(value, options = {}) {
    const next = clampNumber(value, MIN_FREQUENCY, MAX_FREQUENCY, state.frequency);
    state.frequency = roundNumber(next, 4);
    saveSettings();
    if (!options.keepScaleDegree) {
      state.scaleDegree = 0;
    }
    syncFrequencyControls();

    if (options.applyToAudio !== false && state.isPlaying && oscillator && audioContext && state.mode !== "sweep-up" && state.mode !== "sweep-down") {
      const now = audioContext.currentTime;
      oscillator.frequency.cancelScheduledValues(now);
      oscillator.frequency.setTargetAtTime(state.frequency, now, 0.01);
    }

    updateStatus();
    if (options.announce === "frequency") {
      announce(formatNumber(state.frequency), { throttle: Boolean(options.throttle) });
    }
  }

  function shiftFrequency(ratio, label) {
    let next = state.frequency;

    if (next === 0 && ratio > 1) {
      next = 1;
    } else {
      next *= ratio;
    }

    setFrequency(next, { announce: false });
    announce(formatNumber(state.frequency));
  }

  function shiftMajorScale(direction) {
    if (!direction) {
      return;
    }

    if (state.frequency === 0) {
      setFrequency(1, { announce: false, keepScaleDegree: true });
    }

    const semitones = getMajorScaleStepSemitones(direction);
    const next = state.frequency * Math.pow(2, semitones / 12);
    state.scaleDegree = positiveModulo(state.scaleDegree + direction, MAJOR_SCALE_STEPS.length);
    setFrequency(next, { announce: false, keepScaleDegree: true });
    announce(formatNumber(state.frequency));
  }

  function getMajorScaleStepSemitones(direction) {
    if (direction > 0) {
      return MAJOR_SCALE_STEPS[state.scaleDegree];
    }

    return -MAJOR_SCALE_STEPS[positiveModulo(state.scaleDegree - 1, MAJOR_SCALE_STEPS.length)];
  }

  function handleFrequencyPointerDown(event) {
    isFrequencyPointerActive = true;
    beginLiveInteraction();
    els.frequencySlider.setPointerCapture?.(event.pointerId);
    setFrequencyFromClientX(event.clientX);
  }

  function handleFrequencyPointerMove(event) {
    if (!isFrequencyPointerActive) {
      return;
    }
    setFrequencyFromClientX(event.clientX);
  }

  function handleFrequencyPointerEnd(event) {
    isFrequencyPointerActive = false;
    els.frequencySlider.releasePointerCapture?.(event.pointerId);
    endLiveInteraction();
  }

  function handleFrequencyTouch(event) {
    if (!event.touches.length) {
      return;
    }
    isFrequencyPointerActive = true;
    beginLiveInteraction();
    event.preventDefault();
    setFrequencyFromClientX(event.touches[0].clientX);
  }

  function handleFrequencyTouchEnd() {
    isFrequencyPointerActive = false;
    endLiveInteraction();
  }

  function setFrequencyFromClientX(clientX) {
    const rect = els.frequencySlider.getBoundingClientRect();
    if (!rect.width) {
      return;
    }

    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const position = Math.round(ratio * FREQUENCY_SLIDER_STEPS);
    els.frequencySlider.value = String(position);
    setFrequency(sliderPositionToFrequency(position), { announce: "frequency", throttle: true });
  }

  function setVolumeDb(value, options = {}) {
    const next = clampNumber(value, MIN_VOLUME_DB, MAX_VOLUME_DB, state.volumeDb);
    state.volumeDb = roundNumber(next, 1);
    saveSettings();
    syncVolumeControls();

    if (outputGain && audioContext) {
      const now = audioContext.currentTime;
      outputGain.gain.cancelScheduledValues(now);
      outputGain.gain.setTargetAtTime(dbToGain(state.volumeDb), now, 0.015);
    }

    updateStatus();
    if (options.announce === "volume") {
      announce(formatNumber(state.volumeDb), { throttle: Boolean(options.throttle) });
    }
  }

  function updatePulseSettings(changedField) {
    state.pulseOnMs = Math.round(clampNumber(els.pulseOnInput.value, 10, 60000, state.pulseOnMs));
    state.pulseOffMs = Math.round(clampNumber(els.pulseOffInput.value, 10, 60000, state.pulseOffMs));
    saveSettings();
    els.pulseOnInput.value = String(state.pulseOnMs);
    els.pulseOffInput.value = String(state.pulseOffMs);

    if (state.isPlaying && state.mode === "pulse") {
      startCurrentMode();
    }

    updateStatus();
    if (changedField === "pulseOn") {
      announce(`On ${state.pulseOnMs}`);
    } else if (changedField === "pulseOff") {
      announce(`Off ${state.pulseOffMs}`);
    }
  }

  function updateSweepSettings(changedField) {
    state.sweepStart = roundNumber(clampNumber(els.sweepStartInput.value, MIN_FREQUENCY, MAX_FREQUENCY, state.sweepStart), 4);
    state.sweepEnd = roundNumber(clampNumber(els.sweepEndInput.value, MIN_FREQUENCY, MAX_FREQUENCY, state.sweepEnd), 4);
    state.sweepDuration = roundNumber(clampNumber(els.sweepDurationInput.value, 0.05, 3600, state.sweepDuration), 2);
    state.sweepLoop = els.sweepLoopInput.checked;
    saveSettings();

    els.sweepStartInput.value = formatNumber(state.sweepStart);
    els.sweepEndInput.value = formatNumber(state.sweepEnd);
    els.sweepDurationInput.value = formatNumber(state.sweepDuration);

    if (state.isPlaying && (state.mode === "sweep-up" || state.mode === "sweep-down")) {
      startCurrentMode();
    }

    updateStatus();
    if (changedField === "sweepStart") {
      announce(`Start ${formatNumber(state.sweepStart)}`);
    } else if (changedField === "sweepEnd") {
      announce(`End ${formatNumber(state.sweepEnd)}`);
    } else if (changedField === "sweepDuration") {
      announce(`Length ${formatNumber(state.sweepDuration)}`);
    } else if (changedField === "sweepLoop") {
      announce(state.sweepLoop ? "Repeat on" : "Repeat off");
    }
  }

  function syncFrequencyControls() {
    const value = formatNumber(state.frequency);
    if (document.activeElement !== els.frequencyInput) {
      els.frequencyInput.value = value;
    }
    els.frequencySlider.value = String(frequencyToSliderPosition(state.frequency));
    els.frequencySlider.setAttribute("aria-valuetext", formatFrequency(state.frequency));
  }

  function syncVolumeControls() {
    const value = formatNumber(state.volumeDb);
    if (document.activeElement !== els.volumeInput) {
      els.volumeInput.value = value;
    }
    els.volumeSlider.value = String(state.volumeDb);
    els.volumeSlider.setAttribute("aria-valuetext", formatDb(state.volumeDb));
  }

  function updateModePanels() {
    els.pulseSettings.hidden = state.mode !== "pulse";
    els.sweepSettings.hidden = state.mode !== "sweep-up" && state.mode !== "sweep-down";
  }

  function updatePlaybackButtons() {
    els.playButton.disabled = false;
    els.playButton.textContent = state.isPlaying || startInProgress ? "Pause" : "Play";
    els.stopButton.disabled = !state.isPlaying && !startInProgress;
    updateMediaSessionState();
  }

  function updateStatus(text) {
    els.status.textContent = text || statusText();
  }

  function announce(text, options = {}) {
    if (!LIVE_ANNOUNCEMENTS_ENABLED) {
      return;
    }

    if (!text) {
      return;
    }

    if (options.throttle) {
      pendingLiveText = text;

      const now = Date.now();
      const elapsed = now - lastLiveAt;
      const delay = Math.max(0, LIVE_THROTTLE_MS - elapsed);

      if (delay === 0) {
        if (liveTimer !== null) {
          window.clearTimeout(liveTimer);
          liveTimer = null;
        }
        setLiveText(pendingLiveText);
        pendingLiveText = "";
        lastLiveAt = Date.now();
      } else if (liveTimer === null) {
        liveTimer = window.setTimeout(() => {
          setLiveText(pendingLiveText);
          pendingLiveText = "";
          liveTimer = null;
          lastLiveAt = Date.now();
        }, delay);
      }
      return;
    }

    if (liveTimer !== null) {
      window.clearTimeout(liveTimer);
      liveTimer = null;
      pendingLiveText = "";
    }

    setLiveText(text);
    lastLiveAt = Date.now();
  }

  function beginLiveInteraction() {
    if (!liveInteractionActive) {
      cancelPendingLiveAnnouncement();
      lastLiveAt = 0;
    }
    liveInteractionActive = true;
  }

  function endLiveInteraction() {
    liveInteractionActive = false;
    cancelPendingLiveAnnouncement();
  }

  function cancelPendingLiveAnnouncement() {
    if (liveTimer !== null) {
      window.clearTimeout(liveTimer);
      liveTimer = null;
    }
    pendingLiveText = "";
  }

  function setLiveText(text) {
    const token = liveWriteToken + 1;
    liveWriteToken = token;
    els.liveStatus.textContent = "";
    window.setTimeout(() => {
      if (token === liveWriteToken) {
        els.liveStatus.textContent = text;
      }
    }, 0);
  }

  function statusText() {
    if ((state.isPlaying || startInProgress) && isSystemAudioInterruption()) {
      return "Audio interrupted. Waiting to resume.";
    }
    return `${state.isPlaying ? "Playing" : "Stopped"}, ${modeLabel()}, ${formatFrequency(state.frequency)}, ${formatDb(state.volumeDb)}.`;
  }

  function modeLabel() {
    if (state.mode === "pulse") {
      return "pulse";
    }
    if (state.mode === "sweep-up") {
      return "sweep up";
    }
    if (state.mode === "sweep-down") {
      return "sweep down";
    }
    return "continuous";
  }

  function setGateTarget(target) {
    if (!gateGain || !audioContext) {
      return;
    }
    const now = audioContext.currentTime;
    gateGain.gain.cancelScheduledValues(now);
    gateGain.gain.setTargetAtTime(target, now, EDGE_FADE_SECONDS);
  }

  function setupMediaSession() {
    if (!("mediaSession" in navigator)) {
      return;
    }

    if ("MediaMetadata" in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Sine Frequency Generator",
        artist: "Browser tone generator"
      });
    }

    setMediaSessionHandler("play", handleMediaPlayAction);
    setMediaSessionHandler("pause", handleMediaPauseAction);
    setMediaSessionHandler("stop", handleMediaStopAction);
    updateMediaSessionState();
  }

  function handleMediaPlayAction() {
    tracePlayback("media-session-play");
    startPlayback("iPhone/browser media Play command");
  }

  function handleMediaPauseAction() {
    tracePlayback("media-session-pause");
    // WebKit also sends this action for a system interruption. It must not
    // discard the playback request before the interruption can end.
    if ((state.isPlaying || startInProgress) && isSystemAudioInterruption()) {
      updateStatus("Audio interrupted. Waiting to resume.");
      tracePlayback("media-pause-during-interruption");
      return;
    }
    stopPlayback({ source: "iPhone/browser media Pause command" });
  }

  function handleMediaStopAction() {
    tracePlayback("media-session-stop");
    stopPlayback({ source: "iPhone/browser media Stop command" });
  }

  async function startMediaControlAudio() {
    if (!useMediaControlHelper || !els.mediaControlAudio) {
      return;
    }

    if (!els.mediaControlAudio.src) {
      els.mediaControlAudio.src = createSilentWavUrl();
    }

    try {
      tracePlayback("helper-play-request");
      await els.mediaControlAudio.play();
      // A late play() completion must not leave the helper running after Stop.
      if (!state.isPlaying && !startInProgress) {
        els.mediaControlAudio.pause();
      }
    } catch (error) {
      tracePlayback("helper-play-refused", { message: error.message || String(error) });
      // Web Audio still works if the browser refuses the helper element.
    }
  }

  function pauseMediaControlAudio() {
    if (!els.mediaControlAudio) {
      return;
    }

    try {
      els.mediaControlAudio.pause();
      els.mediaControlAudio.currentTime = 0;
    } catch {
      // The helper element is only for media-key routing.
    }
  }

  function createSilentWavUrl() {
    const sampleRate = 8000;
    const seconds = 1;
    const samples = sampleRate * seconds;
    const dataSize = samples * 2;
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);

    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * 2, true);
    view.setUint16(32, 2, true);
    view.setUint16(34, 16, true);
    writeAscii(view, 36, "data");
    view.setUint32(40, dataSize, true);

    const blob = new Blob([buffer], { type: "audio/wav" });
    return URL.createObjectURL(blob);
  }

  function writeAscii(view, offset, text) {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  }

  function setMediaSessionHandler(action, handler) {
    try {
      navigator.mediaSession.setActionHandler(action, handler);
    } catch (error) {
      tracePlayback("media-handler-refused", { source: action, message: error.message || String(error) });
      // Some browsers expose Media Session but not every action.
    }
  }

  function updateMediaSessionState() {
    if (!("mediaSession" in navigator)) {
      return;
    }

    try {
      tracePlayback("media-state-write", { value: state.isPlaying ? "playing" : "paused" });
      navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
    } catch (error) {
      tracePlayback("media-state-refused", { message: error.message || String(error) });
      // Playback state is advisory, so failure is not fatal.
    }
  }

  function handleGlobalKeys(event) {
    if (event.defaultPrevented) {
      return;
    }

    if (event.key === "MediaPlayPause") {
      event.preventDefault();
      tracePlayback("media-key", { key: event.key });
      togglePlayback("Media Play/Pause key");
      return;
    } else if (event.key === "MediaPlay") {
      event.preventDefault();
      tracePlayback("media-key", { key: event.key });
      startPlayback("Media Play key");
      return;
    } else if (event.key === "MediaPause" || event.key === "MediaStop") {
      event.preventDefault();
      tracePlayback("media-key", { key: event.key });
      stopPlayback({ source: `Media ${event.key} key` });
      return;
    }

    if (event.altKey || event.ctrlKey || event.metaKey || shouldIgnoreShortcutTarget(event.target)) {
      return;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    if (key === "k" || key === " ") {
      event.preventDefault();
      tracePlayback("keyboard-shortcut", { key });
      togglePlayback(`Keyboard ${key === " " ? "Space" : key}`);
    } else if (key === "s") {
      event.preventDefault();
      tracePlayback("keyboard-shortcut", { key });
      stopPlayback({ source: "Keyboard S" });
    } else if (key === "1" || key === "c") {
      event.preventDefault();
      setMode("continuous");
    } else if (key === "2" || key === "p") {
      event.preventDefault();
      setMode("pulse");
    } else if (key === "3" || key === "u") {
      event.preventDefault();
      setMode("sweep-up");
    } else if (key === "4" || key === "d") {
      event.preventDefault();
      setMode("sweep-down");
    } else if (key === "ArrowUp") {
      event.preventDefault();
      setVolumeDb(state.volumeDb + (event.shiftKey ? 6 : 1), { announce: "volume" });
    } else if (key === "ArrowDown") {
      event.preventDefault();
      setVolumeDb(state.volumeDb - (event.shiftKey ? 6 : 1), { announce: "volume" });
    } else if (key === "ArrowRight") {
      event.preventDefault();
      shiftFrequency(event.shiftKey ? 2 : Math.pow(2, 1 / 12));
    } else if (key === "ArrowLeft") {
      event.preventDefault();
      shiftFrequency(event.shiftKey ? 0.5 : Math.pow(2, -1 / 12));
    } else if (key === "]") {
      event.preventDefault();
      shiftMajorScale(1);
    } else if (key === "[") {
      event.preventDefault();
      shiftMajorScale(-1);
    }
  }

  function shouldIgnoreShortcutTarget(target) {
    if (!target || target === document.body || target === document.documentElement) {
      return false;
    }

    if (target.isContentEditable) {
      return true;
    }

    return Boolean(target.closest("input, textarea, select, button, summary"));
  }

  function setMode(mode) {
    const input = els.modeInputs.find((candidate) => candidate.value === mode);
    if (!input) {
      return;
    }

    input.checked = true;
    state.mode = mode;
    saveSettings();
    updateModePanels();
    if (state.isPlaying) {
      startCurrentMode();
    }
    updateStatus();
    announce(modeLabel());
  }

  function dbToGain(db) {
    if (db <= MIN_VOLUME_DB) {
      return 0;
    }
    return Math.pow(10, db / 20);
  }

  function sliderPositionToFrequency(position) {
    const sliderPosition = clampNumber(position, 0, FREQUENCY_SLIDER_STEPS, 0);
    if (sliderPosition <= 0) {
      return 0;
    }

    const normalized = sliderPosition / FREQUENCY_SLIDER_STEPS;
    return roundNumber(LOG_SLIDER_MIN_FREQUENCY * Math.pow(MAX_FREQUENCY / LOG_SLIDER_MIN_FREQUENCY, normalized), 2);
  }

  function interpolateSweepFrequency(start, end, progress) {
    if (start > 0 && end > 0) {
      return start * Math.pow(end / start, progress);
    }

    return start + (end - start) * progress;
  }

  function frequencyToSliderPosition(frequency) {
    const value = clampNumber(frequency, MIN_FREQUENCY, MAX_FREQUENCY, 0);
    if (value <= 0) {
      return 0;
    }

    const normalized = Math.log(value / LOG_SLIDER_MIN_FREQUENCY) / Math.log(MAX_FREQUENCY / LOG_SLIDER_MIN_FREQUENCY);
    return Math.round(Math.min(1, Math.max(0, normalized)) * FREQUENCY_SLIDER_STEPS);
  }

  function clampNumber(value, min, max, fallback) {
    const number = Number(value);
    if (!Number.isFinite(number)) {
      return fallback;
    }
    return Math.min(max, Math.max(min, number));
  }

  function roundNumber(value, decimals) {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
  }

  function positiveModulo(value, divisor) {
    return ((value % divisor) + divisor) % divisor;
  }

  function formatNumber(value) {
    if (Number.isInteger(value)) {
      return String(value);
    }
    return String(value).replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  }

  function formatFrequency(value) {
    return `${formatNumber(value)} Hz`;
  }

  function formatDb(value) {
    return `${formatNumber(value)} dB`;
  }

  function showError(message) {
    els.error.textContent = message;
    els.error.hidden = false;
  }

  function clearError() {
    els.error.textContent = "";
    els.error.hidden = true;
  }
})();
