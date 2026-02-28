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
const BYBIT_LIQUIDATION_WS_URL = "wss://stream.bybit.com/v5/public/linear";
const OKX_LIQUIDATION_WS_URL = "wss://ws.okx.com:8443/ws/v5/public";
const BINANCE_KLINE_REST_URL = `https://api.binance.com/api/v3/klines?symbol=${SYMBOL}&interval=1m&limit=200`;
const MAX_CANDLES = 200;
const TOP_BUYERS_LIMIT = 12;
const MIN_TOP_BUYER_BTC = 0.1;
const MAX_LIQUIDATIONS = 30;
const MIN_LIQUIDATION_NOTIONAL_USD = 100_000;
const TOP_BUYERS_REFRESH_MS = 3_000;
const MARKETS_REFRESH_MS = 10_000;
const FEAR_REFRESH_MS = 60_000;
const NEWS_REFRESH_MS = 60_000;
const NEWS_LIMIT = 10;
const RECONNECT_BASE_DELAY_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;
const HISTORY_SYNC_MS = 5_000;
const NASDAQ_100_SYMBOLS = [
  "AAPL","MSFT","NVDA","AMZN","GOOGL","GOOG","META","TSLA","AVGO","COST",
  "NFLX","ASML","AMD","PEP","ADBE","CSCO","TMUS","LIN","TXN","QCOM",
  "INTU","AMGN","CMCSA","HON","AMAT","INTC","BKNG","GILD","ISRG","ADP",
  "VRTX","SBUX","REGN","ADI","PANW","LRCX","MU","MDLZ","PYPL","SNPS",
  "KLAC","MELI","CDNS","MNST","CSX","ORLY","MAR","CTAS","NXPI","ABNB",
  "CRWD","KDP","AEP","PAYX","PCAR","MRVL","FTNT","ROST","AZN","WDAY",
  "ODFL","CHTR","DLTR","MCHP","IDXX","CPRT","EXC","EA","FANG","GEHC",
  "BIIB","XEL","FAST","CSGP","KHC","VRSK","CTSH","GFS","BKR","ON",
  "TEAM","DDOG","ANSS","TTWO","WBD","LULU","ZS","MDB","CCEP","CDW",
  "DXCM","TTD","ILMN","ARM","SMCI","SIRI","PDD","PYPL","AXON","ROP"
];
const NEWS_FEEDS = [
  { source: "CoinDesk", url: "https://www.coindesk.com/arc/outboundfeeds/rss/" },
  { source: "Cointelegraph", url: "https://cointelegraph.com/rss" },
  { source: "CNN", url: "http://rss.cnn.com/rss/edition.rss" },
  { source: "BBC", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
  { source: "Fox News", url: "https://moxie.foxnews.com/google-publisher/latest.xml" }
];

const EXCHANGES = [
  {
    id: "binance",
    name: "Binance",
    logoUrl: "/exchange-logos/binance.svg"
  },
  {
    id: "bybit",
    name: "Bybit",
    logoUrl: "/exchange-logos/bybit.svg"
  },
  {
    id: "okx",
    name: "OKX",
    logoUrl: "/exchange-logos/okx.svg"
  },
  {
    id: "kucoin",
    name: "KuCoin",
    logoUrl: "/exchange-logos/kucoin.svg"
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
/** @type {Array<{title:string,link:string,source:string,publishedAt:number}>} */
let newsItems = [];
let binanceSocket = null;
let forceSockets = {
  binance: null,
  bybit: null,
  okx: null
};
let reconnectAttempt = 0;
let reconnectTimer = null;
let forceReconnectAttempts = {
  binance: 0,
  bybit: 0,
  okx: 0
};
let forceReconnectTimers = {
  binance: null,
  bybit: null,
  okx: null
};
let historySyncTimer = null;
let secondHeartbeatTimer = null;
let topBuyersTimer = null;
let marketsTimer = null;
let fearTimer = null;
let newsTimer = null;
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
    const cryptoRes = await fetch("https://api.binance.com/api/v3/ticker/24hr");
    if (!cryptoRes.ok) {
      throw new Error(`Binance ticker HTTP ${cryptoRes.status}`);
    }
    const cryptoPayload = await cryptoRes.json();
    const stableBases = new Set(["USDT", "USDC", "FDUSD", "BUSD", "TUSD", "DAI", "USDP"]);
    const cryptoRows = Array.isArray(cryptoPayload)
      ? cryptoPayload
          .filter((item) => String(item.symbol || "").endsWith("USDT"))
          .map((item) => {
            const symbol = String(item.symbol || "");
            const base = symbol.replace("USDT", "");
            return {
              symbol: base,
              price: toNumber(item.lastPrice),
              changePercent: toNumber(item.priceChangePercent),
              changeValue: toNumber(item.priceChange),
              quoteVolume: toNumber(item.quoteVolume),
              marketType: "crypto"
            };
          })
          .filter((item) => item.symbol && !stableBases.has(item.symbol) && item.price > 0)
          .sort((a, b) => b.quoteVolume - a.quoteVolume)
          .slice(0, 10)
          .map(({ quoteVolume, ...rest }) => rest)
      : [];

    const uniqueStocks = [...new Set(NASDAQ_100_SYMBOLS)];
    const stockRows = [];
    const chunkSize = 20;
    for (let i = 0; i < uniqueStocks.length; i += chunkSize) {
      const chunk = uniqueStocks.slice(i, i + chunkSize).map((s) => `${s.toLowerCase()}.us`);
      const stockRes = await fetch(
        `https://stooq.com/q/l/?s=${chunk.join("+")}&f=sd2t2ohlcv&h&e=csv`
      );
      if (!stockRes.ok) {
        throw new Error(`Stooq HTTP ${stockRes.status}`);
      }
      const csv = await stockRes.text();
      const lines = csv.split(/\r?\n/).filter(Boolean).slice(1);
      for (const line of lines) {
        const cols = line.split(",");
        if (cols.length < 8) {
          continue;
        }
        const symbolRaw = String(cols[0] || "").toUpperCase();
        const open = toNumber(cols[3]);
        const close = toNumber(cols[6]);
        if (!symbolRaw || open <= 0 || close <= 0) {
          continue;
        }
        const symbol = symbolRaw.replace(".US", "");
        const changeValue = close - open;
        const changePercent = (changeValue / open) * 100;
        stockRows.push({
          symbol,
          price: close,
          changePercent,
          changeValue,
          marketType: "stock"
        });
      }
    }

    markets = [...cryptoRows, ...stockRows].filter((item) => item.symbol && item.price > 0);

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

function decodeXmlEntities(value) {
  const decoded = String(value || "")
    .replace(/<!\[CDATA\[(.*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCodePoint(parseInt(hex, 16)));

  return decoded;
}

function stripHtmlTags(value) {
  return String(value || "").replace(/<[^>]*>/g, " ");
}

function normalizeHeadlineText(value) {
  return stripHtmlTags(decodeXmlEntities(value))
    .replace(/\s+/g, " ")
    .trim();
}

function parseRssItems(xml, source) {
  const items = [];
  const itemRegex = /<item\b[\s\S]*?<\/item>/gi;
  const entryRegex = /<entry\b[\s\S]*?<\/entry>/gi;
  const titleRegex = /<title\b[^>]*>([\s\S]*?)<\/title>/i;
  const linkRegex = /<link>([\s\S]*?)<\/link>/i;
  const atomLinkRegex = /<link\b[^>]*href=["']([^"']+)["'][^>]*\/?>/i;
  const dateRegex = /<pubDate>([\s\S]*?)<\/pubDate>/i;
  const updatedRegex = /<updated>([\s\S]*?)<\/updated>/i;
  const publishedRegex = /<published>([\s\S]*?)<\/published>/i;

  let match;
  while ((match = itemRegex.exec(xml)) !== null) {
    const block = match[0];
    const title = normalizeHeadlineText(block.match(titleRegex)?.[1] || "");
    const link = decodeXmlEntities(block.match(linkRegex)?.[1] || "").trim();
    const dateStr = decodeXmlEntities(block.match(dateRegex)?.[1] || "").trim();
    const publishedAt = Date.parse(dateStr);
    if (!title || !link || !Number.isFinite(publishedAt)) {
      continue;
    }
    items.push({ title, link, source, publishedAt });
  }

  while ((match = entryRegex.exec(xml)) !== null) {
    const block = match[0];
    const title = normalizeHeadlineText(block.match(titleRegex)?.[1] || "");
    const link =
      decodeXmlEntities(block.match(atomLinkRegex)?.[1] || "") ||
      decodeXmlEntities(block.match(linkRegex)?.[1] || "");
    const dateStr = decodeXmlEntities(
      block.match(updatedRegex)?.[1] || block.match(publishedRegex)?.[1] || ""
    ).trim();
    const publishedAt = Date.parse(dateStr);
    if (!title || !link || !Number.isFinite(publishedAt)) {
      continue;
    }
    items.push({ title, link, source, publishedAt });
  }

  return items;
}

function getLatestNews(limit = NEWS_LIMIT) {
  return newsItems.slice(0, limit);
}

async function refreshNews() {
  try {
    const settled = await Promise.allSettled(
      NEWS_FEEDS.map(async (feed) => {
        const res = await fetch(feed.url, {
          headers: { "User-Agent": "Mozilla/5.0" }
        });
        if (!res.ok) {
          throw new Error(`${feed.source} HTTP ${res.status}`);
        }
        const xml = await res.text();
        return parseRssItems(xml, feed.source);
      })
    );

    const merged = [];
    for (const result of settled) {
      if (result.status === "fulfilled") {
        merged.push(...result.value);
      }
    }

    const dedup = new Map();
    merged.forEach((item) => {
      const key = `${item.source}|${item.title}`;
      const prev = dedup.get(key);
      if (!prev || item.publishedAt > prev.publishedAt) {
        dedup.set(key, item);
      }
    });

    newsItems = [...dedup.values()]
      .sort((a, b) => b.publishedAt - a.publishedAt)
      .slice(0, 150);

    io.emit("news", {
      updatedAt: Date.now(),
      limit: NEWS_LIMIT,
      rows: getLatestNews(NEWS_LIMIT)
    });
  } catch (error) {
    console.error("Failed to refresh news:", error.message);
  }
}

function startNewsSync() {
  if (newsTimer) {
    return;
  }
  refreshNews();
  newsTimer = setInterval(() => {
    refreshNews();
  }, NEWS_REFRESH_MS);
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

function scheduleForceReconnect(exchangeId) {
  if (isShuttingDown || forceReconnectTimers[exchangeId]) {
    return;
  }

  forceReconnectAttempts[exchangeId] += 1;
  const delay = Math.min(
    RECONNECT_BASE_DELAY_MS * 2 ** Math.max(0, forceReconnectAttempts[exchangeId] - 1),
    RECONNECT_MAX_DELAY_MS
  );

  forceReconnectTimers[exchangeId] = setTimeout(() => {
    forceReconnectTimers[exchangeId] = null;
    connectForceWebSocket(exchangeId);
  }, delay);
}

function clearForceReconnectTimer(exchangeId) {
  if (forceReconnectTimers[exchangeId]) {
    clearTimeout(forceReconnectTimers[exchangeId]);
    forceReconnectTimers[exchangeId] = null;
  }
}

function pushLiquidation(item) {
  if ((item?.notional || 0) < MIN_LIQUIDATION_NOTIONAL_USD) {
    return;
  }
  liquidations = [item, ...liquidations].slice(0, MAX_LIQUIDATIONS);
  io.emit("liquidation", item);
}

function connectBinanceForceWebSocket() {
  if (isShuttingDown) {
    return;
  }

  const existing = forceSockets.binance;
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearForceReconnectTimer("binance");
  forceSockets.binance = new WebSocket(BINANCE_FORCE_WS_URL);

  forceSockets.binance.on("open", () => {
    forceReconnectAttempts.binance = 0;
    console.log("Connected to Binance forceOrder WS.");
  });

  forceSockets.binance.on("message", (rawData) => {
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
        exchange: "Binance",
        exchangeId: "binance",
        logoUrl: "/exchange-logos/binance.svg",
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

  forceSockets.binance.on("error", (error) => {
    console.error("forceOrder WS error:", error.message);
  });

  forceSockets.binance.on("close", () => {
    forceSockets.binance = null;
    scheduleForceReconnect("binance");
  });
}

function pickFirstNumber(...values) {
  for (const value of values) {
    const n = toNumber(value);
    if (n > 0) {
      return n;
    }
  }
  return 0;
}

function connectBybitForceWebSocket() {
  if (isShuttingDown) {
    return;
  }

  const existing = forceSockets.bybit;
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearForceReconnectTimer("bybit");
  forceSockets.bybit = new WebSocket(BYBIT_LIQUIDATION_WS_URL);

  forceSockets.bybit.on("open", () => {
    forceReconnectAttempts.bybit = 0;
    forceSockets.bybit.send(
      JSON.stringify({
        op: "subscribe",
        args: ["liquidation.BTCUSDT"]
      })
    );
    console.log("Connected to Bybit liquidation WS.");
  });

  forceSockets.bybit.on("message", (rawData) => {
    try {
      const payload = JSON.parse(rawData.toString());
      if (!String(payload?.topic || "").startsWith("liquidation.")) {
        return;
      }

      const rows = Array.isArray(payload?.data) ? payload.data : payload?.data ? [payload.data] : [];
      rows.forEach((entry) => {
        const price = pickFirstNumber(entry.p, entry.price);
        const qty = pickFirstNumber(entry.v, entry.size, entry.qty, entry.q);
        const ts = pickFirstNumber(entry.T, entry.ts, payload.ts) || Date.now();
        if (price <= 0 || qty <= 0) {
          return;
        }
        const sideText = String(entry.S || entry.side || "").toUpperCase();
        const side = sideText === "SELL" ? "sell" : "buy";
        pushLiquidation({
          exchange: "Bybit",
          exchangeId: "bybit",
          logoUrl: "/exchange-logos/bybit.svg",
          symbol: entry.s || "BTCUSDT",
          side,
          price,
          qty,
          notional: price * qty,
          ts
        });
      });
    } catch (error) {
      console.error("Failed to parse Bybit liquidation message:", error.message);
    }
  });

  forceSockets.bybit.on("error", (error) => {
    console.error("Bybit liquidation WS error:", error.message);
  });

  forceSockets.bybit.on("close", () => {
    forceSockets.bybit = null;
    scheduleForceReconnect("bybit");
  });
}

function connectOkxForceWebSocket() {
  if (isShuttingDown) {
    return;
  }

  const existing = forceSockets.okx;
  if (existing && (existing.readyState === WebSocket.OPEN || existing.readyState === WebSocket.CONNECTING)) {
    return;
  }

  clearForceReconnectTimer("okx");
  forceSockets.okx = new WebSocket(OKX_LIQUIDATION_WS_URL);

  forceSockets.okx.on("open", () => {
    forceReconnectAttempts.okx = 0;
    forceSockets.okx.send(
      JSON.stringify({
        op: "subscribe",
        args: [{ channel: "liquidation-orders", instType: "SWAP", instFamily: "BTC-USDT" }]
      })
    );
    console.log("Connected to OKX liquidation WS.");
  });

  forceSockets.okx.on("message", (rawData) => {
    try {
      const payload = JSON.parse(rawData.toString());
      if (payload?.event) {
        return;
      }
      if (payload?.arg?.channel !== "liquidation-orders") {
        return;
      }

      const rows = [];
      const data = Array.isArray(payload?.data) ? payload.data : [];
      data.forEach((item) => {
        if (Array.isArray(item?.details)) {
          item.details.forEach((d) => rows.push({ ...d, instId: item.instId, ts: item.ts || d.ts }));
          return;
        }
        rows.push(item);
      });

      rows.forEach((entry) => {
        const price = pickFirstNumber(entry.bkPx, entry.px, entry.fillPx, entry.price);
        const qty = pickFirstNumber(entry.sz, entry.qty, entry.size, entry.bkSz);
        const notional = pickFirstNumber(entry.notionalUsd, entry.usdSz, price * qty);
        const ts = pickFirstNumber(entry.ts, payload?.ts) || Date.now();
        if (price <= 0 || qty <= 0 || notional <= 0) {
          return;
        }
        const sideText = String(entry.side || entry.S || "").toUpperCase();
        const side = sideText === "SELL" ? "sell" : "buy";
        pushLiquidation({
          exchange: "OKX",
          exchangeId: "okx",
          logoUrl: "/exchange-logos/okx.svg",
          symbol: entry.instId || "BTC-USDT-SWAP",
          side,
          price,
          qty,
          notional,
          ts
        });
      });
    } catch (error) {
      console.error("Failed to parse OKX liquidation message:", error.message);
    }
  });

  forceSockets.okx.on("error", (error) => {
    console.error("OKX liquidation WS error:", error.message);
  });

  forceSockets.okx.on("close", () => {
    forceSockets.okx = null;
    scheduleForceReconnect("okx");
  });
}

function connectForceWebSocket(exchangeId) {
  if (exchangeId === "bybit") {
    connectBybitForceWebSocket();
    return;
  }
  if (exchangeId === "okx") {
    connectOkxForceWebSocket();
    return;
  }
  connectBinanceForceWebSocket();
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
  socket.emit("news", {
    updatedAt: Date.now(),
    limit: NEWS_LIMIT,
    rows: getLatestNews(NEWS_LIMIT)
  });
});

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    binanceWsConnected: binanceSocket?.readyState === WebSocket.OPEN,
    forceWsConnected: Object.values(forceSockets).some((ws) => ws?.readyState === WebSocket.OPEN),
    forceWs: {
      binance: forceSockets.binance?.readyState === WebSocket.OPEN,
      bybit: forceSockets.bybit?.readyState === WebSocket.OPEN,
      okx: forceSockets.okx?.readyState === WebSocket.OPEN
    },
    candles: candles.length,
    latestSecondPrice,
    topBuyersUpdatedAt,
    liquidations: liquidations.length,
    latestNewsCount: getLatestNews(NEWS_LIMIT).length
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

app.get("/api/news", (_req, res) => {
  res.json({
    updatedAt: Date.now(),
    limit: NEWS_LIMIT,
    rows: getLatestNews(NEWS_LIMIT)
  });
});

function shutdown(signal) {
  if (isShuttingDown) {
    return;
  }

  isShuttingDown = true;
  console.log(`Received ${signal}. Shutting down...`);
  clearReconnectTimer();
  clearForceReconnectTimer("binance");
  clearForceReconnectTimer("bybit");
  clearForceReconnectTimer("okx");

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
  if (newsTimer) {
    clearInterval(newsTimer);
    newsTimer = null;
  }

  if (binanceSocket) {
    try {
      binanceSocket.terminate();
    } catch (_error) {
      // no-op
    }
  }
  Object.keys(forceSockets).forEach((key) => {
    const socket = forceSockets[key];
    if (!socket) {
      return;
    }
    try {
      socket.terminate();
    } catch (_error) {
      // no-op
    }
    forceSockets[key] = null;
  });

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
  connectForceWebSocket("binance");
  connectForceWebSocket("bybit");
  connectForceWebSocket("okx");
  startSecondHeartbeat();
  startTopBuyersSync();
  startMarketsSync();
  startFearGreedSync();
  startNewsSync();
  historySyncTimer = setInterval(() => {
    syncMinuteHistory(false);
  }, HISTORY_SYNC_MS);
});
