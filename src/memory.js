const MB = 1_000_000;
const GB = 1_000_000_000;

// Planning heuristic, not a measured peak or a guaranteed upper bound.
// Allow for input copies, the in-memory output, download copies and engine work.
export function estimateMemory(videoBytes, audioBytes, transcode = false) {
  const inputBytes = videoBytes + audioBytes;
  return inputBytes * (transcode ? 6 : 4) + (transcode ? 512 : 256) * MB;
}

export function memoryEnvironment(device = {}) {
  const isIOS = /iPhone|iPad|iPod/i.test(device.userAgent || '')
    || (/Mac/i.test(device.platform || '') && device.maxTouchPoints > 1);
  const deviceBytes = Number.isFinite(device.deviceMemory) && device.deviceMemory > 0
    ? device.deviceMemory * 1024 ** 3 : null;
  return { isIOS, deviceBytes, isMobile: isIOS || /Android|Mobile/i.test(device.userAgent || ''),
    cores: Number.isFinite(device.hardwareConcurrency) ? device.hardwareConcurrency : null };
}

// App policy, not an OS/browser limit. Reserve room for the OS and other tabs.
export function memoryBudget({ isIOS, deviceBytes, isMobile }) {
  return Math.min(isIOS ? 1.5 * GB : isMobile ? GB : 2 * GB,
    deviceBytes ? deviceBytes * 0.25 : Infinity);
}

export function memoryWarning(estimatedBytes, environment, { width = 0, height = 0, transcode = false } = {}) {
  const { isIOS, deviceBytes, isMobile, cores } = environment;
  const reasons = [];
  if (isIOS && estimatedBytes > 1.5 * GB) {
    reasons.push('推定メモリ使用量がiPhone・iPad向けの警告目安（1.5GB）を超えています。');
  }
  if (deviceBytes && estimatedBytes > deviceBytes) {
    reasons.push('推定メモリ使用量が端末のメモリ容量（概算）を超えています。');
  }
  if (estimatedBytes > memoryBudget(environment) && !reasons.length) {
    reasons.push(`推定メモリ使用量が、この端末での処理目安（${formatMemory(memoryBudget(environment))}）を超えています。`);
  }
  if (transcode && width * height >= 3840 * 2160 && (isMobile || (cores && cores <= 4))) {
    reasons.push('この端末で高解像度の映像を変換すると、処理が重くなる可能性があります。');
  }
  return reasons.length ? `${reasons.join('')}解像度を下げるか分割してください` : '';
}

export function estimateCutMemory(size, duration, seconds, { kind = 'video', width = 0, height = 0 } = {}) {
  const ratio = duration > 0 && seconds > 0 ? Math.min(1, seconds / duration) : 1;
  const bytes = Math.max(size * ratio, kind === 'audio' && seconds > 0 ? seconds * 24000 : 0);
  return estimateMemory(bytes, 0, true) + (kind === 'video' ? width * height * 24 : 0);
}

export function recommendSegment(size, duration, environment, options = {}) {
  if (!Number.isFinite(duration) || duration <= 0) return null;
  const target = memoryBudget(environment) * 0.75;
  const overhead = 512 * MB + (options.kind !== 'audio' ? (options.width || 0) * (options.height || 0) * 24 : 0);
  const rate = Math.max(size / duration, options.kind === 'audio' ? 24000 : 1) * 6;
  const seconds = Math.min(duration, Math.max(1, Math.floor(Math.min(300, (target - overhead) / rate))));
  return { seconds, count: Math.ceil(duration / seconds), target,
    feasible: estimateCutMemory(size, duration, seconds, options) <= target };
}

export function formatMemory(bytes) {
  return bytes >= GB ? `${(bytes / GB).toFixed(2)} GB` : `${Math.ceil(bytes / MB)} MB`;
}
