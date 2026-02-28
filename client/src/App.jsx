import { useEffect, useMemo, useRef, useState } from "react";
import { io } from "socket.io-client";
import {
  Chart,
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  BarElement,
  BarController
} from "chart.js";
import "chartjs-adapter-date-fns";
import {
  CandlestickController,
  CandlestickElement,
  OhlcController,
  OhlcElement
} from "chartjs-chart-financial";

Chart.register(
  LinearScale,
  TimeScale,
  Tooltip,
  Legend,
  BarElement,
  BarController,
  CandlestickController,
  CandlestickElement,
  OhlcController,
  OhlcElement
);

const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:3000";
const MAX_SECOND_CANDLES = 240;
const MAX_MINUTE_CANDLES = 320;
const SECOND_CANDLE_INTERVAL_MS = 10_000;
const MIN_BUYER_BTC = 0.1;
const MAX_TOP_BUYERS_FEED = 20;
const SECONDARY_COINS_VISIBLE = 6;
const CHART_RENDER_INTERVAL_MS = 120;
const PRICE_STATE_INTERVAL_MS = 120;
const DATA_STALE_MS = 8000;
const BUYER_SOUND_MIN_INTERVAL_MS = 2000;
const BUYER_SOUND_DEFAULT_TIER = 0;
const BUYER_SOUND_DEFAULT_VOLUME = 0.22;
const BUYER_TING_NOTIONAL_USD = 50000;
const BUYER_TING_FILE = "/sounds/buyer-ting.wav";
const BUYER_SOUND_TIERS = [0.3, 0.5, 0.8, 1.0, 1.5];
const LIQUIDATION_MIN_NOTIONAL = 100000;
const BUYER_SOUND_FILES = [
  "/sounds/buyer-tier-1.wav",
  "/sounds/buyer-tier-2.wav",
  "/sounds/buyer-tier-3.wav",
  "/sounds/buyer-tier-4.wav",
  "/sounds/buyer-tier-5.wav"
];

const livePriceLinePlugin = {
  id: "livePriceLine",
  afterDatasetsDraw(chart) {
    const candleDs = chart?.data?.datasets?.[0];
    const last = candleDs?.data?.[candleDs.data.length - 1];
    const yScale = chart?.scales?.y;
    if (!last || !yScale) {
      return;
    }

    const price = Number(last.c);
    if (!Number.isFinite(price)) {
      return;
    }

    const { ctx, chartArea } = chart;
    const y = yScale.getPixelForValue(price);
    const up = Number(last.c) >= Number(last.o);
    const lineColor = up ? "rgba(39, 216, 148, 0.85)" : "rgba(255, 56, 95, 0.85)";
    const labelBg = up ? "rgba(39, 216, 148, 0.18)" : "rgba(255, 56, 95, 0.2)";

    ctx.save();
    ctx.setLineDash([6, 4]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = lineColor;
    ctx.beginPath();
    ctx.moveTo(chartArea.left, y);
    ctx.lineTo(chartArea.right, y);
    ctx.stroke();
    ctx.setLineDash([]);

    const text = formatPrice(price);
    ctx.font = "700 11px Manrope, sans-serif";
    const textWidth = ctx.measureText(text).width;
    const padX = 7;
    const boxW = textWidth + padX * 2;
    const boxH = 20;
    const boxX = chartArea.right - boxW - 2;
    const boxY = Math.max(chartArea.top + 2, Math.min(y - boxH / 2, chartArea.bottom - boxH - 2));

    ctx.fillStyle = labelBg;
    ctx.fillRect(boxX, boxY, boxW, boxH);
    ctx.strokeStyle = lineColor;
    ctx.lineWidth = 1;
    ctx.strokeRect(boxX, boxY, boxW, boxH);

    ctx.fillStyle = "#f8fbff";
    ctx.textBaseline = "middle";
    ctx.fillText(text, boxX + padX, boxY + boxH / 2);
    ctx.restore();
  }
};

Chart.register(livePriceLinePlugin);

function formatPrice(value) {
  if (value === null || value === undefined) {
    return "--";
  }
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
  });
}

function formatPriceNoDecimal(value) {
  if (value === null || value === undefined) {
    return "--";
  }
  return value.toLocaleString("en-US", {
    maximumFractionDigits: 0
  });
}

function formatCompact(value) {
  if (value === null || value === undefined) {
    return "--";
  }
  return value.toLocaleString("en-US", {
    notation: "compact",
    maximumFractionDigits: 1
  });
}

function formatBtc(value) {
  if (value === null || value === undefined) {
    return "--";
  }
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 3,
    maximumFractionDigits: 3
  });
}

function formatSigned(value, digits = 2) {
  const n = Number(value);
  if (!Number.isFinite(n)) {
    return "--";
  }
  return `${n >= 0 ? "+" : ""}${n.toFixed(digits)}`;
}

function buyerKey(row) {
  return `${row.exchangeId}|${row.price}|${row.size}`;
}

function liquidationKey(row) {
  return `${row.exchangeId || row.exchange || "x"}|${row.ts}|${row.price}|${row.qty || row.notional || 0}`;
}

function getRotatingSlice(items, start, size) {
  if (!Array.isArray(items) || items.length === 0 || size <= 0) {
    return [];
  }
  const out = [];
  for (let i = 0; i < Math.min(size, items.length); i += 1) {
    out.push(items[(start + i) % items.length]);
  }
  return out;
}

function newsKey(item) {
  return `${item?.source || ""}|${item?.title || ""}|${item?.link || ""}`;
}

function shuffleNewsWithDiff(items, previous) {
  if (!Array.isArray(items) || items.length <= 1) {
    return Array.isArray(items) ? [...items] : [];
  }

  const prevKeys = (previous || []).map(newsKey).join("||");
  const next = [...items];

  for (let attempt = 0; attempt < 6; attempt += 1) {
    for (let i = next.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [next[i], next[j]] = [next[j], next[i]];
    }
    const nextKeys = next.map(newsKey).join("||");
    if (nextKeys !== prevKeys) {
      return next;
    }
  }

  const rotated = [...items];
  rotated.push(rotated.shift());
  return rotated;
}

function shouldHideUsdOnePrice(market) {
  if (!market || market.marketType !== "crypto") {
    return false;
  }
  const price = Number(market.price);
  if (!Number.isFinite(price)) {
    return false;
  }
  return Math.abs(price - 1) <= 0.01;
}

function getVolumeByBtcSize(size) {
  if (size < BUYER_SOUND_TIERS[0]) {
    return 0;
  }

  if (size < BUYER_SOUND_TIERS[1]) {
    const t = (size - BUYER_SOUND_TIERS[0]) / (BUYER_SOUND_TIERS[1] - BUYER_SOUND_TIERS[0]);
    return 0.08 + t * 0.08;
  }

  if (size < BUYER_SOUND_TIERS[2]) {
    const t = (size - BUYER_SOUND_TIERS[1]) / (BUYER_SOUND_TIERS[2] - BUYER_SOUND_TIERS[1]);
    return 0.18 + t * 0.14;
  }

  if (size < BUYER_SOUND_TIERS[3]) {
    const t = (size - BUYER_SOUND_TIERS[2]) / (BUYER_SOUND_TIERS[3] - BUYER_SOUND_TIERS[2]);
    return 0.34 + t * 0.16;
  }

  if (size < BUYER_SOUND_TIERS[4]) {
    const t = (size - BUYER_SOUND_TIERS[3]) / (BUYER_SOUND_TIERS[4] - BUYER_SOUND_TIERS[3]);
    return 0.52 + t * 0.2;
  }

  const over = Math.min(1, (size - BUYER_SOUND_TIERS[4]) / 2);
  return 0.74 + over * 0.26;
}

function getBuyerTierIndex(size) {
  if (size >= BUYER_SOUND_TIERS[4]) return 4;
  if (size >= BUYER_SOUND_TIERS[3]) return 3;
  if (size >= BUYER_SOUND_TIERS[2]) return 2;
  if (size >= BUYER_SOUND_TIERS[1]) return 1;
  if (size >= BUYER_SOUND_TIERS[0]) return 0;
  return -1;
}

function bucketStart(ts, intervalMs) {
  return Math.floor(ts / intervalMs) * intervalMs;
}

function upsertCandleFromTrade(candles, trade, intervalMs, maxItems) {
  const x = bucketStart(trade.ts, intervalMs);
  const next = [...candles];
  const last = next[next.length - 1];

  if (!last || last.x !== x) {
    next.push({
      x,
      o: trade.price,
      h: trade.price,
      l: trade.price,
      c: trade.price
    });
  } else {
    last.h = Math.max(last.h, trade.price);
    last.l = Math.min(last.l, trade.price);
    last.c = trade.price;
  }

  return next.slice(-maxItems);
}

function upsertCandleFromKline(candles, kline, maxItems) {
  const point = {
    x: Number(kline.startTime),
    o: Number(kline.open),
    h: Number(kline.high),
    l: Number(kline.low),
    c: Number(kline.close),
    v: Number(kline.volume) || 0
  };
  const next = [...candles];
  const idx = next.findIndex((item) => item.x === point.x);
  if (idx >= 0) {
    next[idx] = point;
  } else {
    next.push(point);
  }
  next.sort((a, b) => a.x - b.x);
  return next.slice(-maxItems);
}

function upsertVolumeFromKline(volumes, kline, maxItems) {
  const point = {
    x: Number(kline.startTime),
    buy: Number(kline.volume) || 0,
    sell: 0
  };
  const next = [...volumes];
  const idx = next.findIndex((item) => item.x === point.x);
  if (idx >= 0) {
    next[idx] = point;
  } else {
    next.push(point);
  }
  next.sort((a, b) => a.x - b.x);
  return next.slice(-maxItems);
}

function upsertVolume(volumes, trade, intervalMs, maxItems) {
  const x = bucketStart(trade.ts, intervalMs);
  const next = [...volumes];
  const last = next[next.length - 1];

  if (!last || last.x !== x) {
    next.push({
      x,
      buy: trade.side === "buy" ? trade.qty : 0,
      sell: trade.side === "sell" ? trade.qty : 0
    });
  } else if (trade.side === "buy") {
    last.buy += trade.qty;
  } else {
    last.sell += trade.qty;
  }

  return next.slice(-maxItems);
}

function createChart(canvas, title, unit) {
  return new Chart(canvas, {
    data: {
      datasets: [
        {
          type: "candlestick",
          label: title,
          data: [],
          yAxisID: "y",
          borderColor: {
            up: "#19d3a2",
            down: "#ff4d73",
            unchanged: "#8a96b3"
          },
          color: {
            up: "#19d3a2",
            down: "#ff4d73",
            unchanged: "#8a96b3"
          },
          borderWidth: 1.4
        },
        {
          type: "bar",
          label: "Buy Vol",
          data: [],
          yAxisID: "yVolume",
          backgroundColor: "rgba(25, 211, 162, 0.55)",
          borderWidth: 0,
          barPercentage: 0.94,
          categoryPercentage: 1,
          parsing: false
        },
        {
          type: "bar",
          label: "Sell Vol",
          data: [],
          yAxisID: "yVolume",
          backgroundColor: "rgba(255, 77, 115, 0.55)",
          borderWidth: 0,
          barPercentage: 0.94,
          categoryPercentage: 1,
          parsing: false
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      animation: false,
      parsing: false,
      normalized: true,
      scales: {
        x: {
          type: "time",
          time: {
            unit,
            displayFormats: {
              second: "HH:mm:ss",
              minute: "HH:mm"
            }
          },
          ticks: { color: "#6f7f9f", maxTicksLimit: 10 },
          grid: { color: "rgba(45, 58, 87, 0.42)" },
          border: { color: "rgba(50, 64, 95, 0.55)" }
        },
        y: {
          position: "right",
          weight: 3,
          ticks: { color: "#7f8aa8", maxTicksLimit: 8 },
          grid: { color: "rgba(45, 58, 87, 0.42)" },
          border: { color: "rgba(50, 64, 95, 0.55)" }
        },
        yVolume: {
          position: "right",
          weight: 1,
          beginAtZero: true,
          ticks: {
            color: "#607091",
            maxTicksLimit: 3
          },
          grid: { color: "rgba(45, 58, 87, 0.22)" },
          border: { color: "rgba(50, 64, 95, 0.45)" }
        }
      },
      plugins: {
        livePriceLine: {},
        legend: {
          display: false
        },
        tooltip: {
          mode: "index",
          intersect: false,
          backgroundColor: "rgba(11, 16, 28, 0.94)",
          borderColor: "rgba(93, 118, 173, 0.5)",
          borderWidth: 1,
          titleColor: "#eef3ff",
          bodyColor: "#d5def1"
        }
      }
    }
  });
}

function App() {
  const secondCanvasRef = useRef(null);
  const minuteCanvasRef = useRef(null);
  const newsBoxRef = useRef(null);
  const secondChartRef = useRef(null);
  const minuteChartRef = useRef(null);
  const secondDataRef = useRef({ candles: [], volumes: [] });
  const minuteDataRef = useRef({ candles: [], volumes: [] });
  const previousPriceRef = useRef(null);
  const previousMarketsRef = useRef(new Map());
  const latestPriceRef = useRef(null);
  const lastPriceSetAtRef = useRef(0);
  const lastDataAtRef = useRef(Date.now());
  const pendingSecondRenderRef = useRef(false);
  const pendingMinuteRenderRef = useRef(false);
  const socketRef = useRef(null);
  const lastHistoryPollRef = useRef(0);
  const alertAudioMapRef = useRef(new Map());
  const fallbackAudioCtxRef = useRef(null);
  const audioUnlockedRef = useRef(false);
  const lastBuyerAlertAtRef = useRef(0);
  const buyerQueueRef = useRef([]);
  const buyerDrainTimerRef = useRef(null);
  const btcFlashTimerRef = useRef(null);
  const buyerPanelPulseTimerRef = useRef(null);
  const liqPanelPulseTimerRef = useRef(null);
  const buyerHotTimersRef = useRef(new Map());
  const liqHotTimersRef = useRef(new Map());

  const [price, setPrice] = useState(null);
  const [priceTrend, setPriceTrend] = useState("neutral");
  const [btcFlash, setBtcFlash] = useState("");
  const [status, setStatus] = useState("Connecting...");
  const [lastTickTime, setLastTickTime] = useState(null);
  const [lastBuyVolume, setLastBuyVolume] = useState(0);
  const [lastSellVolume, setLastSellVolume] = useState(0);
  const [topBuyers, setTopBuyers] = useState([]);
  const [liquidations, setLiquidations] = useState([]);
  const [markets, setMarkets] = useState([]);
  const [fearGreed, setFearGreed] = useState(null);
  const [newsItems, setNewsItems] = useState([]);
  const [displayNewsItems, setDisplayNewsItems] = useState([]);
  const [newsAnimMode, setNewsAnimMode] = useState(0);
  const [topBuyersPulse, setTopBuyersPulse] = useState(false);
  const [liquidationsPulse, setLiquidationsPulse] = useState(false);
  const [hotBuyerRows, setHotBuyerRows] = useState({});
  const [hotLiquidationRows, setHotLiquidationRows] = useState({});

  const normalizeMarketsWithDiff = (rows) => {
    const now = Date.now();
    const map = previousMarketsRef.current;

    const normalized = rows.map((row) => {
      const key = `${row.marketType || "m"}-${row.symbol}`;
      const prev = map.get(key);
      const prevPrice = Number(prev?.price);
      const prevPct = Number(prev?.changePercent);
      const price = Number(row.price);
      const pct = Number(row.changePercent);
      const priceDiff = Number.isFinite(prevPrice) ? price - prevPrice : 0;
      const pctDiff = Number.isFinite(prevPct) ? pct - prevPct : 0;
      const changed =
        !prev ||
        Math.abs(priceDiff) > 1e-9 ||
        Math.abs(pctDiff) > 1e-9;

      map.set(key, { price, changePercent: pct, updatedAt: now });

      return {
        ...row,
        priceDiff,
        pctDiff,
        changed,
        updateDirection: priceDiff > 0 ? "up" : priceDiff < 0 ? "down" : "flat",
        updatedAt: now
      };
    });

    return normalized;
  };

  const btcTicker = markets.find((item) => item.symbol === "BTC");
  const secondaryCoinsAll = markets.filter(
    (item) => item.marketType === "crypto" && item.symbol !== "BTC"
  );
  const secondaryCoinsChanged = secondaryCoinsAll.filter((item) => item.changed);
  const secondaryCoins = secondaryCoinsChanged.length > 0 ? secondaryCoinsChanged : secondaryCoinsAll;
  const marqueeCoins = secondaryCoins.length > 0
    ? secondaryCoins
    : getRotatingSlice(secondaryCoinsAll, 0, SECONDARY_COINS_VISIBLE);

  useEffect(() => {
    const nextMap = new Map();
    BUYER_SOUND_FILES.forEach((filePath, idx) => {
      const audio = new Audio(filePath);
      audio.preload = "auto";
      nextMap.set(idx, audio);
    });
    alertAudioMapRef.current = nextMap;

    const unlockAudio = () => {
      audioUnlockedRef.current = true;
      if (fallbackAudioCtxRef.current?.state === "suspended") {
        fallbackAudioCtxRef.current.resume().catch(() => {});
      }

      alertAudioMapRef.current.forEach((audio) => {
        audio.muted = true;
        const promise = audio.play();
        if (promise?.then) {
          promise
            .then(() => {
              audio.pause();
              audio.currentTime = 0;
              audio.muted = false;
            })
            .catch(() => {
              audio.muted = false;
            });
        } else {
          audio.muted = false;
        }
      });
    };

    window.addEventListener("pointerdown", unlockAudio);
    window.addEventListener("keydown", unlockAudio);
    window.addEventListener("touchstart", unlockAudio);

    return () => {
      window.removeEventListener("pointerdown", unlockAudio);
      window.removeEventListener("keydown", unlockAudio);
      window.removeEventListener("touchstart", unlockAudio);
      alertAudioMapRef.current.forEach((audio) => audio.pause());
      alertAudioMapRef.current.clear();
    };
  }, []);

  useEffect(() => {
    setDisplayNewsItems(shuffleNewsWithDiff(newsItems, displayNewsItems));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newsItems]);

  useEffect(() => {
    const timer = setInterval(() => {
      setNewsAnimMode((prev) => (prev + 1) % 3);
      setDisplayNewsItems((prev) => shuffleNewsWithDiff(newsItems, prev));
    }, 5_000);
    return () => clearInterval(timer);
  }, [newsItems]);

  useEffect(() => {
    const el = newsBoxRef.current;
    if (!el) {
      return undefined;
    }

    let rafId = 0;
    let lastTs = 0;
    const pxPerSecond = 16; // slow and steady
    let running = true;

    const step = (ts) => {
      if (!running) {
        return;
      }
      if (!lastTs) {
        lastTs = ts;
      }
      const dt = (ts - lastTs) / 1000;
      lastTs = ts;

      const maxScroll = Math.max(0, el.scrollHeight - el.clientHeight);
      if (maxScroll <= 1) {
        rafId = requestAnimationFrame(step);
        return;
      }

      el.scrollTop += pxPerSecond * dt;
      if (el.scrollTop >= maxScroll - 1) {
        el.scrollTop = 0;
      }

      rafId = requestAnimationFrame(step);
    };

    rafId = requestAnimationFrame(step);

    return () => {
      running = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
    };
  }, [newsItems.length]);

  useEffect(() => {
    return () => {
      if (btcFlashTimerRef.current) {
        clearTimeout(btcFlashTimerRef.current);
        btcFlashTimerRef.current = null;
      }
      if (buyerPanelPulseTimerRef.current) {
        clearTimeout(buyerPanelPulseTimerRef.current);
        buyerPanelPulseTimerRef.current = null;
      }
      if (liqPanelPulseTimerRef.current) {
        clearTimeout(liqPanelPulseTimerRef.current);
        liqPanelPulseTimerRef.current = null;
      }
      buyerHotTimersRef.current.forEach((id) => clearTimeout(id));
      liqHotTimersRef.current.forEach((id) => clearTimeout(id));
      buyerHotTimersRef.current.clear();
      liqHotTimersRef.current.clear();
    };
  }, []);

  const playFallbackTone = (volume) => {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) {
      return;
    }
    if (!fallbackAudioCtxRef.current) {
      fallbackAudioCtxRef.current = new AudioCtx();
    }
    const ctx = fallbackAudioCtxRef.current;
    if (ctx.state === "suspended" && audioUnlockedRef.current) {
      ctx.resume().catch(() => {});
    }
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = "triangle";
    osc.frequency.setValueAtTime(920, now);
    osc.frequency.exponentialRampToValueAtTime(1420, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(volume, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.2);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.2);
  };

  const playBuyerTing = (tierIndex, volume) => {
    try {
      const base = alertAudioMapRef.current.get(tierIndex);
      if (base) {
        const clip = new Audio(base.src || BUYER_SOUND_FILES[tierIndex] || BUYER_SOUND_FILES[0]);
        clip.preload = "auto";
        clip.volume = Math.max(0.03, Math.min(1, volume));
        const promise = clip.play();
        if (promise?.then) {
          promise.catch(() => {
            playFallbackTone(volume);
          });
        }
        return;
      }
      playFallbackTone(volume);
    } catch (_error) {
      playFallbackTone(volume);
    }
  };

  const playBuyerDoubleTing = (volume = 0.3) => {
    const v = Math.max(0.06, Math.min(1, volume));
    const playOne = () => {
      const clip = new Audio(BUYER_TING_FILE);
      clip.preload = "auto";
      clip.volume = v;
      clip.play().catch(() => {
        playFallbackTone(v);
      });
    };
    playOne();
    setTimeout(playOne, 180);
  };

  const pulseTopBuyersPanel = () => {
    setTopBuyersPulse(true);
    if (buyerPanelPulseTimerRef.current) {
      clearTimeout(buyerPanelPulseTimerRef.current);
    }
    buyerPanelPulseTimerRef.current = setTimeout(() => {
      setTopBuyersPulse(false);
      buyerPanelPulseTimerRef.current = null;
    }, 360);
  };

  const pulseLiquidationsPanel = () => {
    setLiquidationsPulse(true);
    if (liqPanelPulseTimerRef.current) {
      clearTimeout(liqPanelPulseTimerRef.current);
    }
    liqPanelPulseTimerRef.current = setTimeout(() => {
      setLiquidationsPulse(false);
      liqPanelPulseTimerRef.current = null;
    }, 360);
  };

  const markHotBuyerRow = (key) => {
    setHotBuyerRows((prev) => ({ ...prev, [key]: true }));
    const prevTimer = buyerHotTimersRef.current.get(key);
    if (prevTimer) {
      clearTimeout(prevTimer);
    }
    const timeoutId = setTimeout(() => {
      setHotBuyerRows((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      buyerHotTimersRef.current.delete(key);
    }, 1_700);
    buyerHotTimersRef.current.set(key, timeoutId);
  };

  const markHotLiquidationRow = (key) => {
    setHotLiquidationRows((prev) => ({ ...prev, [key]: true }));
    const prevTimer = liqHotTimersRef.current.get(key);
    if (prevTimer) {
      clearTimeout(prevTimer);
    }
    const timeoutId = setTimeout(() => {
      setHotLiquidationRows((prev) => {
        const next = { ...prev };
        delete next[key];
        return next;
      });
      liqHotTimersRef.current.delete(key);
    }, 1_700);
    liqHotTimersRef.current.set(key, timeoutId);
  };

  const pushBuyerRowToFeed = (row) => {
    const now = Date.now();
    const key = buyerKey(row);
    const notional = Number(row?.notional) || 0;

    if (now - lastBuyerAlertAtRef.current >= BUYER_SOUND_MIN_INTERVAL_MS) {
      if (notional > BUYER_TING_NOTIONAL_USD) {
        playBuyerDoubleTing(0.32);
      } else {
        playBuyerTing(BUYER_SOUND_DEFAULT_TIER, BUYER_SOUND_DEFAULT_VOLUME);
      }
      lastBuyerAlertAtRef.current = now;
    }

    setTopBuyers((prev) => {
      let next = prev.filter((item) => item._key !== key);
      next.unshift({
        ...row,
        _key: key,
        _updatedAt: now
      });
      return next.slice(0, MAX_TOP_BUYERS_FEED);
    });
    markHotBuyerRow(key);
    pulseTopBuyersPanel();
  };

  const startBuyerQueueDrain = () => {
    if (buyerDrainTimerRef.current) {
      return;
    }

    buyerDrainTimerRef.current = setInterval(() => {
      const nextRow = buyerQueueRef.current.shift();
      if (!nextRow) {
        clearInterval(buyerDrainTimerRef.current);
        buyerDrainTimerRef.current = null;
        return;
      }
      pushBuyerRowToFeed(nextRow);
    }, 240);
  };

  const mergeTopBuyersFeed = (incomingRows) => {
    const filtered = incomingRows.filter((row) => Number(row?.size) >= MIN_BUYER_BTC);
    if (filtered.length === 0) {
      return;
    }

    filtered.sort((a, b) => Number(b.notional) - Number(a.notional));
    buyerQueueRef.current.push(...filtered);
    startBuyerQueueDrain();
  };

  const applyPrice = (nextPrice, ts, force = false) => {
    if (typeof nextPrice !== "number" || !Number.isFinite(nextPrice)) {
      return;
    }
    lastDataAtRef.current = Date.now();
    const prev = previousPriceRef.current;
    if (prev === null || prev === undefined) {
      setPriceTrend("neutral");
    } else if (nextPrice > prev) {
      setPriceTrend("up");
      setBtcFlash("up");
    } else if (nextPrice < prev) {
      setPriceTrend("down");
      setBtcFlash("down");
    }
    if (btcFlashTimerRef.current) {
      clearTimeout(btcFlashTimerRef.current);
    }
    btcFlashTimerRef.current = setTimeout(() => {
      setBtcFlash("");
      btcFlashTimerRef.current = null;
    }, 380);
    previousPriceRef.current = nextPrice;
    latestPriceRef.current = nextPrice;

    const now = Date.now();
    if (force || now - lastPriceSetAtRef.current >= PRICE_STATE_INTERVAL_MS) {
      setPrice(nextPrice);
      if (ts) {
        setLastTickTime(new Date(ts));
      }
      lastPriceSetAtRef.current = now;
    }
  };

  const socket = useMemo(
    () =>
      io(BACKEND_URL, {
        transports: ["websocket", "polling"],
        reconnection: true,
        reconnectionAttempts: Infinity,
        reconnectionDelay: 1000,
        reconnectionDelayMax: 10000,
        timeout: 10000
      }),
    []
  );
  useEffect(() => {
    socketRef.current = socket;
    return () => {
      socketRef.current = null;
    };
  }, [socket]);

  useEffect(() => {
    if (!secondCanvasRef.current || !minuteCanvasRef.current) {
      return undefined;
    }

    secondChartRef.current = createChart(secondCanvasRef.current, "10s", "second");
    minuteChartRef.current = createChart(minuteCanvasRef.current, "1m", "minute");

    return () => {
      secondChartRef.current?.destroy();
      minuteChartRef.current?.destroy();
      secondChartRef.current = null;
      minuteChartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const renderSecondChart = () => {
      if (!secondChartRef.current) {
        return;
      }
      const candles = secondDataRef.current.candles;
      const volumes = secondDataRef.current.volumes;
      secondChartRef.current.data.datasets[0].data = candles;
      secondChartRef.current.data.datasets[1].data = volumes.map((v) => ({ x: v.x, y: v.buy }));
      secondChartRef.current.data.datasets[2].data = volumes.map((v) => ({ x: v.x, y: v.sell }));
      secondChartRef.current.update("none");
      pendingSecondRenderRef.current = false;
    };

    const renderMinuteChart = () => {
      if (!minuteChartRef.current) {
        return;
      }
      const candles = minuteDataRef.current.candles;
      const volumes = minuteDataRef.current.volumes;
      minuteChartRef.current.data.datasets[0].data = candles;
      minuteChartRef.current.data.datasets[1].data = volumes.map((v) => ({ x: v.x, y: v.buy }));
      minuteChartRef.current.data.datasets[2].data = volumes.map((v) => ({ x: v.x, y: v.sell }));
      minuteChartRef.current.update("none");
      const lastVol = volumes[volumes.length - 1];
      setLastBuyVolume(lastVol?.buy ?? 0);
      setLastSellVolume(lastVol?.sell ?? 0);
      pendingMinuteRenderRef.current = false;
    };

    const renderTimer = setInterval(() => {
      if (pendingSecondRenderRef.current) {
        renderSecondChart();
      }
      if (pendingMinuteRenderRef.current) {
        renderMinuteChart();
      }
    }, CHART_RENDER_INTERVAL_MS);

    const onConnect = () => setStatus("Live");
    const onDisconnect = (reason) => setStatus(`Reconnect (${reason})`);
    const onConnectError = () => setStatus("Connection error");

    const onHistory = (history) => {
      if (!Array.isArray(history)) {
        return;
      }
      const candles = history
        .slice(-MAX_MINUTE_CANDLES)
        .map((k) => ({
          x: Number(k.startTime),
          o: Number(k.open),
          h: Number(k.high),
          l: Number(k.low),
          c: Number(k.close),
          v: Number(k.volume) || 0
        }));
      minuteDataRef.current.candles = candles;
      minuteDataRef.current.volumes = candles.map((c) => ({ x: c.x, buy: c.v || 0, sell: 0 }));
      pendingMinuteRenderRef.current = true;
      const last = candles[candles.length - 1];
      if (last) {
        applyPrice(last.c, undefined, true);
      }
    };

    const onKline = (kline) => {
      minuteDataRef.current.candles = upsertCandleFromKline(
        minuteDataRef.current.candles,
        kline,
        MAX_MINUTE_CANDLES
      );
      minuteDataRef.current.volumes = upsertVolumeFromKline(
        minuteDataRef.current.volumes,
        kline,
        MAX_MINUTE_CANDLES
      );
      pendingMinuteRenderRef.current = true;
      lastDataAtRef.current = Date.now();
    };

    const onTrade = (trade) => {
      if (!trade || typeof trade.price !== "number" || typeof trade.qty !== "number") {
        return;
      }
      applyPrice(trade.price, trade.ts, false);
      secondDataRef.current.candles = upsertCandleFromTrade(
        secondDataRef.current.candles,
        trade,
        SECOND_CANDLE_INTERVAL_MS,
        MAX_SECOND_CANDLES
      );
      secondDataRef.current.volumes = upsertVolume(
        secondDataRef.current.volumes,
        trade,
        SECOND_CANDLE_INTERVAL_MS,
        MAX_SECOND_CANDLES
      );
      pendingSecondRenderRef.current = true;
      lastDataAtRef.current = Date.now();
    };

    const onPrice = (payload) => {
      if (payload && typeof payload.close === "number") {
        applyPrice(payload.close, payload.ts, false);
      }
    };

    const onTopBuyers = (payload) => {
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      mergeTopBuyersFeed(rows);
    };

    const onLiquidations = (payload) => {
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      setLiquidations(
        rows.map((row) => ({
          ...row,
          _key: liquidationKey(row)
        }))
      );
    };
    const onLiquidation = (payload) => {
      const keyed = { ...payload, _key: liquidationKey(payload) };
      setLiquidations((prev) => [keyed, ...prev.filter((item) => item._key !== keyed._key)].slice(0, 30));
      markHotLiquidationRow(keyed._key);
      pulseLiquidationsPanel();
    };

    const onMarkets = (payload) => {
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      setMarkets(normalizeMarketsWithDiff(rows));
    };
    const onFearGreed = (payload) => {
      if (payload && typeof payload.value !== "undefined") {
        setFearGreed(payload);
      }
    };
    const onNews = (payload) => {
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      setNewsItems(rows.slice(0, 10));
    };

    socket.on("connect", onConnect);
    socket.on("disconnect", onDisconnect);
    socket.on("connect_error", onConnectError);
    socket.on("history", onHistory);
    socket.on("kline", onKline);
    socket.on("trade", onTrade);
    socket.on("price", onPrice);
    socket.on("topBuyers", onTopBuyers);
    socket.on("liquidations", onLiquidations);
    socket.on("liquidation", onLiquidation);
    socket.on("markets", onMarkets);
    socket.on("fearGreed", onFearGreed);
    socket.on("news", onNews);

    return () => {
      socket.off("connect", onConnect);
      socket.off("disconnect", onDisconnect);
      socket.off("connect_error", onConnectError);
      socket.off("history", onHistory);
      socket.off("kline", onKline);
      socket.off("trade", onTrade);
      socket.off("price", onPrice);
      socket.off("topBuyers", onTopBuyers);
      socket.off("liquidations", onLiquidations);
      socket.off("liquidation", onLiquidation);
      socket.off("markets", onMarkets);
      socket.off("fearGreed", onFearGreed);
      socket.off("news", onNews);
      socket.close();
      clearInterval(renderTimer);
    };
  }, [socket]);

  useEffect(() => {
    let stopped = false;

    const renderSecondChartFallback = () => {
      if (!secondChartRef.current) {
        return;
      }
      const candles = secondDataRef.current.candles;
      const volumes = secondDataRef.current.volumes;
      secondChartRef.current.data.datasets[0].data = candles;
      secondChartRef.current.data.datasets[1].data = volumes.map((v) => ({ x: v.x, y: v.buy }));
      secondChartRef.current.data.datasets[2].data = volumes.map((v) => ({ x: v.x, y: v.sell }));
      secondChartRef.current.update("none");
    };

    const renderMinuteChartFallback = () => {
      if (!minuteChartRef.current) {
        return;
      }
      const candles = minuteDataRef.current.candles;
      const volumes = minuteDataRef.current.volumes;
      minuteChartRef.current.data.datasets[0].data = candles;
      minuteChartRef.current.data.datasets[1].data = volumes.map((v) => ({ x: v.x, y: v.buy }));
      minuteChartRef.current.data.datasets[2].data = volumes.map((v) => ({ x: v.x, y: v.sell }));
      minuteChartRef.current.update("none");
      const lastVol = volumes[volumes.length - 1];
      setLastBuyVolume(lastVol?.buy ?? 0);
      setLastSellVolume(lastVol?.sell ?? 0);
    };

    const pollPrice = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/price`);
        if (!res.ok || stopped) {
          return;
        }
        const payload = await res.json();
        const close = Number(payload?.close);
        const ts = Number(payload?.ts) || Date.now();
        if (Number.isFinite(close)) {
          applyPrice(close, ts, true);
          const syntheticTrade = { price: close, qty: 0, ts, side: "buy" };
          secondDataRef.current.candles = upsertCandleFromTrade(
            secondDataRef.current.candles,
            syntheticTrade,
            1_000,
            MAX_SECOND_CANDLES
          );
          pendingSecondRenderRef.current = true;
          renderSecondChartFallback();
        }
      } catch (_error) {
        // no-op
      }
    };

    const pollHistory = async () => {
      try {
        const res = await fetch(`${BACKEND_URL}/api/history`);
        if (!res.ok || stopped) {
          return;
        }
        const payload = await res.json();
        const history = Array.isArray(payload?.candles) ? payload.candles : [];
        minuteDataRef.current.candles = history.slice(-MAX_MINUTE_CANDLES).map((k) => ({
          x: Number(k.startTime),
          o: Number(k.open),
          h: Number(k.high),
          l: Number(k.low),
          c: Number(k.close),
          v: Number(k.volume) || 0
        }));
        minuteDataRef.current.volumes = minuteDataRef.current.candles.map((c) => ({
          x: c.x,
          buy: c.v || 0,
          sell: 0
        }));
        pendingMinuteRenderRef.current = true;
        renderMinuteChartFallback();
      } catch (_error) {
        // no-op
      }
    };

    const pollExtras = async () => {
      try {
        const [m, fg, l, tbRes, newsRes] = await Promise.all([
          fetch(`${BACKEND_URL}/api/markets`),
          fetch(`${BACKEND_URL}/api/fear-greed`),
          fetch(`${BACKEND_URL}/api/liquidations`),
          fetch(`${BACKEND_URL}/api/top-buyers`),
          fetch(`${BACKEND_URL}/api/news`)
        ]);
        if (m.ok) {
          const mk = await m.json();
          const rows = Array.isArray(mk?.rows) ? mk.rows : [];
          setMarkets(normalizeMarketsWithDiff(rows));
        }
        if (fg.ok) {
          const fear = await fg.json();
          if (fear && typeof fear.value !== "undefined") {
            setFearGreed(fear);
          }
        }
        if (l.ok) {
          const liq = await l.json();
          const rows = Array.isArray(liq?.rows) ? liq.rows : [];
          setLiquidations(
            rows.map((row) => ({
              ...row,
              _key: liquidationKey(row)
            }))
          );
        }
        if (tbRes.ok) {
          const tb = await tbRes.json();
          const rows = Array.isArray(tb?.rows) ? tb.rows : [];
          mergeTopBuyersFeed(rows);
        }
        if (newsRes.ok) {
          const newsPayload = await newsRes.json();
          const rows = Array.isArray(newsPayload?.rows) ? newsPayload.rows : [];
          setNewsItems(rows.slice(0, 10));
        }
      } catch (_error) {
        // no-op
      }
    };

    const timer = setInterval(async () => {
      await pollPrice();
      const staleFor = Date.now() - lastDataAtRef.current;
      if (staleFor > DATA_STALE_MS) {
        setStatus("Re-syncing realtime...");
        if (socketRef.current && !socketRef.current.connected) {
          socketRef.current.connect();
        }
        await pollHistory();
        await pollExtras();
      }
      const now = Date.now();
      if (now - lastHistoryPollRef.current >= 10_000) {
        lastHistoryPollRef.current = now;
        await pollHistory();
        await pollExtras();
      }
    }, 1_000);

    pollPrice();
    pollHistory();
    pollExtras();

    return () => {
      stopped = true;
      clearInterval(timer);
      if (buyerDrainTimerRef.current) {
        clearInterval(buyerDrainTimerRef.current);
        buyerDrainTimerRef.current = null;
      }
      buyerQueueRef.current = [];
      if (fallbackAudioCtxRef.current && fallbackAudioCtxRef.current.state !== "closed") {
        fallbackAudioCtxRef.current.close().catch(() => {});
      }
    };
  }, []);

  const topMaxNotional = topBuyers.length
    ? Math.max(...topBuyers.map((item) => Number(item.notional) || 0))
    : 0;
  const liquidationsVisible = liquidations
    .filter((item) => Number(item?.notional) >= LIQUIDATION_MIN_NOTIONAL)
    .slice(0, 14);
  const topLiqMaxNotional = liquidationsVisible.length
    ? Math.max(...liquidationsVisible.map((item) => Number(item.notional) || 0))
    : 0;

  return (
    <div className="layout">
      <div className="ticker-strip">
        <div className="btc-block">
          <span className={`btc-head btc-${priceTrend} ${btcFlash ? `btc-flash-${btcFlash}` : ""}`}>
            BTC: {formatPriceNoDecimal(price)}
          </span>
          <b className={(btcTicker?.changePercent ?? 0) >= 0 ? "green" : "red"}>
            {(btcTicker?.changePercent ?? 0) >= 0 ? "+" : ""}
            {(btcTicker?.changePercent ?? 0).toFixed(2)}%
          </b>
        </div>
        <div className="ticker-marquee">
          <div className="ticker-marquee-track">
            {marqueeCoins.map((m) => (
              <span
                className={`ticker-item ${
                  m.updateDirection === "up" ? "ticker-up" : m.updateDirection === "down" ? "ticker-down" : ""
                }`}
                key={`${m.marketType || "m"}-${m.symbol}-a`}
              >
                {m.symbol}: {!shouldHideUsdOnePrice(m) ? `${formatPrice(m.price)} ` : ""}
                <b className={m.changePercent >= 0 ? "green" : "red"}>
                  {m.changePercent >= 0 ? "+" : ""}
                  {m.changePercent.toFixed(2)}%
                </b>
              </span>
            ))}
            {marqueeCoins.map((m) => (
              <span
                className={`ticker-item ${
                  m.updateDirection === "up" ? "ticker-up" : m.updateDirection === "down" ? "ticker-down" : ""
                }`}
                key={`${m.marketType || "m"}-${m.symbol}-b`}
              >
                {m.symbol}: {!shouldHideUsdOnePrice(m) ? `${formatPrice(m.price)} ` : ""}
                <b className={m.changePercent >= 0 ? "green" : "red"}>
                  {m.changePercent >= 0 ? "+" : ""}
                  {m.changePercent.toFixed(2)}%
                </b>
              </span>
            ))}
          </div>
        </div>
      </div>

      <div className="page-grid">
        <main className="charts-col">
          <section className="chart-card top">
            <div className="fear-card">
              <div className="fear-title">FEAR & GREED</div>
              <div className="fear-value">{fearGreed?.value ?? "--"}</div>
              <div className="fear-label">{fearGreed?.classification ?? "Loading"}</div>
            </div>
            <div className="chart-label">10s</div>
            <canvas ref={secondCanvasRef} />
          </section>

          <section className="chart-card">
            <div className="chart-label">1m</div>
            <canvas ref={minuteCanvasRef} />
          </section>
        </main>

        <aside className="stream-col">
          <div className={`stream-panel ${topBuyersPulse ? "panel-pulse panel-pulse-buyers" : ""}`}>
            <div className="panel-title">TOP BUYERS</div>
            <div className="rows">
              {topBuyers.slice(0, 12).map((row, idx) => {
                const intensity = topMaxNotional > 0 ? Number(row.notional) / topMaxNotional : 0;
                return (
                  <div
                    className={`row buyer-row ${hotBuyerRows[row._key] ? "row-hot row-hot-buy" : ""}`}
                    key={row._key || `${row.exchangeId}-${row.price}-${idx}`}
                    style={{ "--buy-intensity": `${(0.14 + intensity * 0.86).toFixed(3)}` }}
                  >
                    <img
                      className="logo"
                      src={row.logoUrl || "/exchange-logos/default-white.svg"}
                      alt={row.exchange}
                      onError={(e) => {
                        if (e.currentTarget.src.endsWith("/exchange-logos/default-white.svg")) {
                          return;
                        }
                        e.currentTarget.src = "/exchange-logos/default-white.svg";
                      }}
                    />
                    <span className="price">{formatPrice(row.price)}</span>
                    <span className="buyer-btc">{formatBtc(row.size)} BTC</span>
                    <span className="money">${formatCompact(row.notional)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`stream-panel ${liquidationsPulse ? "panel-pulse panel-pulse-liq" : ""}`}>
            <div className="panel-title">LIQUIDATIONS &gt; 100K USD</div>
            <div className="rows">
              {liquidationsVisible.map((row, idx) => {
                const intensity = topLiqMaxNotional > 0 ? Number(row.notional) / topLiqMaxNotional : 0;
                const isTop = intensity >= 0.72;
                return (
                  <div
                    className={`row liquidation-row ${row.side === "sell" ? "liq-sell" : "liq-buy"} ${isTop ? "liq-top" : ""} ${
                      hotLiquidationRows[row._key] ? "row-hot row-hot-liq" : ""
                    }`}
                    key={row._key || `${row.ts}-${idx}`}
                    style={{ "--liq-intensity": `${(0.14 + intensity * 0.86).toFixed(3)}` }}
                  >
                    <img
                      className="logo"
                      src={row.logoUrl || "/exchange-logos/default-white.svg"}
                      alt={row.exchange || "exchange"}
                      onError={(e) => {
                        if (e.currentTarget.src.endsWith("/exchange-logos/default-white.svg")) {
                          return;
                        }
                        e.currentTarget.src = "/exchange-logos/default-white.svg";
                      }}
                    />
                    <span>{formatPrice(row.price)}</span>
                    <span className="money">${formatCompact(row.notional)}</span>
                    <span>{new Date(row.ts).toLocaleTimeString("en-GB")}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className={`meta-box news-anim-mode-${newsAnimMode}`} ref={newsBoxRef}>
            <div className="meta-title">LATEST NEWS</div>
            {displayNewsItems.length > 0 ? (
              displayNewsItems.map((item) => (
                <a
                  key={`${item.source}-${item.title}`}
                  className="news-item"
                  href={item.link}
                  target="_blank"
                  rel="noreferrer"
                >
                  <span className="news-source">{item.source}</span>
                  <span className="news-headline">{item.title}</span>
                </a>
              ))
            ) : (
              <div className="news-empty">No new headlines in the last 5 minutes.</div>
            )}
            <div className="meta-foot">
              <span>Status: {status}</span>
              <span>
                Tick: {lastTickTime ? lastTickTime.toLocaleTimeString("en-GB") : "--:--:--"}
              </span>
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
