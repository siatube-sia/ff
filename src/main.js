import './style.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { toBlobURL } from '@ffmpeg/util';
import { estimateMemory, memoryEnvironment, memoryWarning, formatMemory, memoryBudget, estimateCutMemory, recommendSegment } from './memory.js';
import { parseTime, formatTime, validateRange, mountInput, probeDuration, cutArguments, execute } from './media.js';

const $ = (selector) => document.querySelector(selector);

const themeSelect = $('#themeSelect');
const systemTheme = window.matchMedia('(prefers-color-scheme: dark)');
try {
  const savedTheme = localStorage.getItem('av-merger-theme');
  if (['system', 'light', 'dark'].includes(savedTheme)) themeSelect.value = savedTheme;
} catch { /* Theme switching still works when storage is unavailable. */ }

function applyTheme() {
  document.documentElement.dataset.theme = themeSelect.value === 'system'
    ? (systemTheme.matches ? 'dark' : 'light')
    : themeSelect.value;
}
themeSelect.addEventListener('change', () => {
  applyTheme();
  try { localStorage.setItem('av-merger-theme', themeSelect.value); } catch { /* Storage is optional. */ }
});
systemTheme.addEventListener('change', applyTheme);
applyTheme();

const videoInput = $('#videoInput');
const audioInput = $('#audioInput');
const videoDrop = $('#videoDrop');
const audioDrop = $('#audioDrop');
const videoName = $('#videoName');
const audioName = $('#audioName');
const videoPreview = $('#videoPreview');
const audioPreview = $('#audioPreview');
const loopAudio = $('#loopAudio');
const transcodeVideo = $('#transcodeVideo');
const mergeButton = $('#mergeButton');
const resetButton = $('#resetButton');
const statusText = $('#statusText');
const progressText = $('#progressText');
const progressBar = $('#progressBar');
const resultPanel = $('#resultPanel');
const resultPreview = $('#resultPreview');
const downloadButton = $('#downloadButton');
const taskMode = $('#taskMode');
const cutStart = $('#cutStart');
const cutEnd = $('#cutEnd');
const resultAudio = $('#resultAudio');

let videoFile = null;
let audioFile = null;
let ffmpeg = null;
let ffmpegLoaded = false;
let videoObjectUrl = null;
let audioObjectUrl = null;
let resultObjectUrl = null;
let busy = false;
let lastCut = null;
let videoDuration = null;
let audioDuration = null;
let autoPlanPending = true;
let segmentStep = null;
let segmentOrigin = 0;
let segmentIndex = 1;
let warningSignature = '';
let currentWarning = '';

function cutOptions() {
  return { kind: mode(), width: videoPreview.videoWidth || 0, height: videoPreview.videoHeight || 0 };
}

function preparePlan() {
  autoPlanPending = true;
  segmentStep = null;
  segmentOrigin = 0;
  segmentIndex = 1;
  cutStart.value = '0:00';
  cutEnd.value = '';
  $('#segmentSeconds').value = '';
}

function applyRecommended(force = false) {
  if (mode() === 'merge' || (!autoPlanPending && !force) || lastCut) return;
  const file = mode() === 'audio' ? audioFile : videoFile;
  const duration = selectedDuration();
  const plan = file && recommendSegment(file.size, duration, memoryEnvironment(navigator), cutOptions());
  if (!plan) return;
  // If both originals are selected, use the shorter recommendation for both so
  // their saved intervals can subsequently be paired without changing timing.
  const otherFile = mode() === 'audio' ? videoFile : audioFile;
  const otherDuration = mode() === 'audio' ? videoDuration : audioDuration;
  const otherPlan = otherFile && recommendSegment(otherFile.size, otherDuration, memoryEnvironment(navigator),
    { ...cutOptions(), kind: mode() === 'audio' ? 'video' : 'audio' });
  if (otherPlan && Math.abs(duration - otherDuration) < 0.1) plan.seconds = Math.min(plan.seconds, otherPlan.seconds);
  const start = parseTime(cutStart.value);
  segmentOrigin = Number.isFinite(start) && start < duration ? start : 0;
  segmentIndex = 1;
  segmentStep = plan.seconds;
  cutStart.value = formatTime(segmentOrigin);
  cutEnd.value = formatTime(Math.min(duration, segmentOrigin + segmentStep));
  $('#segmentSeconds').value = segmentStep;
  autoPlanPending = false;
}

function updateSegmentLabel() {
  const duration = selectedDuration();
  const count = duration > 0 && segmentStep > 0 ? Math.ceil((duration - segmentOrigin) / segmentStep) : null;
  $('#segmentPlan').textContent = count
    ? `${segmentIndex} / ${count} 本目 · 1本 ${segmentStep}秒（最後は残りの長さ）。保存後は次の範囲へ進めます。`
    : '長さを確認後、メモリ使用量に合わせた秒数を自動設定します。手動指定もできます。';
}

function allowProcessing() {
  updateMemoryEstimate();
  if (currentWarning && !$('#riskConfirm').checked) {
    setStatus('負荷が大きい処理です。分割を選ぶか、警告を確認してください。', 0);
    $('#splitGuidance').scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }
  return true;
}

function mode() { return taskMode.value || 'merge'; }

function selectedDuration() { return mode() === 'audio' ? audioDuration : videoDuration; }

function ready() {
  return !busy && (mode() === 'merge' ? videoFile && audioFile : mode() === 'audio' ? audioFile : videoFile);
}

function releaseResult() {
  resultPreview.removeAttribute('src');
  resultAudio.removeAttribute('src');
  resultPreview.load();
  resultAudio.load();
  downloadButton.removeAttribute('href');
  revoke(resultObjectUrl);
  resultObjectUrl = null;
  resultPanel.hidden = true;
  $('#cutActions').hidden = true;
  $('#savedConfirm').checked = false;
  lastCut = null;
}

function setBusy(value) {
  busy = value;
  for (const control of [videoInput, audioInput, loopAudio, transcodeVideo, taskMode, cutStart, cutEnd, resetButton,
    $('#segmentSeconds'), $('#autoSegmentButton'), $('#splitVideoButton'), $('#splitAudioButton'), $('#shortenButton'), $('#riskConfirm')]) {
    control.disabled = value;
  }
  // Keep a completed cut until the user confirms it was saved.
  mergeButton.disabled = !ready() || Boolean(lastCut);
}

function refreshMode() {
  const isCut = mode() !== 'merge';
  $('#cutSettings').hidden = !isCut;
  $('#mergeSettings').hidden = isCut;
  videoDrop.hidden = mode() === 'audio';
  audioDrop.hidden = mode() === 'video';
  $('#audioPreviewPanel').hidden = !audioFile || mode() === 'video';
  videoPreview.hidden = !videoFile || mode() === 'audio';
  $('#emptyPreview').hidden = !videoPreview.hidden;
  $('#emptyPreviewText').textContent = mode() === 'audio' ? '音声はファイル選択欄のプレーヤーで確認できます' : '映像を選択すると、ここで確認できます';
  $('#pageTitle').textContent = isCut ? `${mode() === 'audio' ? '音声' : '映像'}のみ切り出す` : '音声と映像を結合';
  $('#pageDescription').textContent = isCut
    ? '必要な時間帯だけ切り出して保存。元ファイルを一括コピーせずに読み込みます。形式情報や直前のフレームを読む場合もあります。'
    : '動画と音声を選んで、ひとつのMP4に。動画の元の音声は、選択した音声に置き換わります。';
  mergeButton.textContent = isCut ? '指定範囲を切り出す' : '映像と音声を結合';
  updateReadyState();
}

taskMode.addEventListener('change', () => {
  if (busy) return;
  videoPreview.pause();
  audioPreview.pause();
  releaseResult();
  preparePlan();
  applyRecommended();
  refreshMode();
});

for (const input of [cutStart, cutEnd]) input.addEventListener('input', () => {
  autoPlanPending = false;
  segmentOrigin = parseTime(cutStart.value);
  segmentStep = parseTime(cutEnd.value) - segmentOrigin;
  segmentIndex = 1;
  $('#segmentSeconds').value = segmentStep > 0 ? segmentStep : '';
  updateMemoryEstimate();
});
$('#segmentSeconds').addEventListener('input', () => {
  autoPlanPending = false;
  const seconds = Number($('#segmentSeconds').value);
  if (!(seconds > 0) || !Number.isFinite(seconds)) {
    $('#riskConfirm').checked = false;
    setStatus('1本あたりの秒数に、0より大きい数を入力してください。', 0);
    return;
  }
  segmentStep = seconds;
  segmentIndex = 1;
  segmentOrigin = Number.isFinite(parseTime(cutStart.value)) ? parseTime(cutStart.value) : 0;
  cutStart.value = formatTime(segmentOrigin);
  cutEnd.value = formatTime(Math.min(selectedDuration() || Infinity, segmentOrigin + seconds));
  updateMemoryEstimate();
});
function chooseRecommended() {
  if (busy || lastCut) return;
  autoPlanPending = true;
  applyRecommended(true);
  updateMemoryEstimate();
  if (autoPlanPending) setStatus('長さの確認後に推奨秒数を設定します。「指定範囲を切り出す」で長さを確認できます。', 0);
}
$('#autoSegmentButton').addEventListener('click', chooseRecommended);
$('#shortenButton').addEventListener('click', chooseRecommended);
for (const kind of ['video', 'audio']) {
  $(`#split${kind === 'video' ? 'Video' : 'Audio'}Button`).addEventListener('click', () => {
    if (busy || lastCut) return;
    taskMode.value = kind;
    releaseResult();
    preparePlan();
    applyRecommended();
    refreshMode();
    $('#cutSettings').scrollIntoView({ behavior: 'smooth', block: 'center' });
  });
}
for (const [preview, kind] of [[videoPreview, 'video'], [audioPreview, 'audio']]) {
  preview.addEventListener('loadedmetadata', () => {
    const duration = Number.isFinite(preview.duration) && preview.duration > 0 ? preview.duration : null;
    if (kind === 'video') videoDuration = duration;
    else audioDuration = duration;
    if (!busy) applyRecommended();
    updateMemoryEstimate();
  });
}

function updateMemoryEstimate() {
  const environment = memoryEnvironment(navigator);
  const isCut = mode() !== 'merge';
  const file = mode() === 'audio' ? audioFile : videoFile;
  const hasFiles = isCut ? Boolean(file) : Boolean(videoFile || audioFile);
  const duration = selectedDuration();
  const length = parseTime(cutEnd.value) - parseTime(cutStart.value);
  const hasRange = duration > 0 && Number.isFinite(length) && length > 0;
  // Proportional size is only a planning heuristic (variable bitrates and
  // re-encoding can produce a much larger output).
  const estimated = isCut ? estimateCutMemory(file?.size || 0, duration, length, cutOptions())
    : mergeEstimate();
  $('#memoryEstimate').textContent = hasFiles
    ? `推定メモリ使用量：約 ${formatMemory(estimated)}${isCut ? (hasRange ? '（指定区間の概算）' : '（長さ未取得のため全体で概算）') : videoFile && audioFile ? '' : '（選択済みファイルのみ）'}`
    : 'ファイルを選ぶとメモリ使用量の目安を表示します。';
  $('#deviceMemory').textContent = environment.deviceBytes
    ? `端末メモリ：約 ${formatMemory(environment.deviceBytes)}（空き容量ではありません）`
    : 'このブラウザでは端末メモリ容量を取得できません。';
  const warning = hasFiles ? memoryWarning(estimated, environment, {
    ...cutOptions(), transcode: mode() === 'video' || (mode() === 'merge' && transcodeVideo.checked),
  }) : '';
  const signature = JSON.stringify([mode(), videoFile?.name, audioFile?.name, estimated, cutStart.value, cutEnd.value, warning, transcodeVideo.checked, loopAudio.checked]);
  if (signature !== warningSignature) $('#riskConfirm').checked = false;
  warningSignature = signature;
  currentWarning = warning;
  $('#memoryWarning').textContent = warning;
  $('#memoryWarning').hidden = !warning;
  $('#splitGuidance').hidden = !warning;
  $('#splitVideoButton').hidden = isCut || !videoFile;
  $('#splitAudioButton').hidden = isCut || !audioFile;
  $('#shortenButton').hidden = !isCut;
  updateSegmentLabel();
  $('#sourceDuration').textContent = duration ? `元ファイルの長さ：${formatTime(duration)}` : '長さは読み込めた時点で表示します。';
  $('#memoryNote').textContent = isCut
    ? '時間の割合から求めたファイルサイズの約6倍＋512MBで概算。出力と変換にはメモリが必要です。実測値ではなく、解像度・形式によって増える場合があります。'
    : 'ファイル合計の約4倍＋256MB、H.264変換時は約6倍＋512MBの概算です。';
  $('#memoryNote').textContent += ` 処理目安は${formatMemory(memoryBudget(environment))}。空きメモリの実測値ではなく、成功を保証するものではありません。`;
}

function mergeEstimate(transcode = transcodeVideo.checked) {
  const duration = loopAudio.checked ? videoDuration : Math.min(videoDuration || 0, audioDuration || 0);
  const extraAudio = duration > 0 ? Math.max(0, duration * 24000 - (audioFile?.size || 0)) * 3 : 0;
  const frames = transcode ? (videoPreview.videoWidth || 0) * (videoPreview.videoHeight || 0) * 24 : 0;
  return estimateMemory(videoFile?.size || 0, audioFile?.size || 0, transcode) + extraAudio + frames;
}

transcodeVideo.addEventListener('change', updateMemoryEstimate);
loopAudio.addEventListener('change', updateMemoryEstimate);
updateMemoryEstimate();

function setStatus(text, percent = null) {
  statusText.textContent = text;
  if (percent !== null) {
    const safe = Math.max(0, Math.min(100, Math.round(percent)));
    progressText.textContent = `${safe}%`;
    progressBar.style.width = `${safe}%`;
  }
}

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function revoke(url) {
  if (url) URL.revokeObjectURL(url);
}

function updateReadyState() {
  updateMemoryEstimate();
  mergeButton.disabled = !ready() || Boolean(lastCut);
  setStatus(ready() ? (mode() === 'merge' ? '準備完了。「映像と音声を結合」を押してください。' : '開始・終了を指定して切り出してください。')
    : (mode() === 'merge' ? '映像と音声を選択してください。' : `${mode() === 'audio' ? '音声' : '映像'}ファイルを選択してください。`), 0);
}

function setVideo(file) {
  if (busy || !file) return;
  if (!file.type.startsWith('video/') && !/\.(mp4|webm|mov|m4v)$/i.test(file.name)) {
    setStatus('映像ファイルを選択してください。', 0);
    return;
  }
  releaseResult();
  videoFile = file;
  $('#riskConfirm').checked = false;
  videoDuration = null;
  if (mode() === 'video') preparePlan();
  revoke(videoObjectUrl);
  videoObjectUrl = URL.createObjectURL(file);
  videoPreview.src = videoObjectUrl;
  videoPreview.hidden = false;
  $('#emptyPreview').hidden = true;
  videoName.textContent = `${file.name} · ${fileSize(file.size)}`;
  updateReadyState();
}

function setAudio(file) {
  if (busy || !file) return;
  // WebM is a container: audio-only files may be reported as video/webm,
  // application/octet-stream, or have no MIME type depending on the device.
  const mimeType = file.type.split(';', 1)[0].trim().toLowerCase();
  const isWebM = mimeType === 'video/webm' || /\.webm$/i.test(file.name);
  if (!mimeType.startsWith('audio/') && !isWebM && !/\.m4a$/i.test(file.name)) {
    setStatus('音声ファイルを選択してください。', 0);
    return;
  }
  releaseResult();
  audioFile = file;
  $('#riskConfirm').checked = false;
  audioDuration = null;
  if (mode() === 'audio') preparePlan();
  revoke(audioObjectUrl);
  audioObjectUrl = URL.createObjectURL(file);
  audioPreview.src = audioObjectUrl;
  $('#audioPreviewPanel').hidden = false;
  audioName.textContent = `${file.name} · ${fileSize(file.size)}`;
  updateReadyState();
}

function setupDropZone(zone, input, handler) {
  input.addEventListener('change', () => handler(input.files?.[0]));

  ['dragenter', 'dragover'].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.add('dragover');
    });
  });

  ['dragleave', 'drop'].forEach((eventName) => {
    zone.addEventListener(eventName, (event) => {
      event.preventDefault();
      zone.classList.remove('dragover');
    });
  });

  zone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) handler(file);
  });
}

setupDropZone(videoDrop, videoInput, setVideo);
setupDropZone(audioDrop, audioInput, setAudio);

async function ensureFFmpeg() {
  if (ffmpegLoaded && ffmpeg) return ffmpeg;

  setStatus('FFmpegエンジンを読み込んでいます…（初回のみ約30MB）', 2);

  ffmpeg = new FFmpeg();
  ffmpeg.on('progress', ({ progress }) => {
    if (Number.isFinite(progress)) {
      const pct = 10 + Math.max(0, Math.min(1, progress)) * 85;
      setStatus(mode() === 'merge' ? '結合処理中…' : '切り出し処理中…', pct);
    }
  });
  ffmpeg.on('log', ({ message }) => console.debug('[ffmpeg]', message));

  const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  let coreURL;
  let wasmURL;
  try {
    coreURL = await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript');
    wasmURL = await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm');
    await ffmpeg.load({ coreURL, wasmURL });
  } finally {
    revoke(coreURL);
    revoke(wasmURL);
  }

  ffmpegLoaded = true;
  setStatus('FFmpegエンジンの準備ができました。', 8);
  return ffmpeg;
}

async function safeDelete(name) {
  if (!ffmpeg) return;
  try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
}

async function runMerge() {
  if (!ready() || (lastCut && !$('#savedConfirm').checked)) return;
  if (mode() !== 'merge') return runCut();
  if (!allowProcessing()) return;

  setBusy(true);
  releaseResult();

  let vName;
  let aName;
  const outName = 'merged.mp4';

  try {
    const engine = await ensureFFmpeg();
    setStatus('ファイルを部分読み込みで開いています…', 9);
    vName = await mountInput(engine, videoFile, '/video');
    aName = await mountInput(engine, audioFile, '/audio');

    const args = [];
    args.push('-i', vName);
    if (loopAudio.checked) args.push('-stream_loop', '-1');
    args.push('-i', aName);
    args.push('-map', '0:v:0', '-map', '1:a:0');

    if (transcodeVideo.checked) {
      args.push('-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23');
    } else {
      args.push('-c:v', 'copy');
    }

    args.push('-c:a', 'aac', '-b:a', '192k', '-shortest', '-movflags', '+faststart', '-y', outName);

    setStatus('結合処理中…', 10);

    try {
      await execute(engine, args);
    } catch (firstError) {
      if (transcodeVideo.checked) throw firstError;

      const fallbackWarning = memoryWarning(mergeEstimate(true), memoryEnvironment(navigator),
        { ...cutOptions(), transcode: true });
      if (fallbackWarning) {
        transcodeVideo.checked = true;
        updateMemoryEstimate();
        throw new Error('自動変換では負荷が大きくなるため停止しました。分割を選ぶか、変換設定の警告を確認して再実行してください。');
      }

      // MP4にそのまま入れられない映像コーデックだった場合だけH.264へフォールバック。
      setStatus('映像形式の互換性を確保するためH.264へ変換しています…', 12);
      await safeDelete(outName);

      const fallback = [];
      fallback.push('-i', vName);
      if (loopAudio.checked) fallback.push('-stream_loop', '-1');
      fallback.push('-i', aName);
      fallback.push(
        '-map', '0:v:0', '-map', '1:a:0',
        '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '192k',
        '-shortest', '-movflags', '+faststart', '-y', outName
      );
      await execute(engine, fallback);
    }

    const data = await engine.readFile(outName);
    const blob = new Blob([data], { type: 'video/mp4' });
    resultObjectUrl = URL.createObjectURL(blob);
    resultPreview.src = resultObjectUrl;
    resultPreview.hidden = false;
    resultAudio.hidden = true;
    $('#resultTitle').textContent = '結合完了';
    downloadButton.textContent = 'MP4を保存';
    downloadButton.href = resultObjectUrl;

    const base = videoFile.name.replace(/\.[^.]+$/, '') || 'merged';
    downloadButton.download = `${base}-with-audio.mp4`;
    resultPanel.hidden = false;
    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setStatus(`完了しました。出力サイズ: ${fileSize(blob.size)}`, 100);
  } catch (error) {
    console.error(error);
    setStatus(`処理に失敗しました: ${error?.message || String(error)}`, 0);
  } finally {
    releaseEngine();
    setBusy(false);
  }
}

function releaseEngine() {
  ffmpeg?.terminate();
  ffmpeg = null;
  ffmpegLoaded = false;
}

async function runCut() {
  const kind = mode();
  const file = kind === 'audio' ? audioFile : videoFile;
  let start = parseTime(cutStart.value);
  let end = parseTime(cutEnd.value);
  try {
    if (!autoPlanPending) {
      const seconds = Number($('#segmentSeconds').value);
      if (!(seconds > 0) || !Number.isFinite(seconds)) throw new Error('1本あたりの秒数に、0より大きい数を入力してください。');
      validateRange(start, end, selectedDuration());
    }
  }
  catch (error) { setStatus(error.message, 0); return; }
  if (!autoPlanPending && !allowProcessing()) return;

  setBusy(true);
  releaseResult();
  // Stop playback while the worker is decoding the same source.
  videoPreview.pause();
  audioPreview.pause();
  try {
    const engine = await ensureFFmpeg();
    const path = await mountInput(engine, file, '/input');
    const duration = await probeDuration(engine, path, kind);
    if (kind === 'audio') audioDuration = duration;
    else videoDuration = duration;
    const neededPlan = autoPlanPending;
    applyRecommended();
    start = parseTime(cutStart.value);
    end = parseTime(cutEnd.value);
    updateMemoryEstimate();
    validateRange(start, end, duration);
    if (neededPlan) {
      setStatus('長さを確認し、推奨秒数を設定しました。範囲を確認してもう一度切り出しを押してください。', 0);
      return;
    }
    if (!allowProcessing()) return;
    setStatus(`${formatTime(start)}〜${formatTime(end)}を切り出しています…`, 10);
    await execute(engine, cutArguments(path, kind, start, end));
    const suffix = kind === 'audio' ? 'm4a' : 'mp4';
    const data = await engine.readFile(`cut.${suffix}`);
    if (!data.byteLength) throw new Error('指定範囲のデータを出力できませんでした。');
    const blob = new Blob([data], { type: kind === 'audio' ? 'audio/mp4' : 'video/mp4' });
    resultObjectUrl = URL.createObjectURL(blob);
    const preview = kind === 'audio' ? resultAudio : resultPreview;
    preview.src = resultObjectUrl;
    resultAudio.hidden = kind !== 'audio';
    resultPreview.hidden = kind === 'audio';
    downloadButton.href = resultObjectUrl;
    const base = file.name.replace(/\.[^.]+$/, '') || kind;
    const total = segmentStep > 0 ? Math.ceil((duration - segmentOrigin) / segmentStep) : 1;
    downloadButton.download = `${base}-part${String(segmentIndex).padStart(3, '0')}-${start}s-${end}s.${suffix}`;
    downloadButton.textContent = `${suffix.toUpperCase()}を保存`;
    $('#resultTitle').textContent = `${segmentIndex} / ${total} 本目：${formatTime(start)}〜${formatTime(end)}`;
    lastCut = { start, end, duration, step: segmentStep || end - start, index: segmentIndex, origin: segmentOrigin };
    $('#cutActions').hidden = false;
    $('#savedConfirm').checked = false;
    $('#nextRangeButton').disabled = true;
    $('#useMergeButton').disabled = true;
    $('#cutResultNote').textContent = end >= duration - 0.05
      ? 'ファイルの最後まで切り出しました。保存後、切り出した映像と音声を結合できます。'
      : `残り ${Math.max(0, total - segmentIndex)} 本。保存を確認すると、次の区間に進めます。`;
    resultPanel.hidden = false;
    resultPanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    setStatus(`切り出し完了。出力サイズ: ${fileSize(blob.size)}`, 100);
  } catch (error) {
    console.error(error);
    setStatus(`切り出しに失敗しました: ${error?.message || String(error)}`, 0);
  } finally {
    // Terminating the worker releases MEMFS, mounts and the WASM heap, including
    // allocations that deleting an output file alone would not return to the OS.
    releaseEngine();
    setBusy(false);
  }
}

$('#savedConfirm').addEventListener('change', () => {
  const saved = $('#savedConfirm').checked;
  $('#nextRangeButton').disabled = !saved || !lastCut || lastCut.end >= lastCut.duration - 0.05;
  $('#useMergeButton').disabled = !saved || !lastCut;
  mergeButton.disabled = !saved || !ready();
});

$('#nextRangeButton').addEventListener('click', () => {
  if (busy || !lastCut || !$('#savedConfirm').checked || lastCut.end >= lastCut.duration - 0.05) return;
  const { end, duration, step, index, origin } = lastCut;
  releaseResult();
  segmentStep = step;
  segmentIndex = index + 1;
  segmentOrigin = origin;
  autoPlanPending = false;
  cutStart.value = formatTime(end);
  cutEnd.value = formatTime(Math.min(duration, end + step));
  $('#segmentSeconds').value = step;
  updateReadyState();
  cutStart.focus();
});

$('#useMergeButton').addEventListener('click', () => {
  if (busy || !lastCut || !$('#savedConfirm').checked) return;
  resetFiles();
  taskMode.value = 'merge';
  // Matched cut ranges should not repeat their last audio frame by default.
  loopAudio.checked = false;
  refreshMode();
  setStatus('保存した同じ区間の映像と音声を選択してください。', 0);
});

mergeButton.addEventListener('click', runMerge);

function resetFiles() {
  if (busy) return;
  releaseResult();
  releaseEngine();
  videoFile = null;
  audioFile = null;
  videoDuration = audioDuration = null;
  preparePlan();
  videoInput.value = '';
  audioInput.value = '';
  videoName.textContent = '未選択';
  audioName.textContent = '未選択';
  videoPreview.removeAttribute('src');
  audioPreview.removeAttribute('src');
  resultPreview.removeAttribute('src');
  videoPreview.load();
  audioPreview.load();
  resultPreview.load();
  resultPanel.hidden = true;
  revoke(videoObjectUrl);
  revoke(audioObjectUrl);
  revoke(resultObjectUrl);
  videoObjectUrl = audioObjectUrl = resultObjectUrl = null;
  videoPreview.hidden = true;
  $('#emptyPreview').hidden = false;
  $('#audioPreviewPanel').hidden = true;
  updateMemoryEstimate();
  mergeButton.disabled = true;
  setStatus('映像と音声を選択してください。', 0);
}

resetButton.addEventListener('click', () => { resetFiles(); refreshMode(); });

refreshMode();

window.addEventListener('beforeunload', () => {
  releaseEngine();
  revoke(videoObjectUrl);
  revoke(audioObjectUrl);
  revoke(resultObjectUrl);
});
