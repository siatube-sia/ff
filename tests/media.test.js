import test from 'node:test';
import assert from 'node:assert/strict';
import { parseTime, formatTime, validateRange, mountInput, probeDuration, cutArguments, execute } from '../src/media.js';

test('timestamps and invalid ranges', () => {
  for (const [input, expected] of [['5:00', 300], ['1:02:03.5', 3723.5], ['75', 75], ['0', 0]]) {
    assert.equal(parseTime(input), expected);
    assert.equal(parseTime(formatTime(expected)), expected);
  }
  for (const text of ['', '-1', '1:60', '1:2:3:4', '1e3', '1.5:00']) assert.ok(Number.isNaN(parseTime(text)));
  for (const [start, end] of [[-1, 10], [20, 10], [0, 0], [NaN, 3], [1, Infinity], [600, 601], [0, 601]]) {
    assert.throws(() => validateRange(start, end, 600));
  }
  assert.doesNotThrow(() => validateRange(300, 600, 600));
});

test('mount uses original Blob without whole-file reads and avoids filename collisions', async () => {
  const file = new Blob(['test']);
  file.arrayBuffer = () => { throw new Error('must not read the entire input'); };
  const engine = {
    async createDir(path) { assert.equal(path, '/input'); },
    async mount(type, options, path) {
      assert.equal(type, 'WORKERFS');
      assert.equal(options.blobs[0].data, file);
      assert.equal(path, '/input');
      return true;
    },
  };
  assert.equal(await mountInput(engine, file, '/input'), '/input/source');
  engine.mount = async () => false;
  await assert.rejects(mountInput(engine, file, '/input'), /省メモリ読み込み/);
});

test('cut seeks before input, limits duration and emits only requested stream', () => {
  for (const kind of ['audio', 'video']) {
    const args = cutArguments('/input/source', kind, 300, 600);
    assert.deepEqual(args.slice(0, 6), ['-ss', '300', '-i', '/input/source', '-t', '300']);
    assert.equal(args[args.indexOf('-map') + 1], kind === 'audio' ? '0:a:0' : '0:v:0');
    assert.ok(args.includes(kind === 'audio' ? '-vn' : '-an'));
    assert.equal(args.at(-1), kind === 'audio' ? 'cut.m4a' : 'cut.mp4');
  }
});

test('probe handles WebM format duration and rejects missing streams or duration', async () => {
  let data = { streams: [{ duration: 'N/A' }], format: { duration: '600' } };
  const engine = { ffprobe: async () => 0, readFile: async () => JSON.stringify(data), deleteFile: async () => {} };
  assert.equal(await probeDuration(engine, '/input/source', 'audio'), 600);
  engine.ffprobe = async () => -1;
  assert.equal(await probeDuration(engine, '/input/source', 'audio'), 600);
  data = { streams: [] };
  await assert.rejects(probeDuration(engine, '/input/source', 'audio'), /音声がありません/);
  data = { streams: [{}] };
  await assert.rejects(probeDuration(engine, '/input/source', 'video'), /長さを取得できません/);
});

test('nonzero FFmpeg exit code is a failure', async () => {
  await assert.rejects(execute({ exec: async () => 1 }, []), /終了コード 1/);
});
