(() => {
  // Elements
  const dropArea = document.getElementById("dropArea");
  const fileInput = document.getElementById("image");
  const uploadForm = document.getElementById("uploadForm");
  const resultsDiv = document.getElementById("results");
  const resultLinks = document.getElementById("resultLinks");
  const downloadAllBtn = document.getElementById("downloadAll");
  const resizeButton = document.getElementById("resizeButton");
  const status = document.getElementById("status");
  const errorMessage = document.getElementById("error");
  const sizeInputs = [...document.querySelectorAll('input[name="sizes"]')];
  const imagePreview = document.getElementById("imagePreview");
  const previewEmpty = document.getElementById("previewEmpty");
  const imageMeta = document.getElementById("imageMeta");
  const selectionCount = document.getElementById("selectionCount");
  const resultCount = document.getElementById("resultCount");
  let uploadBytes;
  let configError = "";
  let previewUrl;
  let currentFiles = [];
  let resizing = false;
  let zipping = false;
  let zipController;
  let selectionVersion = 0;

  function updateButtons() {
    resizeButton.disabled = resizing || !uploadBytes;
    resizeButton.textContent = resizing ? "Resizing…" : uploadBytes ? "Resize image" : "Loading limits…";
    if (configError) errorMessage.textContent = configError;
    fileInput.disabled = resizing;
    sizeInputs.forEach((input) => { input.disabled = resizing; });
    downloadAllBtn.disabled = resizing || zipping || currentFiles.length === 0;
    downloadAllBtn.textContent = zipping ? "Preparing ZIP…" : "Download all as ZIP";
    uploadForm.setAttribute("aria-busy", String(resizing));
  }

  function selectedSizes() {
    return [...new Set(sizeInputs.filter((input) => input.checked).map((input) => Number(input.value)))];
  }

  function resetResults() {
    const count = selectedSizes().length;
    selectionCount.textContent = `${count} size${count === 1 ? "" : "s"} selected`;
    resultCount.textContent = "";
    selectionVersion++;
    if (zipController) zipController.abort();
    currentFiles = [];
    resultLinks.replaceChildren();
    resultsDiv.hidden = true;
    downloadAllBtn.hidden = true;
    status.textContent = "";
    errorMessage.textContent = "";
    updateButtons();
  }

  function validateFile(file) {
    if (!file) return "Choose an image first.";
    const supported = ["image/png", "image/jpeg", "image/webp"];
    if ((file.type && !supported.includes(file.type)) || (!file.type && !/\.(png|jpe?g|webp)$/i.test(file.name))) {
      return "Choose a PNG, JPEG, or WebP image.";
    }
    if (uploadBytes && file.size > uploadBytes) return `Image exceeds the ${uploadBytes / (1024 * 1024)} MiB upload limit.`;
    return "";
  }

  // Update drop area text
  function updateDropAreaText() {
    const file = fileInput.files[0];
    document.getElementById("selectedFile").textContent = file ? `Selected: ${file.name}` : "No image selected.";
    const error = file ? validateFile(file) : "";
    errorMessage.textContent = error || configError;
    fileInput.setAttribute("aria-invalid", String(Boolean(error)));
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
    imagePreview.removeAttribute("src");
    imagePreview.hidden = true;
    previewEmpty.hidden = false;
    imageMeta.textContent = "Square crop preview";
    if (file && !error) {
      previewUrl = URL.createObjectURL(file);
      imagePreview.src = previewUrl;
      imagePreview.hidden = false;
      previewEmpty.hidden = true;
    }
  }

  imagePreview.addEventListener("load", () => {
    imageMeta.textContent = `${imagePreview.naturalWidth} × ${imagePreview.naturalHeight} px · Center crop preview`;
  });
  imagePreview.addEventListener("error", () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = undefined;
    imagePreview.hidden = true;
    previewEmpty.hidden = false;
    imageMeta.textContent = "Preview unavailable. The server will validate your image.";
  });

  updateButtons();
  fetch("/config")
    .then(async (response) => {
      const data = await response.json();
      if (!response.ok || !Number.isSafeInteger(data.uploadBytes) || data.uploadBytes <= 0) {
        throw new Error("Invalid upload limits.");
      }
      uploadBytes = data.uploadBytes;
      document.getElementById("uploadLimit").textContent = `Up to ${uploadBytes / (1024 * 1024)} MiB`;
      updateDropAreaText();
    })
    .catch(() => {
      configError = "Unable to load upload limits. Reload this page to try again.";
      document.getElementById("uploadLimit").textContent = "Upload limit unavailable";
    })
    .finally(updateButtons);

  // Handle file input change
  fileInput.addEventListener("change", () => {
    resetResults();
    updateDropAreaText();
  });
  sizeInputs.forEach((input) => input.addEventListener("change", resetResults));

  // Drag & drop handlers
  dropArea.addEventListener("dragover", (event) => {
    event.preventDefault();
    if (!resizing) dropArea.classList.add("dragover");
  });
  dropArea.addEventListener("dragleave", () => dropArea.classList.remove("dragover"));
  dropArea.addEventListener("drop", (event) => {
    event.preventDefault();
    dropArea.classList.remove("dragover");
    if (resizing) return;
    resetResults();
    const files = event.dataTransfer.files;
    if (files.length !== 1 || validateFile(files[0])) {
      fileInput.value = "";
      updateDropAreaText();
      errorMessage.textContent = files.length !== 1 ? "Drop one image at a time." : validateFile(files[0]);
      fileInput.setAttribute("aria-invalid", "true");
      return;
    }
    fileInput.files = files;
    updateDropAreaText();
  });

  // The native file input and its label open the picker by keyboard or click.

  // Handle form submit
  uploadForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (resizing || !uploadBytes) return;
    resetResults();
    const fileError = validateFile(fileInput.files[0]);
    if (fileError) {
      errorMessage.textContent = fileError;
      fileInput.setAttribute("aria-invalid", "true");
      fileInput.focus();
      return;
    }
    const sizes = selectedSizes();
    if (!sizes.length) {
      errorMessage.textContent = "Select at least one size.";
      sizeInputs[0].focus();
      return;
    }
    const version = selectionVersion;
    const formData = new FormData();
    formData.append("image", fileInput.files[0]);
    sizes.forEach((size) => formData.append("sizes", String(size)));
    resizing = true;
    updateButtons();
    status.textContent = "Resizing your image…";
    try {
      const response = await fetch("/resize", { method: "POST", body: formData });
      const data = await response.json().catch(() => null);
      if (!response.ok) throw new Error(data?.error || `Server responded with ${response.status}.`);
      if (!Array.isArray(data?.resizedImages)) throw new Error("The server returned an invalid response.");
      if (version !== selectionVersion) return;

      // The server deduplicates requested sizes before processing.
      data.resizedImages.forEach(({ name, url }) => {
        currentFiles.push(name);
        const link = document.createElement("a");
        link.href = url;
        link.download = name;
        const dimensions = /-(\d+)x\1\.(png|jpg|webp)$/.exec(name);
        const label = document.createElement("span");
        label.className = "result-label";
        label.textContent = dimensions ? `${dimensions[1]} × ${dimensions[1]}` : name;
        const format = document.createElement("small");
        format.textContent = dimensions ? `${dimensions[2].toUpperCase()} · Download` : "Download image";
        label.appendChild(format);
        const arrow = document.createElement("span");
        arrow.className = "download-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "↓";
        link.append(label, arrow);
        resultLinks.appendChild(link);
      });
      resultsDiv.hidden = currentFiles.length === 0;
      downloadAllBtn.hidden = currentFiles.length === 0;
      resultCount.textContent = `${currentFiles.length} icon${currentFiles.length === 1 ? "" : "s"} generated`;
      const skipped = Array.isArray(data.skippedSizes) ? data.skippedSizes : [];
      status.textContent = currentFiles.length
        ? `${currentFiles.length} icon${currentFiles.length === 1 ? "" : "s"} ready. Downloads expire after one hour.`
        : "No icons generated. Selected sizes exceed the image dimensions.";
      if (skipped.length) status.textContent += ` Skipped sizes larger than the image: ${skipped.join(", ")} pixels.`;
    } catch (error) {
      if (version === selectionVersion) {
        status.textContent = "";
        errorMessage.textContent = `Unable to resize: ${error.message}`;
      }
    } finally {
      resizing = false;
      updateButtons();
    }
  });

  // Handle Download All click
  downloadAllBtn.addEventListener("click", async () => {
    if (!currentFiles.length || zipping || resizing) return;
    const version = selectionVersion;
    zipController = new AbortController();
    zipping = true;
    errorMessage.textContent = "";
    status.textContent = "Preparing your ZIP download…";
    updateButtons();
    try {
      const response = await fetch("/download-zip", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: currentFiles }),
        signal: zipController.signal,
      });
      if (!response.ok) {
        const data = await response.json().catch(() => null);
        throw new Error(data?.error || `Server responded with ${response.status}.`);
      }
      const blob = await response.blob();
      if (version !== selectionVersion) return;
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "resized-images.zip";
      document.body.appendChild(link);
      link.click();
      link.remove();
      // Allow the browser to begin consuming the object URL before releasing it.
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      status.textContent = "ZIP download started. Downloads expire after one hour.";
    } catch (error) {
      if (error.name !== "AbortError" && version === selectionVersion) {
        status.textContent = "";
        errorMessage.textContent = `Unable to download ZIP: ${error.message}`;
      }
    } finally {
      zipping = false;
      zipController = undefined;
      updateButtons();
    }
  });
})();
