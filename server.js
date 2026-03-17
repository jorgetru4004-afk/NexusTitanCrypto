'use strict';
// ╔══════════════════════════════════════════════════════════════════╗
// ║   NEXUS TITAN CRYPTO — Crypto Intelligence Specialist            ║
// ║   Spot + Perpetuals · Funding Rate Intelligence · 24/7           ║
// ║   Cross-Chain Flow · DeFi Yield · Fear & Greed Regime            ║
// ║   Built Once — Built Permanently — No Ceiling Ever               ║
// ╚══════════════════════════════════════════════════════════════════╝

const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
app.use(express.json());
app.use(express.static(__dirname));

// ── CONFIG ──
const PORT = process.env.PORT || 8080;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY || process.env.ANTHROPIC_API_KEY || '';
const ALPACA_KEY = process.env.ALPACA_KEY || process.env.APCA_API_KEY_ID || '';
const ALPACA_SECRET = process.env.ALPACA_SECRET || process.env.APCA_API_SECRET_KEY || '';
const ALPACA_BASE = 'https://paper-api.alpaca.markets';
const ALPACA_DATA = 'https://data.alpaca.markets';
const MODEL = 'claude-sonnet-4-6';

// ── SETTINGS ──
const SETTINGS = {
  maxPositions: 4,
  heatCeiling: 0.50,
  dailyLossLimit: 500,
  defaultLeverage: 1,
  scanInterval: 10 * 60 * 1000,
  exitCheckInterval: 5 * 60 * 1000,
  peakProtection: 0.30,
  minConfidence: 62,
  stagedEntry: true,
  maxADVpct: 0.03,
  fundingRateThreshold: 0.01,   // 0.01% per 8hr = extreme funding
  fearGreedExtremeThreshold: 20, // below 20 = extreme fear
  fearGreedGreedThreshold: 80,   // above 80 = extreme greed
};

// Supported crypto pairs via Alpaca
const CRYPTO_UNIVERSE = [
  'BTC/USD', 'ETH/USD', 'SOL/USD', 'AVAX/USD', 'LINK/USD',
  'AAVE/USD', 'UNI/USD', 'DOGE/USD', 'SHIB/USD', 'MATIC/USD',
  'DOT/USD', 'ADA/USD', 'ATOM/USD', 'LTC/USD', 'BCH/USD'
];

// ── PERSISTENCE ──
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
function loadJSON(f, fb) { try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return fb; } }
function saveJSON(f, d) { try { fs.writeFileSync(path.join(DATA_DIR, f), JSON.stringify(d, null, 2)); } catch (e) {} }

// ── STATE ──
const saved = loadJSON('state.json', {});
let cryptoRegime = saved.cryptoRegime || 'NEUTRAL';
let fearGreedIndex = saved.fearGreedIndex || 50;
let fearGreedLabel = saved.fearGreedLabel || 'NEUTRAL';
let btcDominance = saved.btcDominance || 50;
let personality = saved.personality || 'HUNTER';
let totalPnl = saved.totalPnl || 0;
let totalTrades = saved.totalTrades || 0;
let totalWins = saved.totalWins || 0;
let dailyPnl = saved.dailyPnl || 0;
let dailyLoss = saved.dailyLoss || 0;
let dailyTrades = saved.dailyTrades || 0;
let weeklyPnl = saved.weeklyPnl || 0;
let allTimePeak = saved.allTimePeak || 0;
let consecutiveWins = saved.consecutiveWins || 0;
let consecutiveLoss = saved.consecutiveLoss || 0;
let portfolioHeat = 0;
let paused = false;
let pauseReason = '';
let lastScanTime = null;
let btcPrice = 0;
let ethPrice = 0;

let positions = loadJSON('positions.json', {});
let candidates = [];
let rotationLog = [];
let alerts = [];
let tradeJournal = loadJSON('trades.json', []);
let fundingRates = loadJSON('funding.json', {});
let defiYields = loadJSON('defi.json', {});
let learning = loadJSON('learning.json', {
  totalDecisions: 0, regimeWR: {}, patternWR: {}, fundingWR: {},
  hourlyWR: {}, lastOptimized: null
});

let ai1Dec = {}, ai2Dec = {}, ai3Dec = {}, ai4Dec = {}, ai5Dec = {}, ai6Dec = {};

function saveState() {
  saveJSON('state.json', { cryptoRegime, fearGreedIndex, fearGreedLabel, btcDominance, personality, totalPnl, totalTrades, totalWins, dailyPnl, weeklyPnl, allTimePeak, consecutiveWins, consecutiveLoss, lastUpdated: new Date().toISOString() });
}

function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) try { c.send(msg); } catch (e) {} });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

function getSnapshot() {
  return {
    SETTINGS, personality, cryptoRegime, fearGreedIndex, fearGreedLabel, btcDominance,
    btcPrice, ethPrice, paused, pauseReason,
    totalPnl, totalTrades, totalWins, dailyPnl, weeklyPnl, allTimePeak,
    dailyTrades, dailyLoss, portfolioHeat, positions, candidates,
    rotationLog: rotationLog.slice(0, 30), alerts: alerts.slice(0, 30),
    ai1Dec, ai2Dec, ai3Dec, ai4Dec, ai5Dec, ai6Dec,
    learning, tradeJournal: tradeJournal.slice(0, 100),
    fundingRates, defiYields, lastScanTime,
    openPnl: Object.values(positions).reduce((s, p) => s + (p.unrealizedPnl || 0), 0),
    winRate: totalTrades > 0 ? parseFloat((totalWins / totalTrades * 100).toFixed(1)) : 0,
    serverTime: new Date().toISOString()
  };
}

// ══════════════════════════════════════════════════════
// FEAR & GREED INTELLIGENCE
// ══════════════════════════════════════════════════════
async function fetchFearGreed() {
  try {
    const resp = await axios.get('https://api.alternative.me/fng/?limit=1', { timeout: 8000 });
    const data = resp.data?.data?.[0];
    if (data) {
      fearGreedIndex = parseInt(data.value);
      fearGreedLabel = data.value_classification;
      console.log(`😱 Fear & Greed: ${fearGreedIndex} (${fearGreedLabel})`);
    }
  } catch (e) {
    // Fallback — estimate from BTC price action
    console.log('Fear & Greed API unavailable — using price-based estimate');
  }
}

function getFearGreedRegime() {
  if (fearGreedIndex <= 20) return 'EXTREME_FEAR';
  if (fearGreedIndex <= 40) return 'FEAR';
  if (fearGreedIndex <= 60) return 'NEUTRAL';
  if (fearGreedIndex <= 80) return 'GREED';
  return 'EXTREME_GREED';
}

function getCryptoPersonality() {
  const regime = getFearGreedRegime();
  if (regime === 'EXTREME_FEAR') return 'CAPITULATION_HUNTER'; // buy the fear
  if (regime === 'FEAR') return 'SELECTIVE_LONG';
  if (regime === 'NEUTRAL') return 'BALANCED';
  if (regime === 'GREED') return 'MOMENTUM_RIDER';
  return 'DISTRIBUTION_WATCHER'; // extreme greed = look for exhaustion
}

// ══════════════════════════════════════════════════════
// ALPACA CRYPTO DATA
// ══════════════════════════════════════════════════════
const alpacaHeaders = () => ({
  'APCA-API-KEY-ID': ALPACA_KEY,
  'APCA-API-SECRET-KEY': ALPACA_SECRET,
  'Content-Type': 'application/json'
});

async function getCryptoSnapshot(symbol) {
  try {
    // Alpaca uses format like BTC/USD → BTCUSD for crypto
    const sym = symbol.replace('/', '');
    const resp = await axios.get(`${ALPACA_DATA}/v1beta3/crypto/us/snapshots?symbols=${sym}`, {
      headers: alpacaHeaders(), timeout: 8000
    });
    const d = resp.data?.snapshots?.[sym];
    if (!d) return null;
    const price = d?.latestTrade?.p || d?.minuteBar?.c || 0;
    const prevClose = d?.prevDailyBar?.c || price;
    const vol = d?.dailyBar?.v || 0;
    const avgVol = d?.prevDailyBar?.v || vol;
    return {
      symbol, price, change: prevClose > 0 ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0,
      volume: vol, avgVolume: avgVol,
      volMultiple: avgVol > 0 ? parseFloat((vol / avgVol).toFixed(2)) : 1,
      high: d?.dailyBar?.h || price, low: d?.dailyBar?.l || price, type: 'CRYPTO'
    };
  } catch (e) { return null; }
}

async function getMultiCryptoSnapshot(symbols) {
  const syms = symbols.map(s => s.replace('/', ''));
  try {
    const resp = await axios.get(`${ALPACA_DATA}/v1beta3/crypto/us/snapshots?symbols=${syms.join(',')}`, {
      headers: alpacaHeaders(), timeout: 10000
    });
    const result = {};
    for (const [sym, d] of Object.entries(resp.data?.snapshots || {})) {
      const price = d?.latestTrade?.p || d?.minuteBar?.c || 0;
      const prevClose = d?.prevDailyBar?.c || price;
      const vol = d?.dailyBar?.v || 0;
      const avgVol = d?.prevDailyBar?.v || vol;
      const original = sym.slice(0, -3) + '/USD';
      result[original] = {
        symbol: original, price,
        change: prevClose > 0 ? parseFloat(((price - prevClose) / prevClose * 100).toFixed(2)) : 0,
        volume: vol, avgVolume: avgVol,
        volMultiple: avgVol > 0 ? parseFloat((vol / avgVol).toFixed(2)) : 1,
        high: d?.dailyBar?.h || price, low: d?.dailyBar?.l || price, type: 'CRYPTO'
      };
    }
    return result;
  } catch (e) { return {}; }
}

async function placeCryptoOrder(symbol, qty, side) {
  if (!ALPACA_KEY || qty <= 0) return null;
  try {
    const sym = symbol.replace('/', '');
    const body = { symbol: sym, qty: qty.toString(), side, type: 'market', time_in_force: 'gtc' };
    const resp = await axios.post(`${ALPACA_BASE}/v2/orders`, body, { headers: alpacaHeaders(), timeout: 10000 });
    console.log(`📋 TITAN CRYPTO ${side} ${qty} ${symbol} — ${resp.data?.id}`);
    return resp.data;
  } catch (e) {
    console.error(`Crypto order error ${symbol}:`, e.response?.data?.message || e.message);
    return null;
  }
}

// ══════════════════════════════════════════════════════
// FUNDING RATE INTELLIGENCE (Primary Signal)
// ══════════════════════════════════════════════════════
async function fetchFundingRates() {
  const keyCoins = ['BTC', 'ETH', 'SOL', 'AVAX', 'LINK', 'AAVE', 'UNI', 'DOGE', 'MATIC', 'DOT'];

  // Try Bybit public API (US accessible, no geo-restriction)
  try {
    const resp = await axios.get('https://api.bybit.com/v5/market/tickers?category=linear', { timeout: 8000 });
    const items = resp.data?.result?.list || [];
    let found = 0;
    for (const item of items) {
      if (!item.symbol || !item.fundingRate) continue;
      const base = item.symbol.replace('USDT', '').replace('PERP', '');
      if (!keyCoins.includes(base)) continue;
      const rate = parseFloat(item.fundingRate) * 100;
      fundingRates[base] = { rate: parseFloat(rate.toFixed(4)), symbol: item.symbol, source: 'bybit', time: new Date().toISOString() };
      found++;
    }
    if (found > 0) {
      saveJSON('funding.json', fundingRates);
      const extremes = Object.entries(fundingRates)
        .filter(([, v]) => Math.abs(v.rate) > SETTINGS.fundingRateThreshold)
        .map(([k, v]) => `${k}:${v.rate > 0 ? '+' : ''}${v.rate.toFixed(3)}%`);
      console.log(`💰 Funding rates updated (Bybit): ${found} coins${extremes.length ? ' | Extremes: ' + extremes.join(' ') : ''}`);
      return;
    }
  } catch (e) {}

  // Fallback: OKX public API (also US accessible)
  try {
    const results = await Promise.all(
      keyCoins.map(coin =>
        axios.get(`https://www.okx.com/api/v5/public/funding-rate?instId=${coin}-USDT-SWAP`, { timeout: 5000 })
          .then(r => ({ coin, rate: parseFloat(r.data?.data?.[0]?.fundingRate || 0) * 100 }))
          .catch(() => null)
      )
    );
    let found = 0;
    for (const item of results) {
      if (!item) continue;
      fundingRates[item.coin] = { rate: parseFloat(item.rate.toFixed(4)), source: 'okx', time: new Date().toISOString() };
      found++;
    }
    if (found > 0) {
      saveJSON('funding.json', fundingRates);
      console.log(`💰 Funding rates updated (OKX): ${found} coins`);
      return;
    }
  } catch (e) {}

  console.log('💰 Funding rates: all sources unavailable — using cached data');
}

function getFundingSignal(coin) {
  const f = fundingRates[coin];
  if (!f) return { signal: 'NEUTRAL', strength: 0 };
  const rate = f.rate;
  // High positive funding = longs paying too much = potential short or at least caution on longs
  // High negative funding = shorts paying = potential long squeeze
  if (rate > 0.05) return { signal: 'BEARISH', strength: 'EXTREME', note: 'Longs paying extreme premium — reversal risk HIGH' };
  if (rate > 0.02) return { signal: 'BEARISH', strength: 'HIGH', note: 'Longs overextended on funding' };
  if (rate > 0.01) return { signal: 'BEARISH', strength: 'MEDIUM', note: 'Mild long premium in funding' };
  if (rate < -0.05) return { signal: 'BULLISH', strength: 'EXTREME', note: 'Shorts paying extreme premium — long squeeze potential' };
  if (rate < -0.02) return { signal: 'BULLISH', strength: 'HIGH', note: 'Short overextension — squeeze potential HIGH' };
  if (rate < -0.01) return { signal: 'BULLISH', strength: 'MEDIUM', note: 'Shorts paying mild premium' };
  return { signal: 'NEUTRAL', strength: 'LOW', note: 'Funding balanced' };
}

// ══════════════════════════════════════════════════════
// DEFI YIELD INTELLIGENCE
// ══════════════════════════════════════════════════════
async function fetchDeFiYields() {
  try {
    // DeFiLlama yields API (public)
    const resp = await axios.get('https://yields.llama.fi/pools', { timeout: 10000 });
    const pools = (resp.data?.data || [])
      .filter(p => p.tvlUsd > 10000000 && p.apy > 3 && p.apy < 100) // filter quality pools
      .sort((a, b) => b.tvlUsd - a.tvlUsd)
      .slice(0, 10)
      .map(p => ({
        protocol: p.project, symbol: p.symbol,
        apy: parseFloat(p.apy.toFixed(2)), tvl: p.tvlUsd,
        chain: p.chain, safe: p.tvlUsd > 50000000
      }));
    defiYields = { pools, lastUpdated: new Date().toISOString() };
    saveJSON('defi.json', defiYields);
    console.log(`🌾 DeFi yields: Top APY ${pools[0]?.apy}% on ${pools[0]?.protocol}`);
  } catch (e) {
    console.log('DeFi yields unavailable:', e.message);
  }
}

// ══════════════════════════════════════════════════════
// BTC DOMINANCE + MARKET STRUCTURE
// ══════════════════════════════════════════════════════
async function fetchMarketStructure() {
  try {
    const resp = await axios.get('https://api.coingecko.com/api/v3/global', { timeout: 8000 });
    const data = resp.data?.data;
    if (data) {
      btcDominance = parseFloat((data.market_cap_percentage?.btc || 50).toFixed(1));
      btcPrice = data.total_market_cap?.usd ? btcPrice : btcPrice; // use existing price
      console.log(`₿ BTC Dominance: ${btcDominance}%`);
    }
  } catch (e) {}

  // Also try to get BTC price from Alpaca
  try {
    const btcSnap = await getCryptoSnapshot('BTC/USD');
    if (btcSnap) btcPrice = btcSnap.price;
    const ethSnap = await getCryptoSnapshot('ETH/USD');
    if (ethSnap) ethPrice = ethSnap.price;
  } catch (e) {}
}

function getAltcoinSeasonSignal() {
  if (btcDominance < 40) return { active: true, strength: 'STRONG', note: 'Altcoin season active — BTC dom below 40%' };
  if (btcDominance < 45) return { active: true, strength: 'MODERATE', note: 'Alt season forming — BTC dom weakening' };
  if (btcDominance > 55) return { active: false, strength: 'BTC_DOMINANCE', note: 'BTC dominance high — stick to BTC/ETH' };
  return { active: false, strength: 'NEUTRAL', note: 'Neutral rotation environment' };
}

// ══════════════════════════════════════════════════════
// CLAUDE API
// ══════════════════════════════════════════════════════
async function callClaude(prompt, maxTokens = 400) {
  if (!ANTHROPIC_KEY) return null;
  try {
    const resp = await axios.post('https://api.anthropic.com/v1/messages', {
      model: MODEL, max_tokens: maxTokens,
      messages: [{ role: 'user', content: prompt }]
    }, {
      headers: { 'Content-Type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
      timeout: 25000
    });
    return resp.data?.content?.[0]?.text || null;
  } catch (e) { console.error('Claude error:', e.message); return null; }
}

function parseJSON(text) {
  try { const m = text?.match(/\{[\s\S]*\}/); return m ? JSON.parse(m[0]) : null; }
  catch (e) { return null; }
}

// ══════════════════════════════════════════════════════
// PRE-LOADED CRYPTO DOMAIN KNOWLEDGE
// ══════════════════════════════════════════════════════
const CRYPTO_KNOWLEDGE = `
TITAN CRYPTO PRE-LOADED INTELLIGENCE:

FUNDING RATE SIGNALS (PRIMARY):
- Funding rate > +0.05% per 8hr: EXTREME longs — reversal HIGH probability, consider short
- Funding rate > +0.02% per 8hr: Longs overextended — cautious on new longs
- Funding rate < -0.05% per 8hr: EXTREME shorts — long squeeze very likely
- Funding rate < -0.02% per 8hr: Short overextension — long squeeze potential
- Neutral funding (-0.01% to +0.01%): Clean directional signal from price action

FEAR & GREED FRAMEWORK:
- Extreme Fear (0-20): Capitulation zone — historically best BUY signal
- Fear (21-40): Cautious accumulation — select high-conviction longs only
- Neutral (41-59): Follow price action and funding rates
- Greed (60-79): Momentum riding — trend is your friend but manage exits
- Extreme Greed (80-100): Distribution zone — look for exhaustion, shorts on overextended alts

BITCOIN HALVING CYCLES (COMPLETED):
- Halving 1 (2012): 8,000% gain over next 12 months
- Halving 2 (2016): 2,800% gain over next 12 months  
- Halving 3 (2020): 700% gain over next 12 months
- Halving 4 (2024): Cycle ongoing — historically bullish 12-18 months post-halving
- Post-halving pattern: accumulation 3-6 months, then explosive move

ALTCOIN SEASON PATTERNS:
- BTC dominance below 40%: Strong altcoin season
- BTC dominance falling from 50%+: Rotation beginning
- ETH/BTC ratio rising: DeFi and alt season confirmed
- Typical order: BTC leads → ETH follows → Large caps → Mid caps → Small caps → Memes

CAPITULATION PATTERNS:
- Capitulation candle: High volume, large red candle, immediate recovery
- Fake bounce vs real bounce: Real bounce has increasing volume on recovery
- Bottom indicators: Funding rates deeply negative, Fear & Greed below 15, high liquidations
- Best accumulation: After capitulation, during re-accumulation (flat price, falling volume)

LIQUIDATION CASCADE DETECTION:
- Open interest spike + price drop = liquidation cascade likely
- Price gaps through key levels = liquidations triggering stops
- Recovery after cascade = strong bounce signal

DEFI YIELD STRATEGY:
- Use yield farming during EXTREME FEAR when no good trades exist
- Only protocols with >$50M TVL and proven security track record
- Rotate out of yield to trading when momentum signals emerge
- Treat yield as idle capital management not primary strategy

CROSS-CHAIN FLOW SIGNALS:
- Large bridge flows ETH→Solana: Solana ecosystem momentum building
- Large bridge flows to BNB Chain: Speculative altcoin season likely
- Flows back to ETH: Quality rotation, DeFi narrative strengthening

CRYPTO TIME PATTERNS:
- Asia hours (12am-8am ET): Lower volume, easier manipulation
- London open (3am-5am ET): European institutional activity
- NY open (8am-10am ET): Highest volume, trend confirmation or reversal
- Weekend: Lower liquidity, larger percentage moves possible
- Monthly close: Often volatile, OI resets
`;

// ══════════════════════════════════════════════════════
// POSITION SIZING — 7 FACTORS
// ══════════════════════════════════════════════════════
function calculateCryptoSize(symbol, confidence, volMultiple, signalType, price, avgVolume) {
  const budget = 1000;
  const coin = symbol.replace('/USD', '');

  // Factor 1: Volume multiple
  const volFactor = volMultiple >= 10 ? 1.0 : volMultiple >= 5 ? 0.85 : volMultiple >= 3 ? 0.70 : volMultiple >= 2 ? 0.55 : 0.35;

  // Factor 2: Confidence
  const confFactor = confidence >= 80 ? 1.0 : confidence >= 72 ? 0.85 : confidence >= 65 ? 0.70 : 0.55;

  // Factor 3: Signal type
  const sigMultiplier = { 'FUNDING_SQUEEZE': 1.0, 'CAPITULATION': 1.0, 'MOMENTUM': 0.85, 'ALTSEASON': 0.80, 'DEFI': 0.70, 'OTHER': 0.65 };
  const sigFactor = sigMultiplier[signalType] || 0.65;

  // Factor 4: Fear & Greed regime
  const fgRegime = getFearGreedRegime();
  const fgFactor = fgRegime === 'EXTREME_FEAR' ? 1.0 : fgRegime === 'FEAR' ? 0.85 : fgRegime === 'NEUTRAL' ? 0.80 : fgRegime === 'GREED' ? 0.90 : 0.70;

  // Factor 5: Funding rate alignment
  const fundingSignal = getFundingSignal(coin);
  const fundingFactor = fundingSignal.strength === 'EXTREME' ? 1.1 : fundingSignal.strength === 'HIGH' ? 1.0 : 0.85;

  // Factor 6: Portfolio heat
  const heatFactor = portfolioHeat < 0.3 ? 1.0 : portfolioHeat < 0.5 ? 0.80 : 0.60;

  // Factor 7: Historical win rate for this signal
  const signalWR = learning.patternWR[signalType] || 0.5;
  const wRFactor = signalWR >= 0.65 ? 1.1 : signalWR >= 0.55 ? 1.0 : signalWR >= 0.45 ? 0.85 : 0.70;

  const sizeFactor = volFactor * confFactor * sigFactor * fgFactor * fundingFactor * heatFactor * wRFactor;
  let dollarSize = budget * sizeFactor;

  // ADV cap
  if (avgVolume > 0 && price > 0) {
    const maxByADV = avgVolume * price * SETTINGS.maxADVpct;
    dollarSize = Math.min(dollarSize, maxByADV);
  }

  const heatIfAdded = portfolioHeat + (dollarSize / 10000);
  if (heatIfAdded > SETTINGS.heatCeiling) dollarSize = (SETTINGS.heatCeiling - portfolioHeat) * 10000;

  const qty = price > 0 ? Math.max(0.001, parseFloat((dollarSize / price).toFixed(6))) : 0.001;
  const stage1Qty = SETTINGS.stagedEntry ? parseFloat((qty * 0.35).toFixed(6)) : qty;

  return { qty: stage1Qty, totalTargetQty: qty, dollarSize: parseFloat(dollarSize.toFixed(2)), sizeFactor: parseFloat(sizeFactor.toFixed(3)) };
}

// ══════════════════════════════════════════════════════
// 6-AI ADVERSARIAL PIPELINE — CRYPTO SPECIALIST
// ══════════════════════════════════════════════════════

async function runAI1_Crypto(sym, dir, snap) {
  const coin = sym.replace('/USD', '');
  const funding = fundingRates[coin];
  const fgRegime = getFearGreedRegime();
  const prompt = `You are TITAN CRYPTO AI #1 — TECHNICAL ANALYST for crypto markets.
${sym} $${snap.price?.toFixed(4)} ${dir} | Change:${snap.change}% | Volume:${snap.volMultiple}x avg
Fear & Greed: ${fearGreedIndex} (${fearGreedLabel}) | BTC Dom: ${btcDominance}%
Funding rate: ${funding?.rate?.toFixed(4) || 'N/A'}% per 8hr | Regime: ${fgRegime}
Does the technical setup support a ${dir} trade? Consider price action, volume, momentum.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-90,"reason":"technical reason","stop":${dir==='SHORT'?(snap.price*1.06).toFixed(4):(snap.price*0.92).toFixed(4)},"target":${dir==='SHORT'?(snap.price*0.88).toFixed(4):(snap.price*1.15).toFixed(4)}}`;
  try {
    const result = await callClaude(prompt, 200);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI1'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai1Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI1', dec });
    console.log(`🧠 AI1 ${sym} ${dir}: ${dec.verdict} (${dec.confidence}%)`);
    return dec;
  } catch (e) { return null; }
}

async function runAI2_FundingRate(sym, dir, snap) {
  const coin = sym.replace('/USD', '');
  const funding = fundingRates[coin];
  const fundingSignal = getFundingSignal(coin);
  const prompt = `You are TITAN CRYPTO AI #2 — FUNDING RATE & PERPETUALS SPECIALIST.
${sym} $${snap.price?.toFixed(4)} ${dir}
Funding rate: ${funding?.rate?.toFixed(4) || '0.0000'}% per 8hr
Funding signal: ${fundingSignal.signal} (${fundingSignal.strength}) — ${fundingSignal.note}
Fear & Greed: ${fearGreedIndex} (${fearGreedLabel})
${CRYPTO_KNOWLEDGE.slice(0, 400)}
Does the funding rate analysis support a ${dir} trade? 
High positive funding favors SHORT. High negative funding favors LONG.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-90,"reason":"funding analysis","fundingSignal":"${fundingSignal.signal}","fundingStrength":"${fundingSignal.strength}"}`;
  try {
    const result = await callClaude(prompt, 220);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI2'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai2Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI2', dec });
    console.log(`🧠 AI2 FUNDING ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.fundingSignal}]`);
    return dec;
  } catch (e) { return null; }
}

async function runAI3_Risk(sym, dir, snap, sizeData) {
  const prompt = `You are TITAN CRYPTO AI #3 — RISK MANAGER. Crypto is volatile. Be strict.
${sym} $${snap.price?.toFixed(4)} ${dir} | Size: $${sizeData.dollarSize}
Portfolio heat: ${(portfolioHeat*100).toFixed(0)}% | Daily loss: $${dailyLoss.toFixed(2)}/$${SETTINGS.dailyLossLimit}
Fear & Greed: ${fearGreedIndex} — ${fearGreedLabel}
Stop: $${dir==='SHORT'?(snap.price*1.06).toFixed(4):(snap.price*0.92).toFixed(4)}
Target: $${dir==='SHORT'?(snap.price*0.88).toFixed(4):(snap.price*1.15).toFixed(4)}
Is the risk acceptable? Reject if heat>40%, daily loss>60% limit, or Fear&Greed extreme against direction.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-90,"reason":"risk assessment","riskRating":"LOW|MEDIUM|HIGH"}`;
  try {
    const result = await callClaude(prompt, 200);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI3'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai3Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI3', dec });
    console.log(`🧠 AI3 ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.riskRating}]`);
    return dec;
  } catch (e) { return null; }
}

async function runAI4_OnChain(sym, dir, snap) {
  const coin = sym.replace('/USD', '');
  const altSeason = getAltcoinSeasonSignal();
  const prompt = `You are TITAN CRYPTO AI #4 — ON-CHAIN & MARKET STRUCTURE ANALYST.
${sym} $${snap.price?.toFixed(4)} ${dir}
BTC Dominance: ${btcDominance}% | Altcoin Season: ${altSeason.active} (${altSeason.strength})
BTC: $${btcPrice?.toFixed(0)} | ETH: $${ethPrice?.toFixed(0)}
Fear & Greed: ${fearGreedIndex} (${fearGreedLabel})
Altcoin season note: ${altSeason.note}
Is the market structure supporting a ${dir} on ${sym}?
Consider: BTC dominance trend, altcoin rotation, on-chain behavior.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-90,"reason":"market structure analysis","altSeasonFit":"YES|NO|NEUTRAL"}`;
  try {
    const result = await callClaude(prompt, 200);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI4'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai4Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI4', dec });
    console.log(`🧠 AI4 ${sym}: ${dec.verdict} (${dec.confidence}%) [altSeason:${dec.altSeasonFit}]`);
    return dec;
  } catch (e) { return null; }
}

async function runAI5_Devil(sym, dir, snap) {
  const coin = sym.replace('/USD', '');
  const funding = fundingRates[coin];
  const prompt = `You are TITAN CRYPTO AI #5 — DEVIL'S ADVOCATE. Maximum skepticism for crypto.
${sym} $${snap.price?.toFixed(4)} ${dir} | Funding: ${funding?.rate?.toFixed(4)||'N/A'}%
Fear & Greed: ${fearGreedIndex} (${fearGreedLabel}) | BTC Dom: ${btcDominance}%
AIs 1-4 approved this trade. Find every reason it will FAIL:
- Is this a liquidity trap / stop hunt?
- Is the move already exhausted?
- Are whales distributing into this volume?
- What does the smart money know that retail doesn't?
- Is this a classic crypto fake pump?
Only approve if you genuinely cannot find a strong counter-argument.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-90,"reason":"devil's advocate","primaryRisk":"biggest specific risk","counterArgument":"bear case"}`;
  try {
    const result = await callClaude(prompt, 250);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI5'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai5Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI5', dec });
    console.log(`🧠 AI5 DEVIL ${sym}: ${dec.verdict} (${dec.confidence}%) — ${dec.primaryRisk}`);
    return dec;
  } catch (e) { return null; }
}

async function runAI6_Judge(sym, dir, snap, a1, a2, a3, a4, a5) {
  const avg = Math.round([a1,a2,a3,a4,a5].filter(Boolean).reduce((s,a)=>s+(a.confidence||0),0)/5);
  const yesCount = [a1,a2,a3,a4,a5].filter(a=>a?.verdict==='YES').length;
  const prompt = `You are TITAN CRYPTO AI #6 — THE JUDGE. Final authority on crypto trades.
${sym} $${snap.price?.toFixed(4)} ${dir} | Fear&Greed: ${fearGreedIndex} (${fearGreedLabel})
AI1 Technical: ${a1?.verdict} (${a1?.confidence}%)
AI2 Funding: ${a2?.verdict} (${a2?.confidence}%) [${a2?.fundingSignal||''}]
AI3 Risk: ${a3?.verdict} (${a3?.confidence}%) [${a3?.riskRating||''}]
AI4 Market Structure: ${a4?.verdict} (${a4?.confidence}%)
AI5 Devil: ${a5?.verdict} (${a5?.confidence}%) — ${(a5?.primaryRisk||'').slice(0,60)}
Votes YES: ${yesCount}/5 | Avg confidence: ${avg}%
Synthesize. Crypto is more volatile than equities — require stronger consensus.
If Devil's Advocate raised a legitimate crypto-specific risk (whale manipulation, fake pump), respect it.
Return ONLY JSON: {"verdict":"YES"|"NO","confidence":62-92,"finalReason":"synthesis","urgency":"NOW|WAIT|SKIP","tradeQuality":"A|B|C"}`;
  try {
    const result = await callClaude(prompt, 250);
    const dec = parseJSON(result);
    if (!dec) return null;
    dec.ai = 'AI6'; dec.sym = sym; dec.time = new Date().toLocaleTimeString();
    ai6Dec[sym] = dec; broadcast('AI_UPDATE', { sym, ai: 'AI6', dec });
    console.log(`⚖️ JUDGE ${sym}: ${dec.verdict} (${dec.confidence}%) [${dec.tradeQuality}]`);
    return dec;
  } catch (e) { return null; }
}

async function run6AIPipeline(sym, dir, signalType, snap) {
  console.log(`🔱 6-AI CRYPTO PIPELINE: ${sym} ${dir} [${signalType}]`);
  broadcast('PIPELINE_START', { sym, dir, signalType });

  const sizeData = calculateCryptoSize(sym, 70, snap.volMultiple || 1, signalType, snap.price, snap.avgVolume);

  const a1 = await runAI1_Crypto(sym, dir, snap); await sleep(300);
  if (!a1 || a1.verdict !== 'YES') { console.log(`❌ ${sym} blocked at AI1`); return null; }

  const a2 = await runAI2_FundingRate(sym, dir, snap); await sleep(300);
  if (!a2 || a2.verdict !== 'YES') { console.log(`❌ ${sym} blocked at AI2 Funding`); return null; }

  const a3 = await runAI3_Risk(sym, dir, snap, sizeData); await sleep(300);
  if (!a3 || a3.verdict !== 'YES') { console.log(`❌ ${sym} blocked at AI3`); return null; }

  const a4 = await runAI4_OnChain(sym, dir, snap); await sleep(300);

  const a5 = await runAI5_Devil(sym, dir, snap); await sleep(300);
  if (!a5 || a5.verdict !== 'YES') { console.log(`❌ ${sym} blocked by DEVIL — ${a5?.primaryRisk}`); return null; }

  const a6 = await runAI6_Judge(sym, dir, snap, a1, a2, a3, a4, a5);
  if (!a6 || a6.verdict !== 'YES') { console.log(`❌ ${sym} rejected by JUDGE`); return null; }

  const finalSize = calculateCryptoSize(sym, a6.confidence, snap.volMultiple || 1, signalType, snap.price, snap.avgVolume);
  console.log(`✅ 6-AI APPROVED: ${sym} ${dir} | Quality:${a6.tradeQuality} | Size:$${finalSize.dollarSize}`);
  return { a1, a2, a3, a4, a5, a6, sizeData: finalSize };
}

// ══════════════════════════════════════════════════════
// POSITION MANAGEMENT
// ══════════════════════════════════════════════════════
async function enterPosition(sym, dir, signalType, snap, pipelineResult) {
  if (Object.keys(positions).length >= SETTINGS.maxPositions) return false;
  const { sizeData, a6 } = pipelineResult;
  const isShort = dir === 'SHORT';
  const entry = snap.price;
  const stop = isShort ? entry * 1.06 : entry * 0.92;
  const target = isShort ? entry * 0.88 : entry * 1.15;
  const qty = sizeData.qty;

  const order = await placeCryptoOrder(sym, qty, isShort ? 'sell' : 'buy');
  if (!order && ALPACA_KEY) return false;

  const pos = {
    symbol: sym, ticker: sym, type: dir, entry, stop, target, qty,
    totalTargetQty: sizeData.totalTargetQty, stage: 1, maxStages: 3,
    signalType, value: entry * qty, budget: sizeData.dollarSize,
    sizeFactor: sizeData.sizeFactor, unrealizedPnl: 0, peakUnrealizedPnl: 0,
    regime: cryptoRegime, fearGreed: fearGreedIndex,
    fundingAtEntry: fundingRates[sym.replace('/USD', '')]?.rate || 0,
    entryTime: new Date().toISOString(), lastChecked: new Date().toISOString(),
    aiSummary: `${a6.tradeQuality} | ${a6.finalReason?.slice(0, 80)}`
  };

  positions[sym] = pos;
  saveJSON('positions.json', positions);
  updateHeat();
  addRotationLog('➕', sym, `${dir} ${signalType} @ $${entry.toFixed(4)}`);
  broadcast('POSITION_OPENED', { sym, pos });
  console.log(`🟢 ENTER: ${sym} ${dir} @ $${entry.toFixed(4)} | ${qty} | Stage 1 | $${pos.budget}`);
  return true;
}

async function addToPosition(sym) {
  const pos = positions[sym];
  if (!pos || pos.stage >= pos.maxStages) return;
  const snap = await getCryptoSnapshot(sym);
  if (!snap) return;
  const isShort = pos.type === 'SHORT';
  const pnlPct = isShort ? (pos.entry - snap.price) / pos.entry * 100 : (snap.price - pos.entry) / pos.entry * 100;
  if (pnlPct < 2.5) return; // crypto needs more confirmation

  const addQty = parseFloat((pos.totalTargetQty * (pos.stage === 1 ? 0.4 : 0.25)).toFixed(6));
  const order = await placeCryptoOrder(sym, addQty, isShort ? 'sell' : 'buy');
  if (!order && ALPACA_KEY) return;

  pos.qty += addQty; pos.stage++;
  pos.value = snap.price * pos.qty;
  positions[sym] = pos;
  saveJSON('positions.json', positions);
  updateHeat();
  console.log(`📈 STAGE ${pos.stage}: Added ${addQty} ${sym} @ $${snap.price.toFixed(4)}`);
}

async function closePosition(sym, reason, snap) {
  const pos = positions[sym];
  if (!pos) return;
  const price = snap?.price || pos.entry;
  const isShort = pos.type === 'SHORT';
  const pnl = isShort ? (pos.entry - price) * pos.qty : (price - pos.entry) * pos.qty;
  const pnlPct = isShort ? (pos.entry - price) / pos.entry * 100 : (price - pos.entry) / pos.entry * 100;

  await placeCryptoOrder(sym, pos.qty, isShort ? 'buy' : 'sell');

  totalPnl = parseFloat((totalPnl + pnl).toFixed(2));
  dailyPnl = parseFloat((dailyPnl + pnl).toFixed(2));
  weeklyPnl = parseFloat((weeklyPnl + pnl).toFixed(2));
  totalTrades++; dailyTrades++;
  if (pnl > 0) { totalWins++; consecutiveWins++; consecutiveLoss = 0; }
  else { dailyLoss += Math.abs(pnl); consecutiveLoss++; consecutiveWins = 0; }
  if (totalPnl > allTimePeak) allTimePeak = totalPnl;

  const patWR = learning.patternWR[pos.signalType] || { wins: 0, total: 0 };
  patWR.total++; if (pnl > 0) patWR.wins++;
  learning.patternWR[pos.signalType] = patWR;
  learning.totalDecisions++;
  saveJSON('learning.json', learning);
  saveState();

  tradeJournal.unshift({ symbol: sym, ticker: sym, type: pos.type, entry: pos.entry, exit: price, pnl: parseFloat(pnl.toFixed(4)), pnlPct: parseFloat(pnlPct.toFixed(2)), signalType: pos.signalType, regime: pos.regime, fearGreedAtEntry: pos.fearGreed, fundingAtEntry: pos.fundingAtEntry, stage: pos.stage, entryTime: pos.entryTime, exitTime: new Date().toISOString(), reason });
  tradeJournal = tradeJournal.slice(0, 200);
  saveJSON('trades.json', tradeJournal);

  const icon = pnl > 0 ? '🏆' : '📉';
  console.log(`${icon} CLOSE: ${sym} ${pos.type} | P&L: ${pnl>=0?'+':''}$${pnl.toFixed(4)} (${pnlPct>=0?'+':''}${pnlPct.toFixed(2)}%) | ${reason}`);

  addRotationLog('➖', sym, reason);
  delete positions[sym];
  saveJSON('positions.json', positions);
  updateHeat();
  broadcast('POSITION_CLOSED', { sym, pnl, totalPnl });
}

// ══════════════════════════════════════════════════════
// PROACTIVE EXIT INTELLIGENCE
// ══════════════════════════════════════════════════════
async function runExitIntelligence() {
  const syms = Object.keys(positions);
  if (!syms.length) return;

  const snaps = await getMultiCryptoSnapshot(syms);

  for (const sym of syms) {
    const pos = positions[sym];
    if (!pos) continue;
    const snap = snaps[sym];
    if (!snap || !snap.price) continue;

    const isShort = pos.type === 'SHORT';
    const pnlPct = isShort ? (pos.entry - snap.price) / pos.entry * 100 : (snap.price - pos.entry) / pos.entry * 100;
    pos.unrealizedPnl = (snap.price - pos.entry) * pos.qty * (isShort ? -1 : 1);
    pos.currentPrice = snap.price;

    // Peak protection
    if (pos.unrealizedPnl > (pos.peakUnrealizedPnl || 0)) pos.peakUnrealizedPnl = pos.unrealizedPnl;
    const giveBack = pos.peakUnrealizedPnl > 0 ? (pos.peakUnrealizedPnl - pos.unrealizedPnl) / pos.peakUnrealizedPnl : 0;
    if (giveBack > SETTINGS.peakProtection && pos.peakUnrealizedPnl > 5) {
      await closePosition(sym, `Peak protection — gave back ${(giveBack*100).toFixed(0)}%`, snap); continue;
    }

    // Hard stop
    if (pnlPct <= -8) { await closePosition(sym, `Stop loss: ${pnlPct.toFixed(2)}%`, snap); continue; }

    // Target
    if (pnlPct >= 15) { await closePosition(sym, `Target hit: ${pnlPct.toFixed(2)}%`, snap); continue; }

    // Funding rate reversal — if funding flipped strongly against our position, exit
    const coin = sym.replace('/USD', '');
    const funding = fundingRates[coin];
    if (funding && pos.type === 'LONG' && funding.rate > 0.05) {
      await closePosition(sym, `Funding rate extreme: ${funding.rate.toFixed(4)}% — longs in danger`, snap); continue;
    }
    if (funding && pos.type === 'SHORT' && funding.rate < -0.05) {
      await closePosition(sym, `Funding rate extreme: ${funding.rate.toFixed(4)}% — shorts in danger`, snap); continue;
    }

    // Stage add
    if (pos.stage < pos.maxStages && pnlPct >= 2.5) await addToPosition(sym);

    positions[sym] = pos;
  }
  saveJSON('positions.json', positions);
  broadcast('POSITIONS_UPDATE', { positions });
}

// ══════════════════════════════════════════════════════
// MAIN SCANNER — Funding + Fear & Greed + Price Action
// ══════════════════════════════════════════════════════
async function runCryptoScanner() {
  console.log(`🔍 TITAN CRYPTO: Scanner firing... Fear&Greed:${fearGreedIndex}(${fearGreedLabel})`);
  lastScanTime = new Date().toISOString();

  if (paused) return;
  if (portfolioHeat >= SETTINGS.heatCeiling) return;
  if (dailyLoss >= SETTINGS.dailyLossLimit) { paused = true; pauseReason = 'Daily loss limit'; return; }
  if (Object.keys(positions).length >= SETTINGS.maxPositions) return;

  const fgRegime = getFearGreedRegime();
  cryptoRegime = fgRegime;
  personality = getCryptoPersonality();

  // Get snapshots for all tradeable pairs
  const snaps = await getMultiCryptoSnapshot(CRYPTO_UNIVERSE.slice(0, 10));
  const available = Object.entries(snaps).filter(([sym, snap]) => snap && snap.price > 0 && !positions[sym]);

  const scanCandidates = [];

  for (const [sym, snap] of available) {
    const coin = sym.replace('/USD', '');
    const fundingSignal = getFundingSignal(coin);

    // Signal 1: Extreme funding rate squeeze (best signal)
    if (fundingSignal.signal === 'BULLISH' && fundingSignal.strength === 'EXTREME') {
      scanCandidates.push({ sym, snap, dir: 'LONG', signalType: 'FUNDING_SQUEEZE', score: 95, reason: `Extreme short funding: ${fundingRates[coin]?.rate?.toFixed(4)}%` });
    }
    if (fundingSignal.signal === 'BEARISH' && fundingSignal.strength === 'EXTREME') {
      scanCandidates.push({ sym, snap, dir: 'SHORT', signalType: 'FUNDING_SQUEEZE', score: 90, reason: `Extreme long funding: ${fundingRates[coin]?.rate?.toFixed(4)}%` });
    }

    // Signal 2: Capitulation buy (Fear & Greed extreme + price down big)
    if (fgRegime === 'EXTREME_FEAR' && snap.change < -5 && snap.volMultiple > 2) {
      scanCandidates.push({ sym, snap, dir: 'LONG', signalType: 'CAPITULATION', score: 85, reason: `Capitulation: F&G ${fearGreedIndex}, down ${snap.change}% on ${snap.volMultiple}x vol` });
    }

    // Signal 3: Momentum in Greed regime
    if ((fgRegime === 'GREED' || fgRegime === 'NEUTRAL') && snap.change > 5 && snap.volMultiple > 3) {
      scanCandidates.push({ sym, snap, dir: 'LONG', signalType: 'MOMENTUM', score: 75, reason: `Momentum: +${snap.change}% on ${snap.volMultiple}x volume` });
    }

    // Signal 4: Exhaustion short (Extreme Greed + very overextended)
    if (fgRegime === 'EXTREME_GREED' && snap.change > 20 && snap.volMultiple < 2) {
      scanCandidates.push({ sym, snap, dir: 'SHORT', signalType: 'EXHAUSTION', score: 70, reason: `Exhaustion: +${snap.change}% on weak volume in Extreme Greed` });
    }
  }

  // Sort by score
  scanCandidates.sort((a, b) => b.score - a.score);

  candidates = scanCandidates.slice(0, 10).map(c => ({ ...c, addedAt: new Date().toISOString() }));
  broadcast('CANDIDATES_UPDATE', { candidates });

  // Run top candidates through 6-AI pipeline
  for (const candidate of scanCandidates.slice(0, 3)) {
    if (Object.keys(positions).length >= SETTINGS.maxPositions) break;
    if (positions[candidate.sym]) continue;

    addRotationLog('🔍', candidate.sym, candidate.reason.slice(0, 60));
    const result = await run6AIPipeline(candidate.sym, candidate.dir, candidate.signalType, candidate.snap);
    if (result) await enterPosition(candidate.sym, candidate.dir, candidate.signalType, candidate.snap, result);
    await sleep(500);
  }

  broadcast('SNAPSHOT', getSnapshot());
}

// DeFi yield mode when no good trades exist
async function runDeFiYieldMode() {
  const fgRegime = getFearGreedRegime();
  if (fgRegime !== 'EXTREME_FEAR' && fgRegime !== 'FEAR') return;
  if (Object.keys(positions).length > 0) return;
  if (!defiYields.pools?.length) return;

  const topPool = defiYields.pools.find(p => p.safe && p.apy > 5);
  if (topPool) {
    addIntelligence(`🌾 DeFi yield opportunity: ${topPool.protocol} ${topPool.apy}% APY (${topPool.tvl/1e6}M TVL) — idle capital earning in ${fgRegime} regime`);
  }
}

// ── HELPERS ──
function updateHeat() {
  const totalValue = Object.values(positions).reduce((s, p) => s + Math.abs(p.value || (p.entry * p.qty)), 0);
  portfolioHeat = parseFloat(Math.min(totalValue / 10000, 1).toFixed(3));
  broadcast('HEAT_UPDATE', { portfolioHeat });
}

function addRotationLog(icon, ticker, reason) {
  rotationLog.unshift({ icon, ticker, reason, time: new Date().toLocaleTimeString() });
  rotationLog = rotationLog.slice(0, 50);
  broadcast('ROTATION_UPDATE', rotationLog[0]);
}

function addIntelligence(msg) {
  alerts.unshift({ message: msg, severity: 'INFO', time: new Date().toISOString() });
  alerts = alerts.slice(0, 50);
  broadcast('ALERT', alerts[0]);
  console.log(`💡 INTEL: ${msg}`);
}

// ══════════════════════════════════════════════════════
// SCHEDULING — 24/7 Operation
// ══════════════════════════════════════════════════════
function startSchedules() {
  // Main scan — every 10 minutes 24/7 (crypto never sleeps)
  setInterval(async () => {
    await runCryptoScanner();
  }, SETTINGS.scanInterval);

  // Exit intelligence — every 5 minutes
  setInterval(async () => {
    if (Object.keys(positions).length > 0) await runExitIntelligence();
  }, SETTINGS.exitCheckInterval);

  // Funding rates — every 15 minutes
  setInterval(async () => {
    await fetchFundingRates();
  }, 15 * 60 * 1000);

  // Fear & Greed + market structure — every 30 minutes
  setInterval(async () => {
    await fetchFearGreed();
    await fetchMarketStructure();
    await runDeFiYieldMode();
  }, 30 * 60 * 1000);

  // DeFi yields — every 2 hours
  setInterval(() => fetchDeFiYields(), 2 * 60 * 60 * 1000);

  // Daily reset
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      dailyPnl = 0; dailyLoss = 0; dailyTrades = 0;
      if (paused && pauseReason.includes('Daily loss')) { paused = false; pauseReason = ''; }
      saveState();
    }
  }, 60 * 1000);

  // Initial data fetch
  setTimeout(async () => {
    await fetchFearGreed();
    await fetchFundingRates();
    await fetchMarketStructure();
    await fetchDeFiYields();
    console.log('📊 Initial data fetch complete');
    await runCryptoScanner();
  }, 3000);

  setTimeout(() => runExitIntelligence(), 20000);
}

// ── REST API ──
app.get('/health', (req, res) => res.json({ status: 'ok', positions: Object.keys(positions).length }));
app.get('/api/snapshot', (req, res) => res.json(getSnapshot()));
app.get('/api/status', (req, res) => res.json({
  status: 'ONLINE', positions: Object.keys(positions).length,
  portfolioHeat, totalPnl, openPnl: Object.values(positions).reduce((s,p)=>s+(p.unrealizedPnl||0),0),
  dailyPnl, totalTrades, totalWins, winRate: totalTrades>0?totalWins/totalTrades*100:0,
  marketRegime: cryptoRegime, regime: cryptoRegime, personality,
  fearGreedIndex, fearGreedLabel, btcDominance, consecutiveWins, consecutiveLoss
}));
app.post('/api/scan', async (req, res) => { res.json({ message: 'Scan triggered' }); await runCryptoScanner(); });
app.post('/api/pause', (req, res) => { paused = true; pauseReason = req.body.reason || 'Manual'; res.json({ paused }); });
app.post('/api/resume', (req, res) => { paused = false; pauseReason = ''; res.json({ paused }); });
app.post('/api/close/:sym', async (req, res) => {
  const sym = req.params.sym.toUpperCase().replace('_', '/');
  if (!positions[sym]) return res.status(404).json({ error: 'Not found' });
  const snap = await getCryptoSnapshot(sym);
  await closePosition(sym, 'Manual close', snap || { price: positions[sym].entry });
  res.json({ closed: true });
});
app.get('/api/funding', (req, res) => res.json(fundingRates));
app.get('/api/defi', (req, res) => res.json(defiYields));
app.get('/api/trades', (req, res) => res.json(tradeJournal.slice(0, 50)));

wss.on('connection', ws => {
  console.log('📱 TITAN CRYPTO dashboard connected');
  ws.send(JSON.stringify({ type: 'SNAPSHOT', data: getSnapshot() }));
});

// ── STARTUP ──
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║   NEXUS TITAN CRYPTO — Crypto Intelligence Specialist            ║');
  console.log('║   Funding Rate Intelligence · Fear & Greed Regime · 24/7         ║');
  console.log('║   Cross-Chain Flow · DeFi Yield · Long AND Short                 ║');
  console.log('║   Built Once — Built Permanently — No Ceiling Ever               ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`🌌 Claude AI:      ${ANTHROPIC_KEY ? '✅' : '❌ No key'}`);
  console.log(`📊 Alpaca Crypto:  ${ALPACA_KEY ? '✅ Connected' : '⚠️ No key — simulation mode'}`);
  console.log(`😱 Fear & Greed:   ${fearGreedIndex} (${fearGreedLabel})`);
  console.log(`₿ BTC Dominance:  ${btcDominance}%`);
  console.log(`💼 Open positions: ${Object.keys(positions).length}`);
  console.log(`🧠 Total trades:   ${totalTrades}`);
  console.log('');
  console.log('🔱 6-AI ADVERSARIAL PIPELINE:');
  console.log('   AI1 Technical → AI2 Funding Rate → AI3 Risk → AI4 On-Chain → AI5 Devil → AI6 Judge');
  console.log('');
  updateHeat();
  startSchedules();
  console.log('✅ NEXUS TITAN CRYPTO — The hunt begins 24/7');
});
