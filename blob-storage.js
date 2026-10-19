const fs = require("node:fs");
const { Readable } = require("node:stream");

const PREFIX = "image-resizer/v1/";

function createBlobStorage(sdk = require("@vercel/blob")) {
  return {
    // Allow in-flight functions to finish before a different instance deletes expired blobs.
    cleanupGraceMs: 5 * 60 * 1000,

    async write(name, filePath) {
      const stream = fs.createReadStream(filePath);
      try {
        await sdk.put(`${PREFIX}${name}`, stream, {
          access: "private",
          addRandomSuffix: false,
          allowOverwrite: false,
          cacheControlMaxAge: 60,
          contentType: name.endsWith(".jpg") ? "image/jpeg" : `image/${name.split(".").pop()}`,
        });
      } finally {
        stream.destroy();
      }
    },

    async stat(name) {
      try {
        const metadata = await sdk.head(`${PREFIX}${name}`);
        return { size: metadata.size, mtimeMs: metadata.uploadedAt.getTime() };
      } catch (error) {
        if (error instanceof sdk.BlobNotFoundError) return null;
        throw error;
      }
    },

    async open(name) {
      const result = await sdk.get(`${PREFIX}${name}`, { access: "private", useCache: false });
      return result ? Readable.fromWeb(result.stream) : null;
    },

    async remove(names) {
      if (names.length) await sdk.del(names.map((name) => `${PREFIX}${name}`));
    },

    async *entries() {
      let cursor;
      do {
        const page = await sdk.list({ prefix: PREFIX, cursor, limit: 1000 });
        for (const blob of page.blobs) {
          yield { name: blob.pathname.slice(PREFIX.length), mtimeMs: blob.uploadedAt.getTime() };
        }
        cursor = page.hasMore ? page.cursor : undefined;
      } while (cursor);
    },
  };
}

module.exports = { createBlobStorage };
