# Agent guidance

## Agent workflow

These are instruction defaults, not runtime enforcement or tool permissions. Respect higher-priority guidance and explicit user overrides. The host provides installed skill locations; read the matching `SKILL.md` before following a skill. If a required skill is unavailable, report the limitation; do not install skills during `/init`.

- **caveman:** Use the bundled skill for concise chat responses. Preserve technical facts and exact code, commands, paths, and errors. Use full sentences for questions and safety warnings. Keep persisted documentation and code in normal prose. Honor requests to stop caveman or use normal mode.
- **grilling:** Use the bundled skill before asking clarification questions about requirements, preferences, or decisions. Choose its lightest suitable mode; do not turn a clear task into a ritual interview. Use `AskQuestion` when available in an interactive TUI; otherwise ask in chat. Cancellation is not consent.
- **ponytail:** Use the bundled skill when building or changing code. Make the smallest complete change and reuse existing patterns. Retain validation, error handling, security, accessibility, and required tests. Combine it with the task-specific skill rather than replacing debugging, migration, or test-first guidance.

## Overview and layout

This is a Node.js application that resizes an uploaded image into platform-specific icon sizes and offers individual or ZIP downloads.

- `server.js`: CommonJS Express server; Multer uploads, Sharp resizing, Archiver ZIP streaming, and static file serving. Routes are `GET /health`, `POST /resize`, and `POST /download-zip`.
- `public/index.html`: Upload form and grouped size choices.
- `public/js/main.js`: Vanilla JavaScript IIFE handling drag-and-drop, requests, result links, and ZIP downloads.
- `public/css/style.css` and `public/assets/`: Frontend styles and image assets. There is no frontend build step.
- `uploads/` and `resized/`: Runtime files, ignored by Git. `.pi/`, `node_modules/`, and `package-lock.json` are also ignored.

## Commands and validation

Run commands from the project root: static and upload paths are relative to the working directory. npm is the package manager documented in `README.md` and used by `package.json`.

- `npm install`: Install dependencies.
- `npm run build`: Runs `npm install && mkdir -p uploads resized`. This installs dependencies and creates runtime directories; it does not compile or bundle code. It requires a shell supporting these commands.
- `npm start`: Runs `node server.js`. Default URL: `http://localhost:5000`; the listener also accepts `process.env.PORT`.
- Keep `uploads/` and `resized/` writable.

No automated tests, CI workflows, or lint, type-check, format, or test scripts are present. Do not report automated coverage. For behavior changes, manually exercise upload, selected sizes, individual downloads, and ZIP downloads; verify that sizes larger than either source dimension are skipped. Report what was actually checked.

## Contracts and caveats

- `/resize` accepts multipart field `image` and one or multiple `sizes` values. Its response is `{ resizedImages: [{ name, url }] }`. Keep the frontend and backend contracts aligned.
- `/download-zip` accepts JSON `{ files: [...] }`; the frontend sends names returned by `/resize`.
- Generated names use the original basename and extension plus `-<size>x<size>`. The UI repeats sizes across categories and deduplicates result links by size; the server does not deduplicate requested sizes.
- Upload deletion happens after successful processing, not in a failure-safe cleanup block. The README's “auto cleaned” description is not a guarantee for failed requests. Resized outputs are retained.
- Error handling and input validation are minimal. Do not assume the image picker restriction validates server uploads or that ZIP filenames are confined safely; review these boundaries when changing file handling.
