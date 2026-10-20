# Sine Frequency Generator

Static web app for generating sine wave test tones in a browser.

Live app:

https://anthonytrance.github.io/sine-frequency-generator/

## Features

- Frequency input from 0 to 22000 Hz.
- Default frequency of 1000 Hz when no saved frequency is available.
- Frequency, mode, volume, pulse timings, and sweep settings are saved locally as they change. Reopening the app restores them with playback stopped.
- Frequency slider for rough changes.
- Play and stop buttons.
- Continuous tone mode.
- Pulse mode, defaulting to 230 ms on and 230 ms off.
- Pulse edges use a short fade to reduce clicking.
- Octave, chromatic, and major-scale frequency step buttons.
- Volume control in dB from -80 dB to 0 dB, defaulting to -6 dB.
- Native volume slider with 1 dB steps, including screen reader adjustments.
- Volume step buttons for 1 dB and 6 dB changes.
- Sweep up and sweep down modes with configurable start, end, length, and repeat.
- Screen-reader-friendly labels, fieldsets, native controls, and live status.
- Best-effort support for VoiceOver Magic Tap and media play/pause actions through the Media Session API. Browsers with the Audio Session API use playback audio directly, without a second silent player. Older browsers retain the silent media-control helper.
- Temporary Web Audio interruptions retain the playback request and attempt to resume. Pause and Stop cancel pending starts and recovery.
- An interruption reported by the Audio Session API or Web Audio is distinguished from a media pause command. The audio context is reused across Play/Pause unless it is closed or cannot resume.
- Collapsed keyboard shortcut reference in the app.

## Local use

Open `index.html` in a browser. On iOS, audio must be started by pressing Play, because Safari requires a user action before Web Audio can make sound.

## GitHub Pages

This is a static app. To publish it:

1. Create a GitHub repository.
2. Put these files in the repository root or in the GitHub Pages source folder.
3. Enable GitHub Pages for that branch and folder.
4. Visit the Pages URL GitHub gives you.

No server or build step is required.

## Regression checks

With Python, Playwright, and its Chromium browser installed:

```sh
python tests/test_browser_regressions.py
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium executable.
Set `PLAYWRIGHT_BROWSER=webkit` to run the same checks with Playwright WebKit.
Browser builds without Web Audio report the audio checks as skipped.
These checks exercise native volume adjustments, playback interruptions,
delayed helper events, cancellation, and media commands. Physical iPhone and
VoiceOver testing is still needed to confirm the device-specific behavior.
