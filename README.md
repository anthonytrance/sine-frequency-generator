# Sine Frequency Generator

Static web app for generating sine wave test tones in a browser.

Live app:

https://anthonytrance.github.io/sine-frequency-generator/

## Features

- Frequency input from 0 to 22000 Hz.
- Default frequency of 1000 Hz when no saved frequency is available.
- Frequency, mode, volume, pulse timings, and sweep settings are saved locally as they change. Reopening the app restores them with playback stopped.
- Frequency slider for rough changes.
- Separate Play and Stop buttons. Play only starts playback, so repeated accessibility activations cannot toggle it back to stopped. Stop and system Pause commands have the same effect, including restarting a sweep from its beginning on the next Play.
- Continuous tone mode.
- Pulse mode, defaulting to 230 ms on and 230 ms off.
- Pulse edges use a short fade to reduce clicking.
- Octave, chromatic, and major-scale frequency step buttons.
- Volume control in dB from -80 dB to 0 dB, defaulting to -6 dB.
- Native volume slider with 1 dB steps, including screen reader adjustments.
- Volume step buttons for 1 dB and 6 dB changes.
- Sweep up and sweep down modes with configurable start, end, length, and repeat.
- Screen-reader-friendly labels, fieldsets, native controls, and live status.
- Best-effort support for VoiceOver Magic Tap and media play/pause actions through the Media Session API. A silent media element connects system controls to the app's handlers, including on browsers with the Audio Session API. It starts in the activating gesture before Web Audio resumes, and pauses when playback stops. Its raw play/pause events never toggle the tone.
- Temporary Web Audio interruptions retain the playback request and attempt to resume. Stop and system Pause commands cancel pending starts and recovery.
- An interruption reported by the Audio Session API or Web Audio is distinguished from a media pause command. The audio context is reused across Play/Stop unless it is closed or cannot resume.
- Collapsed keyboard shortcut reference in the app.
- Playback troubleshooting includes a local, bounded event report and the exact source of the last stop. Copy uses selection-based copying with a timed Clipboard API fallback, and leaves the report available for manual copying. Nothing is uploaded automatically.

## Local use

Open `index.html` in a browser. On iOS, audio must be started by pressing Play, because Safari requires a user action before Web Audio can make sound.

## GitHub Pages

This is a static app. To publish it:

1. Create a GitHub repository.
2. Put these files in the repository root or in the GitHub Pages source folder.
3. Enable GitHub Pages for that branch and folder.
4. Visit the Pages URL GitHub gives you.

No server or build step is required.

## System media controls

Audio Session selects the playback category, but it does not replace the media
element used for remote controls. WebKit handles commands for a bare
[AudioContext directly](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/Modules/webaudio/AudioContext.cpp),
whereas a [media element dispatches to Media Session handlers](https://github.com/WebKit/WebKit/blob/main/Source/WebCore/html/MediaElementSession.cpp).
Keeping the silent element available lets the app distinguish a system Pause
command from a temporary Web Audio interruption. Its raw playback events only
record diagnostics and cannot stop the tone.

## Regression checks

With Python, Playwright, and its Chromium browser installed:

```sh
python tests/test_browser_regressions.py
```

Set `PLAYWRIGHT_CHROMIUM_EXECUTABLE` to use an existing Chromium executable.
Set `PLAYWRIGHT_BROWSER=webkit` to run the same checks with Playwright WebKit.
Browser builds without Web Audio report the audio checks as skipped.
These checks exercise native volume adjustments, playback interruptions,
delayed helper events, cancellation, and media commands with and without Audio
Session support. System command dispatch is simulated while the real media
element and tone are checked. Physical iPhone and VoiceOver testing is still
needed to confirm the device-specific behavior.
