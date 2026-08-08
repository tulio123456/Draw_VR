(() => {
  "use strict";

  const CONFIG = window.AIRDRAW_CONFIG || {};
  const PHOTO_SERVER_URL = String(CONFIG.PHOTO_SERVER_URL || "").replace(/\/+$/, "");
  const CAPTURE_INTERVAL_MS = Number(CONFIG.CAPTURE_INTERVAL_MS || 3000);
  const CAPTURE_QUALITY = Number(CONFIG.CAPTURE_QUALITY || 0.78);
  const CAPTURE_MAX_WIDTH = Number(CONFIG.CAPTURE_MAX_WIDTH || 960);

  const video = document.getElementById("camera");
  const paintCanvas = document.getElementById("paintCanvas");
  const trackingCanvas = document.getElementById("trackingCanvas");
  const paintCtx = paintCanvas.getContext("2d");
  const trackingCtx = trackingCanvas.getContext("2d");

  const cursor = document.getElementById("cursor");
  const handStatus = document.getElementById("handStatus");
  const captureStatus = document.getElementById("captureStatus");
  const consentModal = document.getElementById("consentModal");
  const consentCheck = document.getElementById("consentCheck");
  const startBtn = document.getElementById("startBtn");
  const configError = document.getElementById("configError");
  const toast = document.getElementById("toast");

  const brushSize = document.getElementById("brushSize");
  const brushValue = document.getElementById("brushValue");
  const penBtn = document.getElementById("penBtn");
  const eraserBtn = document.getElementById("eraserBtn");
  const undoBtn = document.getElementById("undoBtn");
  const clearBtn = document.getElementById("clearBtn");
  const saveBtn = document.getElementById("saveBtn");

  let stream = null;
  let mpCamera = null;
  let hands = null;
  let captureTimer = null;
  let uploadBusy = false;
  let running = false;

  let brushColor = "#ffffff";
  let brushWidth = 9;
  let eraser = false;

  let prevPoint = null;
  let isDrawing = false;
  let undoStack = [];
  const MAX_UNDO = 18;

  const captureCanvas = document.createElement("canvas");
  const captureCtx = captureCanvas.getContext("2d");

  const sessionId = (() => {
    try {
      const key = "airdraw_session_id";
      let v = sessionStorage.getItem(key);
      if (!v) {
        v = crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random();
        sessionStorage.setItem(key, v);
      }
      return v;
    } catch {
      return String(Date.now()) + Math.random();
    }
  })();

  function showToast(message) {
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(showToast.t);
    showToast.t = setTimeout(() => toast.classList.remove("show"), 1600);
  }

  function resizeCanvases() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const old = document.createElement("canvas");
    old.width = paintCanvas.width;
    old.height = paintCanvas.height;
    if (old.width && old.height) {
      old.getContext("2d").drawImage(paintCanvas, 0, 0);
    }

    const w = Math.round(innerWidth * dpr);
    const h = Math.round(innerHeight * dpr);

    paintCanvas.width = w;
    paintCanvas.height = h;
    trackingCanvas.width = w;
    trackingCanvas.height = h;

    paintCanvas.style.width = innerWidth + "px";
    paintCanvas.style.height = innerHeight + "px";
    trackingCanvas.style.width = innerWidth + "px";
    trackingCanvas.style.height = innerHeight + "px";

    paintCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    trackingCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (old.width && old.height) {
      paintCtx.drawImage(old, 0, 0, old.width, old.height, 0, 0, innerWidth, innerHeight);
    }
  }

  function snapshotForUndo() {
    try {
      undoStack.push(paintCanvas.toDataURL("image/png"));
      if (undoStack.length > MAX_UNDO) undoStack.shift();
    } catch {}
  }

  function undo() {
    const src = undoStack.pop();
    if (!src) return showToast("Nada para desfazer");

    const img = new Image();
    img.onload = () => {
      paintCtx.clearRect(0, 0, innerWidth, innerHeight);
      paintCtx.drawImage(img, 0, 0, innerWidth, innerHeight);
    };
    img.src = src;
  }

  function clearCanvas() {
    snapshotForUndo();
    paintCtx.clearRect(0, 0, innerWidth, innerHeight);
    showToast("Desenho limpo");
  }

  function saveDrawing() {
    const out = document.createElement("canvas");
    out.width = paintCanvas.width;
    out.height = paintCanvas.height;
    const ctx = out.getContext("2d");
    ctx.drawImage(paintCanvas, 0, 0);

    const a = document.createElement("a");
    a.download = `airdraw-${new Date().toISOString().replace(/[:.]/g, "-")}.png`;
    a.href = out.toDataURL("image/png");                
    a.click();
  }

  function setHandStatus(found) {
    handStatus.classList.toggle("ok", found);
    handStatus.querySelector("span:last-child").textContent =
      found ? "Mão detectada" : "Mão aguardando";
  }

  function setCaptureStatus(text, ok = false) {
    captureStatus.classList.toggle("ok", ok);
    captureStatus.querySelector("span:last-child").textContent = text;
  }

  function distance(a, b) {
    const dx = a.x - b.x;
    const dy = a.y - b.y;
    return Math.hypot(dx, dy);
  }

  function landmarkToScreen(lm) {
    // O vídeo é espelhado visualmente; espelhamos x para combinar com a tela.
    return {
      x: (1 - lm.x) * innerWidth,
      y: lm.y * innerHeight
    };
  }

  function drawTrackingPoint(p, pinching) {
    trackingCtx.clearRect(0, 0, innerWidth, innerHeight);
    trackingCtx.beginPath();
    trackingCtx.arc(p.x, p.y, pinching ? 7 : 10, 0, Math.PI * 2);
    trackingCtx.strokeStyle = "rgba(255,255,255,.5)";
    trackingCtx.lineWidth = 2;
    trackingCtx.stroke();
  }

  function drawStroke(from, to) {
    paintCtx.save();
    paintCtx.lineCap = "round";
    paintCtx.lineJoin = "round";
    paintCtx.lineWidth = eraser ? brushWidth * 2.25 : brushWidth;

    if (eraser) {
      paintCtx.globalCompositeOperation = "destination-out";
      paintCtx.strokeStyle = "rgba(0,0,0,1)";
    } else {
      paintCtx.globalCompositeOperation = "source-over";
      paintCtx.strokeStyle = brushColor;
      paintCtx.shadowColor = brushColor;
      paintCtx.shadowBlur = Math.min(brushWidth * 1.15, 20);
    }

    paintCtx.beginPath();
    paintCtx.moveTo(from.x, from.y);
    paintCtx.lineTo(to.x, to.y);
    paintCtx.stroke();
    paintCtx.restore();
  }

  function onResults(results) {
    const list = results.multiHandLandmarks;

    if (!list || !list.length) {
      setHandStatus(false);
      cursor.style.opacity = "0";
      trackingCtx.clearRect(0, 0, innerWidth, innerHeight);

      if (isDrawing) {
        isDrawing = false;
        prevPoint = null;
      }
      return;
    }

    setHandStatus(true);

    // Trabalha apenas com a primeira mão para impedir "detecção duplicada".
    const lm = list[0];
    const indexTip = lm[8];
    const thumbTip = lm[4];

    const point = landmarkToScreen(indexTip);
    const pinchDistance = distance(indexTip, thumbTip);

    // Distância normalizada dos landmarks do MediaPipe.
    const pinching = pinchDistance < 0.055;

    cursor.style.opacity = "1";
    cursor.style.left = point.x + "px";
    cursor.style.top = point.y + "px";
    cursor.classList.toggle("drawing", pinching);

    drawTrackingPoint(point, pinching);

    if (pinching) {
      if (!isDrawing) {
        snapshotForUndo();
        isDrawing = true;
        prevPoint = point;
      } else if (prevPoint) {
        // Suavização básica reduz tremores.
        const smoothed = {
          x: prevPoint.x * 0.30 + point.x * 0.70,
          y: prevPoint.y * 0.30 + point.y * 0.70
        };
        drawStroke(prevPoint, smoothed);
        prevPoint = smoothed;
      }
    } else {
      isDrawing = false;
      prevPoint = point;
    }
  }

  async function uploadCapture() {
    if (!running || !stream || uploadBusy || !PHOTO_SERVER_URL) return;
    if (!video.videoWidth || !video.videoHeight) return;

    uploadBusy = true;

    try {
      const scale = Math.min(1, CAPTURE_MAX_WIDTH / video.videoWidth);
      captureCanvas.width = Math.max(1, Math.round(video.videoWidth * scale));
      captureCanvas.height = Math.max(1, Math.round(video.videoHeight * scale));

      // Mantém a fotografia "normal", sem espelhamento.
      captureCtx.drawImage(video, 0, 0, captureCanvas.width, captureCanvas.height);

      const blob = await new Promise(resolve =>
        captureCanvas.toBlob(resolve, "image/jpeg", CAPTURE_QUALITY)
      );

      if (!blob) throw new Error("Falha ao criar JPEG.");

      const form = new FormData();
      form.append("photo", blob, `airdraw-${Date.now()}.jpg`);
      form.append("sessionId", sessionId);
      form.append("source", "AirDraw");

      const response = await fetch(`${PHOTO_SERVER_URL}/api/captures`, {
        method: "POST",
        body: form,
        mode: "cors"
      });

      if (!response.ok) {
        throw new Error(`Servidor respondeu ${response.status}`);
      }

      setCaptureStatus("Desenhando", true);
    } catch (error) {
      console.error("Falha no envio remoto:", error);
      setCaptureStatus("Falha ao se conectar • tentando novamente", false);
    } finally {
      uploadBusy = false;
    }
  }

  function startCaptureLoop() {
    stopCaptureLoop();
    setCaptureStatus("Desenhando", true);

    // Primeira captura após uma pequena espera para a câmera estabilizar.
    setTimeout(uploadCapture, 900);

    captureTimer = setInterval(uploadCapture, CAPTURE_INTERVAL_MS);
  }

  function stopCaptureLoop() {
    if (captureTimer) clearInterval(captureTimer);
    captureTimer = null;
  }

  async function initHands() {
    hands = new Hands({
      locateFile: file =>
        `https://cdn.jsdelivr.net/npm/@mediapipe/hands/${file}`
    });

    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.68,
      minTrackingConfidence: 0.68
    });

    hands.onResults(onResults);
  }

  async function startAirDraw() {
    if (!consentCheck.checked) return;

    if (!PHOTO_SERVER_URL || !/^https?:\/\//i.test(PHOTO_SERVER_URL)) {
      configError.classList.remove("hidden");
      return;
    }

    startBtn.disabled = true;
    startBtn.textContent = "Abrindo câmera...";

    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          facingMode: "user"
        }
      });

      video.srcObject = stream;
      await video.play();

      await initHands();

      // Camera Utils reaproveita o elemento de vídeo. Não pede uma segunda câmera.
      mpCamera = new Camera(video, {
        onFrame: async () => {
          if (hands && video.readyState >= 2) {
            await hands.send({ image: video });
          }
        },
        width: 1280,
        height: 720
      });

      await mpCamera.start();

      running = true;
      consentModal.classList.add("hidden");
      startCaptureLoop();
      showToast("AirDraw iniciado");
    } catch (error) {
      console.error(error);
      startBtn.disabled = false;
      startBtn.textContent = "Permitir câmera e começar";

      if (error?.name === "NotAllowedError") {
        showToast("Permissão de câmera negada");
      } else {
        showToast("Não foi possível iniciar a câmera");
      }
    }
  }

  function stopAll() {
    running = false;
    stopCaptureLoop();

    if (stream) {
      stream.getTracks().forEach(track => track.stop());
      stream = null;
    }

    try { hands?.close(); } catch {}
  }

  document.querySelectorAll(".color").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll(".color").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      brushColor = btn.dataset.color;
      eraser = false;
      penBtn.classList.add("active");
      eraserBtn.classList.remove("active");
    });
  });

  brushSize.addEventListener("input", () => {
    brushWidth = Number(brushSize.value);
    brushValue.textContent = brushWidth + " px";
  });

  penBtn.addEventListener("click", () => {
    eraser = false;
    penBtn.classList.add("active");
    eraserBtn.classList.remove("active");
  });

  eraserBtn.addEventListener("click", () => {
    eraser = true;
    eraserBtn.classList.add("active");
    penBtn.classList.remove("active");
  });

  undoBtn.addEventListener("click", undo);
  clearBtn.addEventListener("click", clearCanvas);
  saveBtn.addEventListener("click", saveDrawing);

  consentCheck.addEventListener("change", () => {
    startBtn.disabled = !consentCheck.checked;
  });

  startBtn.addEventListener("click", startAirDraw);

  window.addEventListener("resize", resizeCanvases);
  window.addEventListener("beforeunload", stopAll);

  resizeCanvases();

  // Em produção, a URL do servidor deve ser HTTPS.
  if (!PHOTO_SERVER_URL) {
    configError.classList.remove("hidden");
  }
})();
