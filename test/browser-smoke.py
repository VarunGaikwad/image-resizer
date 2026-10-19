"""Exercise the actual UI with Chromium and isolated, temporary server storage."""

import argparse
import base64
from contextlib import contextmanager
from io import BytesIO
import json
from pathlib import Path
import select
import struct
import subprocess
import tempfile
import zipfile
import zlib

from playwright.sync_api import expect, sync_playwright

ROOT = Path(__file__).resolve().parent.parent


def png_image(width=96, height=64):
    def chunk(kind, data):
        return struct.pack(">I", len(data)) + kind + data + struct.pack(">I", zlib.crc32(kind + data))

    pixels = (b"\x00" + b"\x33\x66\x99" * width) * height
    return (b"\x89PNG\r\n\x1a\n"
            + chunk(b"IHDR", struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(pixels)) + chunk(b"IEND", b""))


@contextmanager
def local_server():
    with tempfile.TemporaryDirectory(prefix="image-resizer-browser-") as storage:
        script = """
          const { createApp } = require('./server');
          const app = createApp({ storageRoot: process.argv[1], logger: () => {} });
          const server = app.listen(0, '127.0.0.1', () => {
            console.log(`http://127.0.0.1:${server.address().port}`);
          });
        """
        process = subprocess.Popen(["node", "-e", script, storage], cwd=ROOT,
                                   stdout=subprocess.PIPE, text=True)
        try:
            if not select.select([process.stdout], [], [], 15)[0]:
                raise RuntimeError("Server did not start within 15 seconds")
            url = process.stdout.readline().strip()
            if not url.startswith("http://127.0.0.1:"):
                raise RuntimeError("Server failed to start")
            yield url
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()


def run(url, screenshot_dir):
    with sync_playwright() as playwright, tempfile.TemporaryDirectory() as downloads:
        browser = playwright.chromium.launch(headless=True)
        try:
            context = browser.new_context(viewport={"width": 320, "height": 900}, reduced_motion="reduce")
            page = context.new_page()
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)
            page.wait_for_load_state("networkidle")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile layout overflows"
            if screenshot_dir:
                screenshot_dir.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(screenshot_dir / "mobile.png"), full_page=True)

            # Reach the native picker with the keyboard, not a synthetic input change.
            page.keyboard.press("Tab")
            expect(page.locator("#image")).to_be_focused()
            with page.expect_file_chooser() as chooser:
                page.keyboard.press("Enter")
            chooser.value.set_files({"name": "icon.png", "mimeType": "image/png", "buffer": png_image()})
            expect(page.locator("#selectedFile")).to_contain_text("icon.png")
            page.locator("#resizeButton").click()
            expect(page.locator("#error")).to_have_text("Select at least one size.")
            expect(page.locator('input[name="sizes"]').first).to_be_focused()

            # Exercise drag-and-drop as well as the file picker.
            page.evaluate("""encoded => {
              const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
              const transfer = new DataTransfer();
              transfer.items.add(new File([bytes], 'dropped.png', {type: 'image/png'}));
              document.querySelector('#dropArea').dispatchEvent(new DragEvent('drop', {dataTransfer: transfer, bubbles: true, cancelable: true}));
            }""", base64.b64encode(png_image()).decode())
            expect(page.locator("#selectedFile")).to_contain_text("dropped.png")
            for checkbox in page.locator('input[value="16"]').all():
                checkbox.check()
            page.locator('input[value="32"]').first.check()
            page.locator('input[value="128"]').check()

            def busy(route):
                route.fulfill(status=503, content_type="application/json", body=json.dumps({"error": "Server is busy. Please retry shortly."}))

            page.route("**/resize", busy)
            page.locator("#resizeButton").click()
            expect(page.locator("#error")).to_contain_text("Server is busy")
            expect(page.locator("#resizeButton")).to_be_enabled()
            page.unroute("**/resize", busy)

            # Hold a real request to verify loading and duplicate-submit protection.
            held = []
            page.route("**/resize", lambda route: held.append(route))
            page.locator("#resizeButton").click()
            expect(page.locator("#resizeButton")).to_be_disabled()
            expect(page.locator("#image")).to_be_disabled()
            page.locator("#uploadForm").dispatch_event("submit")
            expect(page.locator("#status")).to_have_text("Resizing your image…")
            assert len(held) == 1, "Duplicate submit created another request"
            held[0].continue_()
            page.unroute("**/resize")
            expect(page.locator("#resultLinks a")).to_have_count(2)
            expect(page.locator("#status")).to_contain_text("128 pixels")
            expect(page.locator("#resizeButton")).to_be_enabled()
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Download filenames overflow"

            with page.expect_download() as download:
                page.locator("#resultLinks a").first.click()
            individual_path = Path(downloads) / "individual.png"
            download.value.save_as(individual_path)
            individual = individual_path.read_bytes()
            assert struct.unpack(">II", individual[16:24]) == (16, 16)

            def expired(route):
                route.fulfill(status=410, content_type="application/json", body=json.dumps({"error": "Download expired. Resize your image again."}))

            page.route("**/download-zip", expired)
            page.locator("#downloadAll").click()
            expect(page.locator("#error")).to_contain_text("Download expired")
            expect(page.locator("#downloadAll")).to_be_enabled()
            page.unroute("**/download-zip", expired)
            with page.expect_download() as download:
                page.locator("#downloadAll").click()
            zip_path = Path(downloads) / "icons.zip"
            download.value.save_as(zip_path)
            with zipfile.ZipFile(BytesIO(zip_path.read_bytes())) as archive:
                names = archive.namelist()
                assert len(names) == 2
                assert sorted(struct.unpack(">II", archive.read(name)[16:24]) for name in names) == [(16, 16), (32, 32)]
                assert individual in [archive.read(name) for name in names]
            expect(page.locator("#status")).to_contain_text("ZIP download started")

            if screenshot_dir:
                page.screenshot(path=str(screenshot_dir / "results.png"), full_page=True)
            page.locator('input[value="128"]').uncheck()
            expect(page.locator("#results")).to_be_hidden()
            page.set_viewport_size({"width": 1280, "height": 900})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Desktop layout overflows"
            if screenshot_dir:
                page.screenshot(path=str(screenshot_dir / "desktop.png"), full_page=True)
            assert not errors, f"Browser errors: {errors}"
            print("Browser smoke passed: keyboard, drop, validation, retry, loading, downloads, ZIP, mobile and desktop layout.")
        finally:
            browser.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--url", help="Use an existing server instead of starting an isolated one")
    parser.add_argument("--screenshot-dir", type=Path)
    args = parser.parse_args()
    if args.url:
        run(args.url, args.screenshot_dir)
    else:
        with local_server() as base_url:
            run(base_url, args.screenshot_dir)
