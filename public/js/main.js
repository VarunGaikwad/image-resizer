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
  let currentFiles = [];
  let resizing = false;
  let zipping = false;
  let zipController;
  let selectionVersion = 0;

  function updateButtons() {
    resizeButton.disabled = resizing;
    resizeButton.textContent = resizing ? "Resizing…" : "Resize image";
    fileInput.disabled = resizing;
    sizeInputs.forEach((input) => { input.disabled = resizing; });
    downloadAllBtn.disabled = resizing || zipping || currentFiles.length === 0;
    downloadAllBtn.textContent = zipping ? "Preparing ZIP…" : "Download all as ZIP";
    uploadForm.setAttribute("aria-busy", String(resizing));
  }

  function resetResults() {
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
    if (file.size > 10 * 1024 * 1024) return "Image exceeds the 10 MiB upload limit.";
    return "";
  }

  // Update drop area text
  function updateDropAreaText() {
    const file = fileInput.files[0];
    document.getElementById("selectedFile").textContent = file ? `Selected: ${file.name}` : "No image selected.";
    const error = file ? validateFile(file) : "";
    errorMessage.textContent = error;
    fileInput.setAttribute("aria-invalid", String(Boolean(error)));
  }

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
    if (resizing) return;
    resetResults();
    const fileError = validateFile(fileInput.files[0]);
    if (fileError) {
      errorMessage.textContent = fileError;
      fileInput.setAttribute("aria-invalid", "true");
      fileInput.focus();
      return;
    }
    const selectedSizes = [...new Set(sizeInputs.filter((input) => input.checked).map((input) => Number(input.value)))];
    if (!selectedSizes.length) {
      errorMessage.textContent = "Select at least one size.";
      sizeInputs[0].focus();
      return;
    }
    const version = selectionVersion;
    const formData = new FormData();
    formData.append("image", fileInput.files[0]);
    selectedSizes.forEach((size) => formData.append("sizes", String(size)));
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
        link.textContent = `Download ${name}`;
        resultLinks.appendChild(link);
      });
      resultsDiv.hidden = currentFiles.length === 0;
      downloadAllBtn.hidden = currentFiles.length === 0;
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
