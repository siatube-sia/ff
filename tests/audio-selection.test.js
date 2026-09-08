import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { estimateMemory, memoryEnvironment, memoryWarning, formatMemory } from '../src/memory.js';
import * as media from '../src/media.js';
import * as memory from '../src/memory.js';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const source = readFileSync(new URL('../src/main.js', import.meta.url), 'utf8')
  .replace(/^import .*;\n/gm, '');

function setup(device = {}, dependencies = {}) {
  const elements = new Map([...html.matchAll(/id="([^"]+)"/g)].map(([, id]) => [id, {
    value: id === 'themeSelect' ? 'system' : '',
    hidden: true,
    disabled: true,
    style: {},
    handlers: {},
    classList: { add() {}, remove() {} },
    removeAttribute(name) { delete this[name]; },
    load() {},
    pause() {},
    focus() {},
    scrollIntoView() {},
    addEventListener(event, handler) { (this.handlers[event] ??= []).push(handler); },
  }]));
  runInNewContext(source, {
    estimateMemory, memoryEnvironment, memoryWarning, formatMemory,
    ...media,
    ...memory,
    navigator: device,
    document: { querySelector: selector => elements.get(selector.slice(1)), documentElement: { dataset: {} } },
    window: { matchMedia: () => ({ matches: false, addEventListener() {} }), addEventListener() {} },
    localStorage: { getItem() { return null; } },
    URL: { createObjectURL: () => 'blob:preview', revokeObjectURL() {} },
    Blob,
    console,
    ...dependencies,
  });
  const emit = (id, event, payload) => {
    const results = elements.get(id).handlers[event].map(handler => handler(payload));
    return results.find(result => result?.then);
  };
  elements.get('videoInput').files = [{ name: 'video.mp4', type: 'video/mp4', size: 100 }];
  emit('videoInput', 'change');
  return { elements, emit };
}

test('audio picker includes WebM containers', () => {
  const accept = html.match(/id="audioInput"[^>]*accept="([^"]+)"/)[1].split(',');
  for (const type of ['audio/*', 'video/webm', '.webm']) assert.ok(accept.includes(type));
});

for (const [name, type] of [
  ['audio.webm', 'audio/webm'],
  ['audio.webm', 'video/webm'],
  ['audio.WEBM', ''],
  ['audio.webm', 'application/octet-stream'],
  ['recording', 'video/webm; codecs=opus'],
  ['audio.mp3', 'audio/mpeg'],
  ['audio.wav', 'audio/wav'],
  ['cut.m4a', ''],
  ['cut.m4a', 'video/mp4'],
]) {
  for (const method of ['picker', 'drop']) {
    test(`${method} accepts ${name} (${type || 'empty MIME'})`, () => {
      const { elements, emit } = setup();
      const file = { name, type, size: 100 };
      if (method === 'picker') {
        elements.get('audioInput').files = [file];
        emit('audioInput', 'change');
      } else {
        emit('audioDrop', 'drop', { preventDefault() {}, dataTransfer: { files: [file] } });
      }
      assert.equal(elements.get('mergeButton').disabled, false);
      assert.equal(elements.get('audioPreviewPanel').hidden, false);
      assert.ok(elements.get('audioName').textContent.startsWith(name));
    });
  }
}

test('unrelated files are rejected and cancelling the picker is harmless', () => {
  const { elements, emit } = setup();
  for (const file of [{ name: 'notes.txt', type: 'text/plain' }, { name: 'video.mp4', type: 'video/mp4' }]) {
    elements.get('audioInput').files = [file];
    emit('audioInput', 'change');
    assert.equal(elements.get('mergeButton').disabled, true);
    assert.equal(elements.get('audioPreviewPanel').hidden, true);
  }
  elements.get('audioInput').files = [];
  assert.doesNotThrow(() => emit('audioInput', 'change'));
});

test('memory warning updates on file selection, conversion changes, replacement and reset', () => {
  const { elements, emit } = setup({ userAgent: 'iPhone' });
  const input = elements.get('audioInput');
  input.files = [{ name: 'audio.webm', type: 'video/webm', size: 200e6 }];
  emit('audioInput', 'change');
  assert.equal(elements.get('memoryWarning').hidden, true);
  elements.get('transcodeVideo').checked = true;
  emit('transcodeVideo', 'change');
  assert.equal(elements.get('memoryWarning').hidden, false);
  assert.match(elements.get('memoryWarning').textContent, /解像度を下げるか分割してください/);
  assert.equal(elements.get('mergeButton').disabled, false);
  input.files = [{ name: 'small.webm', type: 'video/webm', size: 10e6 }];
  emit('audioInput', 'change');
  assert.equal(elements.get('memoryWarning').hidden, true);
  input.files = [{ name: 'large.webm', type: 'video/webm', size: 500e6 }];
  emit('audioInput', 'change');
  assert.equal(elements.get('memoryWarning').hidden, false);
  emit('resetButton', 'click');
  assert.equal(elements.get('memoryWarning').hidden, true);
  assert.match(elements.get('memoryEstimate').textContent, /ファイルを選ぶと/);
});

function engineMock() {
  const engines = [];
  class FFmpeg {
    constructor() { this.commands = []; this.inputs = []; engines.push(this); }
    on() {}
    async load() {}
    async createDir() {}
    async mount(type, options, directory) { this.inputs.push({ type, options, directory }); return true; }
    async ffprobe() { return 0; }
    async deleteFile() {}
    async readFile(path) {
      return path === 'metadata.json' ? JSON.stringify({ streams: [{ duration: '600' }] }) : new Uint8Array([1, 2, 3]);
    }
    async exec(args) { this.commands.push(args); return 0; }
    terminate() { this.terminated = true; }
  }
  return { FFmpeg, engines, toBlobURL: async () => 'blob:engine' };
}

for (const kind of ['audio', 'video']) {
  test(`${kind} cut, save acknowledgement, next range and merge saved files`, async () => {
    const mock = engineMock();
    const { elements, emit } = setup({}, mock);
    elements.get('taskMode').value = kind;
    emit('taskMode', 'change');
    if (kind === 'audio') {
      elements.get('audioInput').files = [{ name: 'recording.webm', type: 'video/webm', size: 1e6 }];
      emit('audioInput', 'change');
    }
    elements.get('cutStart').value = '0:00';
    elements.get('cutEnd').value = '5:00';
    emit('cutEnd', 'input');
    const processing = emit('mergeButton', 'click');
    assert.equal(elements.get('taskMode').disabled, true);
    await processing;
    assert.equal(mock.engines.length, 1);
    assert.equal(mock.engines[0].terminated, true);
    assert.equal(elements.get('resultPanel').hidden, false);
    assert.equal(elements.get('resultAudio').hidden, kind !== 'audio');
    assert.equal(elements.get('nextRangeButton').disabled, true);
    assert.match(elements.get('downloadButton').download, kind === 'audio' ? /0s-300s\.m4a$/ : /0s-300s\.mp4$/);
    emit('nextRangeButton', 'click');
    assert.equal(elements.get('resultPanel').hidden, false);
    elements.get('savedConfirm').checked = true;
    emit('savedConfirm', 'change');
    emit('nextRangeButton', 'click');
    assert.equal(elements.get('resultPanel').hidden, true);
    assert.equal(elements.get('cutStart').value, '5:00');
    assert.equal(elements.get('cutEnd').value, '10:00');
    await emit('mergeButton', 'click');
    assert.equal(mock.engines[1].commands[0][1], '300');
    assert.equal(mock.engines[1].terminated, true);
    elements.get('savedConfirm').checked = true;
    emit('savedConfirm', 'change');
    assert.equal(elements.get('nextRangeButton').disabled, true);
    emit('useMergeButton', 'click');
    assert.equal(elements.get('taskMode').value, 'merge');
    assert.equal(elements.get('mergeButton').disabled, true);
    assert.equal(elements.get('loopAudio').checked, false);
    assert.equal(elements.get('videoName').textContent, '未選択');
    assert.equal(elements.get('audioName').textContent, '未選択');
  });
}

test('cut failure releases engine and restores controls', async () => {
  const mock = engineMock();
  mock.FFmpeg.prototype.exec = async () => 1;
  const { elements, emit } = setup({}, { ...mock, console: { error() {} } });
  elements.get('taskMode').value = 'video';
  emit('taskMode', 'change');
  elements.get('cutStart').value = '0';
  elements.get('cutEnd').value = '60';
  emit('cutEnd', 'input');
  await emit('mergeButton', 'click');
  assert.equal(mock.engines[0].terminated, true);
  assert.equal(elements.get('taskMode').disabled, false);
  assert.equal(elements.get('resultPanel').hidden, true);
  assert.match(elements.get('statusText').textContent, /失敗/);
});

test('merge mounts both files and retries nonzero copy exit with H.264', async () => {
  const mock = engineMock();
  mock.FFmpeg.prototype.exec = async function (args) {
    this.commands.push(args);
    return this.commands.length === 1 ? 1 : 0;
  };
  const { elements, emit } = setup({}, mock);
  elements.get('audioInput').files = [{ name: 'cut.m4a', type: '', size: 100 }];
  emit('audioInput', 'change');
  await emit('mergeButton', 'click');
  const engine = mock.engines[0];
  assert.deepEqual(engine.inputs.map(input => input.directory), ['/video', '/audio']);
  assert.ok(engine.commands[0].includes('copy'));
  assert.ok(engine.commands[1].includes('libx264'));
  assert.equal(engine.terminated, true);
  assert.equal(elements.get('resultPanel').hidden, false);
  assert.match(elements.get('statusText').textContent, /完了しました/);
});

test('range past source end is rejected after probe without running conversion', async () => {
  const mock = engineMock();
  const { elements, emit } = setup({}, { ...mock, console: { error() {} } });
  elements.get('taskMode').value = 'video';
  emit('taskMode', 'change');
  elements.get('cutStart').value = '0';
  elements.get('cutEnd').value = '601';
  emit('cutEnd', 'input');
  await emit('mergeButton', 'click');
  assert.equal(mock.engines[0].commands.length, 0);
  assert.equal(mock.engines[0].terminated, true);
  assert.match(elements.get('statusText').textContent, /長さ.*超えています/);
});

test('large merge warns before engine load and routes to auto-sized cuts', async () => {
  const mock = engineMock();
  const { elements, emit } = setup({ userAgent: 'iPhone' }, mock);
  elements.get('videoInput').files = [{ name: 'big.mp4', type: 'video/mp4', size: 2e9 }];
  emit('videoInput', 'change');
  elements.get('videoPreview').duration = 600;
  emit('videoPreview', 'loadedmetadata');
  elements.get('audioInput').files = [{ name: 'sound.m4a', type: 'audio/mp4', size: 1e6 }];
  emit('audioInput', 'change');
  await emit('mergeButton', 'click');
  assert.equal(mock.engines.length, 0);
  assert.equal(elements.get('splitGuidance').hidden, false);
  emit('splitVideoButton', 'click');
  assert.equal(elements.get('taskMode').value, 'video');
  const seconds = Number(elements.get('segmentSeconds').value);
  assert.ok(seconds > 0 && seconds < 200);
  assert.equal(media.parseTime(elements.get('cutEnd').value), seconds);
  assert.equal(elements.get('memoryWarning').hidden, true);
  assert.match(elements.get('segmentPlan').textContent, /1 \/ \d+ 本目/);
});

test('four segments keep contiguous ranges, numbering, save gates and short final tail', async () => {
  const mock = engineMock();
  const { elements, emit } = setup({}, mock);
  elements.get('taskMode').value = 'video';
  emit('taskMode', 'change');
  elements.get('videoPreview').duration = 600;
  emit('videoPreview', 'loadedmetadata');
  elements.get('segmentSeconds').value = '170';
  emit('segmentSeconds', 'input');
  for (let index = 0; index < 4; index++) {
    assert.equal(media.parseTime(elements.get('cutStart').value), index * 170);
    assert.equal(media.parseTime(elements.get('cutEnd').value), Math.min(600, (index + 1) * 170));
    await emit('mergeButton', 'click');
    assert.match(elements.get('resultTitle').textContent, new RegExp(`${index + 1} / 4`));
    assert.ok(elements.get('downloadButton').download.includes(`part00${index + 1}`));
    assert.equal(mock.engines[index].terminated, true);
    emit('nextRangeButton', 'click');
    assert.equal(elements.get('resultPanel').hidden, false);
    elements.get('savedConfirm').checked = true;
    emit('savedConfirm', 'change');
    if (index < 3) emit('nextRangeButton', 'click');
    else assert.equal(elements.get('nextRangeButton').disabled, true);
  }
});

test('late metadata does not overwrite manually selected seconds', () => {
  const { elements, emit } = setup();
  elements.get('taskMode').value = 'video';
  emit('taskMode', 'change');
  elements.get('segmentSeconds').value = '40';
  emit('segmentSeconds', 'input');
  elements.get('videoPreview').duration = 600;
  emit('videoPreview', 'loadedmetadata');
  assert.equal(elements.get('segmentSeconds').value, '40');
  assert.equal(elements.get('cutEnd').value, '0:40');
});

test('unknown duration probes first, presents default range, then cuts on next click', async () => {
  const mock = engineMock();
  const { elements, emit } = setup({}, mock);
  elements.get('taskMode').value = 'video';
  emit('taskMode', 'change');
  await emit('mergeButton', 'click');
  assert.equal(mock.engines[0].commands.length, 0);
  assert.equal(mock.engines[0].terminated, true);
  assert.equal(Number(elements.get('segmentSeconds').value), 300);
  assert.match(elements.get('statusText').textContent, /推奨秒数を設定/);
  await emit('mergeButton', 'click');
  assert.equal(mock.engines[1].commands.length, 1);
});

test('changing risky parameters clears consent and high-cost fallback does not run', async () => {
  const mock = engineMock();
  mock.FFmpeg.prototype.exec = async function (args) { this.commands.push(args); return 1; };
  const { elements, emit } = setup({ userAgent: 'iPhone' }, { ...mock, console: { error() {} } });
  elements.get('videoInput').files = [{ name: 'big.mp4', type: 'video/mp4', size: 240e6 }];
  emit('videoInput', 'change');
  elements.get('audioInput').files = [{ name: 'sound.m4a', type: 'audio/mp4', size: 1e6 }];
  emit('audioInput', 'change');
  await emit('mergeButton', 'click');
  assert.equal(mock.engines[0].commands.length, 1);
  assert.equal(mock.engines[0].terminated, true);
  assert.equal(elements.get('transcodeVideo').checked, true);
  assert.equal(elements.get('splitGuidance').hidden, false);
  elements.get('riskConfirm').checked = true;
  elements.get('transcodeVideo').checked = false;
  emit('transcodeVideo', 'change');
  assert.equal(elements.get('riskConfirm').checked, false);
});

test('known long video duration accounts for repeated audio output', () => {
  const { elements, emit } = setup();
  elements.get('videoPreview').duration = 600000;
  emit('videoPreview', 'loadedmetadata');
  elements.get('audioInput').files = [{ name: 'short.m4a', type: 'audio/mp4', size: 1000 }];
  emit('audioInput', 'change');
  elements.get('loopAudio').checked = true;
  emit('loopAudio', 'change');
  assert.equal(elements.get('memoryWarning').hidden, false);
  elements.get('riskConfirm').checked = true;
  emit('audioInput', 'change');
  assert.equal(elements.get('riskConfirm').checked, false);
});

test('same-duration audio and video share the more conservative default', () => {
  const { elements, emit } = setup({ userAgent: 'iPhone' });
  elements.get('videoInput').files = [{ name: 'big.mp4', type: 'video/mp4', size: 2e9 }];
  emit('videoInput', 'change');
  elements.get('videoPreview').duration = 600;
  emit('videoPreview', 'loadedmetadata');
  elements.get('audioInput').files = [{ name: 'sound.m4a', type: 'audio/mp4', size: 1e6 }];
  emit('audioInput', 'change');
  elements.get('audioPreview').duration = 600;
  emit('audioPreview', 'loadedmetadata');
  elements.get('taskMode').value = 'video';
  emit('taskMode', 'change');
  const seconds = Number(elements.get('segmentSeconds').value);
  elements.get('taskMode').value = 'audio';
  emit('taskMode', 'change');
  assert.equal(Number(elements.get('segmentSeconds').value), seconds);
});
