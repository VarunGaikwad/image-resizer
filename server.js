const archiver = require("archiver");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const LIMITS = Object.freeze({
  uploadBytes: 10 * 1024 * 1024,
  inputPixels: 40_000_000,
  outputPixels: 64_000_000,
  size: 4096,
  entries: 32,
  concurrent: 2,
  zipBytes: 100 * 1024 * 1024,
  retentionMs: 60 * 60 * 1000,
  cleanupIntervalMs: 60 * 1000,
});
const OUTPUT_NAME = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}-([1-9]\d{0,3})x\1\.(png|jpg|webp)$/;
const FORMATS = { png: "png", jpeg: "jpg", webp: "webp" };

function httpError(status, message) {
  return Object.assign(new Error(message), { status, expose: true });
}

function createApp({ storageRoot = __dirname, limits = {}, logger = console.log } = {}) {
  const config = { ...LIMITS, ...limits };
  const uploads = path.resolve(storageRoot, "uploads");
  const resized = path.resolve(storageRoot, "resized");
  fs.mkdirSync(uploads, { recursive: true, mode: 0o700 });
  fs.mkdirSync(resized, { recursive: true, mode: 0o700 });

  const app = express();
  app.disable("x-powered-by");
  const activeDownloads = new Map();
  const deleting = new Set();
  let processing = 0;
  let cleanupRunning = false;
  const log = (event) => logger(JSON.stringify(event));
  const asyncRoute = (handler) => (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
  const upload = multer({
    dest: uploads,
    limits: { fileSize: config.uploadBytes, files: 1, fields: config.entries, parts: config.entries + 1, fieldSize: 32 },
  }).single("image");

  app.use((req, res, next) => {
    const start = Date.now();
    res.once("finish", () => log({ event: "request", method: req.method, status: res.statusCode, durationMs: Date.now() - start }));
    next();
  });
  app.use(express.static(path.join(__dirname, "public")));
  app.get("/health", (req, res) => res.json({ status: "ok" }));

  async function removeFiles(files) {
    await Promise.all(files.map(async (file) => {
      try {
        await fsp.rm(file, { force: true });
      } catch (error) {
        log({ event: "cleanup_error", code: error.code || "UNKNOWN" });
      }
    }));
  }

  app.post("/resize", asyncRoute(async (req, res) => {
    if (processing >= config.concurrent) {
      res.set("Retry-After", "2");
      throw httpError(503, "Server is busy. Please retry shortly.");
    }
    processing++;
    const outputs = [];
    let completed = false;
    let payload;
    try {
      await new Promise((resolve, reject) => upload(req, res, (error) => error ? reject(error) : resolve()));
      if (!req.file) throw httpError(400, "Select an image to upload.");
      const rawSizes = Array.isArray(req.body.sizes) ? req.body.sizes : [req.body.sizes];
      if (!rawSizes.length || rawSizes.length > config.entries || rawSizes.some((size) =>
        typeof size !== "string" || !/^[1-9]\d*$/.test(size) || Number(size) > config.size)) {
        throw httpError(400, `Select 1–${config.entries} sizes, each a whole number from 1 to ${config.size}.`);
      }
      if (Object.keys(req.body).some((key) => key !== "sizes")) throw httpError(400, "Unexpected form field.");
      const sizes = [...new Set(rawSizes.map(Number))];
      const input = await fsp.readFile(req.file.path);
      const isPng = input.subarray(0, 8).equals(Buffer.from("89504e470d0a1a0a", "hex"));
      const supportedSignature = isPng
        || input.subarray(0, 3).equals(Buffer.from("ffd8ff", "hex"))
        || (input.toString("ascii", 0, 4) === "RIFF" && input.toString("ascii", 8, 12) === "WEBP");
      if (!supportedSignature) throw httpError(422, "Use a non-animated PNG, JPEG, or WebP image.");
      // Sharp can expose APNG as a single frame; its animation chunk precedes IDAT.
      if (isPng) {
        for (let offset = 8; offset + 12 <= input.length; offset += 12 + input.readUInt32BE(offset)) {
          const type = input.toString("ascii", offset + 4, offset + 8);
          if (type === "acTL") throw httpError(422, "Use a non-animated PNG, JPEG, or WebP image.");
          if (type === "IDAT" || type === "IEND") break;
        }
      }
      let metadata;
      try {
        metadata = await sharp(req.file.path, { limitInputPixels: config.inputPixels }).metadata();
      } catch {
        throw httpError(422, "Image is corrupt, unsupported, or exceeds the 40 megapixel limit.");
      }
      if (!Object.hasOwn(FORMATS, metadata.format) || (metadata.pages || 1) !== 1) {
        throw httpError(422, "Use a non-animated PNG, JPEG, or WebP image.");
      }
      const rotated = metadata.orientation >= 5 && metadata.orientation <= 8;
      const width = rotated ? metadata.height : metadata.width;
      const height = rotated ? metadata.width : metadata.height;
      const available = sizes.filter((size) => size <= width && size <= height);
      if (available.reduce((pixels, size) => pixels + size * size, 0) > config.outputPixels) {
        throw httpError(400, "Selected sizes exceed the total output pixel limit. Select fewer large sizes.");
      }
      const id = randomUUID();
      const resizedImages = [];
      for (const size of available) {
        if (req.aborted || res.destroyed) throw httpError(400, "Upload was interrupted.");
        const name = `${id}-${size}x${size}.${FORMATS[metadata.format]}`;
        const outputPath = path.join(resized, name);
        outputs.push(outputPath);
        await sharp(req.file.path, { limitInputPixels: config.inputPixels })
          .rotate().resize(size, size, { fit: "cover", withoutEnlargement: true })
          .toFormat(metadata.format).toFile(outputPath);
        resizedImages.push({ name, url: `/resized/${name}` });
      }
      payload = { resizedImages, skippedSizes: sizes.filter((size) => !available.includes(size)) };
      completed = !req.aborted && !res.destroyed;
    } finally {
      // Cleanup must also run for invalid input, processing failures, and disconnected clients.
      await removeFiles([...(req.file ? [req.file.path] : []), ...(!completed ? outputs : [])]);
      processing--;
    }
    if (completed) res.json(payload);
  }));

  async function acquireFiles(names) {
    const held = [];
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      for (const name of held) {
        const count = activeDownloads.get(name) - 1;
        if (count) activeDownloads.set(name, count);
        else activeDownloads.delete(name);
      }
    };
    try {
      for (const name of names) {
        if (typeof name !== "string" || !OUTPUT_NAME.test(name)) throw httpError(400, "Invalid generated filename.");
        if (deleting.has(name)) throw httpError(410, "Download expired. Resize your image again.");
        activeDownloads.set(name, (activeDownloads.get(name) || 0) + 1);
        held.push(name);
      }
      const files = await Promise.all(names.map(async (name) => {
        const filePath = path.join(resized, name);
        let stat;
        try {
          stat = await fsp.lstat(filePath);
        } catch (error) {
          if (error.code === "ENOENT") throw httpError(404, "Download not found or expired. Resize your image again.");
          throw error;
        }
        if (!stat.isFile()) throw httpError(400, "Invalid generated file.");
        if (Date.now() - stat.mtimeMs >= config.retentionMs) throw httpError(410, "Download expired. Resize your image again.");
        return { name, path: filePath, size: stat.size };
      }));
      return { files, release };
    } catch (error) {
      release();
      throw error;
    }
  }

  app.get("/resized/:name", asyncRoute(async (req, res, next) => {
    const { files, release } = await acquireFiles([req.params.name]);
    res.once("close", release);
    res.set("Cache-Control", "private, no-store");
    res.download(files[0].path, files[0].name, (error) => {
      release();
      if (error && !res.destroyed) next(error);
    });
  }));

  app.post("/download-zip", express.json({ limit: "16kb", strict: true }), asyncRoute(async (req, res) => {
    const files = req.body && req.body.files;
    if (!Array.isArray(files) || !files.length || files.length > config.entries) {
      throw httpError(400, `Provide an array of 1–${config.entries} generated filenames.`);
    }
    const held = await acquireFiles([...new Set(files)]);
    if (held.files.reduce((bytes, file) => bytes + file.size, 0) > config.zipBytes) {
      held.release();
      throw httpError(413, "ZIP exceeds the 100 MiB limit. Download fewer files.");
    }
    const archive = archiver("zip", { store: true });
    const fail = (error) => {
      log({ event: "archive_error", code: error.code || "UNKNOWN" });
      archive.abort();
      res.destroy();
    };
    archive.on("error", fail);
    archive.on("warning", fail);
    res.once("close", () => {
      archive.abort();
      held.release();
    });
    res.type("zip");
    res.set("Content-Disposition", 'attachment; filename="resized-images.zip"');
    res.set("Cache-Control", "private, no-store");
    archive.pipe(res);
    archive.on("end", held.release);
    archive.on("close", held.release);
    for (const file of held.files) archive.file(file.path, { name: file.name });
    archive.finalize().catch(fail);
  }));

  async function cleanupExpired() {
    if (cleanupRunning) return;
    cleanupRunning = true;
    try {
      for (const name of await fsp.readdir(resized)) {
        if (!OUTPUT_NAME.test(name) || activeDownloads.has(name) || deleting.has(name)) continue;
        const filePath = path.join(resized, name);
        const stat = await fsp.lstat(filePath).catch(() => null);
        if (!stat || !stat.isFile() || Date.now() - stat.mtimeMs < config.retentionMs || activeDownloads.has(name)) continue;
        deleting.add(name);
        try {
          await removeFiles([filePath]);
        } finally {
          deleting.delete(name);
        }
      }
    } catch (error) {
      log({ event: "cleanup_error", code: error.code || "UNKNOWN" });
    } finally {
      cleanupRunning = false;
    }
  }
  const cleanupTimer = setInterval(cleanupExpired, config.cleanupIntervalMs);
  cleanupTimer.unref();
  app.locals.cleanupExpired = cleanupExpired;
  app.locals.closeStorage = () => clearInterval(cleanupTimer);

  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (res.destroyed) return;
    let status = error.status || 500;
    let message = error.expose || status < 500 ? error.message : "Unable to process request. Please try again.";
    if (error instanceof multer.MulterError) {
      status = error.code === "LIMIT_FILE_SIZE" ? 413 : 400;
      message = status === 413 ? "Image exceeds the 10 MiB upload limit." : "Invalid upload or too many form fields.";
    } else if (error.type === "entity.parse.failed") {
      status = 400;
      message = "Invalid JSON body.";
    } else if (error.type === "entity.too.large") {
      status = 413;
      message = "Request body is too large.";
    }
    log({ event: "request_error", status, code: error.code || "UNKNOWN" });
    res.status(status).json({ error: message });
  });
  return app;
}

if (require.main === module) {
  const app = createApp({ storageRoot: process.env.STORAGE_ROOT || __dirname });
  const port = process.env.PORT || 5000;
  const server = app.listen(port, () => console.log(`Server running at http://localhost:${port}`));
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.once(signal, () => {
      app.locals.closeStorage();
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(1), 10_000).unref();
    });
  }
}

module.exports = { createApp, LIMITS };
