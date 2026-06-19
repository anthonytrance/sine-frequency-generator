# Sine Frequency Generator

Accessible static web app for generating sine wave test tones in a browser.

Live app:

https://anthonytrance.github.io/sine-frequency-generator/

## Features

- Frequency input from 0 to 22000 Hz.
- Frequency slider for rough changes.
- Play and stop buttons.
- Continuous tone mode.
- Pulse mode, defaulting to 200 ms on and 200 ms off.
- Pulse edges use a short fade to reduce clicking.
- Octave, chromatic, and eighth-octave frequency step buttons.
- Volume control in dB from -80 dB to 0 dB.
- Volume step buttons for 1 dB and 6 dB changes.
- Sweep up and sweep down modes with configurable start, end, length, and repeat.
- Screen-reader-friendly labels, fieldsets, native controls, and live status.
- Best-effort support for VoiceOver Magic Tap and media play/pause actions through browser media controls.

## Local use

Open `index.html` in a browser. On iOS, audio must be started by pressing Play, because Safari requires a user action before Web Audio can make sound.

## GitHub Pages

This is a static app. To publish it:

1. Create a GitHub repository.
2. Put these files in the repository root or in the GitHub Pages source folder.
3. Enable GitHub Pages for that branch and folder.
4. Visit the Pages URL GitHub gives you.

No server or build step is required.
