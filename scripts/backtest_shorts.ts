#!/usr/bin/env npx tsx
/**
 * Backtest Script: Test SHORT strategy over last 7 days
 * Uses Binance historical data and our momentum strategy rules
 */

import Decimal from 'decimal.js';

const BINANCE_API = 'https://api.binance.com';
const PAIRS = ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'AVAXUSDT', 'XRPUSDT', 'BNBUSDT', 'SUIUSDT', 'LINKUSDT', 'TONUSDT', 'ADAUSDT'];
const TIMEFRAME = '5m';
const LOOKBACK_DAYS = 7;
const CANDLES_NEEDED = (LOOKBACK_DAYS * 24 * 60) / 5; // 5-min candles for 7 days

// Strategy parameters (matching live bot)
const MOMENTUM_THRESHOLD = 0.60;
const VOLUME_MULTIPLIER = 1.5;
const TAKE_PROFIT_PERCENT = 1.3;
const STOP_LOSS_PERCENT = 5;

interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

interface Trade {
  symbol: string;
  direction: 'LONG' | 'SHORT';
  entry: number;
  exit: number;
  pnl: number;
  pnlPercent: number;
  reason: string;
  entryTime: Date;
  exitTime: Date;
}

async function fetchCandles(symbol: string): Promise<Candle[]> {
  const url = `${BINANCE_API}/api/v3/klines?symbol=${symbol}&interval=${TIMEFRAME}&limit=${CANDLES_NEEDED}`;
  const response = await fetch(url);
  const data = await response.json();

  return data.map((k: any[]) => ({
    time: k[0],
    open: parseFloat(k[1]),
    high: parseFloat(k[2]),
    low: parseFloat(k[3]),
    close: parseFloat(k[4]),
    volume: parseFloat(k[5]),
  }));
}

function calculateEMA(prices: number[], period: number): number {
  const k = 2 / (period + 1);
  let ema = prices.slice(0, period).reduce((a, b) => a + b, 0) / period;
  for (let i = period; i < prices.length; i++) {
    ema = prices[i] * k + ema * (1 - k);
  }
  return ema;
}

function detectEMAStack(prices: number[]): 'BULLISH' | 'BEARISH' | 'SIDEWAYS' {
  if (prices.length < 200) return 'SIDEWAYS';

  const ema20 = calculateEMA(prices, 20);
  const ema50 = calculateEMA(prices, 50);
  const ema200 = calculateEMA(prices, 200);

  if (ema20 > ema50 && ema50 > ema200) return 'BULLISH';
  if (ema20 < ema50 && ema50 < ema200) return 'BEARISH';
  return 'SIDEWAYS';
}

function calculateRSI(prices: number[], period: number = 14): number {
  if (prices.length < period + 1) return 50;

  const changes = [];
  for (let i = 1; i < prices.length; i++) {
    changes.push(prices[i] - prices[i - 1]);
  }

  const recentChanges = changes.slice(-period);
  const gains = recentChanges.filter(c => c > 0);
  const losses = recentChanges.filter(c => c < 0).map(c => Math.abs(c));

  const avgGain = gains.length > 0 ? gains.reduce((a, b) => a + b, 0) / period : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((a, b) => a + b, 0) / period : 0;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
}

function calculateMomentumScore(prices: number[], direction: 'LONG' | 'SHORT'): number {
  const rsi = calculateRSI(prices);
  const ema20 = calculateEMA(prices, 20);
  const ema50 = calculateEMA(prices, 50);
  const currentPrice = prices[prices.length - 1];

  let score = 0;

  // RSI component (0.15 weight)
  if (direction === 'LONG') {
    score += rsi > 50 && rsi < 70 ? 0.15 : 0;
  } else {
    score += rsi < 50 && rsi > 30 ? 0.15 : 0;
  }

  // EMA alignment (0.25 weight)
  if (direction === 'LONG') {
    score += currentPrice > ema20 && ema20 > ema50 ? 0.25 : 0;
  } else {
    score += currentPrice < ema20 && ema20 < ema50 ? 0.25 : 0;
  }

  // MACD approximation (0.20 weight)
  const ema12 = calculateEMA(prices, 12);
  const ema26 = calculateEMA(prices, 26);
  const macd = ema12 - ema26;
  if (direction === 'LONG') {
    score += macd > 0 ? 0.20 : 0;
  } else {
    score += macd < 0 ? 0.20 : 0;
  }

  // Base score for meeting trend (0.40 weight for EMA stack)
  score += 0.40;

  return score;
}

function calculateAverageVolume(candles: Candle[], period: number): number {
  const volumes = candles.slice(-period).map(c => c.volume);
  return volumes.reduce((a, b) => a + b, 0) / volumes.length;
}

async function backtest(): Promise<void> {
  console.log('='.repeat(70));
  console.log('BACKTEST: SHORT Strategy - Last 7 Days');
  console.log('='.repeat(70));
  console.log(`Parameters: TP=${TAKE_PROFIT_PERCENT}%, SL=${STOP_LOSS_PERCENT}%, Momentum>=${MOMENTUM_THRESHOLD}, Vol>=${VOLUME_MULTIPLIER}x`);
  console.log('');

  const allTrades: Trade[] = [];

  for (const pair of PAIRS) {
    console.log(`Fetching ${pair}...`);
    const candles = await fetchCandles(pair);

    if (candles.length < 250) {
      console.log(`  Insufficient data for ${pair}`);
      continue;
    }

    const trades: Trade[] = [];
    let inPosition = false;
    let positionEntry = 0;
    let positionDirection: 'LONG' | 'SHORT' = 'LONG';
    let entryTime = new Date();
    let tp = 0;
    let sl = 0;

    // Walk through candles starting from index 250 (need history for EMAs)
    for (let i = 250; i < candles.length; i++) {
      const historyPrices = candles.slice(i - 250, i).map(c => c.close);
      const currentCandle = candles[i];
      const currentPrice = currentCandle.close;

      if (inPosition) {
        // Check TP/SL
        let exitReason = '';
        let exitPrice = 0;

        if (positionDirection === 'LONG') {
          if (currentCandle.high >= tp) {
            exitReason = 'TP Hit';
            exitPrice = tp;
          } else if (currentCandle.low <= sl) {
            exitReason = 'SL Hit';
            exitPrice = sl;
          }
        } else { // SHORT
          if (currentCandle.low <= tp) {
            exitReason = 'TP Hit';
            exitPrice = tp;
          } else if (currentCandle.high >= sl) {
            exitReason = 'SL Hit';
            exitPrice = sl;
          }
        }

        if (exitReason) {
          const pnl = positionDirection === 'LONG'
            ? exitPrice - positionEntry
            : positionEntry - exitPrice;
          const pnlPercent = (pnl / positionEntry) * 100;

          trades.push({
            symbol: pair,
            direction: positionDirection,
            entry: positionEntry,
            exit: exitPrice,
            pnl,
            pnlPercent,
            reason: exitReason,
            entryTime,
            exitTime: new Date(currentCandle.time),
          });

          inPosition = false;
        }
      } else {
        // Check for new signal
        const emaStack = detectEMAStack(historyPrices);

        if (emaStack === 'SIDEWAYS') continue;

        const direction = emaStack === 'BULLISH' ? 'LONG' : 'SHORT';

        // Check volume
        const avgVol = calculateAverageVolume(candles.slice(i - 21, i - 1), 20);
        const currentVol = candles[i - 1].volume; // Previous complete candle
        const volRatio = currentVol / avgVol;

        if (volRatio < VOLUME_MULTIPLIER) continue;

        // Check momentum
        const momentum = calculateMomentumScore(historyPrices, direction);
        if (momentum < MOMENTUM_THRESHOLD) continue;

        // Enter position
        inPosition = true;
        positionEntry = currentPrice;
        positionDirection = direction;
        entryTime = new Date(currentCandle.time);

        if (direction === 'LONG') {
          tp = currentPrice * (1 + TAKE_PROFIT_PERCENT / 100);
          sl = currentPrice * (1 - STOP_LOSS_PERCENT / 100);
        } else {
          tp = currentPrice * (1 - TAKE_PROFIT_PERCENT / 100);
          sl = currentPrice * (1 + STOP_LOSS_PERCENT / 100);
        }
      }
    }

    allTrades.push(...trades);

    // Summary for this pair
    const pairTrades = trades;
    const longs = pairTrades.filter(t => t.direction === 'LONG');
    const shorts = pairTrades.filter(t => t.direction === 'SHORT');
    const longWins = longs.filter(t => t.reason === 'TP Hit').length;
    const shortWins = shorts.filter(t => t.reason === 'TP Hit').length;

    console.log(`  ${pair}: ${longs.length} longs (${longWins} wins), ${shorts.length} shorts (${shortWins} wins)`);
  }

  console.log('');
  console.log('='.repeat(70));
  console.log('RESULTS SUMMARY');
  console.log('='.repeat(70));

  const longs = allTrades.filter(t => t.direction === 'LONG');
  const shorts = allTrades.filter(t => t.direction === 'SHORT');

  const longWins = longs.filter(t => t.reason === 'TP Hit');
  const longLosses = longs.filter(t => t.reason === 'SL Hit');
  const shortWins = shorts.filter(t => t.reason === 'TP Hit');
  const shortLosses = shorts.filter(t => t.reason === 'SL Hit');

  const longPnl = longs.reduce((sum, t) => sum + t.pnlPercent, 0);
  const shortPnl = shorts.reduce((sum, t) => sum + t.pnlPercent, 0);

  console.log('');
  console.log('LONG TRADES:');
  console.log(`  Total: ${longs.length}`);
  console.log(`  Wins: ${longWins.length} (${longs.length > 0 ? ((longWins.length / longs.length) * 100).toFixed(1) : 0}%)`);
  console.log(`  Losses: ${longLosses.length}`);
  console.log(`  Total P&L: ${longPnl.toFixed(2)}%`);

  console.log('');
  console.log('SHORT TRADES:');
  console.log(`  Total: ${shorts.length}`);
  console.log(`  Wins: ${shortWins.length} (${shorts.length > 0 ? ((shortWins.length / shorts.length) * 100).toFixed(1) : 0}%)`);
  console.log(`  Losses: ${shortLosses.length}`);
  console.log(`  Total P&L: ${shortPnl.toFixed(2)}%`);

  console.log('');
  console.log('COMBINED:');
  console.log(`  Total Trades: ${allTrades.length}`);
  console.log(`  Win Rate: ${allTrades.length > 0 ? (((longWins.length + shortWins.length) / allTrades.length) * 100).toFixed(1) : 0}%`);
  console.log(`  Total P&L: ${(longPnl + shortPnl).toFixed(2)}%`);

  // Show recent SHORT trades
  console.log('');
  console.log('RECENT SHORT TRADES:');
  const recentShorts = shorts.slice(-10);
  for (const t of recentShorts) {
    const winLoss = t.reason === 'TP Hit' ? '✅' : '❌';
    console.log(`  ${winLoss} ${t.symbol.replace('USDT', '')} @ ${t.entry.toFixed(4)} → ${t.exit.toFixed(4)} (${t.pnlPercent.toFixed(2)}%) - ${t.entryTime.toISOString().slice(0, 16)}`);
  }
}

backtest().catch(console.error);
