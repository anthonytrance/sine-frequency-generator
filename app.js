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

  const state = {
    frequency: 440,
    volumeDb: -6,
    mode: "continuous",
    pulseOnMs: 200,
    pulseOffMs: 200,
    sweepStart: 20,
    sweepEnd: 20000,
    sweepDuration: 10,
    sweepLoop: false,
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
  let syncingMediaElement = false;

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
    els.volumeShiftButtons = Array.from(document.querySelectorAll("[data-volume-shift]"));
  }

  function bindEvents() {
    els.playButton.addEventListener("click", togglePlayback);
    els.stopButton.addEventListener("click", () => stopPlayback());
    document.addEventListener("keydown", handleGlobalKeys, true);
    setupMediaSession();

    els.frequencyInput.addEventListener("input", () => setFrequency(els.frequencyInput.value, { announce: "frequency" }));
    els.frequencySlider.addEventListener("input", () => setFrequency(sliderPositionToFrequency(els.frequencySlider.value), { announce: "frequency", throttle: true }));
    els.frequencySlider.addEventListener("pointerdown", handleFrequencyPointerDown);
    els.frequencySlider.addEventListener("pointermove", handleFrequencyPointerMove);
    els.frequencySlider.addEventListener("pointerup", handleFrequencyPointerEnd);
    els.frequencySlider.addEventListener("pointercancel", handleFrequencyPointerEnd);
    els.frequencySlider.addEventListener("touchstart", handleFrequencyTouch, { passive: false });
    els.frequencySlider.addEventListener("touchmove", handleFrequencyTouch, { passive: false });

    els.frequencyShiftButtons.forEach((button) => {
      button.addEventListener("click", () => {
        const ratio = Number(button.dataset.frequencyRatio);
        shiftFrequency(ratio, button.textContent.trim());
      });
    });

    els.volumeInput.addEventListener("input", () => setVolumeDb(els.volumeInput.value, { announce: "volume" }));
    els.volumeSlider.addEventListener("input", () => setVolumeDb(volumeSliderPositionToDb(els.volumeSlider.value), { announce: "volume", throttle: true }));
    els.volumeSlider.addEventListener("pointerdown", handleVolumePointerDown);
    els.volumeSlider.addEventListener("pointermove", handleVolumePointerMove);
    els.volumeSlider.addEventListener("pointerup", handleVolumePointerEnd);
    els.volumeSlider.addEventListener("pointercancel", handleVolumePointerEnd);
    els.volumeSlider.addEventListener("touchstart", handleVolumeTouch, { passive: false });
    els.volumeSlider.addEventListener("touchmove", handleVolumeTouch, { passive: false });
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
    try {
      clearError();
      await ensureAudioContext();
      if (state.isPlaying) {
        startCurrentMode();
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
      await startMediaControlAudio();

      state.isPlaying = true;
      updatePlaybackButtons();
      startCurrentMode();
      updateStatus();
      announce("Playing");
    } catch (error) {
      showError(error.message || "Could not start audio.");
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

    if (!oscillator || !gateGain || !audioContext) {
      state.isPlaying = false;
      updatePlaybackButtons();
      updateStatus();
      announce("Stopped");
      pauseMediaControlAudio();
      return;
    }

    const oldOscillator = oscillator;
    const oldGate = gateGain;
    oscillator = null;
    gateGain = null;
    state.isPlaying = false;
    updatePlaybackButtons();

    try {
      if (options.immediate) {
        oldOscillator.stop();
        oldOscillator.disconnect();
        oldGate.disconnect();
      } else {
        const now = audioContext.currentTime;
        oldGate.gain.cancelScheduledValues(now);
        oldGate.gain.setValueAtTime(Math.max(0, oldGate.gain.value), now);
        oldGate.gain.linearRampToValueAtTime(0, now + EDGE_FADE_SECONDS);
        oldOscillator.stop(now + EDGE_FADE_SECONDS + 0.04);
        window.setTimeout(() => {
          oldOscillator.disconnect();
          oldGate.disconnect();
        }, 90);
      }
    } catch {
      // The node may already be stopped if the browser ended it.
    }

    updateStatus();
    announce("Stopped");
    pauseMediaControlAudio();
  }

  async function ensureAudioContext() {
    const ContextClass = window.AudioContext || window.webkitAudioContext;
    if (!ContextClass) {
      throw new Error("This browser does not support Web Audio.");
    }

    if (!audioContext) {
      audioContext = new ContextClass();
      outputGain = audioContext.createGain();
      outputGain.gain.value = dbToGain(state.volumeDb);
      outputGain.connect(audioContext.destination);
    }

    if (audioContext.state === "suspended") {
      await audioContext.resume();
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
    setFrequency(end, { applyToAudio: false, announce: false });
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

  function handleFrequencyPointerDown(event) {
    isFrequencyPointerActive = true;
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
  }

  function handleFrequencyTouch(event) {
    if (!event.touches.length) {
      return;
    }
    event.preventDefault();
    setFrequencyFromClientX(event.touches[0].clientX);
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
  }

  function handleVolumeTouch(event) {
    if (!event.touches.length) {
      return;
    }
    event.preventDefault();
    setVolumeFromClientX(event.touches[0].clientX);
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
      announce(formatDb(state.volumeDb), { throttle: Boolean(options.throttle) });
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
    els.playButton.setAttribute("aria-pressed", state.isPlaying ? "true" : "false");
    els.stopButton.disabled = !state.isPlaying;
    updateMediaSessionState();
  }

  function updateStatus(text) {
    els.status.textContent = text || statusText();
  }

  function announce(text, options = {}) {
    if (!text) {
      return;
    }

    if (options.throttle) {
      pendingLiveText = text;

      const now = Date.now();
      const elapsed = now - lastLiveAt;
      const delay = Math.max(0, 180 - elapsed);

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

  function setLiveText(text) {
    els.liveStatus.textContent = "";
    window.setTimeout(() => {
      els.liveStatus.textContent = text;
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

    if ("MediaMetadata" in window) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: "Sine Frequency Generator",
        artist: "Browser tone generator"
      });
    }

    setMediaSessionHandler("play", startPlayback);
    setMediaSessionHandler("pause", () => stopPlayback());
    setMediaSessionHandler("stop", () => stopPlayback());
    updateMediaSessionState();
  }

  function handleMediaElementPlay() {
    if (syncingMediaElement || state.isPlaying) {
      return;
    }
    startPlayback();
  }

  function handleMediaElementPause() {
    if (syncingMediaElement || !state.isPlaying) {
      return;
    }
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
      syncingMediaElement = true;
      await els.mediaControlAudio.play();
    } catch {
      // Web Audio still works if the browser refuses the helper element.
    } finally {
      syncingMediaElement = false;
    }
  }

  function pauseMediaControlAudio() {
    if (!els.mediaControlAudio) {
      return;
    }

    try {
      syncingMediaElement = true;
      els.mediaControlAudio.pause();
      els.mediaControlAudio.currentTime = 0;
    } catch {
      // The helper element is only for media-key routing.
    } finally {
      syncingMediaElement = false;
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
    } else if (event.key === "MediaPlay") {
      event.preventDefault();
      startPlayback();
    } else if (event.key === "MediaPause" || event.key === "MediaStop") {
      event.preventDefault();
      stopPlayback();
    }
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
