const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const video = $("#webcam");
const stage = $("#stage");
const drawingCanvas = $("#drawingCanvas");
const overlayCanvas = $("#overlayCanvas");
const drawCtx = drawingCanvas.getContext("2d", { alpha: true, desynchronized: true });
const overlayCtx = overlayCanvas.getContext("2d", { alpha: true, desynchronized: true });

const MEDIAPIPE_VERSION = "1.0.1";
const MEDIAPIPE_SOURCES = [
  {
    module: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs`,
    wasm: `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`
  },
  {
    module: `https://unpkg.com/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/vision_bundle.mjs?module`,
    wasm: `https://unpkg.com/@mediapipe/tasks-vision@${MEDIAPIPE_VERSION}/wasm`
  }
];
const MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";

// O bloqueio temporal evita que uma única falha de quadro faça a mão desaparecer
// e reaparecer continuamente na interface.
const HAND_ACQUIRE_FRAMES = 3;
const HAND_LOST_GRACE_FRAMES = 10;
const STROKE_MISS_FRAMES = 2;

const TOOL_NAMES = {
  brush: "Pincel",
  neon: "Neon",
  marker: "Marcador",
  eraser: "Borracha",
  line: "Linha",
  rectangle: "Retângulo",
  circle: "Círculo"
};

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],[0,17]
];

const state = {
  tool: "brush",
  color: "#4f8cff",
  size: 10,
  smoothing: 0.7,
  sensitivity: 0.55,
  targetFps: 24,
  mirror: true,
  showLandmarks: false,
  showFps: false,
  exportCamera: false,
  cameraVisible: true,
  stream: null,
  cameraId: "",
  handLandmarker: null,
  modelPromise: null,
  modelReady: false,
  running: false,
  inferenceBusy: false,
  lastInferenceAt: 0,
  lastVideoTime: -1,
  detectedPoint: null,
  pinchActive: false,
  pinchStartFrames: 0,
  pinchEndFrames: 0,
  noHandFrames: 0,
  handAcquireFrames: 0,
  handLocked: false,
  activeStroke: null,
  pointerStroke: null,
  history: [],
  historyIndex: -1,
  fpsCounter: 0,
  fpsValue: 0,
  fpsWindowStart: performance.now(),
  loopToken: 0,
  resizeTimer: 0
};

let toastTimer = 0;

class LowPassFilter {
  constructor() { this.initialized = false; this.value = 0; }
  reset(value = 0) { this.initialized = false; this.value = value; }
  filter(value, alpha) {
    if (!this.initialized) {
      this.initialized = true;
      this.value = value;
      return value;
    }
    this.value = alpha * value + (1 - alpha) * this.value;
    return this.value;
  }
}

class OneEuroFilter {
  constructor() {
    this.x = new LowPassFilter();
    this.dx = new LowPassFilter();
    this.lastRaw = null;
    this.lastTime = null;
  }
  reset() {
    this.x.reset();
    this.dx.reset();
    this.lastRaw = null;
    this.lastTime = null;
  }
  alpha(cutoff, dt) {
    const tau = 1 / (2 * Math.PI * cutoff);
    return 1 / (1 + tau / dt);
  }
  filter(value, timestamp, minCutoff, beta, dCutoff = 1) {
    if (this.lastTime == null || this.lastRaw == null) {
      this.lastTime = timestamp;
      this.lastRaw = value;
      return this.x.filter(value, 1);
    }
    const dt = Math.max(1 / 120, Math.min(0.1, (timestamp - this.lastTime) / 1000));
    const derivative = (value - this.lastRaw) / dt;
    const filteredDerivative = this.dx.filter(derivative, this.alpha(dCutoff, dt));
    const cutoff = minCutoff + beta * Math.abs(filteredDerivative);
    const filtered = this.x.filter(value, this.alpha(cutoff, dt));
    this.lastTime = timestamp;
    this.lastRaw = value;
    return filtered;
  }
}

const filterX = new OneEuroFilter();
const filterY = new OneEuroFilter();

function showToast(message, duration = 2600) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.add("hidden"), duration);
}

function setStatus(text, status = "idle") {
  $("#statusText").textContent = text;
  $("#statusPill").dataset.state = status;
}

function updateGestureUi(handFound, pinching = false) {
  const badge = $("#gestureBadge");
  const cursor = $("#handCursor");
  if (!state.running) {
    badge.classList.add("hidden");
    cursor.classList.add("hidden");
    return;
  }
  badge.classList.remove("hidden");
  if (!handFound) {
    $("#gestureIcon").textContent = "○";
    $("#gestureTitle").textContent = "Procurando sua mão";
    $("#gestureHint").textContent = "Mantenha a mão visível e iluminada";
    cursor.classList.add("hidden");
    return;
  }
  $("#gestureIcon").textContent = pinching ? "●" : "○";
  $("#gestureTitle").textContent = pinching ? "Desenhando" : "Mão detectada";
  $("#gestureHint").textContent = pinching ? "Solte a pinça para parar" : "Junte polegar e indicador";
  cursor.classList.remove("hidden");
  cursor.classList.toggle("pinching", pinching);
}

async function importMediaPipe() {
  let lastError;
  for (const source of MEDIAPIPE_SOURCES) {
    try {
      const module = await import(source.module);
      return { module, wasmRoot: source.wasm };
    } catch (error) {
      console.warn("Falha ao carregar MediaPipe por", source.module, error);
      lastError = error;
    }
  }
  throw lastError || new Error("Não foi possível importar o MediaPipe.");
}

async function createHandLandmarker() {
  if (state.modelReady && state.handLandmarker) return state.handLandmarker;
  if (state.modelPromise) return state.modelPromise;

  state.modelPromise = (async () => {
    setStatus("Carregando rastreamento", "loading");
    try {
      const { module, wasmRoot } = await importMediaPipe();
      const { FilesetResolver, HandLandmarker } = module;
      const vision = await FilesetResolver.forVisionTasks(wasmRoot);

      const commonOptions = {
        baseOptions: { modelAssetPath: MODEL_URL, delegate: "GPU" },
        runningMode: "VIDEO",
        numHands: 1,
        minHandDetectionConfidence: 0.58,
        minHandPresenceConfidence: 0.52,
        minTrackingConfidence: 0.68
      };

      try {
        state.handLandmarker = await HandLandmarker.createFromOptions(vision, commonOptions);
      } catch (gpuError) {
        console.warn("GPU indisponível. Tentando CPU.", gpuError);
        commonOptions.baseOptions.delegate = "CPU";
        state.handLandmarker = await HandLandmarker.createFromOptions(vision, commonOptions);
      }

      state.modelReady = true;
      setStatus(state.running ? "Câmera ativa" : "Rastreamento pronto", "ready");
      return state.handLandmarker;
    } catch (error) {
      console.error(error);
      state.modelPromise = null;
      setStatus("Erro no rastreamento", "error");
      showToast("Falha ao carregar o rastreamento. Verifique a internet e recarregue a página.", 5200);
      throw error;
    }
  })();

  return state.modelPromise;
}

function stopCamera() {
  state.running = false;
  state.loopToken += 1;
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }
  video.srcObject = null;
  finishStroke();
  resetTracking();
}

async function listCameras() {
  if (!navigator.mediaDevices?.enumerateDevices) return;
  const devices = await navigator.mediaDevices.enumerateDevices();
  const cameras = devices.filter((device) => device.kind === "videoinput");
  const select = $("#cameraSelect");
  const selected = state.cameraId || select.value;
  select.innerHTML = '<option value="">Câmera padrão</option>';
  cameras.forEach((camera, index) => {
    const option = document.createElement("option");
    option.value = camera.deviceId;
    option.textContent = camera.label || `Câmera ${index + 1}`;
    select.append(option);
  });
  if ([...select.options].some((option) => option.value === selected)) select.value = selected;
}

async function startCamera(deviceId = state.cameraId) {
  if (!navigator.mediaDevices?.getUserMedia) {
    setStatus("Câmera indisponível", "error");
    showToast("Este navegador não permite acessar a câmera.", 4200);
    return;
  }

  stopCamera();
  state.cameraId = deviceId || "";
  setStatus("Abrindo câmera", "loading");

  const videoSettings = {
    width: { ideal: 960 },
    height: { ideal: 540 },
    frameRate: { ideal: 30, max: 30 }
  };
  if (state.cameraId) videoSettings.deviceId = { exact: state.cameraId };
  else videoSettings.facingMode = "user";

  let pendingStream = null;
  try {
    const streamPromise = navigator.mediaDevices.getUserMedia({ video: videoSettings, audio: false });
    const modelPromise = createHandLandmarker();
    pendingStream = await streamPromise;
    await modelPromise;
    state.stream = pendingStream;
    video.srcObject = pendingStream;
    await video.play();
    await listCameras();
    resizeCanvases(true);
    state.running = true;
    state.lastVideoTime = -1;
    state.lastInferenceAt = 0;
    $("#startScreen").classList.add("hidden");
    setStatus("Câmera ativa", "ready");
    updateGestureUi(false);
    startPredictionLoop();
  } catch (error) {
    console.error(error);
    pendingStream?.getTracks().forEach((track) => track.stop());
    stopCamera();
    $("#startScreen").classList.remove("hidden");
    setStatus("Permissão necessária", "error");
    const name = error?.name || "";
    if (name === "NotAllowedError") showToast("Permita o uso da câmera no navegador e tente novamente.", 5000);
    else if (name === "NotFoundError") showToast("Nenhuma câmera foi encontrada.", 4200);
    else showToast("Não foi possível iniciar a câmera. Tente reiniciá-la nas configurações.", 5000);
  }
}

function resizeCanvases(preserve = true) {
  const rect = stage.getBoundingClientRect();
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  if (drawingCanvas.width === width && drawingCanvas.height === height) return;

  let snapshot = null;
  if (preserve && drawingCanvas.width > 1 && drawingCanvas.height > 1) {
    snapshot = document.createElement("canvas");
    snapshot.width = drawingCanvas.width;
    snapshot.height = drawingCanvas.height;
    snapshot.getContext("2d").drawImage(drawingCanvas, 0, 0);
  }

  drawingCanvas.width = overlayCanvas.width = width;
  drawingCanvas.height = overlayCanvas.height = height;

  if (snapshot) drawCtx.drawImage(snapshot, 0, 0, width, height);
  resetTracking();
  resetHistory();
}

function resetTracking() {
  state.detectedPoint = null;
  state.pinchActive = false;
  state.pinchStartFrames = 0;
  state.pinchEndFrames = 0;
  state.noHandFrames = 0;
  state.handAcquireFrames = 0;
  state.handLocked = false;
  filterX.reset();
  filterY.reset();
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  $("#handCursor").classList.add("hidden");
}

function releaseHandLock() {
  finishStroke();
  state.handLocked = false;
  state.handAcquireFrames = 0;
  state.noHandFrames = 0;
  state.pinchActive = false;
  state.pinchStartFrames = 0;
  state.pinchEndFrames = 0;
  state.detectedPoint = null;
  filterX.reset();
  filterY.reset();
  updateGestureUi(false);
}

function mapLandmarkToCanvas(point) {
  const canvasWidth = drawingCanvas.width;
  const canvasHeight = drawingCanvas.height;
  const videoWidth = video.videoWidth || 960;
  const videoHeight = video.videoHeight || 540;

  const scale = Math.max(canvasWidth / videoWidth, canvasHeight / videoHeight);
  const renderedWidth = videoWidth * scale;
  const renderedHeight = videoHeight * scale;
  const cropX = (renderedWidth - canvasWidth) / 2;
  const cropY = (renderedHeight - canvasHeight) / 2;

  let x = point.x * renderedWidth - cropX;
  const y = point.y * renderedHeight - cropY;
  if (state.mirror) x = canvasWidth - x;
  return { x, y };
}

function landmarkDistance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, (a.z || 0) - (b.z || 0));
}

function getPinchRatio(landmarks) {
  const pinchDistance = landmarkDistance(landmarks[4], landmarks[8]);
  const palmWidth = Math.max(landmarkDistance(landmarks[5], landmarks[17]), 0.055);
  return pinchDistance / palmWidth;
}

function updatePinchState(ratio) {
  const startThreshold = 0.42 - state.sensitivity * 0.14;
  const endThreshold = startThreshold + 0.16;

  if (!state.pinchActive) {
    if (ratio < startThreshold) state.pinchStartFrames += 1;
    else state.pinchStartFrames = 0;
    if (state.pinchStartFrames >= 3) {
      state.pinchActive = true;
      state.pinchStartFrames = 0;
      state.pinchEndFrames = 0;
    }
  } else {
    if (ratio > endThreshold) state.pinchEndFrames += 1;
    else state.pinchEndFrames = 0;
    if (state.pinchEndFrames >= 4) {
      state.pinchActive = false;
      state.pinchEndFrames = 0;
      state.pinchStartFrames = 0;
    }
  }
  return state.pinchActive;
}

function filterPoint(rawPoint, timestamp) {
  const smooth = state.smoothing;
  const minCutoff = 4 - smooth * 3.25;
  const beta = 0.085 - smooth * 0.055;
  const x = filterX.filter(rawPoint.x, timestamp, minCutoff, beta);
  const y = filterY.filter(rawPoint.y, timestamp, minCutoff, beta);
  return { x, y };
}

function startPredictionLoop() {
  const token = ++state.loopToken;
  const tick = (timestamp) => {
    if (!state.running || token !== state.loopToken) return;
    processVideoFrame(timestamp);
    if (typeof video.requestVideoFrameCallback === "function") {
      video.requestVideoFrameCallback((now) => tick(now));
    } else {
      requestAnimationFrame(tick);
    }
  };
  if (typeof video.requestVideoFrameCallback === "function") video.requestVideoFrameCallback((now) => tick(now));
  else requestAnimationFrame(tick);
}

function processVideoFrame(timestamp) {
  if (!state.handLandmarker || state.inferenceBusy || video.readyState < 2) return;
  const minInterval = 1000 / state.targetFps;
  if (timestamp - state.lastInferenceAt < minInterval) return;
  if (video.currentTime === state.lastVideoTime) return;

  state.inferenceBusy = true;
  state.lastInferenceAt = timestamp;
  state.lastVideoTime = video.currentTime;

  try {
    const result = state.handLandmarker.detectForVideo(video, performance.now());
    handleResult(result, timestamp);
    updateFps(timestamp);
  } catch (error) {
    console.error("Erro durante a detecção:", error);
  } finally {
    state.inferenceBusy = false;
  }
}

function handleResult(result, timestamp) {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  const landmarks = result?.landmarks?.[0];

  if (!landmarks) {
    state.handAcquireFrames = 0;
    state.noHandFrames += 1;

    // Interrompe o traço rapidamente, mas mantém a mão bloqueada por alguns
    // quadros. Assim uma falha isolada do MediaPipe não faz a UI piscar.
    if (state.noHandFrames >= STROKE_MISS_FRAMES) finishStroke();

    if (state.handLocked && state.noHandFrames < HAND_LOST_GRACE_FRAMES) {
      updateGestureUi(true, false);
      $("#handCursor").classList.add("hidden");
      return;
    }

    if (state.handLocked) releaseHandLock();
    else updateGestureUi(false);
    return;
  }

  state.noHandFrames = 0;

  // A mão só é aceita depois de aparecer em vários quadros consecutivos.
  // Depois disso ela permanece bloqueada até realmente sair da câmera.
  if (!state.handLocked) {
    state.handAcquireFrames += 1;
    if (state.handAcquireFrames < HAND_ACQUIRE_FRAMES) {
      updateGestureUi(false);
      return;
    }

    state.handLocked = true;
    state.handAcquireFrames = 0;
    state.detectedPoint = null;
    state.pinchActive = false;
    state.pinchStartFrames = 0;
    state.pinchEndFrames = 0;
    filterX.reset();
    filterY.reset();
  }

  if (state.showLandmarks) drawHandLandmarks(landmarks);

  const rawPoint = mapLandmarkToCanvas(landmarks[8]);
  const point = filterPoint(rawPoint, timestamp);
  const previous = state.detectedPoint;
  state.detectedPoint = point;

  const maxJump = Math.hypot(drawingCanvas.width, drawingCanvas.height) * 0.18;
  const jumped = previous && Math.hypot(point.x - previous.x, point.y - previous.y) > maxJump;
  if (jumped) {
    filterX.reset();
    filterY.reset();
    state.detectedPoint = rawPoint;
    finishStroke();
  }

  const pinching = updatePinchState(getPinchRatio(landmarks));
  updateCursor(point, pinching);
  updateGestureUi(true, pinching);

  if (pinching && !jumped) continueStroke(point);
  else finishStroke();
}

function updateCursor(point, pinching) {
  const rect = stage.getBoundingClientRect();
  const cursor = $("#handCursor");
  cursor.style.left = `${point.x / drawingCanvas.width * rect.width}px`;
  cursor.style.top = `${point.y / drawingCanvas.height * rect.height}px`;
  cursor.classList.toggle("pinching", pinching);
}

function drawHandLandmarks(landmarks) {
  overlayCtx.save();
  overlayCtx.lineWidth = Math.max(2, drawingCanvas.width / 650);
  overlayCtx.strokeStyle = "rgba(255,255,255,.45)";
  overlayCtx.fillStyle = "rgba(79,140,255,.9)";

  for (const [a, b] of HAND_CONNECTIONS) {
    const p1 = mapLandmarkToCanvas(landmarks[a]);
    const p2 = mapLandmarkToCanvas(landmarks[b]);
    overlayCtx.beginPath();
    overlayCtx.moveTo(p1.x, p1.y);
    overlayCtx.lineTo(p2.x, p2.y);
    overlayCtx.stroke();
  }

  for (const landmark of landmarks) {
    const point = mapLandmarkToCanvas(landmark);
    overlayCtx.beginPath();
    overlayCtx.arc(point.x, point.y, Math.max(3, drawingCanvas.width / 360), 0, Math.PI * 2);
    overlayCtx.fill();
  }
  overlayCtx.restore();
}

function effectiveSize() {
  return state.size * Math.min(window.devicePixelRatio || 1, 2);
}

function prepareStrokeContext(context, tool = state.tool) {
  const size = effectiveSize();
  context.globalCompositeOperation = tool === "eraser" ? "destination-out" : "source-over";
  context.strokeStyle = state.color;
  context.fillStyle = state.color;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.lineWidth = tool === "marker" ? size * 2.2 : size;
  context.globalAlpha = tool === "marker" ? 0.25 : 1;
  context.shadowBlur = tool === "neon" ? size * 1.7 : 0;
  context.shadowColor = tool === "neon" ? state.color : "transparent";
}

function continueStroke(point) {
  if (!state.activeStroke) {
    state.activeStroke = {
      start: { ...point },
      last: { ...point },
      tool: state.tool,
      base: isShapeTool(state.tool) ? copyCanvas(drawingCanvas) : null,
      moved: false
    };
    if (!isShapeTool(state.tool)) drawDot(point, state.tool);
    return;
  }

  const stroke = state.activeStroke;
  const distance = Math.hypot(point.x - stroke.last.x, point.y - stroke.last.y);
  if (distance < 0.6) return;
  stroke.moved = true;

  if (isShapeTool(stroke.tool)) {
    previewShape(stroke, point);
  } else {
    drawSegment(stroke.last, point, stroke.tool);
  }
  stroke.last = { ...point };
}

function finishStroke() {
  const stroke = state.activeStroke;
  if (!stroke) return;
  if (isShapeTool(stroke.tool)) {
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    if (stroke.moved) drawShape(drawCtx, stroke.tool, stroke.start, stroke.last);
  }
  state.activeStroke = null;
  captureHistory();
}

function isShapeTool(tool) {
  return tool === "line" || tool === "rectangle" || tool === "circle";
}

function drawDot(point, tool) {
  drawCtx.save();
  prepareStrokeContext(drawCtx, tool);
  drawCtx.beginPath();
  drawCtx.arc(point.x, point.y, Math.max(1, drawCtx.lineWidth / 2), 0, Math.PI * 2);
  drawCtx.fill();
  drawCtx.restore();
}

function drawSegment(from, to, tool) {
  drawCtx.save();
  prepareStrokeContext(drawCtx, tool);
  drawCtx.beginPath();
  drawCtx.moveTo(from.x, from.y);
  drawCtx.lineTo(to.x, to.y);
  drawCtx.stroke();
  if (tool === "neon") {
    drawCtx.shadowBlur = 0;
    drawCtx.globalAlpha = 0.9;
    drawCtx.lineWidth = Math.max(1, effectiveSize() * 0.33);
    drawCtx.strokeStyle = "rgba(255,255,255,.92)";
    drawCtx.beginPath();
    drawCtx.moveTo(from.x, from.y);
    drawCtx.lineTo(to.x, to.y);
    drawCtx.stroke();
  }
  drawCtx.restore();
}

function drawShape(context, tool, start, end) {
  context.save();
  prepareStrokeContext(context, tool);
  context.setLineDash([]);
  context.beginPath();
  if (tool === "line") {
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
  } else if (tool === "rectangle") {
    context.rect(start.x, start.y, end.x - start.x, end.y - start.y);
  } else if (tool === "circle") {
    const radius = Math.hypot(end.x - start.x, end.y - start.y);
    context.arc(start.x, start.y, radius, 0, Math.PI * 2);
  }
  context.stroke();
  context.restore();
}

function previewShape(stroke, point) {
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  overlayCtx.save();
  prepareStrokeContext(overlayCtx, stroke.tool);
  overlayCtx.globalAlpha = 0.86;
  overlayCtx.setLineDash([10, 8]);
  overlayCtx.beginPath();
  if (stroke.tool === "line") {
    overlayCtx.moveTo(stroke.start.x, stroke.start.y);
    overlayCtx.lineTo(point.x, point.y);
  } else if (stroke.tool === "rectangle") {
    overlayCtx.rect(stroke.start.x, stroke.start.y, point.x - stroke.start.x, point.y - stroke.start.y);
  } else {
    const radius = Math.hypot(point.x - stroke.start.x, point.y - stroke.start.y);
    overlayCtx.arc(stroke.start.x, stroke.start.y, radius, 0, Math.PI * 2);
  }
  overlayCtx.stroke();
  overlayCtx.restore();
}

function copyCanvas(source) {
  const copy = document.createElement("canvas");
  copy.width = source.width;
  copy.height = source.height;
  copy.getContext("2d").drawImage(source, 0, 0);
  return copy;
}

function resetHistory() {
  state.history = [copyCanvas(drawingCanvas)];
  state.historyIndex = 0;
  updateHistoryButtons();
}

function captureHistory() {
  const snapshot = copyCanvas(drawingCanvas);
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshot);
  if (state.history.length > 14) state.history.shift();
  state.historyIndex = state.history.length - 1;
  updateHistoryButtons();
}

function restoreHistory(index) {
  const snapshot = state.history[index];
  if (!snapshot) return;
  drawCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  drawCtx.drawImage(snapshot, 0, 0, drawingCanvas.width, drawingCanvas.height);
  state.historyIndex = index;
  updateHistoryButtons();
}

function updateHistoryButtons() {
  $("#undoButton").disabled = state.historyIndex <= 0;
  $("#redoButton").disabled = state.historyIndex >= state.history.length - 1;
}

function clearDrawing() {
  finishStroke();
  drawCtx.clearRect(0, 0, drawingCanvas.width, drawingCanvas.height);
  overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
  captureHistory();
  showToast("Tela limpa.");
}

function drawVideoCover(context, targetWidth, targetHeight) {
  if (!video.videoWidth || !video.videoHeight) return;
  const scale = Math.max(targetWidth / video.videoWidth, targetHeight / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  const x = (targetWidth - width) / 2;
  const y = (targetHeight - height) / 2;

  context.save();
  if (state.mirror) {
    context.translate(targetWidth, 0);
    context.scale(-1, 1);
    context.drawImage(video, targetWidth - x - width, y, width, height);
  } else {
    context.drawImage(video, x, y, width, height);
  }
  context.restore();
}

function savePng() {
  finishStroke();
  const output = document.createElement("canvas");
  output.width = drawingCanvas.width;
  output.height = drawingCanvas.height;
  const context = output.getContext("2d");

  if (state.exportCamera && state.running) drawVideoCover(context, output.width, output.height);
  else {
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, output.width, output.height);
  }
  context.drawImage(drawingCanvas, 0, 0);

  output.toBlob((blob) => {
    if (!blob) return showToast("Não foi possível gerar a imagem.");
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    const now = new Date();
    const stamp = now.toISOString().slice(0, 19).replaceAll(":", "-");
    anchor.href = url;
    anchor.download = `airdraw-tulio-${stamp}.png`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast("Imagem salva em PNG.");
  }, "image/png");
}

function updateFps(timestamp) {
  state.fpsCounter += 1;
  const elapsed = timestamp - state.fpsWindowStart;
  if (elapsed >= 1000) {
    state.fpsValue = Math.round(state.fpsCounter * 1000 / elapsed);
    state.fpsCounter = 0;
    state.fpsWindowStart = timestamp;
    $("#performanceBadge").textContent = `${state.fpsValue} FPS`;
  }
}

function selectTool(tool) {
  finishStroke();
  state.tool = tool;
  $$(".tool-button").forEach((button) => button.classList.toggle("active", button.dataset.tool === tool));
  $("#toolName").textContent = TOOL_NAMES[tool];
}

function selectColor(color) {
  state.color = color;
  $("#colorInput").value = color;
  $("#colorPreview").style.background = color;
  $$(".swatch").forEach((button) => button.classList.toggle("active", button.dataset.color.toLowerCase() === color.toLowerCase()));
}

function pointerPosition(event) {
  const rect = drawingCanvas.getBoundingClientRect();
  return {
    x: (event.clientX - rect.left) * drawingCanvas.width / rect.width,
    y: (event.clientY - rect.top) * drawingCanvas.height / rect.height
  };
}

function onPointerDown(event) {
  if (event.pointerType === "mouse" && event.button !== 0) return;
  drawingCanvas.setPointerCapture?.(event.pointerId);
  state.pointerStroke = { pointerId: event.pointerId };
  continueStroke(pointerPosition(event));
}

function onPointerMove(event) {
  if (!state.pointerStroke || state.pointerStroke.pointerId !== event.pointerId) return;
  continueStroke(pointerPosition(event));
}

function onPointerUp(event) {
  if (!state.pointerStroke || state.pointerStroke.pointerId !== event.pointerId) return;
  state.pointerStroke = null;
  finishStroke();
}

function bindEvents() {
  $("#startButton").addEventListener("click", () => startCamera());
  $("#mouseModeButton")?.addEventListener("click", () => {
    stopCamera();
    state.cameraVisible = false;
    stage.classList.add("camera-hidden");
    $("#startScreen").classList.add("hidden");
    setStatus("Modo mouse", "ready");
    showToast("Modo mouse ativado. Clique e arraste para desenhar.");
  });
  $("#settingsButton").addEventListener("click", () => $("#settingsDialog").showModal());
  $("#restartCameraButton").addEventListener("click", () => startCamera($("#cameraSelect").value));
  $("#cameraSelect").addEventListener("change", (event) => {
    state.cameraId = event.target.value;
    if (state.running) startCamera(state.cameraId);
  });

  $("#undoButton").addEventListener("click", () => restoreHistory(state.historyIndex - 1));
  $("#redoButton").addEventListener("click", () => restoreHistory(state.historyIndex + 1));
  $("#clearButton").addEventListener("click", clearDrawing);
  $("#saveButton").addEventListener("click", savePng);
  $("#cameraToggleButton").addEventListener("click", () => {
    state.cameraVisible = !state.cameraVisible;
    stage.classList.toggle("camera-hidden", !state.cameraVisible);
    showToast(state.cameraVisible ? "Câmera visível." : "Câmera ocultada.");
  });

  $$(".tool-button").forEach((button) => button.addEventListener("click", () => selectTool(button.dataset.tool)));
  $$(".swatch").forEach((button) => button.addEventListener("click", () => selectColor(button.dataset.color)));
  $("#colorInput").addEventListener("input", (event) => selectColor(event.target.value));

  $("#sizeInput").addEventListener("input", (event) => {
    state.size = Number(event.target.value);
    $("#sizeValue").textContent = `${state.size} px`;
  });
  $("#smoothingInput").addEventListener("input", (event) => {
    state.smoothing = Number(event.target.value) / 100;
    $("#smoothingValue").textContent = `${event.target.value}%`;
    filterX.reset();
    filterY.reset();
  });
  $("#sensitivityInput").addEventListener("input", (event) => {
    state.sensitivity = Number(event.target.value) / 100;
    const value = Number(event.target.value);
    $("#sensitivityValue").textContent = value < 35 ? "Baixa" : value > 70 ? "Alta" : "Média";
  });
  $("#performanceSelect").addEventListener("change", (event) => state.targetFps = Number(event.target.value));
  $("#mirrorInput").addEventListener("change", (event) => {
    state.mirror = event.target.checked;
    stage.classList.toggle("mirrored", state.mirror);
    resetTracking();
  });
  $("#landmarksInput").addEventListener("change", (event) => state.showLandmarks = event.target.checked);
  $("#fpsInput").addEventListener("change", (event) => {
    state.showFps = event.target.checked;
    $("#performanceBadge").classList.toggle("hidden", !state.showFps);
  });
  $("#exportCameraInput").addEventListener("change", (event) => state.exportCamera = event.target.checked);

  drawingCanvas.addEventListener("pointerdown", onPointerDown);
  drawingCanvas.addEventListener("pointermove", onPointerMove);
  drawingCanvas.addEventListener("pointerup", onPointerUp);
  drawingCanvas.addEventListener("pointercancel", onPointerUp);

  window.addEventListener("keydown", (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "z") {
      event.preventDefault();
      if (event.shiftKey) restoreHistory(state.historyIndex + 1);
      else restoreHistory(state.historyIndex - 1);
    }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      savePng();
    }
  });

  navigator.mediaDevices?.addEventListener?.("devicechange", listCameras);
  const observer = new ResizeObserver(() => {
    clearTimeout(state.resizeTimer);
    state.resizeTimer = setTimeout(() => resizeCanvases(true), 120);
  });
  observer.observe(stage);
  window.addEventListener("beforeunload", stopCamera);
}

function initialize() {
  bindEvents();
  resizeCanvases(false);
  resetHistory();
  selectColor(state.color);
  setStatus("Aguardando", "idle");
  createHandLandmarker().catch(() => {});
}

initialize();
