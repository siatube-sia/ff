export function parseTime(value) {
  const text = String(value).trim();
  if (!/^\d+(?::\d{1,2}){0,2}(?:\.\d+)?$/.test(text)) return NaN;
  const parts = text.split(':').map(Number);
  if (parts.slice(1).some(part => part >= 60)) return NaN;
  const seconds = parts.reduce((total, part) => total * 60 + part, 0);
  return Number.isFinite(seconds) ? seconds : NaN;
}

export function formatTime(seconds) {
  const ms = Math.round(seconds * 1000);
  const minutes = Math.floor(ms / 60000);
  const remainder = ((ms % 60000) / 1000).toFixed(3).replace(/\.?0+$/, '');
  return `${minutes}:${remainder.padStart(2, '0')}`;
}

export function validateRange(start, end, duration = null) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
    throw new Error('開始・終了を「分:秒」または秒数で入力し、終了を開始より後にしてください。');
  }
  if (Number.isFinite(duration) && (start >= duration || end > duration + 0.05)) {
    throw new Error(`指定範囲がファイルの長さ（${formatTime(duration)}）を超えています。`);
  }
}

// File/Blob handles are mounted read-only. Do not replace this with fetchFile or
// arrayBuffer: those copy the entire input before FFmpeg can seek into it.
export async function mountInput(engine, file, directory) {
  await engine.createDir(directory);
  const name = 'source';
  const mounted = await engine.mount('WORKERFS', { blobs: [{ name, data: file }] }, directory);
  if (!mounted) throw new Error('この処理エンジンは省メモリ読み込みに対応していません。ページを再読み込みしてください。');
  return `${directory}/${name}`;
}

export async function probeDuration(engine, path, kind) {
  const code = await engine.ffprobe([
    '-v', 'error', '-select_streams', kind === 'audio' ? 'a:0' : 'v:0',
    '-show_entries', 'format=duration:stream=duration,codec_type', '-of', 'json',
    path, '-o', 'metadata.json',
  ]);
  // core 0.12.10 can return -1 after writing valid ffprobe JSON. Validate the
  // actual output in that case; positive error codes still fail immediately.
  if (code !== 0 && code !== -1) throw new Error('ファイル情報を読み取れませんでした。');
  let metadata;
  try { metadata = JSON.parse(await engine.readFile('metadata.json', 'utf8')); }
  catch { throw new Error('ファイル情報を読み取れませんでした。'); }
  await engine.deleteFile('metadata.json');
  if (!metadata.streams?.length) {
    throw new Error(kind === 'audio' ? 'このファイルに音声がありません。' : 'このファイルに映像がありません。');
  }
  const streamDuration = Number(metadata.streams[0].duration);
  const duration = Number.isFinite(streamDuration) && streamDuration > 0
    ? streamDuration : Number(metadata.format?.duration);
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new Error('ファイルの長さを取得できません。長さの情報を持つMP4・M4A・WebMなどで保存し直してください。');
  }
  return duration;
}

export function cutArguments(path, kind, start, end) {
  validateRange(start, end);
  // Input-side seeking starts near the range; re-encoding discards frames before
  // the requested start instead of including an earlier keyframe in the result.
  const args = ['-ss', String(start), '-i', path, '-t', String(end - start)];
  if (kind === 'audio') {
    args.push('-map', '0:a:0', '-vn', '-c:a', 'aac', '-b:a', '192k');
  } else {
    args.push('-map', '0:v:0', '-an', '-c:v', 'libx264', '-preset', 'ultrafast',
      '-crf', '23', '-threads', '1', '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2', '-pix_fmt', 'yuv420p');
  }
  return [...args, '-movflags', '+faststart', '-y', kind === 'audio' ? 'cut.m4a' : 'cut.mp4'];
}

export async function execute(engine, args) {
  const code = await engine.exec(args);
  if (code !== 0) throw new Error(`処理できませんでした（終了コード ${code}）。形式や指定範囲を確認してください。`);
}
