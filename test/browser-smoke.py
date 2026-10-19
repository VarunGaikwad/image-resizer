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
            page.add_init_script("""
              window.previewUrls = [];
              window.revokedUrls = [];
              const create = URL.createObjectURL.bind(URL);
              const revoke = URL.revokeObjectURL.bind(URL);
              URL.createObjectURL = blob => {
                const url = create(blob);
                if (blob instanceof File) window.previewUrls.push(url);
                return url;
              };
              URL.revokeObjectURL = url => { window.revokedUrls.push(url); revoke(url); };
            """)
            errors = []
            page.on("pageerror", lambda error: errors.append(str(error)))
            page.goto(url)
            page.wait_for_load_state("networkidle")
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Mobile layout overflows"
            expect(page.locator("#selectionCount")).to_have_text("0 sizes selected")
            expect(page.locator("#imagePreview")).to_be_hidden()
            expect(page.locator("#previewEmpty")).to_be_visible()
            if screenshot_dir:
                screenshot_dir.mkdir(parents=True, exist_ok=True)
                page.screenshot(path=str(screenshot_dir / "mobile.png"), full_page=True)
                page.set_viewport_size({"width": 1440, "height": 1000})
                page.screenshot(path=str(screenshot_dir / "desktop-empty.png"), full_page=True)
                page.set_viewport_size({"width": 320, "height": 900})

            # Reach the native picker with the keyboard, not a synthetic input change.
            page.keyboard.press("Tab")
            expect(page.locator("#image")).to_be_focused()
            with page.expect_file_chooser() as chooser:
                page.keyboard.press("Enter")
            chooser.value.set_files({"name": "icon.png", "mimeType": "image/png", "buffer": png_image()})
            expect(page.locator("#selectedFile")).to_contain_text("icon.png")
            expect(page.locator("#imagePreview")).to_be_visible()
            expect(page.locator("#imageMeta")).to_contain_text("96 × 64 px")
            first_preview = page.locator("#imagePreview").get_attribute("src")
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
            expect(page.locator("#imagePreview")).not_to_have_attribute("src", first_preview)
            assert page.evaluate("url => window.revokedUrls.includes(url)", first_preview), "Replaced preview URL leaked"
            expect(page.locator("#imageMeta")).to_contain_text("96 × 64 px")
            for checkbox in page.locator('input[value="16"]').all():
                checkbox.check()
            page.locator('input[value="32"]').first.check()
            page.locator('input[value="128"]').check()
            expect(page.locator("#selectionCount")).to_have_text("3 sizes selected")

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
            expect(page.locator("#resultCount")).to_have_text("2 icons generated")
            expect(page.locator("#resultLinks a").first).to_have_text("16 × 16PNG · Download↓")
            assert page.locator("#resultLinks a").first.get_attribute("download").endswith("-16x16.png")
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
                page.set_viewport_size({"width": 1440, "height": 1000})
                page.screenshot(path=str(screenshot_dir / "desktop-results.png"), full_page=True)
            page.locator('input[value="128"]').uncheck()
            expect(page.locator("#results")).to_be_hidden()
            page.set_viewport_size({"width": 1280, "height": 900})
            assert page.evaluate("document.documentElement.scrollWidth <= innerWidth"), "Desktop layout overflows"
            if screenshot_dir:
                page.screenshot(path=str(screenshot_dir / "desktop.png"), full_page=True)
            # All-oversized selections have feedback rather than an empty download panel.
            for checkbox in page.locator('input[name="sizes"]').all():
                checkbox.uncheck()
            page.locator('input[value="128"]').check()
            page.locator("#resizeButton").click()
            expect(page.locator("#status")).to_contain_text("No icons generated")
            expect(page.locator("#results")).to_be_hidden()

            # Invalid replacements clear the preview and release its object URL.
            previous_preview = page.locator("#imagePreview").get_attribute("src")
            page.locator("#image").set_input_files({"name": "invalid.gif", "mimeType": "image/gif", "buffer": b"GIF89a"})
            expect(page.locator("#error")).to_have_text("Choose a PNG, JPEG, or WebP image.")
            expect(page.locator("#imagePreview")).to_be_hidden()
            expect(page.locator("#previewEmpty")).to_be_visible()
            assert page.evaluate("url => window.revokedUrls.includes(url)", previous_preview)

            # Real JPEG and WebP uploads retain their format through the new UI.
            page.locator('input[value="128"]').uncheck()
            page.locator('input[value="32"]').first.check()
            for image_format in ["jpeg", "webp"]:
                source = subprocess.check_output(["node", "-e", f"""
                  require('sharp')({{create: {{width: 96, height: 64, channels: 3, background: '#336699'}}}})
                    .toFormat('{image_format}').toBuffer().then(bytes => process.stdout.write(bytes));
                """], cwd=ROOT)
                page.locator("#image").set_input_files({"name": f"source.{image_format}", "mimeType": f"image/{image_format}", "buffer": source})
                expect(page.locator("#imageMeta")).to_contain_text("96 × 64 px")
                page.locator("#resizeButton").click()
                expect(page.locator("#resultLinks a")).to_have_count(1)
                extension = "jpg" if image_format == "jpeg" else "webp"
                expect(page.locator("#resultLinks a small")).to_have_text(f"{extension.upper()} · Download")
                with page.expect_download() as download:
                    page.locator("#resultLinks a").click()
                assert download.value.suggested_filename.endswith(f"-32x32.{extension}")

            # An image decoding failure must not leave a broken preview or stale results.
            page.locator("#image").set_input_files({"name": "corrupt.png", "mimeType": "image/png", "buffer": b"not an image"})
            expect(page.locator("#imageMeta")).to_contain_text("Preview unavailable")
            expect(page.locator("#imagePreview")).to_be_hidden()
            expect(page.locator("#previewEmpty")).to_be_visible()
            expect(page.locator("#results")).to_be_hidden()
            assert page.evaluate("window.revokedUrls.includes(window.previewUrls.at(-1))")
            page.locator("#resizeButton").click()
            expect(page.locator("#error")).to_contain_text("Unable to resize")
            expect(page.locator("#resizeButton")).to_be_enabled()

            # Deployment limits arrive before submission is enabled, including Vercel's 4 MiB cap.
            pending_config = []
            page.route("**/config", lambda route: pending_config.append(route))
            page.reload()
            expect(page.locator("#resizeButton")).to_have_text("Loading limits…")
            expect(page.locator("#resizeButton")).to_be_disabled()
            pending_config[0].fulfill(status=200, content_type="application/json", body=json.dumps({"uploadBytes": 4 * 1024 * 1024}))
            expect(page.locator("#uploadLimit")).to_have_text("Up to 4 MiB")
            expect(page.locator("#resizeButton")).to_be_enabled()
            attempts = []
            page.on("request", lambda req: attempts.append(req.url) if req.method == "POST" and req.url.endswith("/resize") else None)
            page.locator("#image").set_input_files({"name": "large.png", "mimeType": "image/png", "buffer": b"0" * (4 * 1024 * 1024 + 1)})
            page.locator("#resizeButton").click()
            expect(page.locator("#error")).to_have_text("Image exceeds the 4 MiB upload limit.")
            assert not attempts, "Oversized image was uploaded despite deployment cap"
            page.unroute("**/config")

            # Missing configuration fails closed instead of falling back to the wrong upload cap.
            for status_code, body in [(503, {}), (200, {"uploadBytes": "invalid"})]:
                page.route("**/config", lambda route, request, code=status_code, data=body: route.fulfill(status=code, content_type="application/json", body=json.dumps(data)))
                page.reload()
                expect(page.locator("#error")).to_contain_text("Reload this page")
                expect(page.locator("#resizeButton")).to_be_disabled()
                page.unroute("**/config")

            assert not errors, f"Browser errors: {errors}"
            print("Browser smoke passed: keyboard, preview lifecycle, unique counts, drop, validation, retry, loading, PNG/JPEG/WebP downloads, ZIP, skipped sizes, deployment limits, mobile and desktop layout.")
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
