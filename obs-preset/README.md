# OBS Low-PC Preset

## Files
- `BTC-LowPC/basic.ini`
- `BTC-LowPC/service.json`
- `export/BTC-LowPC-OBS-Profile.zip`

## Import to OBS
1. Open OBS.
2. Go to `Profile` -> `Import`.
3. Select folder: `obs-preset/BTC-LowPC`.
4. Switch to profile `BTC-LowPC`.
5. Open `Settings` -> `Stream` and paste your YouTube Stream Key.

## Web Source for this project
1. Start app:
   - backend: `npm run start --prefix server`
   - frontend: `npm run preview --prefix client -- --host 127.0.0.1 --port 4173`
2. In OBS add `Browser Source`:
   - URL: `http://127.0.0.1:4173`
   - Width: `1920`
   - Height: `1080`

## Notes
- Preset uses `x264 + veryfast` for maximum compatibility.
- If your GPU supports hardware encoding, switch Encoder to `NVENC` / `QuickSync` for lower CPU load.

