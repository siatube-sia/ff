import './style.css';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

const $ = (selector) => document.querySelector(selector);

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

let videoFile = null;
let audioFile = null;
let ffmpeg = null;
let ffmpegLoaded = false;
let videoObjectUrl = null;
let audioObjectUrl = null;
let resultObjectUrl = null;

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

function extension(file, fallback) {
  const match = file.name.match(/\.([a-zA-Z0-9]+)$/);
  return match ? match[1].toLowerCase() : fallback;
}

function revoke(url) {
  if (url) URL.revokeObjectURL(url);
}

function updateReadyState() {
  mergeButton.disabled = !(videoFile && audioFile);
  if (videoFile && audioFile) {
    setStatus('準備完了。「映像と音声を結合」を押してください。', 0);
  }
}

function setVideo(file) {
  if (!file?.type.startsWith('video/')) {
    setStatus('映像ファイルを選択してください。', 0);
    return;
  }
  videoFile = file;
  revoke(videoObjectUrl);
  videoObjectUrl = URL.createObjectURL(file);
  videoPreview.src = videoObjectUrl;
  videoName.textContent = `${file.name} · ${fileSize(file.size)}`;
  updateReadyState();
}

function setAudio(file) {
  if (!file?.type.startsWith('audio/')) {
    setStatus('音声ファイルを選択してください。', 0);
    return;
  }
  audioFile = file;
  revoke(audioObjectUrl);
  audioObjectUrl = URL.createObjectURL(file);
  audioPreview.src = audioObjectUrl;
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
      setStatus('結合処理中…', pct);
    }
  });
  ffmpeg.on('log', ({ message }) => console.debug('[ffmpeg]', message));

  const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/esm';
  await ffmpeg.load({
    coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
    wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
  });

  ffmpegLoaded = true;
  setStatus('FFmpegエンジンの準備ができました。', 8);
  return ffmpeg;
}

async function safeDelete(name) {
  if (!ffmpeg) return;
  try { await ffmpeg.deleteFile(name); } catch { /* ignore */ }
}

async function runMerge() {
  if (!videoFile || !audioFile) return;

  mergeButton.disabled = true;
  resetButton.disabled = true;
  resultPanel.hidden = true;
  revoke(resultObjectUrl);
  resultObjectUrl = null;

  const vName = `video.${extension(videoFile, 'mp4')}`;
  const aName = `audio.${extension(audioFile, 'mp3')}`;
  const outName = 'merged.mp4';

  try {
    const engine = await ensureFFmpeg();
    setStatus('ファイルをメモリへ読み込んでいます…', 9);

    await engine.writeFile(vName, await fetchFile(videoFile));
    await engine.writeFile(aName, await fetchFile(audioFile));

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
      await engine.exec(args);
    } catch (firstError) {
      if (transcodeVideo.checked) throw firstError;

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
      await engine.exec(fallback);
    }

    const data = await engine.readFile(outName);
    const blob = new Blob([data.buffer], { type: 'video/mp4' });
    resultObjectUrl = URL.createObjectURL(blob);
    resultPreview.src = resultObjectUrl;
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
    await safeDelete(vName);
    await safeDelete(aName);
    await safeDelete(outName);
    mergeButton.disabled = !(videoFile && audioFile);
    resetButton.disabled = false;
  }
}

mergeButton.addEventListener('click', runMerge);

resetButton.addEventListener('click', async () => {
  videoFile = null;
  audioFile = null;
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
  mergeButton.disabled = true;
  setStatus('映像と音声を選択してください。', 0);
});

window.addEventListener('beforeunload', () => {
  revoke(videoObjectUrl);
  revoke(audioObjectUrl);
  revoke(resultObjectUrl);
});
