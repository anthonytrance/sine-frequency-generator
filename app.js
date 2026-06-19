(() => {
  "use strict";

  const MIN_FREQUENCY = 0;
  const MAX_FREQUENCY = 22000;
  const LOG_SLIDER_MIN_FREQUENCY = 1;
  const FREQUENCY_SLIDER_STEPS = 1000;
  const MIN_VOLUME_DB = -80;
  const MAX_VOLUME_DB = 0;
  const VOLUME_SLIDER_STEPS = 1000;
  const EDGE_FADE_SECONDS = 0.008;
  const LIVE_ANNOUNCEMENTS_ENABLED = true;
  const LIVE_THROTTLE_MS = 3500;
  const MEDIA_HELPER_ARM_MS = 3000;
  const MEDIA_HELPER_EVENT_MUTE_MS = 80;
  const MAJOR_SCALE_STEPS = [2, 2, 1, 2, 2, 2, 1];

  const state = {
    frequency: 440,
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
  let isVolumePointerActive = false;
  let liveTimer = null;
  let pendingLiveText = "";
  let lastLiveAt = 0;
  let liveWriteToken = 0;
  let liveInteractionActive = false;
  let mediaHelperEventsMuted = false;
  let mediaHelperPauseArmed = false;
  let mediaHelperArmTimer = null;
  let mediaHelperEventMuteTimer = null;
  let mediaSessionSupported = false;
  let startInProgress = false;

  document.addEventListener("DOMContentLoaded", init);

  function init() {
    bindElements();
    bindEvents();
    updateModePanels();
    syncFrequencyControls();
    syncVolumeControls();
    updatePlaybackButtons();
    updateStatus();
  }

  function bindElements() {
    els.playButton = document.getElementById("playButton");
    els.stopButton = document.getElementById("stopButton");
    els.status = document.getElementById("status");
    els.mediaControlAudio = document.getElementById("mediaControlAudio");
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

  function bindEvents() {
    els.playButton.addEventListener("click", togglePlayback);
    els.stopButton.addEventListener("click", () => stopPlayback());
    document.addEventListener("keydown", handleGlobalKeys, true);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    window.addEventListener("focus", handlePageReturn);
    window.addEventListener("pageshow", handlePageReturn);
    setupMediaSession();

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
      if (!isVolumePointerActive) {
        setVolumeDb(volumeSliderPositionToDb(els.volumeSlider.value), { announce: "volume", throttle: true });
      }
    });
    els.volumeSlider.addEventListener("pointerdown", handleVolumePointerDown);
    els.volumeSlider.addEventListener("pointermove", handleVolumePointerMove);
    els.volumeSlider.addEventListener("pointerup", handleVolumePointerEnd);
    els.volumeSlider.addEventListener("pointercancel", handleVolumePointerEnd);
    els.volumeSlider.addEventListener("touchstart", handleVolumeTouch, { passive: false });
    els.volumeSlider.addEventListener("touchmove", handleVolumeTouch, { passive: false });
    els.volumeSlider.addEventListener("touchend", handleVolumeTouchEnd);
    els.volumeSlider.addEventListener("touchcancel", handleVolumeTouchEnd);
    els.mediaControlAudio.addEventListener("play", handleMediaElementPlay);
    els.mediaControlAudio.addEventListener("pause", handleMediaElementPause);

    els.volumeShiftButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const shift = Number(button.dataset.volumeShift);
        setVolumeDb(state.volumeDb + shift, { announce: "volume" });
      });
    });

    els.modeInputs.forEach((input) => {
      input.addEventListener("change", () => {
        state.mode = input.value;
        updateModePanels();
        if (state.isPlaying) {
          startCurrentMode();
        }
        updateStatus();
        announce(modeLabel());
      });
    });

    els.pulseOnInput.addEventListener("change", () => updatePulseSettings("pulseOn"));
    els.pulseOffInput.addEventListener("change", () => updatePulseSettings("pulseOff"));

    els.sweepStartInput.addEventListener("change", () => updateSweepSettings("sweepStart"));
    els.sweepEndInput.addEventListener("change", () => updateSweepSettings("sweepEnd"));
    els.sweepDurationInput.addEventListener("change", () => updateSweepSettings("sweepDuration"));
    els.sweepLoopInput.addEventListener("change", () => updateSweepSettings("sweepLoop"));
  }

  async function startPlayback() {
    if (startInProgress) {
      return;
    }

    if (isEngineHealthy()) {
      startCurrentMode();
      startMediaControlAudio();
      return;
    }

    if (state.isPlaying) {
      stopPlayback({ immediate: true, silent: true });
    } else if (oscillator || gateGain) {
      disposeToneNodes({ immediate: true });
    }

    startInProgress = true;
    updatePlaybackButtons();

    try {
      clearError();
      await ensureAudioContext({ forceNew: true });

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
      startCurrentMode();
      startMediaControlAudio();
      updateStatus();
      announce("Playing");
    } catch (error) {
      disposeToneNodes({ immediate: true });
      state.isPlaying = false;
      updatePlaybackButtons();
      showError(error.message || "Could not start audio.");
    } finally {
      startInProgress = false;
      updatePlaybackButtons();
    }
  }

  function togglePlayback() {
    if (state.isPlaying) {
      stopPlayback();
    } else {
      startPlayback();
    }
  }

  function stopPlayback(options = {}) {
    clearModeTimers();

    state.isPlaying = false;
    startInProgress = false;
    updatePlaybackButtons();
    disposeToneNodes(options);
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

    if (options.forceNew || !audioContext || audioContext.state === "closed") {
      createAudioContext(ContextClass);
    }

    await resumeAudioContext();

    if (!isAudioContextRunning()) {
      createAudioContext(ContextClass);
      await resumeAudioContext();
    }

    if (!isAudioContextRunning()) {
      throw new Error("Audio did not start. Press Play again.");
    }
  }

  function createAudioContext(ContextClass) {
    const oldContext = audioContext;

    audioContext = new ContextClass();
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

    if (!state.isPlaying || document.visibilityState === "hidden") {
      return;
    }

    window.setTimeout(() => {
      if (state.isPlaying && !isEngineHealthy() && document.visibilityState !== "hidden") {
        stopPlayback({ immediate: true, silent: true });
      }
    }, 300);
  }

  function handleVisibilityChange() {
    if (document.visibilityState !== "hidden") {
      handlePageReturn();
    }
  }

  function handlePageReturn() {
    if (document.visibilityState === "hidden") {
      return;
    }

    if (state.isPlaying && !isEngineHealthy()) {
      stopPlayback({ immediate: true, silent: true });
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

  function handleVolumePointerDown(event) {
    isVolumePointerActive = true;
    beginLiveInteraction();
    els.volumeSlider.setPointerCapture?.(event.pointerId);
    setVolumeFromClientX(event.clientX);
  }

  function handleVolumePointerMove(event) {
    if (!isVolumePointerActive) {
      return;
    }
    setVolumeFromClientX(event.clientX);
  }

  function handleVolumePointerEnd(event) {
    isVolumePointerActive = false;
    els.volumeSlider.releasePointerCapture?.(event.pointerId);
    endLiveInteraction();
  }

  function handleVolumeTouch(event) {
    if (!event.touches.length) {
      return;
    }
    isVolumePointerActive = true;
    beginLiveInteraction();
    event.preventDefault();
    setVolumeFromClientX(event.touches[0].clientX);
  }

  function handleVolumeTouchEnd() {
    isVolumePointerActive = false;
    endLiveInteraction();
  }

  function setVolumeFromClientX(clientX) {
    const rect = els.volumeSlider.getBoundingClientRect();
    if (!rect.width) {
      return;
    }

    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const position = Math.round(ratio * VOLUME_SLIDER_STEPS);
    els.volumeSlider.value = String(position);
    setVolumeDb(volumeSliderPositionToDb(position), { announce: "volume", throttle: true });
  }

  function setVolumeDb(value, options = {}) {
    const next = clampNumber(value, MIN_VOLUME_DB, MAX_VOLUME_DB, state.volumeDb);
    state.volumeDb = roundNumber(next, 1);
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
    els.volumeSlider.value = String(dbToVolumeSliderPosition(state.volumeDb));
    els.volumeSlider.setAttribute("aria-valuetext", formatDb(state.volumeDb));
  }

  function updateModePanels() {
    els.pulseSettings.hidden = state.mode !== "pulse";
    els.sweepSettings.hidden = state.mode !== "sweep-up" && state.mode !== "sweep-down";
  }

  function updatePlaybackButtons() {
    els.playButton.disabled = false;
    els.playButton.textContent = state.isPlaying ? "Pause" : "Play";
    els.stopButton.disabled = !state.isPlaying;
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

    mediaSessionSupported = true;

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

  function handleMediaElementPlay() {
    if (mediaHelperEventsMuted || mediaSessionSupported || startInProgress) {
      return;
    }
    if (state.isPlaying) {
      armMediaHelperPauseSoon();
      return;
    }
    startPlayback();
  }

  function handleMediaElementPause() {
    if (mediaHelperEventsMuted || mediaSessionSupported || !mediaHelperPauseArmed || !state.isPlaying) {
      return;
    }

    stopPlayback();
  }

  function handleMediaPlayAction() {
    startPlayback();
  }

  function handleMediaPauseAction() {
    stopPlayback();
  }

  function handleMediaStopAction() {
    stopPlayback();
  }

  async function startMediaControlAudio() {
    if (!els.mediaControlAudio) {
      return;
    }

    if (!els.mediaControlAudio.src) {
      els.mediaControlAudio.src = createSilentWavUrl();
    }

    try {
      disarmMediaHelperPause();
      muteMediaHelperEvents();
      await els.mediaControlAudio.play();
      armMediaHelperPauseSoon();
    } catch {
      // Web Audio still works if the browser refuses the helper element.
    } finally {
      unmuteMediaHelperEventsSoon();
    }
  }

  function pauseMediaControlAudio() {
    if (!els.mediaControlAudio) {
      return;
    }

    try {
      disarmMediaHelperPause();
      muteMediaHelperEvents();
      els.mediaControlAudio.pause();
      els.mediaControlAudio.currentTime = 0;
    } catch {
      // The helper element is only for media-key routing.
    } finally {
      unmuteMediaHelperEventsSoon();
    }
  }

  function armMediaHelperPauseSoon() {
    disarmMediaHelperPause();
    mediaHelperArmTimer = window.setTimeout(() => {
      mediaHelperPauseArmed = Boolean(state.isPlaying && els.mediaControlAudio && !els.mediaControlAudio.paused);
      mediaHelperArmTimer = null;
    }, MEDIA_HELPER_ARM_MS);
  }

  function disarmMediaHelperPause() {
    mediaHelperPauseArmed = false;
    if (mediaHelperArmTimer !== null) {
      window.clearTimeout(mediaHelperArmTimer);
      mediaHelperArmTimer = null;
    }
  }

  function muteMediaHelperEvents() {
    mediaHelperEventsMuted = true;
    if (mediaHelperEventMuteTimer !== null) {
      window.clearTimeout(mediaHelperEventMuteTimer);
      mediaHelperEventMuteTimer = null;
    }
  }

  function unmuteMediaHelperEventsSoon() {
    if (mediaHelperEventMuteTimer !== null) {
      window.clearTimeout(mediaHelperEventMuteTimer);
    }
    mediaHelperEventMuteTimer = window.setTimeout(() => {
      mediaHelperEventsMuted = false;
      mediaHelperEventMuteTimer = null;
    }, MEDIA_HELPER_EVENT_MUTE_MS);
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
    } catch {
      // Some browsers expose Media Session but not every action.
    }
  }

  function updateMediaSessionState() {
    if (!("mediaSession" in navigator)) {
      return;
    }

    try {
      navigator.mediaSession.playbackState = state.isPlaying ? "playing" : "paused";
    } catch {
      // Playback state is advisory, so failure is not fatal.
    }
  }

  function handleGlobalKeys(event) {
    if (event.defaultPrevented) {
      return;
    }

    if (event.key === "MediaPlayPause") {
      event.preventDefault();
      togglePlayback();
      return;
    } else if (event.key === "MediaPlay") {
      event.preventDefault();
      startPlayback();
      return;
    } else if (event.key === "MediaPause" || event.key === "MediaStop") {
      event.preventDefault();
      stopPlayback();
      return;
    }

    if (event.altKey || event.ctrlKey || event.metaKey || shouldIgnoreShortcutTarget(event.target)) {
      return;
    }

    const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;

    if (key === "k" || key === " ") {
      event.preventDefault();
      togglePlayback();
    } else if (key === "s") {
      event.preventDefault();
      stopPlayback();
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

  function volumeSliderPositionToDb(position) {
    const sliderPosition = clampNumber(position, 0, VOLUME_SLIDER_STEPS, dbToVolumeSliderPosition(state.volumeDb));
    const normalized = sliderPosition / VOLUME_SLIDER_STEPS;
    return roundNumber(MIN_VOLUME_DB + normalized * (MAX_VOLUME_DB - MIN_VOLUME_DB), 1);
  }

  function dbToVolumeSliderPosition(db) {
    const value = clampNumber(db, MIN_VOLUME_DB, MAX_VOLUME_DB, state.volumeDb);
    const normalized = (value - MIN_VOLUME_DB) / (MAX_VOLUME_DB - MIN_VOLUME_DB);
    return Math.round(Math.min(1, Math.max(0, normalized)) * VOLUME_SLIDER_STEPS);
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
