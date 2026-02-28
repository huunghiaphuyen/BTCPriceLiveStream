import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import WebSocket from "ws";

const PORT = process.env.PORT || 3000;
const SYMBOL = "BTCUSDT";
const SYMBOL_LOWER = SYMBOL.toLowerCase();
const BINANCE_WS_URL = `wss://stream.binance.com:9443/stream?streams=${SYMBOL_LOWER}@trade/${SYMBOL_LOWER}@kline_1m`;
const BINANCE_FORCE_WS_URL = "wss://fstream.binance.com/ws/btcusdt@forceOrder";
const BINANCE_KLINE_REST_URL = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=200`;
const MAX_CANDLES = 200;
const TOP_BUYERS_LIMIT = 12;
const MIN_TOP_BUYER_BTC = 0.1;
const MAX_LIQUIDATIONS = 30;
const TOP_BUYERS_REFRESH_MS = 3_000;
const MARKETS_REFRESH_MS = 5_000;
const FEAR_REFRESH_MS = 60_000;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const HISTORY_SYNC_MS = 15_000;
const MARKET_SYMBOLS = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "DOGEUSDT", "ADAUSDT"];

const EXCHANGES = [
  {
    id: "binance",
    name: "Binance",
    logoUrl: "https://cdn.simpleicons.org/binance/F0B90B"
  },
  {
    id: "bybit",
    name: "Bybit",
    logoUrl: "https://cdn.simpleicons.org/bybit/F7A600"
  },
  {
    id: "okx",
    name: "OKX",
    logoUrl: "https://cdn.simpleicons.org/okx/ffffff"
  },
  {
    id: "kucoin",
    name: "KuCoin",
    logoUrl: "https://cdn.simpleicons.org/kucoin/14BE8A"
  }
];

const app = express();
app.use(cors());
app.use(express.json());

const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: "*", methods: ["GET", "POST"] }
});

/** @type {Array<{startTime:number,open:number,high:number,low:number,close:number,volume:number,isClosed:boolean}>} */
let candles = [];
let latestClose = null;
let latestSecondPrice = null;
let latestSecondTs = null;
/** @type {Array<{exchange:string,exchangeId:string,logoUrl:string,price:number,size:number,notional:number}>} */
let topBuyers = [];
/** @type {Array<{exchange:string,status:string,error?:string}>} */
let exchangeStatus = [];
let topBuyersUpdatedAt = null;
let liquidations = [];
let markets = [];
let fearGreed = null;
let binanceSocket = null;
let forceSocket = null;
let reconnectAttempt = 0;
let reconnectTimer = null;
let forceReconnectAttempt = 0;
let forceReconnectTimer = null;
let historySyncTimer = null;
let secondHeartbeatTimer = null;
let topBuyersTimer = null;
let marketsTimer = null;
let fearTimer = null;
let lastSecondBucket = null;
let isShuttingDown = false;

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function setCandles(nextCandles) {
  candles = nextCandles
    .slice()
    .sort((a, b) => a.startTime - b.startTime)
    .slice(-MAX_CANDLES);

  if (candles.length > 0) {
    latestClose = candles[candles.length - 1].close;
  }
}

function upsertCandle(candle) {
  const idx = candles.findIndex((item) => item.startTime === candle.startTime);
  if (idx >= 0) {
    candles[idx] = candle;
  } else {
    candles.push(candle);
    candles.sort((a, b) => a.startTime - b.startTime);
    candles = candles.slice(-MAX_CANDLES);
  }

  latestClose = candle.close;
  return candle;
}

function emitSecondPrice(close, ts) {
  latestSecondPrice = close;
  latestSecondTs = ts;

  const secondBucket = Math.floor(ts / 1_000);
  if (secondBucket === lastSecondBucket) {
    return;
  }
  lastSecondBucket = secondBucket;

  io.emit("price", { close, ts, source: "second" });
}

function startSecondHeartbeat() {
  if (secondHeartbeatTimer) {
    return;
  }

  secondHeartbeatTimer = setInterval(() => {
    if (latestSecondPrice === null) {
      return;
    }
    emitSecondPrice(latestSecondPrice, Date.now());
  }, 1_000);
}

function normalizeRestKline(entry) {
  return {
    startTime: toNumber(entry[0]),
    open: toNumber(entry[1]),
    high: toNumber(entry[2]),
    low: toNumber(entry[3]),
    close: toNumber(entry[4]),
    volume: toNumber(entry[5]),
    isClosed: true
  };
}

async function fetchMinuteHistoryFromBinance() {
  const response = await fetch(BINANCE_KLINE_REST_URL, { method: "GET" });
  if (!response.ok) {
    throw new Error(`Binance REST returned ${response.status}`);
  }

  const payload = await response.json();
  if (!Array.isArray(payload)) {
    throw new Error("Binance REST returned invalid payload");
  }

  return payload.map(normalizeRestKline).slice(-MAX_CANDLES);
}

async function syncMinuteHistory(emitHistory = false) {
  try {
    const nextCandles = await fetchMinuteHistoryFromBinance();
    if (nextCandles.length === 0) {
      return;
    }

    const prevLast = candles[candles.length - 1];
    setCandles(nextCandles);
    const nowLast = candles[candles.length - 1];

    const changed =
      !prevLast ||
      prevLast.startTime !== nowLast.startTime ||
      prevLast.close !== nowLast.close ||
      prevLast.volume !== nowLast.volume;

    if (emitHistory || changed) {
      io.emit("history", candles);
      io.emit("kline", nowLast);
      io.emit("price", { close: nowLast.close, startTime: nowLast.startTime, source: "minute" });
    }
  } catch (error) {
    console.error("Failed to sync Binance minute history:", error.message);
  }
}

function normalizeWsKline(kline) {
  return {
    startTime: toNumber(kline.t),
    open: toNumber(kline.o),
    high: toNumber(kline.h),
    low: toNumber(kline.l),
    close: toNumber(kline.c),
    volume: toNumber(kline.v),
    isClosed: Boolean(kline.x)
  };
}

function mapRawBidsToRows(rawBids, exchange) {
  const rows = rawBids
    .map((item) => {
      const price = toNumber(item[0]);
      const size = toNumber(item[1]);
      return {
        exchange: exchange.name,
        exchangeId: exchange.id,
        logoUrl: exchange.logoUrl,
        price,
        size,
        notional: price * size
      };
    })
    .filter((item) => item.price > 0 && item.size >= MIN_TOP_BUYER_BTC)
    .sort((a, b) => b.notional - a.notional);

  return rows.slice(0, TOP_BUYERS_LIMIT);
}

async function fetchBinanceBids() {
  const res = await fetch(
    "https://api.binance.com/api/v3/depth?symbol=BTCUSDT&limit=50"
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  const bids = Array.isArray(json?.bids) ? json.bids : [];
  return mapRawBidsToRows(bids, EXCHANGES[0]);
}

async function fetchBybitBids() {
  const res = await fetch(
    "https://api.bybit.com/v5/market/orderbook?category=spot&symbol=BTCUSDT&limit=50"
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  const bids = Array.isArray(json?.result?.b) ? json.result.b : [];
  return mapRawBidsToRows(bids, EXCHANGES[1]);
}

async function fetchOkxBids() {
  const res = await fetch("https://www.okx.com/api/v5/market/books?instId=BTC-USDT&sz=50");
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  const bids = Array.isArray(json?.data?.[0]?.bids) ? json.data[0].bids : [];
  return mapRawBidsToRows(bids, EXCHANGES[2]);
}

async function fetchKucoinBids() {
  const res = await fetch(
    "https://api.kucoin.com/api/v1/market/orderbook/level2_20?symbol=BTC-USDT"
  );
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const json = await res.json();
  const bids = Array.isArray(json?.data?.bids) ? json.data.bids : [];
  return mapRawBidsToRows(bids, EXCHANGES[3]);
}

async function refreshTopBuyersGlobal() {
  const tasks = [
    { exchange: EXCHANGES[0], fn: fetchBinanceBids },
    { exchange: EXCHANGES[1], fn: fetchBybitBids },
    { exchange: EXCHANGES[2], fn: fetchOkxBids },
    { exchange: EXCHANGES[3], fn: fetchKucoinBids }
  ];

  const settled = await Promise.allSettled(tasks.map((item) => item.fn()));

  /** @type {Array<{exchange:string,exchangeId:string,logoUrl:string,price:number,size:number,notional:number}>} */
  const merged = [];
  /** @type {Array<{exchange:string,status:string,error?:string}>} */
  const status = [];

  settled.forEach((result, idx) => {
    const exchange = tasks[idx].exchange;
    if (result.status === "fulfilled") {
      merged.push(...result.value);
      status.push({ exchange: exchange.name, status: "ok" });
    } else {
      status.push({
        exchange: exchange.name,
        status: "error",
        error: result.reason?.message || "unknown"
      });
    }
  });

  topBuyers = merged.sort((a, b) => b.notional - a.notional).slice(0, TOP_BUYERS_LIMIT);
  exchangeStatus = status;
  topBuyersUpdatedAt = Date.now();

  io.emit("topBuyers", {
    symbol: SYMBOL,
    minBtc: MIN_TOP_BUYER_BTC,
    updatedAt: topBuyersUpdatedAt,
    rows: topBuyers,
    exchanges: exchangeStatus
  });
}

function startTopBuyersSync() {
  if (topBuyersTimer) {
    return;
  }

  refreshTopBuyersGlobal().catch((error) => {
    console.error("Failed to fetch global top buyers:", error.message);
  });

  topBuyersTimer = setInterval(() => {
    refreshTopBuyersGlobal().catch((error) => {
      console.error("Failed to refresh global top buyers:", error.message);
    });
  }, TOP_BUYERS_REFRESH_MS);
}

async function refreshMarkets() {
  try {
    const params = new URLSearchParams({ symbols: JSON.stringify(MARKET_SYMBOLS) });
    const res = await fetch(`https://api.binance.com/api/v3/ticker/24hr?${params.toString()}`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json();
    if (!Array.isArray(payload)) {
      return;
    }

    markets = payload
      .map((item) => ({
        symbol: item.symbol.replace("USDT", ""),
        price: toNumber(item.lastPrice),
        changePercent: toNumber(item.priceChangePercent),
        changeValue: toNumber(item.priceChange)
      }))
      .filter((item) => item.price > 0);

    io.emit("markets", { updatedAt: Date.now(), rows: markets });
  } catch (error) {
    console.error("Failed to refresh markets:", error.message);
  }
}

function startMarketsSync() {
  if (marketsTimer) {
    return;
  }
  refreshMarkets();
  marketsTimer = setInterval(() => {
    refreshMarkets();
  }, MARKETS_REFRESH_MS);
}

async function refreshFearGreed() {
  try {
    const res = await fetch("https://api.alternative.me/fng/?limit=1");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const payload = await res.json();
    const row = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (!row) {
      return;
    }
    fearGreed = {
      value: toNumber(row.value),
      classification: row.value_classification || "Unknown",
      timestamp: toNumber(row.timestamp) * 1000
    };
    io.emit("fearGreed", fearGreed);
  } catch (error) {
    console.error("Failed to refresh fear & greed:", error.message);
  }
}

function startFearGreedSync() {
  if (fearTimer) {
    return;
  }
  refreshFearGreed();
  fearTimer = setInterval(() => {
    refreshFearGreed();
  }, FEAR_REFRESH_MS);
}

function scheduleReconnect() {
  if (isShuttingDown || reconnectTimer) {
    return;
  }

  reconnectAttempt += 1;
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, reconnectAttempt - 1),
    RECONNECT_MAX_DELAY_MS
  );

  console.warn(`Binance WS disconnected. Reconnecting in ${delay}ms (attempt ${reconnectAttempt})`);

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectBinanceWebSocket();
  }, delay);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleForceReconnect() {
  if (isShuttingDown || forceReconnectTimer) {
    return;
  }

  forceReconnectAttempt += 1;
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, forceReconnectAttempt - 1),
    RECONNECT_MAX_DELAY_MS
  );

  forceReconnectTimer = setTimeout(() => {
    forceReconnectTimer = null;
    connectForceWebSocket();
  }, delay);
}

function clearForceReconnectTimer() {
  if (forceReconnectTimer) {
    clearTimeout(forceReconnectTimer);
    forceReconnectTimer = null;
  }
}

function pushLiquidation(item) {
  liquidations = [item, ...liquidations].slice(0, MAX_LIQUIDATIONS);
  io.emit("liquidation", item);
}

function connectForceWebSocket() {
  if (isShuttingDown) {
    return;
  }

  if (
    forceSocket &&
    (forceSocket.readyState === WebSocket.OPEN || forceSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  clearForceReconnectTimer();
  forceSocket = new WebSocket(BINANCE_FORCE_WS_URL);

  forceSocket.on("open", () => {
    forceReconnectAttempt = 0;
    console.log("Connected to Binance forceOrder WS.");
  });

  forceSocket.on("message", (rawData) => {
    try {
      const payload = JSON.parse(rawData.toString());
      const order = payload?.o;
      if (!order) {
        return;
      }

      const qty = toNumber(order.q);
      const price = toNumber(order.ap || order.p);
      const side = order.S === "SELL" ? "sell" : "buy";
      if (qty <= 0 || price <= 0) {
        return;
      }

      pushLiquidation({
        symbol: order.s,
        side,
        price,
        qty,
        notional: price * qty,
        ts: toNumber(order.T) || Date.now()
      });
    } catch (error) {
      console.error("Failed to parse forceOrder message:", error.message);
    }
  });

  forceSocket.on("error", (error) => {
    console.error("forceOrder WS error:", error.message);
  });

  forceSocket.on("close", () => {
    forceSocket = null;
    scheduleForceReconnect();
  });
}

function connectBinanceWebSocket() {
  if (isShuttingDown) {
    return;
  }

  if (
    binanceSocket &&
    (binanceSocket.readyState === WebSocket.OPEN ||
      binanceSocket.readyState === WebSocket.CONNECTING)
  ) {
    return;
  }

  clearReconnectTimer();
  binanceSocket = new WebSocket(BINANCE_WS_URL);

  binanceSocket.on("open", () => {
    reconnectAttempt = 0;
    console.log("Connected to Binance WS.");
  });

  binanceSocket.on("message", (rawData) => {
    try {
      const payload = JSON.parse(rawData.toString());
      const stream = payload?.stream;
      const data = payload?.data;

      if (!stream || !data) {
        return;
      }

      if (stream.endsWith("@trade")) {
        const close = toNumber(data.p);
        const qty = toNumber(data.q);
        const ts = toNumber(data.T) || Date.now();
        if (close > 0) {
          emitSecondPrice(close, ts);
          io.emit("trade", {
            symbol: SYMBOL,
            price: close,
            qty,
            ts,
            side: Boolean(data.m) ? "sell" : "buy"
          });
        }
      }

      if (stream.endsWith("@kline_1m")) {
        const kline = data.k;
        if (!kline) {
          return;
        }
        const candle = normalizeWsKline(kline);
        const updated = upsertCandle(candle);
        io.emit("kline", updated);
      }
    } catch (error) {
      console.error("Failed to parse Binance WS message:", error.message);
    }
  });

  binanceSocket.on("error", (error) => {
    console.error("Binance WS error:", error.message);
  });

  binanceSocket.on("close", () => {
    console.warn("Binance WS closed.");
    binanceSocket = null;
    scheduleReconnect();
  });
}

io.on("connection", (socket) => {
  if (candles.length > 0) {
    socket.emit("history", candles);
  }

  if (latestSecondPrice !== null) {
    socket.emit("price", { close: latestSecondPrice, ts: latestSecondTs, source: "second" });
  } else if (latestClose !== null) {
    socket.emit("price", {
      close: latestClose,
      startTime: candles[candles.length - 1]?.startTime ?? null,
      source: "minute"
    });
  }

  socket.emit("topBuyers", {
    symbol: SYMBOL,
    minBtc: MIN_TOP_BUYER_BTC,
    updatedAt: topBuyersUpdatedAt,
    rows: topBuyers,
    exchanges: exchangeStatus
  });

  socket.emit("liquidations", {
    updatedAt: Date.now(),
    rows: liquidations
  });

  socket.emit("markets", {
    updatedAt: Date.now(),
    rows: markets
  });

  if (fearGreed) {
    socket.emit("fearGreed", fearGreed);
  }
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    binanceWsConnected: binanceSocket?.readyState === WebSocket.OPEN,
    forceWsConnected: forceSocket?.readyState === WebSocket.OPEN,
    candles: candles.length,
    latestSecondPrice,
    topBuyersUpdatedAt,
    liquidations: liquidations.length
  });
});

app.get("/api/price", (_req, res) => {
  const close = latestSecondPrice ?? latestClose;
  if (close === null) {
    res.status(503).json({ message: "Price is not available yet" });
    return;
  }

  res.json({
    symbol: SYMBOL,
    close,
    ts: latestSecondTs,
    startTime: candles[candles.length - 1]?.startTime ?? null
  });
});

app.get("/api/history", (_req, res) => {
  res.json({
    symbol: SYMBOL,
    interval: "1m",
    candles: candles.slice(-MAX_CANDLES)
  });
});

app.get("/api/top-buyers", (_req, res) => {
  res.json({
    symbol: SYMBOL,
    minBtc: MIN_TOP_BUYER_BTC,
    updatedAt: topBuyersUpdatedAt,
    rows: topBuyers,
    exchanges: exchangeStatus
  });
});

app.get("/api/liquidations", (_req, res) => {
  res.json({
    updatedAt: Date.now(),
    rows: liquidations
  });
});

app.get("/api/markets", (_req, res) => {
  res.json({
    updatedAt: Date.now(),
    rows: markets
  });
});

app.get("/api/fear-greed", (_req, res) => {
  res.json(fearGreed ?? {});
});

function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}. Shutting down...`);
  clearReconnectTimer();
  clearForceReconnectTimer();

  if (historySyncTimer) {
    clearInterval(historySyncTimer);
    historySyncTimer = null;
  }

  if (secondHeartbeatTimer) {
    clearInterval(secondHeartbeatTimer);
    secondHeartbeatTimer = null;
  }

  if (topBuyersTimer) {
    clearInterval(topBuyersTimer);
    topBuyersTimer = null;
  }
  if (marketsTimer) {
    clearInterval(marketsTimer);
    marketsTimer = null;
  }
  if (fearTimer) {
    clearInterval(fearTimer);
    fearTimer = null;
  }

  if (binanceSocket) {
    try {
      binanceSocket.terminate();
    } catch (_error) {
      // no-op
    }
  }
  if (forceSocket) {
    try {
      forceSocket.terminate();
    } catch (_error) {
      // no-op
    }
  }

  io.close(() => {
    httpServer.close(() => process.exit(0));
  });
  setTimeout(() => process.exit(1), 5_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

httpServer.listen(PORT, async () => {
  console.log(`Server running on http://localhost:${PORT}`);
  await syncMinuteHistory(true);
  connectBinanceWebSocket();
  connectForceWebSocket();
  startSecondHeartbeat();
  startTopBuyersSync();
  startMarketsSync();
  startFearGreedSync();
  historySyncTimer = setInterval(() => {
    syncMinuteHistory(false);
  }, HISTORY_SYNC_MS);
});
