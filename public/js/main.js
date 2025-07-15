(() => {
  // Elements
  const dropArea = document.getElementById("dropArea");
  const fileInput = document.getElementById("image");
  const uploadForm = document.getElementById("uploadForm");
  const resultsDiv = document.getElementById("results");
  const downloadAllBtn = document.getElementById("downloadAll");
  let currentFiles = [];

  // Update drop area text
  function updateDropAreaText(fileName) {
    dropArea.querySelector("p").textContent = `📷 Selected: ${fileName}`;
  }

  // Handle file input change
  fileInput.addEventListener("change", () => {
    if (fileInput.files.length > 0) {
      updateDropAreaText(fileInput.files[0].name);
    }
  });

  // Drag & drop handlers
  dropArea.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropArea.classList.add("dragover");
  });

  dropArea.addEventListener("dragleave", () => {
    dropArea.classList.remove("dragover");
  });

  dropArea.addEventListener("drop", (e) => {
    e.preventDefault();
    dropArea.classList.remove("dragover");

    const file = e.dataTransfer.files[0];
    if (file && file.type.startsWith("image/")) {
      fileInput.files = e.dataTransfer.files;
      updateDropAreaText(file.name);
    } else {
      alert("Please drop a valid image file.");
    }
  });

  // Click on drop area to open file picker
  dropArea.addEventListener("click", () => fileInput.click());

  // Handle form submit
  uploadForm.addEventListener("submit", async (e) => {
    e.preventDefault();

    const formData = new FormData(uploadForm);

    try {
      const res = await fetch("/resize", {
        method: "POST",
        body: formData,
      });

      if (!res.ok) throw new Error(`Server responded with ${res.status}`);

      const data = await res.json();

      currentFiles = [];
      resultsDiv.innerHTML = "";

      if (!data.resizedImages || data.resizedImages.length === 0) {
        resultsDiv.innerHTML =
          "<p>No resized images (sizes may exceed original).</p>";
        downloadAllBtn.style.display = "none";
        return;
      }

      // Deduplicate files by size (assuming filenames contain size like '48x48')
      const seenSizes = new Set();

      data.resizedImages.forEach(({ name, url }) => {
        const sizeMatch = name.match(/(\d+)x\1/);
        const sizeKey = sizeMatch ? sizeMatch[1] : name;

        if (!seenSizes.has(sizeKey)) {
          seenSizes.add(sizeKey);
          currentFiles.push(name);

          const a = document.createElement("a");
          a.href = url;
          a.download = name;
          a.textContent = `📥 ${name}`;
          resultsDiv.appendChild(a);
        }
      });

      if (currentFiles.length > 0) {
        resultsDiv.appendChild(downloadAllBtn);
        downloadAllBtn.style.display = "inline-block";
      } else {
        downloadAllBtn.style.display = "none";
      }
    } catch (error) {
      alert("Error resizing images: " + error.message);
    }
  });

  // Handle Download All click
  downloadAllBtn.addEventListener("click", async () => {
    if (currentFiles.length === 0) return;

    try {
      const res = await fetch("/download-zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: currentFiles }),
      });

      if (!res.ok) throw new Error(`Server error: ${res.status}`);

      const blob = await res.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "resized-images.zip";
      document.body.appendChild(a);
      a.click();
      a.remove();
      window.URL.revokeObjectURL(url);
    } catch (error) {
      alert("Failed to download zip: " + error.message);
    }
  });
})();
