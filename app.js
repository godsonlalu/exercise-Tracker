const state = {
  csvFiles: [],
  selectedFile: '',
  data: [],
  verdictChart: null,
  viewChart: null,
  depthChart: null,
  streamActive: false,
  sourceMode: null,
  videoStream: null,
  uploadedVideoUrl: null,
  uploadedFileName: '',
  poseLandmarker: null,
  poseModel: null,
  lastPoseTimestamp: -1,
  liveChart: null,
  liveSamples: [],
  liveRepLog: [],
  sessionStartedAt: 0,
  currentExerciseSeconds: 0,
  lastSampleAt: 0,
  liveAngle: null,
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
  worstBodySag: 0,
  pushupSide: null,
  pushupElbowSamples: [],
  pushupBodySamples: [],
  pushupSagSamples: [],
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
  videoFileInput: document.getElementById('videoFileInput'),
  uploadedVideoName: document.getElementById('uploadedVideoName'),
  analyzeVideoBtn: document.getElementById('analyzeVideoBtn'),
  videoExerciseSelect: document.getElementById('videoExerciseSelect'),
  liveStatusBadge: document.getElementById('liveStatusBadge'),
  liveSummary: document.getElementById('liveSummary'),
  cameraVideo: document.getElementById('cameraVideo'),
  overlayCanvas: document.getElementById('overlayCanvas'),
  currentRep: document.getElementById('currentRep'),
  liveGood: document.getElementById('liveGood'),
  liveBad: document.getElementById('liveBad'),
  liveState: document.getElementById('liveState'),
  livePhase: document.getElementById('livePhase'),
  liveTimer: document.getElementById('liveTimer'),
  liveFormFeedback: document.getElementById('liveFormFeedback'),
  liveAngle: document.getElementById('liveAngle'),
  liveAngleLabel: document.getElementById('liveAngleLabel'),
  liveRepRows: document.getElementById('liveRepRows'),
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

  if (!state.streamActive) renderStats(state.data);
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
  elements.livePhase.textContent = state.repPhase;
  elements.liveAngle.textContent = state.liveAngle === null ? '--' : `${Math.round(state.liveAngle)}°`;
  elements.liveTimer.textContent = formatElapsedTime(state.currentExerciseSeconds);

  const successRate = state.currentRep ? (state.goodReps / state.currentRep) * 100 : 0;
  elements.totalReps.textContent = state.currentRep;
  elements.goodReps.textContent = state.goodReps;
  elements.badReps.textContent = state.badReps;
  elements.successRate.textContent = `${successRate.toFixed(1)}%`;
}

function resetTracking() {
  state.goodReps = 0;
  state.badReps = 0;
  state.currentRep = 0;
  state.liveState = 'Waiting';
  state.repPhase = 'UP';
  state.pushupSide = null;
  resetPushupSmoothing();
  state.liveSamples = [];
  state.liveRepLog = [];
  state.sessionStartedAt = performance.now();
  state.currentExerciseSeconds = 0;
  state.lastSampleAt = 0;
  state.liveAngle = null;
  resetRepMeasurements();
  if (state.liveChart) {
    state.liveChart.data.labels = [];
    state.liveChart.data.datasets[0].data = [];
    state.liveChart.data.datasets[0].label = 'Joint angle';
    state.liveChart.update('none');
  }
  elements.liveRepRows.innerHTML = '<tr><td colspan="4" class="empty-live-row">Reps appear here as you move.</td></tr>';
  elements.liveFormFeedback.textContent = 'Feedback will appear after your first rep.';
  elements.liveFormFeedback.className = 'live-form-feedback waiting';
  elements.liveAngleLabel.textContent = 'Joint angle';
  updateLiveMetrics();
}

function resetRepMeasurements() {
  state.minKneeAngle = 999;
  state.minThighAngle = 999;
  state.maxTorsoLean = 0;
  state.minElbowAngle = 999;
  state.worstBodyAngle = 999;
  state.worstBodySag = 0;
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

function plankTilt(shoulder, ankle) {
  return Math.atan2(Math.abs(ankle.y - shoulder.y), Math.abs(ankle.x - shoulder.x) + 1e-6) * 180 / Math.PI;
}

function getPoseReadinessHint(landmarks) {
  if (!landmarks) return 'No person detected';
  const ids = state.exercise === 'squat'
    ? chooseSide(landmarks, { left: [11, 23, 25, 27], right: [12, 24, 26, 28] })
    : (state.pushupSide ?? chooseSide(landmarks, { left: [11, 13, 15, 23, 27], right: [12, 14, 16, 24, 28] }));
  if (!ids.every((index) => (landmarks[index].visibility ?? 1) >= 0.5)) {
    return state.exercise === 'pushup'
      ? 'Show your full body from the side'
      : 'Step back and keep your full body in frame';
  }
  if (state.exercise === 'pushup' && state.repPhase === 'UP') {
    const shoulder = point(landmarks, ids[0]);
    const ankle = point(landmarks, ids[4]);
    if (plankTilt(shoulder, ankle) > 45) return 'Push-up: turn sideways and get into plank';
  }
  return '';
}

function drawOverlay(ctx, width, height, landmarks, poseHint) {
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
  if (landmarks && poseHint) {
    const message = poseHint;
    ctx.font = '600 16px sans-serif';
    const textWidth = ctx.measureText(message).width;
    const boxWidth = Math.min(width - 28, textWidth + 24);
    ctx.fillStyle = 'rgba(5, 11, 20, 0.82)';
    ctx.fillRect(14, height - 52, boxWidth, 38);
    ctx.fillStyle = '#ffd17a';
    ctx.fillText(message, 26, height - 27, boxWidth - 24);
  }
}

function scoreRep(verdict, feedback, metricLabel, metricValue) {
  state.currentRep += 1;
  state.liveState = verdict === 'good' ? 'Good' : 'Bad';
  if (verdict === 'good') state.goodReps += 1;
  else state.badReps += 1;
  updateLiveMetrics();
  state.liveRepLog.unshift({
    rep: state.currentRep,
    time: formatElapsedTime(state.currentExerciseSeconds),
    metric: `${metricValue.toFixed(0)}°`,
    verdict,
    feedback,
  });
  state.liveRepLog = state.liveRepLog.slice(0, 8);
  elements.liveRepRows.innerHTML = state.liveRepLog.map((rep) => `
    <tr>
      <td>${rep.rep}</td>
      <td>${rep.time}</td>
      <td>${rep.metric}</td>
      <td class="rep-result-cell">
        <span class="${rep.verdict === 'good' ? 'badge-good' : 'badge-bad'}">${rep.verdict === 'good' ? 'Good' : 'Adjust'}</span>
        ${rep.verdict === 'bad' ? `<small class="rep-feedback">${rep.feedback}</small>` : ''}
      </td>
    </tr>`).join('');
  elements.liveFormFeedback.textContent = feedback;
  elements.liveFormFeedback.className = `live-form-feedback ${verdict}`;
  updateLiveStatus(verdict === 'good' ? 'Good rep' : 'Bad rep', verdict === 'good' ? 'good' : 'bad');
  elements.liveSummary.textContent = feedback;
  resetRepMeasurements();
}

function formatElapsedTime(seconds) {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainingSeconds = (seconds % 60).toFixed(1).padStart(4, '0');
  return `${minutes}:${remainingSeconds}`;
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
    state.liveAngle = kneeAngle;
    elements.liveAngleLabel.textContent = 'Knee angle';
    recordLiveSample(kneeAngle, 'Knee angle');
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
        scoreRep(issues.length ? 'bad' : 'good', issues.length ? issues.join(' ') : 'Good squat rep detected.', 'Knee angle', state.minKneeAngle);
      }
    }
    return;
  }

  const ids = state.repPhase === 'DOWN' && state.pushupSide
    ? state.pushupSide
    : chooseSide(landmarks, { left: [11, 13, 15, 23, 27], right: [12, 14, 16, 24, 28] });
  const [shoulderId, elbowId, wristId, hipId, ankleId] = ids;
  if (![shoulderId, elbowId, wristId, hipId, ankleId].every(visible)) return;
  const shoulder = point(landmarks, shoulderId);
  const elbow = point(landmarks, elbowId);
  const wrist = point(landmarks, wristId);
  const hip = point(landmarks, hipId);
  const ankle = point(landmarks, ankleId);
  if (state.repPhase === 'UP') {
    state.pushupSide = ids;
    if (plankTilt(shoulder, ankle) > 45) {
      resetPushupSmoothing();
      state.pushupSide = null;
      return;
    }
  }

  const rawElbowAngle = jointAngle(shoulder, elbow, wrist);
  const alignment = bodyAlignment(shoulder, hip, ankle);
  const elbowAngle = smoothSample(state.pushupElbowSamples, rawElbowAngle);
  const bodyAngle = smoothSample(state.pushupBodySamples, alignment.angle);
  const bodySag = smoothSample(state.pushupSagSamples, alignment.sag);
  state.liveAngle = elbowAngle;
  elements.liveAngleLabel.textContent = 'Elbow angle';
  recordLiveSample(elbowAngle, 'Elbow angle');

  if (state.repPhase === 'UP' && elbowAngle < 140) {
    state.repPhase = 'DOWN';
    resetRepMeasurements();
    state.pushupSide = ids;
  }
  if (state.repPhase === 'DOWN') {
    state.minElbowAngle = Math.min(state.minElbowAngle, elbowAngle);
    if (bodyAngle < state.worstBodyAngle) {
      state.worstBodyAngle = bodyAngle;
      state.worstBodySag = bodySag;
    }
    if (elbowAngle > 155) {
      state.repPhase = 'UP';
      const issues = [];
      if (state.minElbowAngle > 115) issues.push('Half rep: lower further.');
      else if (state.minElbowAngle > 100) issues.push('Almost: lower a little more.');
      if (state.worstBodyAngle < 165) {
        issues.push(state.worstBodySag > 0 ? 'Hips sagging: tighten your core.' : 'Hips too high: lower your hips.');
      }
      scoreRep(issues.length ? 'bad' : 'good', issues.length ? issues.join(' ') : 'Good push-up rep detected.', 'Elbow angle', state.minElbowAngle);
      state.pushupSide = null;
    }
  }
}

function bodyAlignment(shoulder, hip, ankle) {
  const angle = jointAngle(shoulder, hip, ankle);
  const dx = ankle.x - shoulder.x;
  if (Math.abs(dx) < 1e-6) return { angle, sag: 0 };
  const lineY = shoulder.y + ((hip.x - shoulder.x) * (ankle.y - shoulder.y)) / dx;
  return { angle, sag: hip.y - lineY };
}

function smoothSample(samples, value) {
  samples.push(value);
  if (samples.length > 5) samples.shift();
  return samples.reduce((sum, sample) => sum + sample, 0) / samples.length;
}

function resetPushupSmoothing() {
  state.pushupElbowSamples = [];
  state.pushupBodySamples = [];
  state.pushupSagSamples = [];
}

function recordLiveSample(angle, label) {
  const now = performance.now();
  if (!state.liveChart || now - state.lastSampleAt < 140) return;
  state.lastSampleAt = now;
  state.liveSamples.push({ time: (now - state.sessionStartedAt) / 1000, angle });
  state.liveSamples = state.liveSamples.slice(-80);
  state.liveChart.data.labels = state.liveSamples.map((sample) => sample.time.toFixed(1));
  state.liveChart.data.datasets[0].label = label;
  state.liveChart.data.datasets[0].data = state.liveSamples.map((sample) => sample.angle);
  state.liveChart.update('none');
}

function createLiveChart() {
  const ctx = document.getElementById('liveAngleChart');
  state.liveChart = new Chart(ctx, {
    type: 'line',
    data: {
      labels: [],
      datasets: [{
        label: 'Joint angle',
        data: [],
        borderColor: '#57d5ff',
        backgroundColor: 'rgba(87, 213, 255, 0.12)',
        borderWidth: 2,
        pointRadius: 0,
        tension: 0.28,
        fill: true,
      }],
    },
    options: {
      animation: false,
      maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: '#9ab0d0', maxTicksLimit: 5, maxRotation: 0 },
          grid: { color: 'rgba(255,255,255,0.05)' },
          title: { display: true, text: 'Time (s)', color: '#9ab0d0', font: { size: 10 } },
        },
        y: {
          min: 0,
          max: 180,
          ticks: { color: '#9ab0d0', stepSize: 90 },
          grid: { color: 'rgba(255,255,255,0.05)' },
          title: { display: true, text: 'Angle (°)', color: '#9ab0d0', font: { size: 10 } },
        },
      },
    },
  });
}

async function ensurePoseLandmarker() {
  const model = state.exercise === 'pushup' ? 'full' : 'lite';
  if (state.poseLandmarker && state.poseModel === model) return;
  if (state.poseLandmarker) {
    state.poseLandmarker.close();
    state.poseLandmarker = null;
  }
  const vision = await import('https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/vision_bundle.mjs');
  const visionFiles = await vision.FilesetResolver.forVisionTasks(
    'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.14/wasm',
  );
  state.poseLandmarker = await vision.PoseLandmarker.createFromOptions(visionFiles, {
    baseOptions: {
      modelAssetPath: `https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_${model}/float16/1/pose_landmarker_${model}.task`,
    },
    runningMode: 'VIDEO',
    numPoses: 1,
    minPoseDetectionConfidence: 0.6,
    minTrackingConfidence: 0.6,
  });
  state.poseModel = model;
}

async function startCapture() {
  if (state.streamActive) stopCapture();
  clearVideoSource();

  state.exercise = elements.exerciseSelect.value;
  state.sourceMode = 'camera';
  state.lastPoseTimestamp = -1;
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
    state.sessionStartedAt = performance.now();
    state.currentExerciseSeconds = 0;
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

function clearVideoSource() {
  const video = elements.cameraVideo;
  video.pause();
  if (state.videoStream) {
    state.videoStream.getTracks().forEach((track) => track.stop());
    state.videoStream = null;
  }
  video.srcObject = null;
  if (state.uploadedVideoUrl) {
    URL.revokeObjectURL(state.uploadedVideoUrl);
    state.uploadedVideoUrl = null;
  }
  video.removeAttribute('src');
  video.load();
  video.controls = false;
  document.querySelector('.camera-wrap').style.aspectRatio = '16 / 9';
}

async function analyzeUploadedVideo() {
  const file = elements.videoFileInput.files[0];
  if (!file) return;
  if (state.streamActive) stopCapture();
  else clearVideoSource();

  state.exercise = elements.videoExerciseSelect.value;
  state.sourceMode = 'file';
  state.lastPoseTimestamp = -1;
  state.uploadedFileName = file.name;
  elements.exerciseBadge.textContent = state.exercise === 'squat' ? 'Squat' : 'Push-up';
  resetTracking();
  updateLiveStatus('Preparing video', 'idle');
  elements.liveSummary.textContent = `Loading ${file.name} for analysis.`;

  try {
    await ensurePoseLandmarker();
    const video = elements.cameraVideo;
    state.uploadedVideoUrl = URL.createObjectURL(file);
    video.controls = false;
    video.muted = true;
    video.src = state.uploadedVideoUrl;
    if (video.readyState < HTMLMediaElement.HAVE_METADATA) {
      await new Promise((resolve, reject) => {
        video.addEventListener('loadedmetadata', resolve, { once: true });
        video.addEventListener('error', () => reject(new Error('The selected video could not be loaded.')), { once: true });
      });
    }
    document.querySelector('.camera-wrap').style.aspectRatio = `${video.videoWidth} / ${video.videoHeight}`;
    await video.play();
    state.sessionStartedAt = performance.now();
    state.currentExerciseSeconds = 0;
    state.streamActive = true;
    updateLiveStatus('Analyzing video', 'idle');
    elements.liveSummary.textContent = `Analyzing ${file.name}.`;
    processFrames();
  } catch (error) {
    console.error(error);
    state.streamActive = false;
    clearVideoSource();
    state.sourceMode = null;
    updateLiveStatus('Video error', 'bad');
    elements.liveSummary.textContent = 'Could not play this video. Try a supported MP4, MOV, WebM, or AVI file.';
  }
}

function stopCapture() {
  state.streamActive = false;
  if (state.animationId) cancelAnimationFrame(state.animationId);
  state.animationId = null;
  clearVideoSource();
  state.sourceMode = null;
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

  const timestamp = state.sourceMode === 'file' ? video.currentTime * 1000 : performance.now();
  if (state.sourceMode === 'file' && timestamp <= state.lastPoseTimestamp) {
    state.animationId = requestAnimationFrame(processFrames);
    return;
  }
  state.lastPoseTimestamp = timestamp;
  state.currentExerciseSeconds = state.sourceMode === 'file'
    ? video.currentTime
    : (timestamp - state.sessionStartedAt) / 1000;
  elements.liveTimer.textContent = formatElapsedTime(state.currentExerciseSeconds);
  const result = state.poseLandmarker.detectForVideo(video, timestamp);
  const landmarks = result.landmarks?.[0] ?? null;
  const poseHint = getPoseReadinessHint(landmarks);
  const poseReady = !poseHint;
  if (poseReady) {
    trackPoseRep(landmarks);
    elements.livePhase.textContent = state.repPhase;
    elements.liveAngle.textContent = state.liveAngle === null ? '--' : `${Math.round(state.liveAngle)}°`;
  } else if (!landmarks) {
    elements.livePhase.textContent = 'No pose';
    elements.liveAngle.textContent = '--';
  } else {
    elements.livePhase.textContent = 'Reframe';
    elements.liveAngle.textContent = '--';
  }
  drawOverlay(ctx, width, height, landmarks, poseHint);
  state.animationId = requestAnimationFrame(processFrames);
}

function finishUploadedVideo() {
  if (state.sourceMode !== 'file') return;
  state.streamActive = false;
  if (state.animationId) cancelAnimationFrame(state.animationId);
  state.animationId = null;
  state.liveState = 'Complete';
  elements.liveState.textContent = 'Complete';
  elements.livePhase.textContent = 'Complete';
  updateLiveStatus('Video complete', 'idle');
  elements.liveSummary.textContent = `Finished analyzing ${state.uploadedFileName}.`;
}

async function initDashboard() {
  try {
    await loadFiles();
  } catch (error) {
    console.error('CSV load failed', error);
  }

  createLiveChart();

  elements.startCaptureBtn.addEventListener('click', startCapture);
  elements.stopCaptureBtn.addEventListener('click', stopCapture);
  elements.videoFileInput.addEventListener('change', () => {
    const file = elements.videoFileInput.files[0];
    elements.uploadedVideoName.textContent = file ? file.name : 'No video selected';
    elements.analyzeVideoBtn.disabled = !file;
    if (file) {
      updateLiveStatus('Video ready', 'idle');
      elements.liveSummary.textContent = 'Choose an exercise, then analyze this video.';
    }
  });
  elements.analyzeVideoBtn.addEventListener('click', analyzeUploadedVideo);
  elements.cameraVideo.addEventListener('ended', finishUploadedVideo);
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
