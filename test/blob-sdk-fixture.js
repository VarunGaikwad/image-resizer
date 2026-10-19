const assert = require("node:assert/strict");

// An SDK-level double keeps real HTTP, Sharp, and Archiver behavior in cloud-path tests.
function blobSdkFixture() {
  const blobs = new Map();
  const opened = [];
  const uploads = [];
  let failWriteAt;
  class BlobNotFoundError extends Error {}
  const sdk = {
    BlobNotFoundError,
    async put(pathname, stream, options) {
      assert.equal(options.access, "private");
      assert.equal(options.addRandomSuffix, false);
      assert.equal(options.allowOverwrite, false);
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      const bytes = Buffer.concat(chunks);
      assert.ok(!blobs.has(pathname));
      blobs.set(pathname, { bytes, uploadedAt: new Date(), contentType: options.contentType });
      uploads.push(pathname);
      if (uploads.length === failWriteAt) throw new Error("Simulated Blob write failure after commit");
      return { pathname };
    },
    async head(pathname) {
      const blob = blobs.get(pathname);
      if (!blob) throw new BlobNotFoundError();
      return { size: blob.bytes.length, uploadedAt: blob.uploadedAt };
    },
    async get(pathname, options) {
      assert.equal(options.access, "private");
      assert.equal(options.useCache, false);
      opened.push(pathname);
      const blob = blobs.get(pathname);
      if (!blob) return null;
      return { stream: new ReadableStream({ start(controller) { controller.enqueue(blob.bytes); controller.close(); } }) };
    },
    async del(pathnames) {
      for (const pathname of pathnames) blobs.delete(pathname);
    },
    async list({ prefix, cursor }) {
      const paths = [...blobs.keys()].sort().filter((pathname) => pathname.startsWith(prefix) && (!cursor || pathname > cursor));
      const page = paths.slice(0, 2);
      return {
        blobs: page.map((pathname) => ({ pathname, uploadedAt: blobs.get(pathname).uploadedAt })),
        hasMore: paths.length > page.length,
        cursor: page.at(-1),
      };
    },
  };
  return { sdk, blobs, opened, uploads, failSecondWrite() { failWriteAt = uploads.length + 2; } };
}

module.exports = { blobSdkFixture };
