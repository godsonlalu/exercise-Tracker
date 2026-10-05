const state = {
  csvFiles: [],
  selectedFile: '',
  data: [],
  verdictChart: null,
  viewChart: null,
  depthChart: null,
  streamActive: false,
  videoStream: null,
  poseLandmarker: null,
  animationId: null,
  exercise: 'squat',
  goodReps: 0,
  badReps: 0,
  currentRep: 0,
  liveState: 'Waiting',
  repPhase: 'UP',
  minKneeAngle: 999,
  minThighAngle: 999,
  maxTorsoLean: 0,
  minElbowAngle: 999,
  worstBodyAngle: 999,
};

const elements = {
  fileSelect: document.getElementById('fileSelect'),
  insightsList: document.getElementById('insightsList'),
  totalReps: document.getElementById('totalReps'),
  goodReps: document.getElementById('goodReps'),
  badReps: document.getElementById('badReps'),
  successRate: document.getElementById('successRate'),
  exerciseBadge: document.getElementById('exerciseBadge'),
  tableHead: document.getElementById('tableHead'),
  tableBody: document.getElementById('tableBody'),
  exerciseSelect: document.getElementById('exerciseSelect'),
  startCaptureBtn: document.getElementById('startCaptureBtn'),
  stopCaptureBtn: document.getElementById('stopCaptureBtn'),
  liveStatusBadge: document.getElementById('liveStatusBadge'),
  liveSummary: document.getElementById('liveSummary'),
  cameraVideo: document.getElementById('cameraVideo'),
  overlayCanvas: document.getElementById('overlayCanvas'),
  currentRep: document.getElementById('currentRep'),
  liveGood: document.getElementById('liveGood'),
  liveBad: document.getElementById('liveBad'),
  liveState: document.getElementById('liveState'),
};

function parseCSV(text) {
  const rows = text.trim().split(/\r?\n/);
  if (!rows.length) return [];

  const headers = rows[0].split(',').map((h) => h.trim());
  const values = rows.slice(1).filter((row) => row.trim() !== '');

  return values.map((row) => {
    const cells = row.split(',');
    const obj = {};
    headers.forEach((header, index) => {
      obj[header] = cells[index] ? cells[index].trim() : '';
    });
    return obj;
  });
}

function getShortExerciseName(fileName) {
  const lower = fileName.toLowerCase();
  if (lower.includes('squat')) return 'Squat';
  if (lower.includes('push')) return 'Push-up';
  return 'Workout';
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function updateLiveStatus(label, type) {
  elements.liveStatusBadge.textContent = label;
  elements.liveStatusBadge.className = `status-badge ${type}`;
  if (label === 'Good rep') {
    elements.liveSummary.textContent = 'Movement is valid and being counted correctly.';
  } else if (label === 'Bad rep') {
    elements.liveSummary.textContent = 'Form is outside the target range. Improve depth or posture.';
  } else if (label === 'Ready') {
    elements.liveSummary.textContent = 'Camera is ready. Start your movement and the tracker will monitor it.';
  } else if (label === 'Idle') {
    elements.liveSummary.textContent = 'Waiting to start the live capture.';
  }
}

function buildInsights(data) {
  if (!data.length) {
    elements.insightsList.innerHTML = '<li>No valid rep data.</li>';
    return;
  }

  const good = data.filter((row) => (row.verdict || '').toLowerCase() === 'good').length;
  const bad = data.filter((row) => (row.verdict || '').toLowerCase() === 'bad').length;
  const total = data.length;
  const successRate = total ? ((good / total) * 100).toFixed(1) : '0.0';

  const angleKey = 'min_knee_angle' in data[0] ? 'min_knee_angle' : 'min_elbow_angle';
  const avgDepth = data.reduce((sum, row) => sum + toNumber(row[angleKey]), 0) / total;

  const items = [
    `Good rate: ${successRate}%`,
    `Strong reps: ${good} / ${total}`,
    `Weak reps: ${bad}`,
    `Avg depth: ${avgDepth.toFixed(1)}°`,
  ];

  elements.insightsList.innerHTML = items.map((item) => `<li>${item}</li>`).join('');
}

function renderStats(data) {
  const total = data.length;
  const good = data.filter((row) => (row.verdict || '').toLowerCase() === 'good').length;
  const bad = data.filter((row) => (row.verdict || '').toLowerCase() === 'bad').length;
  const successRate = total ? (good / total) * 100 : 0;

  elements.totalReps.textContent = total;
  elements.goodReps.textContent = good;
  elements.badReps.textContent = bad;
  elements.successRate.textContent = `${successRate.toFixed(1)}%`;

  const name = getShortExerciseName(state.selectedFile);
  elements.exerciseBadge.textContent = name;
}

function renderVerdictChart(data) {
  const verdicts = { good: 0, bad: 0, unknown: 0 };
  data.forEach((row) => {
    const verdict = (row.verdict || 'unknown').toLowerCase();
    if (verdict in verdicts) verdicts[verdict] += 1;
  });

  const chartData = Object.entries(verdicts).filter(([, value]) => value > 0);

  const ctx = document.getElementById('verdictChart');
  if (state.verdictChart) state.verdictChart.destroy();

  state.verdictChart = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels: chartData.map(([label]) => label),
      datasets: [{
        data: chartData.map(([, value]) => value),
        backgroundColor: ['#30d57c', '#ff6b6b', '#7c9cff'],
      }],
    },
    options: {
      plugins: { legend: { labels: { color: '#edf4ff' } } },
      maintainAspectRatio: false,
    },
  });
}

function renderViewChart(data) {
  const viewMap = {};
  data.forEach((row) => {
    const view = row.view || 'unknown';
    viewMap[view] = (viewMap[view] || 0) + 1;
  });

  const ctx = document.getElementById('viewChart');
  if (state.viewChart) state.viewChart.destroy();

  state.viewChart = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: Object.keys(viewMap),
      datasets: [{
        label: 'Reps',
        data: Object.values(viewMap),
        backgroundColor: ['#7c9cff', '#57d5ff', '#30d57c'],
        borderRadius: 8,
      }],
    },
    options: {
      plugins: { legend: { display: false } },
      scales: {
        x: { ticks: { color: '#edf4ff' }, grid: { display: false } },
        y: { ticks: { color: '#edf4ff' }, grid: { color: 'rgba(255,255,255,0.08)' } },
      },
      maintainAspectRatio: false,
    },
  });
}

function renderDepthChart(data) {
  const depthKey = 'min_knee_angle' in data[0] ? 'min_knee_angle' : 'min_elbow_angle';
  const labels = data.map((row) => row.rep || '-');
  const values = data.map((row) => toNumber(row[depthKey]));

  const ctx = document.getElementById('depthChart');
  if (state.depthChart) state.depthChart.destroy();

  state.depthChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: depthKey.includes('knee') ? 'Knee angle (°)' : 'Elbow angle (°)',
        data: values,
        borderColor: '#7c9cff',
        backgroundColor: 'rgba(124, 156, 255, 0.22)',
        tension: 0.3,
        fill: true,
      }],
    },
    options: {
      plugins: { legend: { labels: { color: '#edf4ff' } } },
      scales: {
        x: { ticks: { color: '#edf4ff' }, grid: { display: false } },
        y: { ticks: { color: '#edf4ff' }, grid: { color: 'rgba(255,255,255,0.08)' } },
      },
      maintainAspectRatio: false,
    },
  });
}

function renderTable(data) {
  const columns = [...new Set(data.flatMap((row) => Object.keys(row)))];
  const displayColumns = columns.filter((col) => !['source_file', 'exercise'].includes(col));

  const headHtml = displayColumns.map((col) => `<th>${col}</th>`).join('');
  elements.tableHead.innerHTML = headHtml;

  const bodyHtml = data.map((row) => {
    const cells = displayColumns.map((col) => {
      let value = row[col] ?? '';
      if (col === 'verdict') {
        const verdict = String(value).toLowerCase();
        if (verdict === 'good') {
          return `<td><span class="badge-good">Good</span></td>`;
        }
        if (verdict === 'bad') {
          return `<td><span class="badge-bad">Bad</span></td>`;
        }
      }
      return `<td>${value}</td>`;
    }).join('');
    return `<tr>${cells}</tr>`;
  }).join('');

  elements.tableBody.innerHTML = bodyHtml;
}

async function loadFiles() {
  const response = await fetch('/api/files');
  state.csvFiles = await response.json();
  state.csvFiles = state.csvFiles.filter((file) => file.toLowerCase().endsWith('.csv'));

  if (!state.csvFiles.length) {
    return;
  }

  elements.fileSelect.innerHTML = state.csvFiles
    .map((file) => `<option value="${file}">${file}</option>`)
    .join('');

  state.selectedFile = state.csvFiles[0];
  elements.fileSelect.value = state.selectedFile;
  await loadSelectedFile();

  elements.fileSelect.addEventListener('change', (event) => {
    state.selectedFile = event.target.value;
    loadSelectedFile();
  });
}

async function loadSelectedFile() {
  const csvUrl = `/api/data?file=${encodeURIComponent(state.selectedFile)}`;
  const response = await fetch(csvUrl);
  const text = await response.text();
  state.data = parseCSV(text);

  if (!state.data.length) {
    elements.insightsList.innerHTML = '<li>No rows found in this CSV.</li>';
    return;
  }

  renderStats(state.data);
  buildInsights(state.data);
  renderVerdictChart(state.data);
  renderViewChart(state.data);
  renderDepthChart(state.data);
  renderTable(state.data);
}

function updateLiveMetrics() {
  elements.currentRep.textContent = state.currentRep;
  elements.liveGood.textContent = state.goodReps;
  elements.liveBad.textContent = state.badReps;
  elements.liveState.textContent = state.liveState;
}

function resetTracking() {
  state.goodReps = 0;
  state.badReps = 0;
  state.currentRep = 0;
  state.liveState = 'Waiting';
  state.repPhase = 'UP';
  resetRepMeasurements();
  updateLiveMetrics();
}

function resetRepMeasurements() {
  state.minKneeAngle = 999;
  state.minThighAngle = 999;
  state.maxTorsoLean = 0;
  state.minElbowAngle = 999;
  state.worstBodyAngle = 999;
}

function point(landmarks, index) {
  const landmark = landmarks[index];
  return { x: landmark.x, y: landmark.y };
}

function jointAngle(a, b, c) {
  const ba = { x: a.x - b.x, y: a.y - b.y };
  const bc = { x: c.x - b.x, y: c.y - b.y };
  const dot = ba.x * bc.x + ba.y * bc.y;
  const denominator = Math.hypot(ba.x, ba.y) * Math.hypot(bc.x, bc.y);
  const cosine = Math.max(-1, Math.min(1, dot / (denominator || 1)));
  return Math.acos(cosine) * 180 / Math.PI;
}

function chooseSide(landmarks, ids) {
  const visibility = (index) => landmarks[index].visibility ?? 1;
  const leftScore = ids.left.reduce((sum, index) => sum + visibility(index), 0);
  const rightScore = ids.right.reduce((sum, index) => sum + visibility(index), 0);
  return leftScore >= rightScore ? ids.left : ids.right;
}

function hasRequiredLandmarks(landmarks) {
  if (!landmarks) return false;
  const ids = state.exercise === 'squat'
    ? chooseSide(landmarks, { left: [11, 23, 25, 27], right: [12, 24, 26, 28] })
    : chooseSide(landmarks, { left: [11, 13, 15, 23, 27], right: [12, 14, 16, 24, 28] });
  return ids.every((index) => (landmarks[index].visibility ?? 1) >= 0.5);
}

function drawOverlay(ctx, width, height, landmarks, poseReady) {
  ctx.clearRect(0, 0, width, height);
  if (landmarks) {
    const connections = [
      [11, 12], [11, 13], [13, 15], [15, 17], [15, 19], [12, 14], [14, 16], [16, 18], [16, 20],
      [11, 23], [12, 24], [23, 24], [23, 25], [25, 27], [27, 29], [29, 31], [27, 31],
      [24, 26], [26, 28], [28, 30], [30, 32], [28, 32],
    ];
    ctx.lineWidth = Math.max(3, width / 240);
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#3be28f';
    for (const [start, end] of connections) {
      const a = landmarks[start];
      const b = landmarks[end];
      if ((a.visibility ?? 1) < 0.35 || (b.visibility ?? 1) < 0.35) continue;
      ctx.beginPath();
      ctx.moveTo(a.x * width, a.y * height);
      ctx.lineTo(b.x * width, b.y * height);
      ctx.stroke();
    }
    ctx.fillStyle = '#fff';
    for (const landmark of landmarks) {
      if ((landmark.visibility ?? 1) < 0.35) continue;
      ctx.beginPath();
      ctx.arc(landmark.x * width, landmark.y * height, Math.max(3, width / 320), 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.fillStyle = 'rgba(5, 11, 20, 0.78)';
  ctx.fillRect(14, 14, 210, 38);
  ctx.font = '600 16px sans-serif';
  ctx.fillStyle = '#fff';
  ctx.fillText(landmarks ? `${state.exercise === 'squat' ? 'Squat' : 'Push-up'} | ${state.repPhase}` : 'No person detected', 26, 39);
  if (landmarks && !poseReady) {
    const message = 'Step back and keep your full body in frame';
    ctx.font = '600 16px sans-serif';
    const textWidth = ctx.measureText(message).width;
    const boxWidth = Math.min(width - 28, textWidth + 24);
    ctx.fillStyle = 'rgba(5, 11, 20, 0.82)';
    ctx.fillRect(14, height - 52, boxWidth, 38);
    ctx.fillStyle = '#ffd17a';
    ctx.fillText(message, 26, height - 27, boxWidth - 24);
  }
}

function scoreRep(verdict, feedback) {
  state.currentRep += 1;
  state.liveState = verdict === 'good' ? 'Good' : 'Bad';
  if (verdict === 'good') state.goodReps += 1;
  else state.badReps += 1;
  elements.currentRep.textContent = state.currentRep;
  elements.liveGood.textContent = state.goodReps;
  elements.liveBad.textContent = state.badReps;
  elements.liveState.textContent = state.liveState;
  updateLiveStatus(verdict === 'good' ? 'Good rep' : 'Bad rep', verdict === 'good' ? 'good' : 'bad');
  elements.liveSummary.textContent = feedback;
  resetRepMeasurements();
}

function trackPoseRep(landmarks) {
  const visible = (index) => (landmarks[index].visibility ?? 1) >= 0.5;
  if (state.exercise === 'squat') {
    const ids = chooseSide(landmarks, { left: [11, 23, 25, 27], right: [12, 24, 26, 28] });
    const [shoulderId, hipId, kneeId, ankleId] = ids;
    if (![shoulderId, hipId, kneeId, ankleId].every(visible)) return;
    const shoulder = point(landmarks, shoulderId);
    const hip = point(landmarks, hipId);
    const knee = point(landmarks, kneeId);
    const ankle = point(landmarks, ankleId);
    const kneeAngle = jointAngle(hip, knee, ankle);
    const thighAngle = Math.atan2(knee.y - hip.y, Math.abs(knee.x - hip.x) + 1e-6) * 180 / Math.PI;
    const torsoLean = Math.acos(Math.max(-1, Math.min(1, (hip.y - shoulder.y) / (Math.hypot(shoulder.x - hip.x, shoulder.y - hip.y) || 1)))) * 180 / Math.PI;

    if (state.repPhase === 'UP' && kneeAngle < 150) {
      state.repPhase = 'DOWN';
      resetRepMeasurements();
    }
    if (state.repPhase === 'DOWN') {
      state.minKneeAngle = Math.min(state.minKneeAngle, kneeAngle);
      state.minThighAngle = Math.min(state.minThighAngle, thighAngle);
      state.maxTorsoLean = Math.max(state.maxTorsoLean, torsoLean);
      if (kneeAngle > 160) {
        state.repPhase = 'UP';
        const issues = [];
        if (state.minThighAngle > 35) issues.push('Half squat: go deeper.');
        else if (state.minThighAngle > 20) issues.push('Almost: go a little lower.');
        if (state.maxTorsoLean > 45) issues.push('Keep your chest up.');
        scoreRep(issues.length ? 'bad' : 'good', issues.length ? issues.join(' ') : 'Good squat rep detected.');
      }
    }
    return;
  }

  const ids = chooseSide(landmarks, { left: [11, 13, 15, 23, 27], right: [12, 14, 16, 24, 28] });
  const [shoulderId, elbowId, wristId, hipId, ankleId] = ids;
  if (![shoulderId, elbowId, wristId, hipId, ankleId].every(visible)) return;
  const shoulder = point(landmarks, shoulderId);
  const elbow = point(landmarks, elbowId);
  const wrist = point(landmarks, wristId);
  const hip = point(landmarks, hipId);
  const ankle = point(landmarks, ankleId);
  const elbowAngle = jointAngle(shoulder, elbow, wrist);
  const bodyAngle = jointAngle(shoulder, hip, ankle);

  if (state.repPhase === 'UP' && elbowAngle < 140) {
    state.repPhase = 'DOWN';
    resetRepMeasurements();
  }
  if (state.repPhase === 'DOWN') {
    state.minElbowAngle = Math.min(state.minElbowAngle, elbowAngle);
    state.worstBodyAngle = Math.min(state.worstBodyAngle, bodyAngle);
    if (elbowAngle > 155) {
      state.repPhase = 'UP';
      const issues = [];
      if (state.minElbowAngle > 115) issues.push('Half rep: lower further.');
      else if (state.minElbowAngle > 100) issues.push('Almost: lower a little more.');
      if (state.worstBodyAngle < 165) issues.push('Keep your body straight.');
      scoreRep(issues.length ? 'bad' : 'good', issues.length ? issues.join(' ') : 'Good push-up rep detected.');
    }
  }
}

async function ensurePoseLandmarker() {
  if (state.poseLandmarker) return;
  const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
  const visionFiles = await vision.FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  );
  state.poseLandmarker = await vision.PoseLandmarker.createFromOptions(visionFiles, {
    baseOptions: {
      modelAssetPath: 'https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task',
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
}

async function startCapture() {
  if (state.streamActive) return;

  state.exercise = elements.exerciseSelect.value;
  elements.exerciseBadge.textContent = state.exercise === 'squat' ? 'Squat' : 'Push-up';
  resetTracking();
  updateLiveStatus('Ready', 'idle');

  try {
    await ensurePoseLandmarker();
    const stream = await navigator.mediaDevices.getUserMedia({
      video: {
        facingMode: 'user',
        width: { ideal: 1280 },
        height: { ideal: 960 },
      },
      audio: false,
    });
    state.videoStream = stream;
    elements.cameraVideo.srcObject = stream;
    await elements.cameraVideo.play();
    document.querySelector('.camera-wrap').style.aspectRatio =
      `${elements.cameraVideo.videoWidth} / ${elements.cameraVideo.videoHeight}`;
    state.streamActive = true;
    processFrames();
  } catch (error) {
    console.error(error);
    updateLiveStatus('Camera blocked', 'bad');
    elements.liveSummary.textContent = 'Allow camera access and internet access to load live pose tracking.';
  }
}

function stopCapture() {
  state.streamActive = false;
  if (state.animationId) cancelAnimationFrame(state.animationId);
  if (state.videoStream) {
    state.videoStream.getTracks().forEach((track) => track.stop());
    state.videoStream = null;
  }
  if (elements.cameraVideo) {
    elements.cameraVideo.srcObject = null;
  }
  const ctx = elements.overlayCanvas.getContext('2d');
  ctx.clearRect(0, 0, elements.overlayCanvas.width, elements.overlayCanvas.height);
  updateLiveStatus('Idle', 'idle');
  elements.liveState.textContent = 'Waiting';
  elements.liveSummary.textContent = 'Capture stopped.';
}

function processFrames() {
  if (!state.streamActive || !elements.cameraVideo.videoWidth) {
    return;
  }

  const video = elements.cameraVideo;
  const canvas = elements.overlayCanvas;
  const ctx = canvas.getContext('2d');
  const width = video.videoWidth;
  const height = video.videoHeight;

  canvas.width = width;
  canvas.height = height;

  const result = state.poseLandmarker.detectForVideo(video, performance.now());
  const landmarks = result.landmarks?.[0] ?? null;
  const poseReady = hasRequiredLandmarks(landmarks);
  if (poseReady) trackPoseRep(landmarks);
  drawOverlay(ctx, width, height, landmarks, poseReady);
  state.animationId = requestAnimationFrame(processFrames);
}

async function initDashboard() {
  try {
    await loadFiles();
  } catch (error) {
    console.error('CSV load failed', error);
  }

  elements.startCaptureBtn.addEventListener('click', startCapture);
  elements.stopCaptureBtn.addEventListener('click', stopCapture);
  elements.exerciseSelect.addEventListener('change', (event) => {
    state.exercise = event.target.value;
    elements.exerciseBadge.textContent = state.exercise === 'squat' ? 'Squat' : 'Push-up';
  });

  updateLiveStatus('Idle', 'idle');
  elements.liveSummary.textContent = 'Waiting to start the live capture.';
  elements.currentRep.textContent = '0';
  elements.liveGood.textContent = '0';
  elements.liveBad.textContent = '0';
}

initDashboard();
