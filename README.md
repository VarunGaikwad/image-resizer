# Image Icon Resizer

A simple web application to resize images into multiple icon sizes for different platforms like mobile, wearables, desktop, and web extensions. Users can upload an image, select desired icon sizes, and download resized images individually or as a ZIP archive.

---

## Features

- Drag & drop or select image upload
- Select multiple icon sizes categorized by device/use case
- Resize images on the server using Sharp
- Download resized images individually
- Download all resized images in a ZIP file
- Responsive and accessible UI

---

## Tech Stack

- Frontend: HTML, CSS, vanilla JavaScript
- Backend: Node.js, Express, Multer, Sharp, Archiver

---

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/VarunGaikwad/image-resizer.git
   cd image-resizer
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Create necessary directories:

   ```bash
   mkdir uploads resized
   ```

---

## Usage

Start the server:

```bash
npm start
```

Open your browser and go to:
http://localhost:5000

Upload an image, select icon sizes, and resize.

---

## API Endpoints

### POST `/resize`

- Accepts multipart/form-data with:
  - `image`: image file to resize
  - `sizes`: one or multiple sizes (e.g. 24, 48, 72)
- Returns JSON with resized image filenames and URLs.

### POST `/download-zip`

- Accepts JSON body:
  ```json
  {
    "files": ["image-24x24.png", "image-48x48.png"]
  }
  ```
- Returns a ZIP archive of requested resized images.

---

## Folder Structure

```plaintext
/
├── public/ # Frontend files (HTML, CSS, JS)
├── uploads/ # Temporary uploads (auto cleaned)
├── resized/ # Resized images output
├── server.js # Express backend server
├── package.json # Project dependencies and scripts
└── README.md
```

---

## Notes

- Make sure `uploads` and `resized` folders exist and are writable.
- Uploaded images larger than requested sizes will be resized, smaller ones will be ignored.
- Error handling is minimal; improve as needed.
- Tested on Node.js v16+.

---

## License

MIT License © Varun Gaikwd

---

## Acknowledgements

- [Sharp](https://github.com/lovell/sharp) for image processing
- [Archiver](https://github.com/archiverjs/node-archiver) for ZIP file creation
- Inspired by common icon size requirements for various platforms

---

Feel free to contribute or raise issues!

---

If you want me to add badges, CI instructions, or anything else, just ask!
