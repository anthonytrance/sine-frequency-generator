"""Browser regressions. Requires Python and Playwright with a browser installed."""

import os
from pathlib import Path
import unittest

from playwright.sync_api import expect, sync_playwright


APP_URL = Path(__file__).resolve().parents[1].joinpath("index.html").as_uri()
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
        self.page.set_default_timeout(5000)
        self.errors = []
        self.page.on("pageerror", lambda error: self.errors.append(str(error)))
        self.page.add_init_script(OBSERVE_AUDIO)

    def tearDown(self):
        self.context.close()
        self.assertEqual(self.errors, [])

    def open_app(self, init_script=None):
        if init_script:
            self.page.add_init_script(init_script)
        self.page.goto(APP_URL)

    def play(self):
        if not self.page.evaluate("Boolean(window.AudioContext || window.webkitAudioContext)"):
            self.skipTest("This Playwright browser build does not expose Web Audio")
        self.page.locator("#playButton").click()
        expect(self.page.locator("#playButton")).to_have_text("Pause")

    def volume(self):
        return float(self.page.locator("#volumeInput").input_value())

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

    def test_delayed_helper_pause_does_not_stop_the_tone(self):
        self.open_app("delete Navigator.prototype.mediaSession;")
        self.play()
        self.page.wait_for_timeout(3300)
        self.page.locator("#mediaControlAudio").evaluate("audio => audio.pause()")
        self.page.wait_for_timeout(400)
        expect(self.page.locator("#playButton")).to_have_text("Pause")
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
        expect(self.page.locator("#playButton")).to_have_text("Pause")
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
        self.page.locator("#playButton").click()
        self.page.evaluate("window.testEndInterruption?.()")
        self.page.wait_for_timeout(400)
        expect(self.page.locator("#playButton")).to_have_text("Play")
        expect(self.page.locator("#status")).to_contain_text("Stopped")
        self.assertLess(self.signal_rms(), 0.001)

    def test_media_pause_cancels_an_unfinished_start(self):
        self.open_app("window.testDelayStart = true;")
        self.play()
        self.page.wait_for_function("Boolean(window.testReleaseStart)")
        self.page.evaluate("window.testMediaActions.pause()")
        self.page.evaluate("window.testReleaseStart()")
        self.page.wait_for_timeout(400)
        expect(self.page.locator("#playButton")).to_have_text("Play")
        expect(self.page.locator("#status")).to_contain_text("Stopped")

    def test_explicit_media_play_pause_and_stop_still_work(self):
        self.open_app()
        self.play()
        self.page.evaluate("window.testMediaActions.pause()")
        expect(self.page.locator("#playButton")).to_have_text("Play")
        self.page.evaluate("window.testMediaActions.play()")
        expect(self.page.locator("#playButton")).to_have_text("Pause")
        self.page.evaluate("window.testMediaActions.stop()")
        expect(self.page.locator("#playButton")).to_have_text("Play")

    def test_pause_button_cancels_an_unfinished_start(self):
        self.open_app("window.testDelayStart = true;")
        self.play()
        self.page.wait_for_function("Boolean(window.testReleaseStart)")
        expect(self.page.locator("#playButton")).to_have_text("Pause")
        expect(self.page.locator("#stopButton")).to_be_enabled()
        self.page.locator("#playButton").click()
        self.page.evaluate("window.testReleaseStart()")
        self.page.wait_for_timeout(200)
        expect(self.page.locator("#playButton")).to_have_text("Play")

    def test_cancelled_start_cannot_disrupt_a_new_play_request(self):
        self.open_app("window.testDelayStart = true;")
        self.play()
        self.page.wait_for_function("Boolean(window.testReleaseStart)")
        self.page.locator("#stopButton").click()
        self.page.evaluate("window.testDelayStart = false")
        self.play()
        self.page.evaluate("window.testReleaseStart()")
        self.page.wait_for_timeout(200)
        expect(self.page.locator("#playButton")).to_have_text("Pause")
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
            expect(self.page.locator("#playButton")).to_have_text("Pause")
        self.page.locator("#stopButton").click()
        expect(self.page.locator("#playButton")).to_have_text("Play")


if __name__ == "__main__":
    unittest.main(verbosity=2)
