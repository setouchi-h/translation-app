# Discord Native App 用リアルタイム翻訳字幕アプリ

## 目的

Discord の native app で通話しているときに、PC上で相手の音声を拾い、OpenAI Realtime Translation を使って翻訳字幕のみを画面に表示する。

音声翻訳の再生は不要。字幕だけでよい。

## 現時点の方針

最初の実装は Electron native app で進める。

理由:

- `getUserMedia()`, `enumerateDevices()`, Web Audio API, AudioWorklet が安定して使いやすい
- 仮想オーディオ入力の扱いが Tauri より読みやすい
- 透明ウィンドウ、常に手前、字幕オーバーレイを作りやすい
- まず MVP を早く動かす目的に合っている

Tauri も候補だったが、WebView の音声入力まわりが OS 依存になりやすいため、MVP は Electron を選ぶ。

## 想定ユーザー体験

1. ユーザーが Discord native app で通話する
2. Discord の出力音声を仮想オーディオデバイスへ流す
3. 字幕アプリでその仮想入力を選ぶ
4. Start を押す
5. 相手の発話がリアルタイムに翻訳字幕として表示される

## 音声取得方式

### アプリ音声の直接取得（macOS 14.2 以降、既定）

仮想オーディオデバイスなしで、選んだアプリの音だけを取得する。

- Input で「Selected apps」を選び、対象アプリ（既定は Discord）を選んで Start を押す
- 「All audio except selected apps」は、選んだアプリ以外のすべての音を取得する。何も選ばなければ PC 全体の音になる
- 選んだアプリは「Selected apps」と「All audio except selected apps」で別々に記憶される
- 初回は macOS の「システムオーディオ録音」の許可が必要になる場合がある

実装:

- `frontend/native/mac/AppAudioTap.swift`: Core Audio のプロセスタップで音声を取得し、24kHz モノラル PCM16 を標準出力に流すコマンド
- `frontend/src/main/appAudioCapture.ts`: コマンドを起動し、100ms のチャンクにして字幕セッションへ渡す
- `frontend/src/shared/capture.ts`: main、preload、renderer で共有する型
- `frontend/src/renderer/src/hooks/useInputSource.ts`: 入力元（アプリまたは入力デバイス）の選択と保存
- `npm run build:native` でコマンドを `frontend/resources/bin/` にビルドする（`dev` と `build` から自動で実行される）

制約:

- アプリ単位でしか分けられない。ブラウザはタブごとに分離できず、ゲーム内ボイスチャットは声とゲーム音を分離できない
- Windows は未対応（下の仮想オーディオ方式を使う）

### 仮想オーディオ方式（Windows、古い macOS）

macOS:

- BlackHole 2ch
- Loopback

Windows:

- VB-CABLE
- Voicemeeter

macOS の例:

- Audio MIDI Setup で Multi-Output Device を作る
- 出力先に「ヘッドホン」と「BlackHole 2ch」を含める
- Discord native app の Output Device をその Multi-Output Device にする
- 字幕アプリ側の Input Device を BlackHole 2ch にする

## MVP 機能

- Electron アプリ
- 入力デバイス選択
- 翻訳先言語選択
- Start / Stop
- 常に手前の字幕ウィンドウ
- 透明または半透明の字幕オーバーレイ
- 翻訳字幕のライブ表示
- 直前字幕の履歴表示
- APIキー入力、または `OPENAI_API_KEY` 環境変数利用
- 音声出力なし

## 非MVP

最初はやらない:

- Discord Bot
- Discord API 連携
- 翻訳音声の再生
- 翻訳音声を Discord に戻す
- Zoom 対応
- 話者分離
- Windows でのアプリ音声の直接取得
- 配布用 notarization / signing

## 技術構成

Electron main process:

- OpenAI API キー管理
- OpenAI Realtime Translation WebSocket 接続
- renderer から受け取った音声 chunk を Realtime API へ送信
- 翻訳テキスト delta を renderer へ返す

Electron renderer:

- UI
- 音声入力デバイス列挙
- `getUserMedia()` で仮想オーディオ入力を取得
- AudioWorklet で音声 chunk 化
- PCM16 base64 へ変換
- 字幕表示

## OpenAI 側

使用想定:

- OpenAI Realtime Translation
- model: `gpt-realtime-translate`

字幕だけ使う。
翻訳音声イベントは再生しない。
翻訳 transcript delta を UI に表示する。

## 重要な設計注意

- Discord の音声と翻訳結果の出力がループしないようにする
- 字幕アプリは音声再生しないため、ループリスクは低い
- 入力は Discord 音声が入った仮想オーディオデバイスだけにする
- ユーザーのマイク音声は拾わない設計にする
- 通話相手の同意や利用規約に注意する

## 最初に検証すること

1. Electron で仮想オーディオ入力を列挙できるか
2. BlackHole / Loopback の音声を `getUserMedia()` で取得できるか
3. AudioWorklet で安定して PCM16 chunk を作れるか
4. OpenAI Realtime Translation に送って字幕 delta が返るか
5. 字幕表示の遅延が実用範囲か

## 推奨する最初の成果物

`discord-native-captions` という Electron アプリ。

画面:

- 上部に Input / Target Language / Start / Stop
- 下部に大きな字幕
- 常に手前
- 小さい字幕バーとして使える

## 開発時の注意

ユーザーは勝手にファイル作成や実装を進められることを嫌がっている。
新しいセッションでは、まず作業場所と作成ファイル一覧を確認してから実装に入ること。

## docs

<https://developers.openai.com/cookbook/examples/voice_solutions/realtim>

## docs

<https://developers.openai.com/cookbook/examples/voice_solutions/realtime_translation_guide>
<https://github.com/openai/openai-cookbook/blob/main/examples/voice_solutions/realtime_translation_guide.mdx>
