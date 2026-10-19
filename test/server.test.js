const { test } = require("node:test");
const assert = require("node:assert/strict");
const { once } = require("node:events");
const { request } = require("node:http");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const sharp = require("sharp");
const { createApp } = require("../server");
const { createBlobStorage } = require("../blob-storage");
const { blobSdkFixture } = require("./blob-sdk-fixture");

async function fixture(t, limits = {}, options = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "image-resizer-test-"));
  const app = createApp({ ...options, storageRoot: root, limits, logger: () => {} });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    app.locals.closeStorage();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const image = await sharp({ create: { width: 96, height: 64, channels: 4, background: "#33669980" } }).png().toBuffer();
  async function upload(sizes = [16, 32, 128], buffer = image, name = "icon.png") {
    const form = new FormData();
    if (buffer !== null) form.append("image", new Blob([buffer]), name);
    if (sizes !== null) for (const size of sizes) form.append("sizes", String(size));
    return fetch(`${base}/resize`, { method: "POST", body: form });
  }
  async function zip(files) {
    return fetch(`${base}/download-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files }) });
  }
  async function assertClean() {
    assert.deepEqual(await fs.readdir(path.join(root, "uploads")), []);
  }
  return { app, root, base, image, upload, zip, assertClean };
}

// Inspect central directory entries and their stored bytes without another ZIP dependency.
function readZip(buffer) {
  const end = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, "ZIP has an end-of-central-directory record");
  const count = buffer.readUInt16LE(end + 10);
  let cursor = buffer.readUInt32LE(end + 16);
  const entries = [];
  for (let i = 0; i < count; i++) {
    assert.equal(buffer.readUInt32LE(cursor), 0x02014b50);
    assert.equal(buffer.readUInt16LE(cursor + 10), 0, "Image entries are stored without recompression");
    const size = buffer.readUInt32LE(cursor + 20);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const offset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.subarray(cursor + 46, cursor + 46 + nameLength).toString();
    assert.equal(buffer.readUInt32LE(offset), 0x04034b50);
    const start = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    entries.push({ name, data: buffer.subarray(start, start + size) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

test("health and assets work; valid sizes produce downloadable squares and a complete ZIP", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await (await fetch(`${f.base}/health`)).json(), { status: "ok" });
  assert.equal((await fetch(`${f.base}/assets/icon-16x16.png`)).status, 200);
  const response = await f.upload();
  assert.equal(response.status, 200);
  const data = await response.json();
  assert.deepEqual(data.skippedSizes, [128]);
  assert.equal(data.resizedImages.length, 2);
  const downloaded = new Map();
  for (const [i, file] of data.resizedImages.entries()) {
    const result = await fetch(`${f.base}${file.url}`);
    assert.equal(result.status, 200);
    assert.match(result.headers.get("content-disposition"), /attachment/);
    assert.match(result.headers.get("cache-control"), /no-store/);
    const bytes = Buffer.from(await result.arrayBuffer());
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.width, [16, 32][i]);
    assert.equal(metadata.height, [16, 32][i]);
    assert.equal(metadata.hasAlpha, true);
    downloaded.set(file.name, bytes);
  }
  const zip = await f.zip([...downloaded.keys()]);
  assert.equal(zip.status, 200);
  const entries = readZip(Buffer.from(await zip.arrayBuffer()));
  assert.equal(entries.length, 2);
  for (const entry of entries) assert.deepEqual(entry.data, downloaded.get(entry.name));
  await f.assertClean();
});

test("duplicate sizes yield one output; requests with the same original name stay independent", async (t) => {
  const f = await fixture(t);
  const responses = await Promise.all([f.upload([48, 48, 16]), f.upload([48, 48, 16])]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  const [a, b] = await Promise.all(responses.map((response) => response.json()));
  assert.equal(a.resizedImages.length, 2);
  assert.equal(b.resizedImages.length, 2);
  assert.notEqual(a.resizedImages[0].name, b.resizedImages[0].name);
  const zip = await f.zip([a.resizedImages[0].name, a.resizedImages[0].name]);
  assert.equal(readZip(Buffer.from(await zip.arrayBuffer())).length, 1);
  await f.assertClean();
});

test("the maximum 32 requested sizes and ZIP entries are accepted", async (t) => {
  const f = await fixture(t);
  const response = await f.upload(Array.from({ length: 32 }, (_, i) => i + 1));
  assert.equal(response.status, 200);
  const { resizedImages } = await response.json();
  assert.equal(resizedImages.length, 32);
  const zip = await f.zip(resizedImages.map((file) => file.name));
  assert.equal(zip.status, 200);
  assert.equal(readZip(Buffer.from(await zip.arrayBuffer())).length, 32);
  await f.assertClean();
});

test("unexpected fields and multiple images are rejected without leftover uploads", async (t) => {
  const f = await fixture(t);
  for (const multiple of [false, true]) {
    const form = new FormData();
    form.append("image", new Blob([f.image]), "icon.png");
    form.append("sizes", "16");
    if (multiple) form.append("image", new Blob([f.image]), "other.png");
    else form.append("unexpected", "value");
    const response = await fetch(`${f.base}/resize`, { method: "POST", body: form });
    assert.equal(response.status, 400);
    await f.assertClean();
  }
  assert.equal((await f.upload([16])).status, 200);
});

test("sizes larger than either source dimension are skipped without upscaling", async (t) => {
  const f = await fixture(t);
  const response = await f.upload([65, 96]);
  assert.deepEqual(await response.json(), { resizedImages: [], skippedSizes: [65, 96] });
  assert.deepEqual(await fs.readdir(path.join(f.root, "resized")), []);
  await f.assertClean();
});

test("JPEG and WebP content works regardless of the supplied extension", async (t) => {
  const f = await fixture(t);
  for (const [format, extension] of [["jpeg", "jpg"], ["webp", "webp"]]) {
    const buffer = await sharp(f.image).toFormat(format).toBuffer();
    const response = await f.upload([24], buffer, "misleading.txt");
    assert.equal(response.status, 200);
    const { resizedImages: [file] } = await response.json();
    assert.ok(file.name.endsWith(`.${extension}`));
    const result = await fetch(`${f.base}${file.url}`);
    assert.equal((await sharp(Buffer.from(await result.arrayBuffer())).metadata()).format, format);
  }
  await f.assertClean();
});

test("EXIF rotation is applied before center cropping", async (t) => {
  const f = await fixture(t);
  const buffer = await sharp(f.image).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const response = await f.upload([32], buffer);
  assert.equal(response.status, 200);
  const { resizedImages: [file] } = await response.json();
  const bytes = Buffer.from(await (await fetch(`${f.base}${file.url}`)).arrayBuffer());
  const expected = await sharp(buffer).rotate().resize(32, 32, { fit: "cover", withoutEnlargement: true }).jpeg().toBuffer();
  assert.deepEqual(bytes, expected);
});

test("missing image and malformed sizes fail with JSON errors and remove uploads", async (t) => {
  const f = await fixture(t);
  assert.equal((await f.upload([16], null)).status, 400);
  for (const sizes of [null, [], [0], [-1], ["NaN"], ["1.5"], ["1e2"], [4097], [""], Array(33).fill(16)]) {
    const response = await f.upload(sizes);
    assert.equal(response.status, 400, `Invalid sizes: ${JSON.stringify(sizes)}`);
    assert.equal(typeof (await response.json()).error, "string");
    await f.assertClean();
  }
  assert.deepEqual(await fs.readdir(path.join(f.root, "resized")), []);
});

test("oversized uploads, decoded pixel limits, and total output limits are enforced", async (t) => {
  const small = await fixture(t, { uploadBytes: 64 });
  assert.equal((await small.upload()).status, 413);
  await small.assertClean();
  const pixels = await fixture(t, { inputPixels: 100 });
  assert.equal((await pixels.upload()).status, 422);
  await pixels.assertClean();
  const output = await fixture(t, { outputPixels: 500 });
  assert.equal((await output.upload([16, 32])).status, 400);
  await output.assertClean();
});

test("corrupt, truncated, animated, and unsupported image content is rejected and cleaned", async (t) => {
  const f = await fixture(t);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80"/></svg>');
  const animatedWebp = await sharp(Buffer.from([255, 0, 0, 255, 0, 255, 0, 255]), {
    raw: { width: 1, height: 2, channels: 4, pageHeight: 1 },
  }).webp({ loop: 0, delay: [100, 100] }).toBuffer();
  assert.equal((await sharp(animatedWebp).metadata()).pages, 2);
  const apng = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACGFjVEwAAAACAAAAAPONk3AAAAAaZmNUTAAAAAAAAAABAAAAAQAAAAAAAAAAAAEACgAAWn8w0AAAAA1JREFUeJxj+M/A8B8ABQAB/4mZPR0AAAAaZmNUTAAAAAEAAAABAAAAAQAAAAAAAAAAAAEACgAAwQzaBAAAABFmZEFUAAAAAnicY2D4z/AfAAQBAf9i5+mcAAAAAElFTkSuQmCC", "base64");
  for (const bytes of [Buffer.from("not an image"), f.image.subarray(0, 40), svg, animatedWebp, apng]) {
    const response = await f.upload([16], bytes);
    assert.equal(response.status, 422);
    assert.equal(typeof (await response.json()).error, "string");
    await f.assertClean();
    assert.deepEqual(await fs.readdir(path.join(f.root, "resized")), []);
  }
});

test("processing failures remove partial outputs and release capacity for retries", async (t) => {
  const f = await fixture(t);
  const original = sharp.prototype.toFile;
  let writes = 0;
  const mocked = t.mock.method(sharp.prototype, "toFile", function (...args) {
    if (++writes === 2) return Promise.reject(new Error("Simulated write failure"));
    return original.apply(this, args);
  });
  const response = await f.upload([16, 32]);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Unable to process request. Please try again." });
  await f.assertClean();
  assert.deepEqual(await fs.readdir(path.join(f.root, "resized")), []);
  mocked.mock.restore();
  assert.equal((await f.upload([16])).status, 200);
});

test("ZIP rejects traversal, invalid types, missing files, malformed JSON, and large payloads", async (t) => {
  const f = await fixture(t);
  for (const files of [null, "x", [], ["../package.json"], ["/etc/passwd"], ["..\\server.js"], [{}], [null], Array(33).fill("x")]) {
    const response = await f.zip(files);
    assert.equal(response.status, 400);
    assert.match(response.headers.get("content-type"), /json/);
  }
  assert.equal((await f.zip([`${randomUUID()}-16x16.png`])).status, 404);
  const malformed = await fetch(`${f.base}/download-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" });
  assert.equal(malformed.status, 400);
  const oversized = await fetch(`${f.base}/download-zip`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ files: ["x".repeat(20_000)] }) });
  assert.equal(oversized.status, 413);
  const wrongType = await fetch(`${f.base}/download-zip`, { method: "POST", body: "files=x" });
  assert.equal(wrongType.status, 400);
});

test("ZIP and individual downloads reject symlinks and enforce ZIP byte limits", async (t) => {
  const f = await fixture(t, { zipBytes: 1 });
  const { resizedImages: [file] } = await (await f.upload([16])).json();
  assert.equal((await f.zip([file.name])).status, 413);
  const linkName = `${randomUUID()}-16x16.png`;
  await fs.symlink(path.join(__dirname, "..", "package.json"), path.join(f.root, "resized", linkName));
  assert.equal((await f.zip([linkName])).status, 400);
  assert.equal((await fetch(`${f.base}/resized/${linkName}`)).status, 400);
});

test("expired outputs are unavailable and removed without deleting unknown files", async (t) => {
  const f = await fixture(t);
  const { resizedImages: [file] } = await (await f.upload([16])).json();
  const output = path.join(f.root, "resized", file.name);
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(output, old, old);
  assert.equal((await fetch(`${f.base}${file.url}`)).status, 410);
  assert.equal((await f.zip([file.name])).status, 410);
  await fs.writeFile(path.join(f.root, "resized", "legacy-output.png"), "leave existing files alone");
  await f.app.locals.cleanupExpired();
  assert.deepEqual(await fs.readdir(path.join(f.root, "resized")), ["legacy-output.png"]);
});

test("an in-flight download stays protected from expiry cleanup", async (t) => {
  const f = await fixture(t);
  const { resizedImages: [file] } = await (await f.upload([16])).json();
  const output = path.join(f.root, "resized", file.name);
  // A large local fixture keeps sendFile active while the client stops reading.
  const handle = await fs.open(output, "r+");
  await handle.truncate(32 * 1024 * 1024);
  await handle.close();
  const req = request(`${f.base}${file.url}`);
  const received = once(req, "response");
  req.end();
  const [response] = await received;
  response.pause();
  const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
  await fs.utimes(output, old, old);
  await f.app.locals.cleanupExpired();
  assert.ok((await fs.stat(output)).isFile());
  response.destroy();
  req.destroy();
});

test("busy processing returns 503 and releases capacity after upload disconnect", async (t) => {
  const f = await fixture(t, { concurrent: 1 });
  const boundary = "test-boundary";
  const req = request(`${f.base}/resize`, { method: "POST", headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` } });
  req.on("error", () => {});
  req.write(`--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="icon.png"\r\nContent-Type: image/png\r\n\r\n`);
  req.write(Buffer.alloc(100));
  await waitFor(async () => (await fs.readdir(path.join(f.root, "uploads"))).length > 0);
  const busy = await f.upload([16]);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers.get("retry-after"), "2");
  assert.deepEqual(await busy.json(), { error: "Server is busy. Please retry shortly." });
  req.destroy();
  await waitFor(async () => (await fs.readdir(path.join(f.root, "uploads"))).length === 0);
  assert.equal((await f.upload([16])).status, 200);
});

test("Blob outputs survive a different instance and leave no local files after processing", async (t) => {
  const cloud = blobSdkFixture();
  const a = await fixture(t, {}, { blobStore: createBlobStorage(cloud.sdk) });
  const b = await fixture(t, {}, { blobStore: createBlobStorage(cloud.sdk) });
  const response = await a.upload();
  assert.equal(response.status, 200);
  const { resizedImages, skippedSizes } = await response.json();
  assert.deepEqual(skippedSizes, [128]);
  assert.equal(resizedImages.length, 2);
  assert.equal(cloud.blobs.size, 2);
  await a.assertClean();
  assert.deepEqual(await fs.readdir(path.join(a.root, "resized")), []);
  const downloaded = new Map();
  for (const file of resizedImages) {
    const result = await fetch(`${b.base}${file.url}`);
    assert.equal(result.status, 200);
    assert.match(result.headers.get("cache-control"), /no-store/);
    assert.match(result.headers.get("content-disposition"), /attachment/);
    const bytes = Buffer.from(await result.arrayBuffer());
    assert.equal((await sharp(bytes).metadata()).height, Number(/-(\d+)x/.exec(file.name)[1]));
    downloaded.set(file.name, bytes);
  }
  const zip = await b.zip([...downloaded.keys()]);
  assert.equal(zip.status, 200);
  for (const entry of readZip(Buffer.from(await zip.arrayBuffer()))) {
    assert.deepEqual(entry.data, downloaded.get(entry.name));
  }
  assert.equal(readZip(Buffer.from(await (await b.zip([resizedImages[0].name, resizedImages[0].name])).arrayBuffer())).length, 1);
});

test("failed Blob uploads remove partial remote and local outputs and permit retries", async (t) => {
  const cloud = blobSdkFixture();
  const f = await fixture(t, {}, { blobStore: createBlobStorage(cloud.sdk) });
  cloud.failSecondWrite();
  const response = await f.upload([16, 32]);
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: "Unable to process request. Please try again." });
  assert.equal(cloud.blobs.size, 0);
  assert.deepEqual(await fs.readdir(path.join(f.root, "resized")), []);
  await f.assertClean();
  assert.equal((await f.upload([16])).status, 200);
});

test("Blob downloads validate names, expiry, missing files and ZIP limits before opening streams", async (t) => {
  const cloud = blobSdkFixture();
  const f = await fixture(t, { zipBytes: 1 }, { blobStore: createBlobStorage(cloud.sdk) });
  const { resizedImages: [file] } = await (await f.upload([16])).json();
  assert.equal((await f.zip([file.name])).status, 413);
  assert.deepEqual(cloud.opened, []);
  assert.equal((await f.zip(["../package.json"])).status, 400);
  assert.equal((await fetch(`${f.base}/resized/invalid.png`)).status, 400);
  const missing = `${randomUUID()}-16x16.png`;
  assert.equal((await f.zip([missing])).status, 404);
  assert.equal((await fetch(`${f.base}/resized/${missing}`)).status, 404);
  const stored = cloud.blobs.get(cloud.uploads[0]);
  stored.uploadedAt = new Date(Date.now() - 61 * 60 * 1000);
  assert.equal((await fetch(`${f.base}${file.url}`)).status, 410);
  assert.equal((await f.zip([file.name])).status, 410);
  assert.deepEqual(cloud.opened, []);
});

test("authenticated cleanup paginates Blob outputs, respects deletion grace, and leaves other files alone", async (t) => {
  const cloud = blobSdkFixture();
  const f = await fixture(t, {}, { blobStore: createBlobStorage(cloud.sdk), cronSecret: "test-secret" });
  const { resizedImages } = await (await f.upload([16, 24, 32, 48])).json();
  const paths = cloud.uploads;
  for (const pathname of paths.slice(0, 3)) cloud.blobs.get(pathname).uploadedAt = new Date(Date.now() - 2 * 60 * 60 * 1000);
  cloud.blobs.get(paths[3]).uploadedAt = new Date(Date.now() - 61 * 60 * 1000);
  const legacy = "image-resizer/v1/legacy.png";
  const unrelated = `other-app/${randomUUID()}-16x16.png`;
  cloud.blobs.set(legacy, { bytes: Buffer.alloc(0), uploadedAt: new Date(0) });
  cloud.blobs.set(unrelated, { bytes: Buffer.alloc(0), uploadedAt: new Date(0) });
  assert.equal((await fetch(`${f.base}/api/cleanup`)).status, 401);
  assert.equal((await fetch(`${f.base}/api/cleanup`, { headers: { Authorization: "Bearer wrong" } })).status, 401);
  assert.equal(cloud.blobs.size, 6);
  const response = await fetch(`${f.base}/api/cleanup`, { headers: { Authorization: "Bearer test-secret" } });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: "ok" });
  assert.deepEqual([...cloud.blobs.keys()].sort(), [paths[3], legacy, unrelated].sort());
  assert.equal((await fetch(`${f.base}${resizedImages[0].url}`)).status, 404);
  assert.equal((await fetch(`${f.base}${resizedImages[3].url}`)).status, 410);
  t.mock.method(cloud.sdk, "list", async () => { throw new Error("Unavailable"); });
  assert.equal((await fetch(`${f.base}/api/cleanup`, { headers: { Authorization: "Bearer test-secret" } })).status, 503);
});

test("cloud stream open failures release earlier streams and return JSON before ZIP headers", async (t) => {
  const cloud = blobSdkFixture();
  const f = await fixture(t, {}, { blobStore: createBlobStorage(cloud.sdk) });
  const { resizedImages } = await (await f.upload([16, 32])).json();
  let firstStream;
  t.mock.method(cloud.sdk, "get", async (pathname) => {
    if (pathname.endsWith(resizedImages[1].name)) return null;
    const bytes = cloud.blobs.get(pathname).bytes;
    return { stream: new ReadableStream({ start(controller) { controller.enqueue(bytes); }, cancel() { firstStream = "cancelled"; } }) };
  });
  const response = await f.zip(resizedImages.map((file) => file.name));
  assert.equal(response.status, 404);
  assert.equal(typeof (await response.json()).error, "string");
  await waitFor(async () => firstStream === "cancelled");
});

test("upload configuration reflects each deployment and missing cron secrets never authorize cleanup", async (t) => {
  const local = await fixture(t);
  const vercel = await fixture(t, { uploadBytes: 4 * 1024 * 1024 }, { cronSecret: "" });
  assert.deepEqual(await (await fetch(`${local.base}/config`)).json(), { uploadBytes: 10 * 1024 * 1024 });
  const response = await fetch(`${vercel.base}/config`);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { uploadBytes: 4 * 1024 * 1024 });
  assert.equal((await fetch(`${vercel.base}/api/cleanup`, { headers: { Authorization: "Bearer undefined" } })).status, 401);
  const tooLarge = await vercel.upload([16], Buffer.alloc(4 * 1024 * 1024 + 1));
  assert.equal(tooLarge.status, 413);
  assert.deepEqual(await tooLarge.json(), { error: "Image exceeds the 4 MiB upload limit." });
  await vercel.assertClean();
});

async function waitFor(predicate) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail("Timed out waiting for cleanup");
}
