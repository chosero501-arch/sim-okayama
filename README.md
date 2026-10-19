# シム岡山

GBC/DMG 互換の街づくりゲーム(岡山県27市町村)。`sim_okayama.gbc` が ROM(段階10 川オートタイル版(32×24), SHA-256 f08ee79f…e5f4)。

## ブラウザで遊ぶ
`index.html` が EmulatorJS(CDN)で ROM を読み込みます。
- GitHub Pages: Settings → Pages → Branch `main` / `/(root)`(非公開リポジトリでの Pages は有料プランのみ)
- ローカル: このフォルダで `python -m http.server` → http://localhost:8000/ (file:// 直開きは不可)

セーブはブラウザ内(IndexedDB)に保存され、ブラウザ/端末ごとに別です。

## ブラウザ版(自作エミュレータ)
`index.html` は ROM とエミュレータ(emu/gb.js)を1ファイルに埋め込んだ版です。スマホは画面下のタッチパッド、PCは矢印キー/X=A/Z=B/Enter=START/Shift=SELECT。セーブはブラウザに自動保存(設定から .sav 書き出し・読み込み可)。旧 EmulatorJS 版は `index_ejs.html`。
