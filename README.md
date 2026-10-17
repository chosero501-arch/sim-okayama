# シム岡山

GBC/DMG 互換の街づくりゲーム(岡山県27市町村)。`sim_okayama.gbc` が ROM(段階9 地図32×24版, SHA-256 bc7f8a8d…35dd)。

## ブラウザで遊ぶ
`index.html` が EmulatorJS(CDN)で ROM を読み込みます。
- GitHub Pages: Settings → Pages → Branch `main` / `/(root)`(非公開リポジトリでの Pages は有料プランのみ)
- ローカル: このフォルダで `python -m http.server` → http://localhost:8000/ (file:// 直開きは不可)

セーブはブラウザ内(IndexedDB)に保存され、ブラウザ/端末ごとに別です。
