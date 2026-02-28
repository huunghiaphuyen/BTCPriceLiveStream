# BTC/USDT Live Price Stream

Ứng dụng web hiển thị giá BTC/USDT realtime từ Bybit API:
- Giá realtime theo giây qua Bybit WebSocket ticker.
- Nến 1 phút qua Bybit REST kline (đồng bộ định kỳ).

## Cấu trúc thư mục

```text
project-root/
  package.json
  server/
    package.json
    index.js
  client/
    package.json
    index.html
    vite.config.js
    src/
      main.jsx
      App.jsx
      styles.css
```

## Yêu cầu môi trường

- Node.js 18+
- npm 9+

## Cách chạy

```bash
npm install
npm run dev
```

- Backend: `http://localhost:3000`
- Frontend: `http://localhost:5173`

## API

- `GET /api/price`: trả về giá close mới nhất
- `GET /api/history`: trả về tối đa 100 cây nến gần nhất
- `GET /health`: trạng thái server và kết nối Bybit

## Socket events

- `history`: gửi lịch sử nến khi client mới connect
- `kline`: gửi nến realtime (update hoặc nến mới)
- `price`: gửi giá close mới nhất

## Ghi chú

- Dữ liệu chỉ lưu trong memory (không dùng database).
- Backend có logic tự reconnect Bybit WS theo exponential backoff.
- Frontend tự reconnect socket.io tới backend khi mất kết nối.
