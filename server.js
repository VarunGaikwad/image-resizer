const archiver = require("archiver");
const express = require("express");
const multer = require("multer");
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = 5000;

app.use(express.static("public"));
app.use("/resized", express.static("resized"));

const upload = multer({ dest: "uploads/" });

app.post("/resize", upload.single("image"), async (req, res) => {
  const filePath = req.file.path;
  const fileExt = path.extname(req.file.originalname) || ".png";
  const baseName = path.basename(req.file.originalname, fileExt);
  const sizes = req.body.sizes;

  const image = sharp(filePath);
  const metadata = await image.metadata();

  const availableSizes = Array.isArray(sizes)
    ? sizes.map(Number)
    : [Number(sizes)];
  const resizedImages = [];

  for (const size of availableSizes) {
    if (size <= metadata.width && size <= metadata.height) {
      const outputName = `${baseName}-${size}x${size}${fileExt}`;
      const outputPath = `resized/${outputName}`;

      await image.resize(size, size).toFile(outputPath);

      resizedImages.push({
        name: outputName,
        url: `/resized/${outputName}`,
      });
    }
  }

  // Cleanup
  fs.unlinkSync(filePath);

  res.json({ resizedImages });
});

app.post("/download-zip", express.json(), async (req, res) => {
  const { files } = req.body;
  if (!files || !files.length) {
    return res.status(400).json({ error: "No files provided" });
  }

  res.setHeader("Content-Type", "application/zip");
  res.setHeader(
    "Content-Disposition",
    "attachment; filename=resized-images.zip"
  );

  const archive = archiver("zip");
  archive.pipe(res);

  files.forEach((file) => {
    const filePath = path.join(__dirname, "resized", file);
    archive.file(filePath, { name: file });
  });

  archive.finalize();
});

app.listen(PORT, () =>
  console.log(`Server running at http://localhost:${PORT}`)
);
