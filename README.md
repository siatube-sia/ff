# Browser Audio + Video Merger

動画ファイルと音声ファイルをブラウザ内で結合し、MP4として保存するシンプルなWebアプリです。

- サーバーへのメディアアップロードなし
- ffmpeg.wasm によるブラウザ内処理
- 動画の元音声を、選択した音声へ置換
- 音声が短い場合は動画尺までループ可能
- 高速な映像ストリームコピー + 失敗時のH.264自動フォールバック

## 起動

Node.js が入っている環境で:

```bash
npm install
npm run dev
```

表示された localhost のURLをブラウザで開いてください。

## 本番ビルド

```bash
npm run build
npm run preview
```

## 注意

初回処理時に FFmpeg core（約30MB）をCDNから読み込みます。その後の動画・音声処理自体はブラウザ内で行われます。
大きな動画は端末メモリを多く使用します。
