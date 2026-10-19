# Image Icon Resizer

Resize one image into selected square icon sizes, then download individual files or a ZIP. The application uses Express, Multer, Sharp, Archiver, and vanilla HTML/CSS/JavaScript. There is no frontend build step.

## Quick start

Use Node.js **22 or 24 LTS** and npm.

```bash
npm ci
npm start
```

Open <http://localhost:5000>. The server creates `uploads/` and `resized/` automatically. Paths are resolved from the application directory, not the working directory.

Optional environment variables:

- `PORT`: listening port, default `5000`.
- `STORAGE_ROOT`: parent directory for `uploads/` and `resized/`, default the application directory. Relative values resolve from the working directory. Keep this directory writable and private to the application.

## Image behavior and limits

| Boundary | Limit / behavior |
| --- | --- |
| Input | Non-animated PNG, JPEG, or WebP; actual file content is checked |
| Upload size | 10 MiB |
| Decoded image | 40 million pixels |
| Requested sizes | 1–32 entries, each an integer from 1 to 4096; duplicates are processed once |
| Generated pixels | At most 64 million pixels across all outputs in one request |
| Geometry | Apply EXIF orientation, then center-crop to squares; never upscale |
| Oversized selections | Skip a size if it exceeds either oriented source dimension |
| Output format | Same raster format as the input; JPEG uses `.jpg` |
| Output metadata | Original EXIF and other metadata are not copied |
| Processing | Two simultaneous resize requests, including uploads; excess requests receive `503` and `Retry-After: 2` |
| ZIP | 1–32 filenames, at most 100 MiB total file bytes; duplicate names are included once |
| ZIP JSON body | 16 KiB |
| Retention | Outputs expire one hour after creation; cleanup runs every minute while the process runs |

Sizes are common starting points, not complete platform packaging specifications. Check the current platform requirements before publishing an app. ICO/ICNS files, manifests, and app-store bundles are not generated.

The UI supports keyboard file selection, drag-and-drop, visible size descriptions, inline errors, loading states, and mobile screens. Duplicate size choices across categories generate one result.

## API

### `GET /health`

Returns `200` with `{ "status": "ok" }`. This is a liveness check, not a disk-space or dependency-readiness check.

### `POST /resize`

Multipart form fields:

- `image`: exactly one image.
- `sizes`: one or more integer strings, for example `16`, `32`, and `48`.

```bash
curl -F 'image=@icon.png' -F 'sizes=16' -F 'sizes=32' http://localhost:5000/resize
```

Example response:

```json
{
  "resizedImages": [
    {
      "name": "8cb87629-8116-46af-92ca-821e56f7fa37-16x16.png",
      "url": "/resized/8cb87629-8116-46af-92ca-821e56f7fa37-16x16.png"
    }
  ],
  "skippedSizes": [128]
}
```

Names use a random per-request identifier instead of the uploaded filename. Concurrent uploads cannot overwrite each other. The `resizedImages` contract is unchanged; `skippedSizes` is an additional field. If every size is too large, the response succeeds with an empty `resizedImages` array.

### `GET /resized/:name`

Downloads a generated image as an attachment. Responses use `Cache-Control: private, no-store`. Only generated-name patterns and regular files are accepted; arbitrary paths and symlinks are rejected.

### `POST /download-zip`

Send JSON containing the exact names returned by `/resize`:

```json
{
  "files": ["8cb87629-8116-46af-92ca-821e56f7fa37-16x16.png"]
}
```

Returns a streamed `resized-images.zip`. All requested files are validated before streaming starts. If a later archive/read error occurs, the connection closes rather than returning a partial archive as a successful download.

### Errors

Errors before download streaming starts return JSON:

```json
{ "error": "Select an image to upload." }
```

- `400`: missing image, invalid sizes, invalid filenames, malformed JSON, excessive entries, or output-pixel budget exceeded.
- `404`: download not found, including expired files already removed.
- `410`: download expired but not yet removed.
- `413`: upload, JSON body, or ZIP byte limit exceeded.
- `422`: corrupt, unsupported, animated, or excessive-pixel image.
- `500`: processing or storage failure; internal details are not exposed.
- `503`: processing capacity reached; retry after the indicated delay.

## Checks

```bash
npm run build   # Syntax checks only; does not install dependencies or bundle assets
npm test        # Node's built-in test runner; isolated temporary storage
npm audit --omit=dev
```

API tests exercise real HTTP uploads, dimensions, orientation, PNG transparency, JPEG/WebP compatibility, individual downloads, ZIP contents, input limits, traversal/symlinks, filename collisions, partial-failure cleanup, disconnects, concurrency, and expiration.

For the browser smoke test, use Python 3.13 and install Playwright in a virtual environment:

```bash
python -m venv .venv
. .venv/bin/activate
pip install -r test/requirements.txt
python -m playwright install --with-deps chromium
python test/browser-smoke.py --screenshot-dir test-artifacts
```

On Windows, use the virtual environment's Windows activation command. The smoke script's managed-server mode uses POSIX `select`; run it under Linux/WSL, or use `--url http://localhost:5000` against an already running server.

The browser script starts its own server with temporary storage unless `--url` is supplied. It checks keyboard access, drag-and-drop, selection validation, failure/retry, disabled loading states, duplicate-submit protection, skipped-size feedback, individual and ZIP downloads, stale-result clearing, and 320px/desktop overflow. Screenshots are optional. A human screen-reader and cross-browser review is still recommended.

GitHub Actions runs API checks on Node 22 and 24, audits production dependencies, and runs Chromium smoke checks on Node 24. Browser screenshots are uploaded as CI artifacts.

## Storage, privacy, and deployment

- Uploads are deleted after processing, including normal failures and interrupted uploads. Partial outputs are removed after processing failures.
- Abrupt process termination or filesystem failures can leave temporary files. Inspect old `uploads/` files during maintenance; do not delete files belonging to active requests.
- Expired generated outputs are removed by the running process. Downloads already reading a file are protected from cleanup. When the process is stopped, no scheduled deletion occurs; after restart, expired outputs are unavailable immediately and removed on the next cleanup pass.
- Download URLs and names are bearer secrets, not authenticated access. Anyone holding a name can download or archive that output until expiry. Do not use this deployment for sensitive images without an access-control layer.
- Only the application should be able to write its storage. New runtime directories use private permissions where the operating system supports them.
- Put public deployments behind HTTPS and a reverse proxy with request-rate, connection, upload-duration, and body-size limits. The two-request processing cap is per process, not a distributed rate limiter.
- Monitor disk space and errors. Expiry and per-request limits are not a total disk quota. Run one process per storage root; multiple processes need coordinated cleanup and admission limits before sharing a root.
- JSON request logs contain method, status, and duration. Error logs include event/status/error codes, not filenames, paths, or image contents. A later streaming failure may occur after HTTP headers have been sent.
- `SIGINT`/`SIGTERM` stop accepting new connections and allow up to ten seconds for shutdown. Forced termination can interrupt processing, so retention is not a guarantee of secure erasure.

### Upgrade and rollback

This version restricts uploads to PNG/JPEG/WebP and changes generated filenames. Deploy the frontend and backend together. Existing download links using original-basename filenames must be regenerated. Legacy files are deliberately not deleted or served by the new generated-file routes; remove them manually only after confirming they are no longer needed.

Sharp was upgraded from the previous `^0.33.0` range to `^0.35.5` to address dependency advisories. Keep `package.json` and `package-lock.json` together for reproducible installs. To roll back, restore both files and the matching application/frontend revision, then run `npm ci`. Storage is not migrated or deleted, but rolling back may restore the old security defects; review before doing so.

## Layout

```text
server.js                 Express routes, processing, limits, cleanup
public/index.html         Upload and size-selection interface
public/js/main.js         Browser interaction and downloads
public/css/style.css      Responsive styles and interaction states
public/assets/            Favicons
uploads/                  Temporary uploads (ignored)
resized/                  Generated files (ignored)
test/server.test.js       API regression checks
test/browser-smoke.py     Chromium workflow smoke checks
.github/workflows/ci.yml  Automated gates
```

## License

MIT License © Varun Gaikwad.

Built with [Sharp](https://github.com/lovell/sharp), [Express](https://expressjs.com/), [Multer](https://github.com/expressjs/multer), and [Archiver](https://www.archiverjs.com/).
