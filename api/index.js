const os = require("node:os");
const path = require("node:path");
const { createApp } = require("../server");
const { createBlobStorage } = require("../blob-storage");

module.exports = createApp({
  storageRoot: path.join(os.tmpdir(), "image-resizer"),
  limits: { uploadBytes: 4 * 1024 * 1024 },
  blobStore: createBlobStorage(),
});
