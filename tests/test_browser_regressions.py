"""Browser regressions. Requires Python and Playwright with a browser installed."""

import os
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright


APP_URL = Path(__file__).resolve().parents[1].joinpath("index.html").as_uri()
SETTINGS_KEY = "sine-frequency-generator.settings.v1"
PLAYBACK_LOG_KEY = "sine-frequency-generator.playback-log.v1"
NATIVE_AUDIO_SESSION = """
window.testAudioSession = new EventTarget();
window.testAudioSession.type = 'auto';
window.testAudioSession.state = 'active';
Object.defineProperty(navigator, 'audioSession', { value: window.testAudioSession });
"""
OBSERVE_AUDIO = """
window.testAudioContexts = [];
window.testMediaActions = {};
const NativeAudioContext = window.AudioContext || window.webkitAudioContext;
if (NativeAudioContext) {
window.AudioContext = class extends NativeAudioContext {
  constructor(...args) {
    super(...args);
    this.testGains = [];
    // Inspect the generated signal upstream of a muted output, without playing
    // test tones through the computer's speakers.
    const silentOutput = super.createGain();
    silentOutput.gain.value = 0;
    silentOutput.connect(this.destination);
    Object.defineProperty(this, 'destination', { value: silentOutput });
    window.testAudioContexts.push(this);
    if (window.testDelayStart) {
      Object.defineProperty(this, 'state', {
        configurable: true,
        get: () => 'suspended'
      });
      this.resume = () => new Promise(resolve => {
        window.testReleaseStart = () => {
          delete this.state;
          resolve();
        };
      });
    }
  }
  createGain() {
    const gain = super.createGain();
    this.testGains.push(gain);
    return gain;
  }
};
}
if ('mediaSession' in navigator) {
  const setActionHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
  navigator.mediaSession.setActionHandler = (action, handler) => {
    window.testMediaActions[action] = handler;
    setActionHandler(action, handler);
  };
}
"""


class BrowserRegressions(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.playwright = sync_playwright().start()
        engine = os.environ.get("PLAYWRIGHT_BROWSER", "chromium")
        launch = {"headless": True}
        if engine == "chromium":
            launch["args"] = ["--mute-audio"]
            if executable := os.environ.get("PLAYWRIGHT_CHROMIUM_EXECUTABLE"):
                launch["executable_path"] = executable
        cls.browser = getattr(cls.playwright, engine).launch(**launch)

    @classmethod
    def tearDownClass(cls):
        cls.browser.close()
        cls.playwright.stop()

    def setUp(self):
        self.context = self.browser.new_context(viewport={"width": 390, "height": 844})
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.context.add_init_script(OBSERVE_AUDIO)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def open_app(self, init_script=None):
        if init_script:
            self.page.add_init_script(init_script)
        self.page.goto(APP_URL)

    def play(self, wait_for_audio=True):
        if not self.page.evaluate("Boolean(window.AudioContext || window.webkitAudioContext)"):
            self.skipTest("This Playwright browser build does not expose Web Audio")
        self.page.locator("#playButton").click()
        expect(self.page.locator("#pauseButton")).to_be_enabled()
        if wait_for_audio:
            expect(self.page.locator("#status")).to_contain_text("Playing")

    def volume(self):
        return float(self.page.locator("#volumeInput").input_value())

    def reopen_app(self):
        self.page.close()
        self.page = self.context.new_page()
        self.page.set_default_timeout(10000)
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.goto(APP_URL)

    def signal_rms(self):
        return self.page.evaluate("""async () => {
          const context = window.testAudioContexts.at(-1);
          const gain = context.testGains[0];
          const analyser = context.createAnalyser();
          gain.connect(analyser);
          await new Promise(resolve => setTimeout(resolve, 150));
          const samples = new Float32Array(analyser.fftSize);
          analyser.getFloatTimeDomainData(samples);
          gain.disconnect(analyser);
          return Math.sqrt(samples.reduce((sum, value) => sum + value * value, 0) / samples.length);
        }""")

    def test_volume_moves_one_db_in_both_directions_without_getting_stuck(self):
        self.open_app()
        slider = self.page.locator("#volumeSlider")
        for expected_db in range(-7, -21, -1):
            slider.press("ArrowDown")
            self.assertEqual(self.volume(), expected_db)
            expect(slider).to_have_attribute("aria-valuetext", f"{expected_db} dB")
        for expected_db in range(-19, -5):
            slider.press("ArrowUp")
            self.assertEqual(self.volume(), expected_db)

    def test_native_accessibility_steps_and_volume_limits(self):
        self.open_app()
        slider = self.page.locator("#volumeSlider")
        self.assertEqual(slider.get_attribute("min"), "-80")
        self.assertEqual(slider.get_attribute("max"), "0")
        self.assertEqual(slider.get_attribute("step"), "1")
        for method, expected_db in (("stepDown", -7), ("stepUp", -6)):
            slider.evaluate("(slider, method) => { slider[method](); slider.dispatchEvent(new Event('input', { bubbles: true })); }", method)
            self.assertEqual(self.volume(), expected_db)
        slider.press("Home")
        self.assertEqual(self.volume(), -80)
        slider.press("ArrowDown")
        self.assertEqual(self.volume(), -80)
        slider.press("End")
        self.assertEqual(self.volume(), 0)
        slider.press("ArrowUp")
        self.assertEqual(self.volume(), 0)

    def test_fractional_numeric_volume_still_adjusts_by_at_least_one_db(self):
        self.open_app()
        number = self.page.locator("#volumeInput")
        slider = self.page.locator("#volumeSlider")
        for key in ("ArrowDown", "ArrowUp"):
            number.fill("-6.5")
            slider.press(key)
            delta = self.volume() - -6.5
            self.assertGreaterEqual(abs(delta), 1)
            self.assertEqual(delta > 0, key == "ArrowUp")

    def test_volume_pointer_drag_still_works(self):
        self.open_app()
        slider = self.page.locator("#volumeSlider")
        slider.scroll_into_view_if_needed()
        box = slider.bounding_box()
        self.page.mouse.click(box["x"] + box["width"] * 0.25, box["y"] + box["height"] / 2)
        quiet = self.volume()
        self.page.mouse.click(box["x"] + box["width"] * 0.75, box["y"] + box["height"] / 2)
        self.assertGreater(self.volume(), quiet + 20)

    def test_repeated_play_activations_do_not_stop_the_tone(self):
        self.open_app()
        self.play()
        play = self.page.get_by_role("button", name="Play", exact=True)
        self.page.wait_for_timeout(350)
        play.click()
        play.dblclick(delay=100)
        # Assistive technology can activate without a pointer click count.
        play.evaluate("button => button.click()")
        play.press("Enter")
        play.press("Space")
        self.page.wait_for_timeout(400)
        expect(play).to_have_text("Play")
        expect(play).to_be_focused()
        expect(self.page.locator("#pauseButton")).to_be_enabled()
        expect(self.page.locator("#status")).to_contain_text("Playing")
        self.assertGreater(self.signal_rms(), 0.1)
        self.assertEqual(self.page.evaluate("window.testAudioContexts.length"), 1)
        events = self.page.evaluate("key => JSON.parse(localStorage.getItem(key))", PLAYBACK_LOG_KEY)
        self.assertFalse(any(event["event"] == "stop" for event in events))

    def test_repeated_play_during_an_unfinished_start_keeps_the_request(self):
        self.open_app("window.testDelayStart = true;")
        self.play(wait_for_audio=False)
        self.page.wait_for_function("Boolean(window.testReleaseStart)")
        self.page.locator("#playButton").click()
        expect(self.page.locator("#pauseButton")).to_be_enabled()
        self.page.evaluate("window.testReleaseStart()")
        expect(self.page.locator("#status")).to_contain_text("Playing")
        self.assertGreater(self.signal_rms(), 0.1)
        self.assertEqual(self.page.evaluate("window.testAudioContexts.length"), 1)

    def test_delayed_helper_pause_does_not_stop_the_tone(self):
        self.open_app("delete Navigator.prototype.mediaSession;")
        self.play()
        self.page.wait_for_timeout(3300)
        self.page.locator("#mediaControlAudio").evaluate("audio => audio.pause()")
        self.page.wait_for_timeout(400)
        expect(self.page.locator("#pauseButton")).to_be_enabled()
        expect(self.page.locator("#status")).to_contain_text("Playing")

    def test_audio_interruption_recovers_instead_of_becoming_a_stop(self):
        self.open_app()
        self.play()
        self.page.evaluate("""async () => {
          const context = window.testAudioContexts.at(-1);
          const resume = context.resume.bind(context);
          context.resume = () => new Promise(resolve => {
            window.testEndInterruption = () => resume().then(resolve);
          });
          await context.suspend();
        }""")
        self.page.wait_for_timeout(700)
        expect(self.page.locator("#pauseButton")).to_be_enabled()
        self.page.evaluate("window.testEndInterruption()")
        self.page.wait_for_function("window.testAudioContexts.at(-1).state === 'running'")
        expect(self.page.locator("#status")).to_contain_text("Playing")
        self.assertGreater(self.signal_rms(), 0.1)

    def test_explicit_pause_during_interruption_stays_stopped(self):
        self.open_app()
        self.play()
        self.page.evaluate("""async () => {
          const context = window.testAudioContexts.at(-1);
          const resume = context.resume.bind(context);
          context.resume = () => new Promise(resolve => {
            window.testEndInterruption = () => resume().then(resolve);
          });
          await context.suspend();
        }""")
        self.page.wait_for_timeout(100)
        self.page.locator("#pauseButton").click()
        self.page.evaluate("window.testEndInterruption?.()")
        self.page.wait_for_timeout(400)
        expect(self.page.locator("#pauseButton")).to_be_disabled()
        expect(self.page.locator("#status")).to_contain_text("Stopped")
        self.assertLess(self.signal_rms(), 0.001)

    def test_media_pause_cancels_an_unfinished_start(self):
        self.open_app("window.testDelayStart = true;")
        self.play(wait_for_audio=False)
        self.page.wait_for_function("Boolean(window.testReleaseStart)")
        self.page.evaluate("window.testMediaActions.pause()")
        self.page.evaluate("window.testReleaseStart()")
        self.page.wait_for_timeout(400)
        expect(self.page.locator("#pauseButton")).to_be_disabled()
        expect(self.page.locator("#status")).to_contain_text("Stopped")

    def test_explicit_media_play_pause_and_stop_still_work(self):
        self.open_app()
        self.play()
        self.page.evaluate("window.testMediaActions.pause()")
        expect(self.page.locator("#pauseButton")).to_be_disabled()
        self.page.evaluate("window.testMediaActions.play()")
        expect(self.page.locator("#status")).to_contain_text("Playing")
        self.page.evaluate("window.testMediaActions.stop()")
        expect(self.page.locator("#pauseButton")).to_be_disabled()
        expect(self.page.locator("#status")).to_contain_text("Stopped")

    def test_keyboard_toggle_still_works_outside_the_buttons(self):
        self.open_app()
        self.play()
        self.page.evaluate("document.activeElement.blur()")
        self.page.keyboard.press("k")
        expect(self.page.locator("#status")).to_contain_text("Stopped")
        self.page.keyboard.press("Space")
        expect(self.page.locator("#status")).to_contain_text("Playing")
        self.assertGreater(self.signal_rms(), 0.1)

    def test_pause_button_cancels_an_unfinished_start(self):
        self.open_app("window.testDelayStart = true;")
        self.play(wait_for_audio=False)
        self.page.wait_for_function("Boolean(window.testReleaseStart)")
        expect(self.page.locator("#pauseButton")).to_be_enabled()
        expect(self.page.locator("#stopButton")).to_be_enabled()
        self.page.locator("#pauseButton").click()
        self.page.evaluate("window.testReleaseStart()")
        self.page.wait_for_timeout(200)
        expect(self.page.locator("#pauseButton")).to_be_disabled()
        expect(self.page.locator("#status")).to_contain_text("Stopped")

    def test_cancelled_start_cannot_disrupt_a_new_play_request(self):
        self.open_app("window.testDelayStart = true;")
        self.play(wait_for_audio=False)
        self.page.wait_for_function("Boolean(window.testReleaseStart)")
        self.page.locator("#stopButton").click()
        self.page.evaluate("window.testDelayStart = false")
        self.play()
        self.page.evaluate("window.testReleaseStart()")
        self.page.wait_for_timeout(200)
        expect(self.page.locator("#status")).to_contain_text("Playing")
        self.assertGreater(self.signal_rms(), 0.1)

    def test_volume_changes_the_actual_tone_level(self):
        self.open_app()
        self.play()
        before = self.signal_rms()
        self.page.locator("#volumeSlider").press("ArrowDown")
        after = self.signal_rms()
        self.assertAlmostEqual(after / before, 10 ** (-1 / 20), delta=0.03)

    def test_continuous_pulse_and_sweep_modes_keep_playing(self):
        self.open_app()
        self.play()
        for mode in ("pulse", "sweep-up", "sweep-down", "continuous"):
            self.page.locator(f"input[name=mode][value='{mode}']").check()
            self.page.wait_for_timeout(200)
            expect(self.page.locator("#pauseButton")).to_be_enabled()
        self.page.locator("#stopButton").click()
        expect(self.page.locator("#pauseButton")).to_be_disabled()

    def test_fresh_settings_default_to_1000_hz(self):
        self.open_app()
        expect(self.page.locator("#frequencyInput")).to_have_value("1000")
        expect(self.page.locator("#frequencySlider")).to_have_attribute("aria-valuetext", "1000 Hz")
        expect(self.page.locator("#status")).to_contain_text("1000 Hz")
        expect(self.page.locator("#playButton")).to_have_text("Play")
        expect(self.page.locator("#pauseButton")).to_be_disabled()

    def test_frequency_mode_and_pulse_settings_survive_closing_the_app(self):
        self.open_app()
        self.page.locator("#frequencyInput").fill("1750.25")
        self.page.locator("#volumeInput").fill("-18")
        self.page.locator("input[name=mode][value=pulse]").check()
        self.page.locator("#pulseOnInput").fill("315")
        self.page.locator("#pulseOffInput").fill("420")
        self.page.locator("#pulseOffInput").blur()
        self.reopen_app()
        expect(self.page.locator("#frequencyInput")).to_have_value("1750.25")
        expect(self.page.locator("#volumeInput")).to_have_value("-18")
        expect(self.page.locator("input[name=mode][value=pulse]")).to_be_checked()
        expect(self.page.locator("#pulseSettings")).to_be_visible()
        expect(self.page.locator("#pulseOnInput")).to_have_value("315")
        expect(self.page.locator("#pulseOffInput")).to_have_value("420")
        expect(self.page.locator("#status")).to_contain_text("Stopped")

    def test_zero_values_and_sweep_settings_survive_reload(self):
        self.open_app()
        self.page.locator("#frequencyInput").fill("0")
        self.page.locator("#volumeInput").fill("0")
        self.page.locator("input[name=mode][value=sweep-down]").check()
        for selector, value in (("#sweepStartInput", "0"), ("#sweepEndInput", "3000"), ("#sweepDurationInput", "0.5")):
            self.page.locator(selector).fill(value)
            self.page.locator(selector).blur()
        self.page.locator("#sweepLoopInput").check()
        self.page.reload()
        expect(self.page.locator("#frequencyInput")).to_have_value("0")
        expect(self.page.locator("#volumeInput")).to_have_value("0")
        expect(self.page.locator("input[name=mode][value=sweep-down]")).to_be_checked()
        expect(self.page.locator("#sweepSettings")).to_be_visible()
        expect(self.page.locator("#sweepStartInput")).to_have_value("0")
        expect(self.page.locator("#sweepEndInput")).to_have_value("3000")
        expect(self.page.locator("#sweepDurationInput")).to_have_value("0.5")
        expect(self.page.locator("#sweepLoopInput")).to_be_checked()

    def test_reopening_a_previously_playing_app_never_autoplays(self):
        self.open_app()
        self.page.locator("#frequencyInput").fill("1234")
        self.play()
        self.reopen_app()
        expect(self.page.locator("#frequencyInput")).to_have_value("1234")
        expect(self.page.locator("#status")).to_contain_text("Stopped")
        expect(self.page.locator("#playButton")).to_have_text("Play")
        expect(self.page.locator("#pauseButton")).to_be_disabled()
        self.assertEqual(self.page.evaluate("window.testAudioContexts.length"), 0)
        expect(self.page.locator("#stopButton")).to_be_disabled()

    def test_invalid_stored_settings_fall_back_to_defaults(self):
        self.open_app()
        for saved in ("not json", "[]", '{"frequency":"bad","mode":"unknown","volumeDb":100,"isPlaying":true}'):
            with self.subTest(saved=saved):
                self.page.evaluate("([key, value]) => localStorage.setItem(key, value)", [SETTINGS_KEY, saved])
                self.page.reload()
                expect(self.page.locator("#frequencyInput")).to_have_value("1000")
                expect(self.page.locator("#volumeInput")).to_have_value("-6")
                expect(self.page.locator("input[name=mode][value=continuous]")).to_be_checked()
                self.assertEqual(self.page.evaluate("window.testAudioContexts.length"), 0)

    def test_unavailable_storage_does_not_break_the_controls(self):
        self.open_app("""
          Storage.prototype.getItem = () => { throw new DOMException('Blocked', 'SecurityError'); };
          Storage.prototype.setItem = () => { throw new DOMException('Full', 'QuotaExceededError'); };
        """)
        expect(self.page.locator("#frequencyInput")).to_have_value("1000")
        self.page.locator("#frequencyInput").fill("2500")
        self.page.locator("input[name=mode][value=pulse]").check()
        self.page.locator("#volumeSlider").press("ArrowDown")
        expect(self.page.locator("#status")).to_contain_text("2500 Hz")
        self.assertEqual(self.volume(), -7)

    def test_native_audio_session_keeps_remote_play_pause_connected(self):
        self.open_app(NATIVE_AUDIO_SESSION)
        self.play()
        self.page.wait_for_function("!document.getElementById('mediaControlAudio').paused")
        self.assertEqual(self.page.evaluate("window.testAudioSession.type"), "playback")
        # WebKit maps a remote toggle to Play or Pause using its media
        # element's state. Exercise that route while inspecting the real tone.
        for _ in range(2):
            self.page.evaluate("""() => {
              const audio = document.getElementById('mediaControlAudio');
              window.testMediaActions[audio.paused ? 'play' : 'pause']();
            }""")
            expect(self.page.locator("#status")).to_contain_text("Stopped")
            self.assertTrue(self.page.locator("#mediaControlAudio").evaluate("audio => audio.paused"))
            self.assertEqual(self.page.evaluate("navigator.mediaSession.playbackState"), "paused")
            self.assertLess(self.signal_rms(), 0.001)
            self.page.wait_for_timeout(300)
            expect(self.page.locator("#status")).to_contain_text("Stopped")
            self.page.evaluate("""() => {
              const audio = document.getElementById('mediaControlAudio');
              window.testMediaActions[audio.paused ? 'play' : 'pause']();
            }""")
            expect(self.page.locator("#status")).to_contain_text("Playing")
            self.page.wait_for_function("!document.getElementById('mediaControlAudio').paused")
            self.assertEqual(self.page.evaluate("navigator.mediaSession.playbackState"), "playing")
            self.assertGreater(self.signal_rms(), 0.1)
        self.assertEqual(self.page.evaluate("window.testAudioContexts.length"), 1)

    def test_media_controls_are_primed_before_web_audio_finishes_starting(self):
        self.open_app(NATIVE_AUDIO_SESSION + "window.testDelayStart = true;")
        self.play(wait_for_audio=False)
        self.page.wait_for_function("Boolean(window.testReleaseStart)")
        self.page.wait_for_function("!document.getElementById('mediaControlAudio').paused")
        self.page.evaluate("window.testMediaActions.pause()")
        self.page.evaluate("window.testReleaseStart()")
        self.page.wait_for_timeout(300)
        expect(self.page.locator("#status")).to_contain_text("Stopped")
        self.assertTrue(self.page.locator("#mediaControlAudio").evaluate("audio => audio.paused"))
        expect(self.page.locator("#pauseButton")).to_be_disabled()

    def test_refused_media_control_audio_does_not_break_the_tone(self):
        self.open_app(NATIVE_AUDIO_SESSION + """
          HTMLMediaElement.prototype.play = function () {
            return Promise.reject(new DOMException('Denied', 'NotAllowedError'));
          };
        """)
        self.play()
        self.assertGreater(self.signal_rms(), 0.1)
        events = self.page.evaluate("key => JSON.parse(localStorage.getItem(key))", PLAYBACK_LOG_KEY)
        self.assertTrue(any(event["event"] == "helper-play-refused" for event in events))

    def test_media_pause_while_priming_cancels_start_before_creating_audio(self):
        self.open_app(NATIVE_AUDIO_SESSION + """
          HTMLMediaElement.prototype.play = function () {
            window.testMediaActions.pause();
            return Promise.resolve();
          };
        """)
        if not self.page.evaluate("Boolean(window.AudioContext || window.webkitAudioContext)"):
            self.skipTest("This Playwright browser build does not expose Web Audio")
        self.page.locator("#playButton").click()
        expect(self.page.locator("#status")).to_contain_text("Stopped")
        expect(self.page.locator("#pauseButton")).to_be_disabled()
        self.assertEqual(self.page.evaluate("window.testAudioContexts.length"), 0)

    def test_play_pause_reuses_the_audio_context(self):
        self.open_app()
        for _ in range(3):
            self.play()
            self.assertGreater(self.signal_rms(), 0.1)
            self.page.locator("#pauseButton").click()
            expect(self.page.locator("#pauseButton")).to_be_disabled()
            expect(self.page.locator("#status")).to_contain_text("Stopped")
        self.assertEqual(self.page.evaluate("window.testAudioContexts.length"), 1)

    def test_system_pause_action_recovers_after_audio_session_interruption(self):
        self.open_app(NATIVE_AUDIO_SESSION)
        self.play()
        self.page.evaluate("""async () => {
          window.testAudioSession.state = 'interrupted';
          window.testAudioSession.dispatchEvent(new Event('statechange'));
          await window.testAudioContexts.at(-1).suspend();
          window.testMediaActions.pause();
        }""")
        expect(self.page.locator("#pauseButton")).to_be_enabled()
        expect(self.page.locator("#status")).to_contain_text("interrupted")
        self.page.evaluate("""() => {
          window.testAudioSession.state = 'active';
          window.testAudioSession.dispatchEvent(new Event('statechange'));
        }""")
        self.page.wait_for_function("window.testAudioContexts.at(-1).state === 'running'")
        expect(self.page.locator("#status")).to_contain_text("Playing")
        self.assertGreater(self.signal_rms(), 0.1)

    def test_manual_stop_during_system_interruption_is_not_undone(self):
        self.open_app(NATIVE_AUDIO_SESSION)
        self.play()
        self.page.evaluate("""async () => {
          window.testAudioSession.state = 'interrupted';
          await window.testAudioContexts.at(-1).suspend();
          window.testMediaActions.pause();
        }""")
        self.page.locator("#stopButton").click()
        self.page.evaluate("""() => {
          window.testAudioSession.state = 'active';
          window.testAudioSession.dispatchEvent(new Event('statechange'));
        }""")
        expect(self.page.locator("#pauseButton")).to_be_disabled()
        expect(self.page.locator("#status")).to_contain_text("Stopped")
        self.assertLess(self.signal_rms(), 0.001)

    def test_playback_report_identifies_a_media_pause_and_copies_in_one_message(self):
        self.open_app("""
          document.execCommand = () => false;
          Object.defineProperty(navigator, 'clipboard', { value: {
            writeText: async text => { window.testCopiedReport = text; }
          }});
        """)
        self.play()
        self.page.evaluate("window.testMediaActions.pause()")
        self.page.get_by_text("Playback troubleshooting", exact=True).click()
        expect(self.page.locator("#lastPlaybackStop")).to_contain_text("iPhone/browser media Pause command")
        self.page.get_by_role("button", name="Copy playback report", exact=True).click()
        self.page.wait_for_function("Boolean(window.testCopiedReport)")
        report = self.page.evaluate("window.testCopiedReport")
        self.assertIn("Sine Frequency Generator 2026-10-20.5", report)
        self.assertIn("media-session-pause", report)
        self.assertIn("iPhone/browser media Pause command", report)
        self.assertLessEqual(len(report), 3800)
        expect(self.page.locator("#playbackReportStatus")).to_contain_text("copied")

    def test_playback_report_retains_the_last_stop_after_reopening(self):
        self.open_app()
        self.play()
        self.page.locator("#stopButton").click()
        self.reopen_app()
        self.page.get_by_text("Playback troubleshooting", exact=True).click()
        expect(self.page.locator("#lastPlaybackStop")).to_contain_text("Stop button")
        events = self.page.evaluate("key => JSON.parse(localStorage.getItem(key))", PLAYBACK_LOG_KEY)
        self.assertTrue(any(event["event"] == "stop" and event["source"] == "Stop button" for event in events))

    def test_copy_report_has_an_accessible_fallback_if_clipboard_is_denied(self):
        self.open_app("""
          document.execCommand = () => false;
          Object.defineProperty(navigator, 'clipboard', { value: {
            writeText: async () => { throw new DOMException('Denied', 'NotAllowedError'); }
          }});
        """)
        self.page.get_by_text("Playback troubleshooting", exact=True).click()
        self.page.get_by_role("button", name="Copy playback report", exact=True).click()
        report = self.page.get_by_role("textbox", name="Playback report", exact=True)
        expect(report).to_be_visible()
        expect(report).to_be_focused()
        self.assertIn("Sine Frequency Generator", report.input_value())
        self.assertEqual(report.evaluate("element => element.selectionEnd - element.selectionStart"), len(report.input_value()))
        expect(self.page.locator("#playbackReportStatus")).to_contain_text("Automatic copying was unavailable")

    def test_copy_report_uses_selected_text_if_the_clipboard_api_is_unavailable(self):
        self.open_app("""
          document.execCommand = command => {
            window.testCopyCommand = command;
            window.testCopiedReport = document.getElementById('playbackReport').value;
            return true;
          };
          Object.defineProperty(navigator, 'clipboard', { value: undefined });
        """)
        self.page.get_by_text("Playback troubleshooting", exact=True).click()
        copy = self.page.get_by_role("button", name="Copy playback report", exact=True)
        copy.click()
        self.assertEqual(self.page.evaluate("window.testCopyCommand"), "copy")
        self.assertIn("Sine Frequency Generator 2026-10-20.5", self.page.evaluate("window.testCopiedReport"))
        expect(self.page.locator("#playbackReportStatus")).to_contain_text("report copied")
        expect(copy).to_be_focused()

    def test_copy_report_stays_available_when_the_clipboard_request_never_finishes(self):
        self.open_app("""
          document.execCommand = () => false;
          Object.defineProperty(navigator, 'clipboard', { value: {
            writeText: () => new Promise(() => {})
          }});
        """)
        self.page.get_by_text("Playback troubleshooting", exact=True).click()
        self.page.get_by_role("button", name="Copy playback report", exact=True).click()
        report = self.page.get_by_role("textbox", name="Playback report", exact=True)
        expect(report).to_be_visible()
        expect(report).to_be_focused()
        self.assertEqual(report.evaluate("element => element.selectionEnd - element.selectionStart"), len(report.input_value()))
        expect(self.page.locator("#playbackReportStatus")).to_contain_text("Automatic copying was unavailable")

    def test_diagnostic_history_is_bounded(self):
        self.open_app()
        self.page.evaluate("""() => {
          for (let index = 0; index < 60; index++) {
            document.dispatchEvent(new Event('visibilitychange'));
          }
        }""")
        events = self.page.evaluate("key => JSON.parse(localStorage.getItem(key))", PLAYBACK_LOG_KEY)
        self.assertLessEqual(len(events), 40)

    def test_synchronous_media_pause_does_not_announce_playing_after_stop(self):
        self.open_app("""
          if ('mediaSession' in navigator) {
          let playbackState = 'none';
          Object.defineProperty(navigator.mediaSession, 'playbackState', {
            get: () => playbackState,
            set: value => {
              playbackState = value;
              if (value === 'playing') window.testMediaActions.pause();
            }
          });
          }
        """)
        if not self.page.evaluate("Boolean(window.AudioContext || window.webkitAudioContext)"):
            self.skipTest("This Playwright browser build does not expose Web Audio")
        self.page.locator("#playButton").click()
        expect(self.page.locator("#playButton")).to_have_text("Play")
        expect(self.page.locator("#pauseButton")).to_be_disabled()
        expect(self.page.locator("#liveStatus")).to_have_text("Stopped")
        events = self.page.evaluate("key => JSON.parse(localStorage.getItem(key))", PLAYBACK_LOG_KEY)
        last_stop = max(index for index, event in enumerate(events) if event["event"] == "stop")
        self.assertFalse(any(event["event"] in ("playing", "helper-play-request") for event in events[last_stop + 1:]))
        self.assertIn("media Pause command", events[last_stop]["source"])

    def test_cached_markup_without_new_controls_does_not_break_playback(self):
        self.open_app("""
          document.addEventListener('DOMContentLoaded', () => {
            document.querySelector('[aria-labelledby=playback-troubleshooting-heading]')?.remove();
            document.getElementById('pauseButton')?.remove();
          });
        """)
        expect(self.page.locator("#frequencyInput")).to_have_value("1000")
        self.play()
        self.assertGreater(self.signal_rms(), 0.1)
        self.page.locator("#pauseButton").click()
        expect(self.page.locator("#status")).to_contain_text("Stopped")


if __name__ == "__main__":
    unittest.main(verbosity=2)
