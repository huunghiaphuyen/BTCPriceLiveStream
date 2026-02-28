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
const MIN_BUYER_BTC = 0.1;
const MAX_TOP_BUYERS_FEED = 20;
const SECONDARY_COINS_VISIBLE = 6;
const ALERT_BTC_LEVELS = {
  low: 0.1,
  mid: 0.5,
  high: 1.0
};

function formatPrice(value) {
  if (value === null || value === undefined) {
    return "--";
  }
  return value.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2
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

function buyerKey(row) {
  return `${row.exchangeId}|${row.price}|${row.size}`;
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

function getVolumeByBtcSize(size) {
  if (size < ALERT_BTC_LEVELS.low) {
    return 0;
  }

  if (size < ALERT_BTC_LEVELS.mid) {
    const t = (size - ALERT_BTC_LEVELS.low) / (ALERT_BTC_LEVELS.mid - ALERT_BTC_LEVELS.low);
    return 0.06 + t * 0.07; // 0.10 -> 0.13
  }

  if (size < ALERT_BTC_LEVELS.high) {
    const t = (size - ALERT_BTC_LEVELS.mid) / (ALERT_BTC_LEVELS.high - ALERT_BTC_LEVELS.mid);
    return 0.14 + t * 0.18; // 0.14 -> 0.32
  }

  const over = Math.min(1, (size - ALERT_BTC_LEVELS.high) / 3); // >=1 BTC louder, capped
  return 0.34 + over * 0.46; // up to 0.80
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
    c: Number(kline.close)
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
            up: "#27d894",
            down: "#ff385f",
            unchanged: "#95a1bc"
          },
          color: {
            up: "#27d894",
            down: "#ff385f",
            unchanged: "#95a1bc"
          },
          borderWidth: 1.3
        },
        {
          type: "bar",
          label: "Buy Vol",
          data: [],
          yAxisID: "yVolume",
          backgroundColor: "rgba(39, 216, 148, 0.45)",
          borderWidth: 0,
          parsing: false
        },
        {
          type: "bar",
          label: "Sell Vol",
          data: [],
          yAxisID: "yVolume",
          backgroundColor: "rgba(255, 56, 95, 0.45)",
          borderWidth: 0,
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
          ticks: { color: "#7f8aa8", maxTicksLimit: 12 },
          grid: { color: "rgba(255,255,255,0.06)" }
        },
        y: {
          position: "right",
          weight: 3,
          ticks: { color: "#7f8aa8" },
          grid: { color: "rgba(255,255,255,0.08)" }
        },
        yVolume: {
          position: "right",
          weight: 1,
          ticks: {
            color: "#69738f",
            callback: (value) => Math.abs(value)
          },
          grid: { color: "rgba(255,255,255,0.04)" }
        }
      },
      plugins: {
        legend: {
          labels: {
            color: "#a4aec7",
            usePointStyle: true,
            boxWidth: 8
          }
        },
        tooltip: {
          mode: "index",
          intersect: false,
          backgroundColor: "#101421",
          borderColor: "rgba(255,255,255,0.2)",
          borderWidth: 1,
          titleColor: "#eef2ff",
          bodyColor: "#cbd5e1"
        }
      }
    }
  });
}

function App() {
  const secondCanvasRef = useRef(null);
  const minuteCanvasRef = useRef(null);
  const secondChartRef = useRef(null);
  const minuteChartRef = useRef(null);
  const secondDataRef = useRef({ candles: [], volumes: [] });
  const minuteDataRef = useRef({ candles: [], volumes: [] });
  const previousPriceRef = useRef(null);
  const lastHistoryPollRef = useRef(0);
  const alertAudioRef = useRef(null);
  const fallbackAudioCtxRef = useRef(null);
  const lastBuyerAlertAtRef = useRef(0);
  const buyerQueueRef = useRef([]);
  const buyerDrainTimerRef = useRef(null);

  const [price, setPrice] = useState(null);
  const [priceTrend, setPriceTrend] = useState("neutral");
  const [status, setStatus] = useState("Connecting...");
  const [lastTickTime, setLastTickTime] = useState(null);
  const [lastBuyVolume, setLastBuyVolume] = useState(0);
  const [lastSellVolume, setLastSellVolume] = useState(0);
  const [topBuyers, setTopBuyers] = useState([]);
  const [liquidations, setLiquidations] = useState([]);
  const [markets, setMarkets] = useState([]);
  const [fearGreed, setFearGreed] = useState(null);
  const [secondaryCoinOffset, setSecondaryCoinOffset] = useState(0);
  const btcTicker = markets.find((item) => item.symbol === "BTC");
  const secondaryCoins = markets.filter(
    (item) => item.marketType === "crypto" && item.symbol !== "BTC"
  );
  const secondaryCoinsVisible = getRotatingSlice(
    secondaryCoins,
    secondaryCoinOffset,
    SECONDARY_COINS_VISIBLE
  );

  useEffect(() => {
    alertAudioRef.current = new Audio("/sounds/buyer-ting.wav");
    alertAudioRef.current.preload = "auto";
    return () => {
      if (alertAudioRef.current) {
        alertAudioRef.current.pause();
        alertAudioRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    if (secondaryCoins.length === 0) {
      return undefined;
    }
    const timer = setInterval(() => {
      setSecondaryCoinOffset((prev) => (prev + SECONDARY_COINS_VISIBLE) % secondaryCoins.length);
    }, 10_000);
    return () => clearInterval(timer);
  }, [secondaryCoins.length]);

  const playBuyerTing = (volume) => {
    try {
      if (alertAudioRef.current) {
        const clip = alertAudioRef.current.cloneNode();
        clip.volume = Math.max(0.03, Math.min(1, volume));
        clip.play().catch(() => {});
        return;
      }

      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) {
        return;
      }
      if (!fallbackAudioCtxRef.current) {
        fallbackAudioCtxRef.current = new AudioCtx();
      }
      const ctx = fallbackAudioCtxRef.current;
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
    } catch (_error) {
      // no-op
    }
  };

  const pushBuyerRowToFeed = (row) => {
    const now = Date.now();
    const key = buyerKey(row);

    const btcSize = Number(row.size) || 0;
    if (now - lastBuyerAlertAtRef.current > 300) {
      const volume = getVolumeByBtcSize(btcSize);
      if (volume > 0) {
        playBuyerTing(volume);
        lastBuyerAlertAtRef.current = now;
      }
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
    }, 120);
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

  const applyPrice = (nextPrice, ts) => {
    if (typeof nextPrice !== "number" || !Number.isFinite(nextPrice)) {
      return;
    }
    const prev = previousPriceRef.current;
    if (prev === null || prev === undefined) {
      setPriceTrend("neutral");
    } else if (nextPrice > prev) {
      setPriceTrend("up");
    } else if (nextPrice < prev) {
      setPriceTrend("down");
    }
    previousPriceRef.current = nextPrice;
    setPrice(nextPrice);
    if (ts) {
      setLastTickTime(new Date(ts));
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
    if (!secondCanvasRef.current || !minuteCanvasRef.current) {
      return undefined;
    }

    secondChartRef.current = createChart(secondCanvasRef.current, "10s", "second");
    minuteChartRef.current = createChart(minuteCanvasRef.current, "15m", "minute");

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
      secondChartRef.current.data.datasets[2].data = volumes.map((v) => ({ x: v.x, y: -v.sell }));
      secondChartRef.current.update("none");
    };

    const renderMinuteChart = () => {
      if (!minuteChartRef.current) {
        return;
      }
      const candles = minuteDataRef.current.candles;
      const volumes = minuteDataRef.current.volumes;
      minuteChartRef.current.data.datasets[0].data = candles;
      minuteChartRef.current.data.datasets[1].data = volumes.map((v) => ({ x: v.x, y: v.buy }));
      minuteChartRef.current.data.datasets[2].data = volumes.map((v) => ({ x: v.x, y: -v.sell }));
      minuteChartRef.current.update("none");
      const lastVol = volumes[volumes.length - 1];
      setLastBuyVolume(lastVol?.buy ?? 0);
      setLastSellVolume(lastVol?.sell ?? 0);
    };

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
          c: Number(k.close)
        }));
      minuteDataRef.current.candles = candles;
      if (minuteDataRef.current.volumes.length === 0) {
        minuteDataRef.current.volumes = candles.map((c) => ({ x: c.x, buy: 0, sell: 0 }));
      }
      renderMinuteChart();
      const last = candles[candles.length - 1];
      if (last) {
        applyPrice(last.c);
      }
    };

    const onKline = (kline) => {
      minuteDataRef.current.candles = upsertCandleFromKline(
        minuteDataRef.current.candles,
        kline,
        MAX_MINUTE_CANDLES
      );
      renderMinuteChart();
    };

    const onTrade = (trade) => {
      if (!trade || typeof trade.price !== "number" || typeof trade.qty !== "number") {
        return;
      }
      applyPrice(trade.price, trade.ts);
      secondDataRef.current.candles = upsertCandleFromTrade(
        secondDataRef.current.candles,
        trade,
        1_000,
        MAX_SECOND_CANDLES
      );
      secondDataRef.current.volumes = upsertVolume(
        secondDataRef.current.volumes,
        trade,
        1_000,
        MAX_SECOND_CANDLES
      );
      renderSecondChart();

      minuteDataRef.current.candles = upsertCandleFromTrade(
        minuteDataRef.current.candles,
        trade,
        60_000,
        MAX_MINUTE_CANDLES
      );
      minuteDataRef.current.volumes = upsertVolume(
        minuteDataRef.current.volumes,
        trade,
        60_000,
        MAX_MINUTE_CANDLES
      );
      renderMinuteChart();
    };

    const onPrice = (payload) => {
      if (payload && typeof payload.close === "number") {
        applyPrice(payload.close, payload.ts);
      }
    };

    const onTopBuyers = (payload) => {
      const rows = Array.isArray(payload?.rows) ? payload.rows : [];
      mergeTopBuyersFeed(rows);
    };

    const onLiquidations = (payload) => {
      setLiquidations(Array.isArray(payload?.rows) ? payload.rows : []);
    };
    const onLiquidation = (payload) => {
      setLiquidations((prev) => [payload, ...prev].slice(0, 30));
    };

    const onMarkets = (payload) => {
      setMarkets(Array.isArray(payload?.rows) ? payload.rows : []);
    };
    const onFearGreed = (payload) => {
      if (payload && typeof payload.value !== "undefined") {
        setFearGreed(payload);
      }
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
      socket.close();
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
      secondChartRef.current.data.datasets[2].data = volumes.map((v) => ({ x: v.x, y: -v.sell }));
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
      minuteChartRef.current.data.datasets[2].data = volumes.map((v) => ({ x: v.x, y: -v.sell }));
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
          applyPrice(close, ts);
          const syntheticTrade = { price: close, qty: 0, ts, side: "buy" };
          secondDataRef.current.candles = upsertCandleFromTrade(
            secondDataRef.current.candles,
            syntheticTrade,
            1_000,
            MAX_SECOND_CANDLES
          );
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
          c: Number(k.close)
        }));
        if (minuteDataRef.current.volumes.length === 0) {
          minuteDataRef.current.volumes = minuteDataRef.current.candles.map((c) => ({
            x: c.x,
            buy: 0,
            sell: 0
          }));
        }
        renderMinuteChartFallback();
      } catch (_error) {
        // no-op
      }
    };

    const pollExtras = async () => {
      try {
        const [m, fg, l, tbRes] = await Promise.all([
          fetch(`${BACKEND_URL}/api/markets`),
          fetch(`${BACKEND_URL}/api/fear-greed`),
          fetch(`${BACKEND_URL}/api/liquidations`),
          fetch(`${BACKEND_URL}/api/top-buyers`)
        ]);
        if (m.ok) {
          const mk = await m.json();
          setMarkets(Array.isArray(mk?.rows) ? mk.rows : []);
        }
        if (fg.ok) {
          const fear = await fg.json();
          if (fear && typeof fear.value !== "undefined") {
            setFearGreed(fear);
          }
        }
        if (l.ok) {
          const liq = await l.json();
          setLiquidations(Array.isArray(liq?.rows) ? liq.rows : []);
        }
        if (tbRes.ok) {
          const tb = await tbRes.json();
          const rows = Array.isArray(tb?.rows) ? tb.rows : [];
          mergeTopBuyersFeed(rows);
        }
      } catch (_error) {
        // no-op
      }
    };

    const timer = setInterval(async () => {
      await pollPrice();
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

  return (
    <div className="layout">
      <div className="ticker-strip">
        <div className="btc-block">
          <span className={`btc-head btc-${priceTrend}`}>BTC: {formatPrice(price)}</span>
          <b className={(btcTicker?.changePercent ?? 0) >= 0 ? "green" : "red"}>
            {(btcTicker?.changePercent ?? 0) >= 0 ? "+" : ""}
            {(btcTicker?.changePercent ?? 0).toFixed(2)}%
          </b>
        </div>
        {secondaryCoinsVisible.map((m) => (
          <span className="ticker-item" key={`${m.marketType || "m"}-${m.symbol}`}>
            {m.symbol}: {formatPrice(m.price)}{" "}
            <b className={m.changePercent >= 0 ? "green" : "red"}>
              {m.changePercent >= 0 ? "+" : ""}
              {m.changePercent.toFixed(2)}%
            </b>
          </span>
        ))}
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
            <div className="chart-label">15m</div>
            <canvas ref={minuteCanvasRef} />
          </section>
        </main>

        <aside className="stream-col">
          <div className="stream-panel">
            <div className="panel-title">TOP BUYERS (&gt;= 0.1 BTC)</div>
            <div className="rows">
              {topBuyers.slice(0, 12).map((row, idx) => {
                const intensity = topMaxNotional > 0 ? Number(row.notional) / topMaxNotional : 0;
                return (
                  <div
                    className="row buyer-row"
                    key={row._key || `${row.exchangeId}-${row.price}-${idx}`}
                    style={{ "--buy-intensity": `${(0.14 + intensity * 0.86).toFixed(3)}` }}
                  >
                    <img className="logo" src={row.logoUrl} alt={row.exchange} />
                    <span className="price">{formatPrice(row.price)}</span>
                    <span className="buyer-btc">{formatBtc(row.size)} BTC</span>
                    <span className="money">${formatCompact(row.notional)}</span>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="stream-panel">
            <div className="panel-title">LIQUIDATIONS</div>
            <div className="rows">
              {liquidations.slice(0, 14).map((row, idx) => (
                <div className={`row ${row.side === "sell" ? "liq-sell" : "liq-buy"}`} key={`${row.ts}-${idx}`}>
                  <span>{formatPrice(row.price)}</span>
                  <span>${formatCompact(row.notional)}</span>
                  <span>{new Date(row.ts).toLocaleTimeString("en-GB")}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="meta-box">
            <div>Status: {status}</div>
            <div>Last tick: {lastTickTime ? lastTickTime.toLocaleTimeString("en-GB") : "--:--:--"}</div>
            <div>Buy Vol: {formatCompact(lastBuyVolume)} BTC</div>
            <div>Sell Vol: {formatCompact(lastSellVolume)} BTC</div>
          </div>
        </aside>
      </div>
    </div>
  );
}

export default App;
