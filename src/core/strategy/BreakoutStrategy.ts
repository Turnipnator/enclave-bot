import Decimal from 'decimal.js';
import pino from 'pino';
import { EnclaveClient } from '../exchange/EnclaveClient';
import { OrderSide, OrderType } from '../exchange/types';
import { TechnicalIndicators, PriceData } from '../indicators/TechnicalIndicators';
import { config } from '../../config/config';
import { HealthCheck } from '../../utils/healthCheck';
import { TelegramService } from '../../services/telegram/TelegramService';

export interface BreakoutConfig {
  lookbackPeriod: number;
  volumeMultiplier: number;
  trailingStopPercent: number;
  positionSize: Decimal;
  useScalping: boolean;
  breakoutBuffer: number;
  takeProfitPercent?: number; // Optional take profit target
}

export interface Signal {
  symbol: string;
  side: OrderSide;
  entryPrice: Decimal;
  stopLoss: Decimal;
  takeProfit?: Decimal;
  confidence: number;
  reason: string;
}

export class BreakoutStrategy {
  private readonly client: EnclaveClient;
  private readonly config: BreakoutConfig;
  private readonly logger: pino.Logger;
  private readonly telegram?: TelegramService;
  private priceHistory: Map<string, PriceData[]> = new Map();
  private activeSignals: Map<string, Signal> = new Map();
  private trailingStops: Map<string, { high: Decimal; stop: Decimal }> = new Map();
  // Trend Following: Track last N trend readings for each symbol
  private trendHistory: Map<string, Array<'UPTREND' | 'DOWNTREND' | 'SIDEWAYS'>> = new Map();

  constructor(client: EnclaveClient, strategyConfig: BreakoutConfig, telegram?: TelegramService) {
    this.client = client;
    this.config = strategyConfig;
    this.telegram = telegram;
    this.logger = pino({ name: 'BreakoutStrategy', level: config.logLevel });
  }

  private roundToIncrement(price: Decimal, symbol: string): Decimal {
    let increment: number;

    // Price increments verified from Enclave API /v1/markets
    if (symbol === 'BTC-USD.P') {
      increment = 1; // Whole dollars
    } else if (symbol === 'ETH-USD.P') {
      increment = 0.1; // 1 decimal place
    } else if (symbol === 'SOL-USD.P') {
      increment = 0.01; // 2 decimal places
    } else if (symbol === 'AVAX-USD.P') {
      increment = 0.001; // 3 decimal places
    } else if (symbol === 'XRP-USD.P') {
      increment = 0.0001; // 4 decimal places
    } else if (symbol === 'BNB-USD.P') {
      increment = 0.01; // 2 decimal places
    } else if (symbol === 'DOGE-USD.P') {
      increment = 0.0001; // 4 decimal places
    } else if (symbol === 'LINK-USD.P') {
      increment = 0.001; // 3 decimal places
    } else if (symbol === 'SUI-USD.P') {
      increment = 0.0001; // 4 decimal places
    } else if (symbol === 'HYPE-USD.P') {
      increment = 0.001; // 3 decimal places
    } else if (symbol === 'NXP-USD.P') {
      increment = 0.001; // 3 decimal places
    } else {
      increment = 0.001; // Default to 3 decimal places
    }

    const priceNumber = price.toNumber();
    const rounded = Math.round(priceNumber / increment) * increment;
    return new Decimal(rounded.toFixed(8)); // Avoid floating point errors
  }

  public async updatePriceHistory(symbol: string): Promise<void> {
    try {
      const marketData = await this.client.getMarketData(symbol);
      // const trades = await this.client.getTrades(symbol, 100); // For future use

      const currentPriceData: PriceData = {
        high: marketData.high24h,
        low: marketData.low24h,
        close: marketData.last,
        volume: marketData.volume24h,
        timestamp: marketData.timestamp,
      };

      const history = this.priceHistory.get(symbol) || [];
      const previousPrice = history.length > 0 ? history[history.length - 1].close : new Decimal(0);

      history.push(currentPriceData);

      // Keep only necessary history
      const maxHistory = this.config.lookbackPeriod * 2;
      if (history.length > maxHistory) {
        history.splice(0, history.length - maxHistory);
      }

      this.priceHistory.set(symbol, history);

      this.logger.debug(`Updated ${symbol} price: ${previousPrice.toString()} -> ${currentPriceData.close.toString()} (${history.length} points)`);
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to update price history for ${symbol}`);
    }
  }

  /**
   * Initialize price history with historical data from external source
   */
  public initializeWithHistoricalData(
    symbol: string,
    historicalData: PriceData[]
  ): void {
    this.priceHistory.set(symbol, [...historicalData]);
    this.logger.info(
      { symbol, dataPoints: historicalData.length },
      `Initialized ${symbol} with historical data`
    );
  }

  public async generateSignal(symbol: string): Promise<Signal | null> {
    const history = this.priceHistory.get(symbol);
    this.logger.debug(`Price history for ${symbol}: ${history?.length || 0} points, required: ${this.config.lookbackPeriod}`);

    if (!history || history.length < this.config.lookbackPeriod) {
      this.logger.debug(`Insufficient price history for ${symbol}. Have: ${history?.length || 0}, need: ${this.config.lookbackPeriod}`);
      return null;
    }

    // DEFENSIVE: Validate price history quality before analysis
    const historyCheck = HealthCheck.validatePriceHistory(symbol, history, this.config.lookbackPeriod);
    if (!historyCheck.valid) {
      this.logger.error({ symbol, errors: historyCheck.errors }, `Price history validation failed for ${symbol} - skipping signal generation`);
      return null;
    }

    try {
      const resistance = TechnicalIndicators.calculateResistance(
        history,
        this.config.lookbackPeriod
      );
      const support = TechnicalIndicators.calculateSupport(
        history,
        this.config.lookbackPeriod
      );

      const currentPrice = history[history.length - 1].close;

      // DEFENSIVE: Validate support/resistance calculations
      const srCheck = HealthCheck.validateSupportResistance(symbol, support, resistance, currentPrice);
      if (!srCheck.valid) {
        this.logger.error({ symbol, errors: srCheck.errors }, `Support/Resistance validation failed for ${symbol} - skipping signal generation`);
        return null;
      }
      const avgVolume = TechnicalIndicators.calculateAverageVolume(
        history,
        Math.min(20, history.length)
      );

      // CRITICAL: Check trend direction before taking any signal
      const trend = TechnicalIndicators.detectTrend(history, 20, 50);
      const priceStructure = TechnicalIndicators.detectPriceStructure(history, 10);

      // NEW: Check last 10 candles for breakout + volume spike (not just current)
      // This catches violent moves that happen between bot checks
      // Using 10 candles (50 min on 5m chart) to catch moves that happened recently
      const candleLookback = Math.min(10, history.length);
      let breakoutCandle: PriceData | null = null;
      let breakoutType: 'BULLISH' | 'BEARISH' | null = null;

      for (let i = history.length - 1; i >= history.length - candleLookback; i--) {
        const candle = history[i];
        const candleBreakout = TechnicalIndicators.detectBreakout(
          candle.close,
          resistance,
          support,
          this.config.breakoutBuffer
        );
        const candleVolumeSpike = TechnicalIndicators.isVolumeSpike(
          candle.volume,
          avgVolume,
          this.config.volumeMultiplier
        );

        // NEW: Also detect large single-candle moves (>5%) with volume
        // This catches violent dumps/pumps even if they don't "break" S/R
        let largeMoveType: 'BULLISH' | 'BEARISH' | null = null;
        if (i > 0) {
          const prevCandle = history[i - 1];
          const pctChange = candle.close.minus(prevCandle.close).dividedBy(prevCandle.close).times(100);

          if (pctChange.lessThan(-5) && candleVolumeSpike) {
            // >5% drop with volume = bearish violent move
            largeMoveType = 'BEARISH';
            this.logger.debug(`${symbol}: Large BEARISH move detected in candle ${i} - ${pctChange.toFixed(1)}% drop with ${candle.volume.dividedBy(avgVolume).toFixed(1)}x volume`);
          } else if (pctChange.greaterThan(5) && candleVolumeSpike) {
            // >5% pump with volume = bullish violent move
            largeMoveType = 'BULLISH';
            this.logger.debug(`${symbol}: Large BULLISH move detected in candle ${i} - ${pctChange.toFixed(1)}% pump with ${candle.volume.dividedBy(avgVolume).toFixed(1)}x volume`);
          }
        }

        // NEW: Detect cumulative moves over 2-5 candles (slow grinds)
        // This catches gradual moves that don't show up as single-candle spikes
        let cumulativeMoveType: 'BULLISH' | 'BEARISH' | null = null;
        if (i >= 1) {  // Fixed: need i >= 1 to detect 2-candle moves (was i >= 2)
          // Check different window sizes: 2, 3, 4, 5 candles
          for (const windowSize of [2, 3, 4, 5]) {
            if (i >= windowSize - 1) {
              const startIdx = i - windowSize + 1;
              const startCandle = history[startIdx];
              const endCandle = candle;

              // Calculate cumulative % change
              const cumulativeChange = endCandle.close.minus(startCandle.close)
                .dividedBy(startCandle.close)
                .times(100);

              // Calculate average volume across the window
              let totalVolume = new Decimal(0);
              for (let j = startIdx; j <= i; j++) {
                totalVolume = totalVolume.plus(history[j].volume);
              }
              const avgWindowVolume = totalVolume.dividedBy(windowSize);
              const volumeRatio = avgWindowVolume.dividedBy(avgVolume);

              // Detect cumulative grind: 1.75%+ move with decent avg volume (0.2x threshold)
              if (cumulativeChange.lessThan(-1.75) && volumeRatio.greaterThanOrEqualTo(0.2)) {
                cumulativeMoveType = 'BEARISH';
                this.logger.debug(`${symbol}: Cumulative BEARISH grind detected over ${windowSize} candles - ${cumulativeChange.toFixed(1)}% drop with ${volumeRatio.toFixed(2)}x avg volume`);
                break; // Found a signal, stop checking other windows
              } else if (cumulativeChange.greaterThan(1.75) && volumeRatio.greaterThanOrEqualTo(0.2)) {
                cumulativeMoveType = 'BULLISH';
                this.logger.debug(`${symbol}: Cumulative BULLISH grind detected over ${windowSize} candles - ${cumulativeChange.toFixed(1)}% pump with ${volumeRatio.toFixed(2)}x avg volume`);
                break; // Found a signal, stop checking other windows
              }
            }
          }
        }

        this.logger.debug(`${symbol}: Checking candle ${i} - breakout: ${candleBreakout}, large move: ${largeMoveType}, cumulative: ${cumulativeMoveType}, vol spike: ${candleVolumeSpike}, price: ${candle.close.toFixed(2)}, vol: ${candle.volume.dividedBy(avgVolume).toFixed(1)}x`);

        const signalType = candleBreakout || largeMoveType || cumulativeMoveType;

        // Check volume: cumulative moves already validated volume, single-candle moves need volume spike
        const volumeOK = candleVolumeSpike || (cumulativeMoveType !== null);

        // Found a breakout OR large move with volume confirmation in recent candles
        if (signalType && volumeOK) {
          // CRITICAL: Trend alignment logic
          // - Cumulative moves: Allow SIDEWAYS (slow grinds can happen during consolidation)
          // - Breakouts/Large moves: Require strict UPTREND/DOWNTREND (prevent counter-trend bounces)
          let trendAligned = false;

          if (cumulativeMoveType !== null) {
            // Cumulative slow grinds: Allow SIDEWAYS or aligned trend
            trendAligned = (signalType === 'BULLISH' && (trend === 'UPTREND' || trend === 'SIDEWAYS')) ||
                          (signalType === 'BEARISH' && (trend === 'DOWNTREND' || trend === 'SIDEWAYS'));
            this.logger.debug(`${symbol}: Cumulative move ${signalType} in ${trend} market - ${trendAligned ? 'ALLOWED' : 'REJECTED'}`);
          } else {
            // Breakouts and large single-candle moves: Strict trend alignment required
            trendAligned = (signalType === 'BULLISH' && trend === 'UPTREND') ||
                          (signalType === 'BEARISH' && trend === 'DOWNTREND');
            this.logger.debug(`${symbol}: Breakout/large move ${signalType} in ${trend} market - ${trendAligned ? 'ALLOWED' : 'REJECTED'}`);
          }

          if (!trendAligned) {
            this.logger.debug(`${symbol}: ${signalType} signal found in candle ${i} but trend is ${trend} - skipping counter-trend move`);
            continue; // Keep looking for trend-aligned signals
          }

          // For BEARISH: check if trend is still down (current < resistance)
          // For BULLISH: check if trend is still up (current > support)
          if (signalType === 'BULLISH') {
            // Price is still above support = bullish move continuing
            if (currentPrice.greaterThan(support)) {
              breakoutCandle = candle;
              breakoutType = 'BULLISH';
              this.logger.info(`${symbol}: Found BULLISH signal in recent candle (${i}) - price $${candle.close.toFixed(2)}, vol ${candle.volume.dividedBy(avgVolume).toFixed(1)}x, still above support`);
              break;
            }
          } else if (signalType === 'BEARISH') {
            // Price is still below resistance = bearish move continuing
            if (currentPrice.lessThan(resistance)) {
              breakoutCandle = candle;
              breakoutType = 'BEARISH';
              this.logger.info(`${symbol}: Found BEARISH signal in recent candle (${i}) - price $${candle.close.toFixed(2)}, vol ${candle.volume.dividedBy(avgVolume).toFixed(1)}x, still below resistance`);
              break;
            } else {
              this.logger.debug(`${symbol}: BEARISH signal found but price ${currentPrice.toFixed(2)} is above resistance ${resistance.toFixed(2)} - move reversed`);
            }
          }
        }
      }

      const breakout = breakoutType;
      const volumeSpike = breakoutCandle !== null;

      this.logger.debug(`${symbol} analysis:` + JSON.stringify({
        currentPrice: currentPrice.toString(),
        resistance: resistance.toString(),
        support: support.toString(),
        avgVolume: avgVolume.toString(),
        volumeMultiplier: this.config.volumeMultiplier,
        volumeSpike,
        breakout,
        trend,
        priceStructure,
        breakoutBuffer: this.config.breakoutBuffer,
        recentCandlesChecked: candleLookback
      }));

      // Only take signals that align with the trend
      if (breakout && volumeSpike && breakoutCandle) {
        // BULLISH breakout: Only if we're in an UPTREND
        if (breakout === 'BULLISH' && trend === 'DOWNTREND') {
          this.logger.info(`${symbol}: BULLISH breakout REJECTED - trend is ${trend}, not UPTREND`);
          return null;
        }

        // BEARISH breakout: Only if we're in a DOWNTREND
        if (breakout === 'BEARISH' && trend === 'UPTREND') {
          this.logger.info(`${symbol}: BEARISH breakout REJECTED - trend is ${trend}, not DOWNTREND`);
          return null;
        }

        // Additional confirmation: price structure should match trend
        if (breakout === 'BULLISH' && priceStructure === 'LOWER_LOWS') {
          this.logger.info(`${symbol}: BULLISH breakout REJECTED - price structure shows LOWER_LOWS`);
          return null;
        }

        if (breakout === 'BEARISH' && priceStructure === 'HIGHER_HIGHS') {
          this.logger.info(`${symbol}: BEARISH breakout REJECTED - price structure shows HIGHER_HIGHS`);
          return null;
        }
        const side = breakout === 'BULLISH' ? OrderSide.BUY : OrderSide.SELL;

        // Use current price for entry (we're entering now, not at the breakout candle)
        // But increase confidence if we found the breakout in a recent candle
        const entryPrice = currentPrice;
        const stopLoss =
          breakout === 'BULLISH'
            ? entryPrice.times(1 - this.config.trailingStopPercent / 100)
            : entryPrice.times(1 + this.config.trailingStopPercent / 100);

        // Calculate RSI for additional confirmation
        const rsi = TechnicalIndicators.calculateRSI(history);

        // CRITICAL RSI FILTER: Prevent counter-trend entries at extreme levels
        // ASYMMETRIC THRESHOLDS (oversold bounces more reliable than overbought reversals):
        // - Don't SHORT when RSI < 30 (too oversold, high bounce risk)
        // - Don't LONG when RSI > 80 (extremely overbought, allow strong uptrends up to 80)
        if (breakout === 'BEARISH' && rsi.lessThan(30)) {
          this.logger.info(`${symbol}: BEARISH signal REJECTED - RSI ${rsi.toFixed(2)} is too oversold (< 30), high bounce risk`);
          return null;
        }
        if (breakout === 'BULLISH' && rsi.greaterThan(80)) {
          this.logger.info(`${symbol}: BULLISH signal REJECTED - RSI ${rsi.toFixed(2)} is extremely overbought (> 80), high reversal risk`);
          return null;
        }

        let confidence = 0.5;

        if (breakout === 'BULLISH' && rsi.lessThan(70)) {
          confidence = 0.7;
        } else if (breakout === 'BEARISH' && rsi.greaterThan(30)) {
          confidence = 0.7;
        }

        // Check ATR for volatility confirmation
        const atr = TechnicalIndicators.calculateATR(history, Math.min(14, history.length - 1));
        const atrPercent = atr.dividedBy(entryPrice).times(100);

        if (atrPercent.greaterThan(1)) {
          confidence += 0.1;
        }

        // Calculate take profit if configured
        let takeProfit: Decimal | undefined;
        if (this.config.takeProfitPercent) {
          takeProfit = breakout === 'BULLISH'
            ? entryPrice.times(1 + this.config.takeProfitPercent / 100)
            : entryPrice.times(1 - this.config.takeProfitPercent / 100);
        }

        // Increase confidence for trend-aligned trades
        if (breakout === 'BULLISH' && priceStructure === 'HIGHER_HIGHS') {
          confidence += 0.1;
        } else if (breakout === 'BEARISH' && priceStructure === 'LOWER_LOWS') {
          confidence += 0.1;
        }

        // Higher confidence if breakout was recent (found in last 5 candles)
        confidence += 0.1;

        const signal: Signal = {
          symbol,
          side,
          entryPrice,
          stopLoss,
          takeProfit,
          confidence,
          reason: `${breakout} breakout (recent candle) in ${trend}, ${priceStructure} structure, vol spike, RSI: ${rsi.toFixed(2)}`,
        };

        this.logger.info({ signal }, `✅ TREND-ALIGNED Signal generated for ${symbol}: ${side} in ${trend} (multi-candle detection)`);
        return signal;
      }

      // Check for scalping opportunities if enabled
      if (this.config.useScalping && history.length >= 20) {
        const bollinger = TechnicalIndicators.calculateBollingerBands(
          history.map((h) => h.close),
          Math.min(20, history.length),
          2
        );

        if (currentPrice.lessThan(bollinger.lower)) {
          return {
            symbol,
            side: OrderSide.BUY,
            entryPrice: currentPrice,
            stopLoss: currentPrice.times(0.98),
            confidence: 0.4,
            reason: 'Scalp: Price below lower Bollinger Band',
          };
        } else if (currentPrice.greaterThan(bollinger.upper)) {
          return {
            symbol,
            side: OrderSide.SELL,
            entryPrice: currentPrice,
            stopLoss: currentPrice.times(1.02),
            confidence: 0.4,
            reason: 'Scalp: Price above upper Bollinger Band',
          };
        }
      }

      // TREND FOLLOWING: Check for slow grind opportunities (if enabled)
      if (config.enableTrendFollowing) {
        const trendFollowingSignal = this.generateTrendFollowingSignal(
          symbol,
          history,
          currentPrice,
          trend,
          priceStructure,
          avgVolume
        );
        if (trendFollowingSignal) {
          return trendFollowingSignal;
        }
      }

      return null;
    } catch (error) {
      this.logger.error({
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack
        } : error,
        symbol
      }, `Failed to generate signal for ${symbol}`);
      return null;
    }
  }

  /**
   * Update trend history for consecutive trend tracking
   */
  private updateTrendHistory(symbol: string, trend: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS'): void {
    const history = this.trendHistory.get(symbol) || [];
    history.push(trend);

    // Keep only last 10 trend readings (enough for tracking)
    if (history.length > 10) {
      history.shift();
    }

    this.trendHistory.set(symbol, history);
  }

  /**
   * Check if trend has been consistent for N consecutive checks
   */
  private hasConsecutiveTrend(
    symbol: string,
    expectedTrend: 'UPTREND' | 'DOWNTREND',
    minConsecutive: number
  ): boolean {
    const history = this.trendHistory.get(symbol) || [];

    if (history.length < minConsecutive) {
      return false;
    }

    // Check last N readings
    const recent = history.slice(-minConsecutive);
    return recent.every(t => t === expectedTrend);
  }

  /**
   * Generate trend-following signal for slow grinds
   * This catches gradual moves that don't trigger breakout signals
   */
  private generateTrendFollowingSignal(
    symbol: string,
    history: PriceData[],
    currentPrice: Decimal,
    trend: 'UPTREND' | 'DOWNTREND' | 'SIDEWAYS',
    priceStructure: 'HIGHER_HIGHS' | 'LOWER_LOWS' | 'CHOPPY',
    avgVolume: Decimal
  ): Signal | null {
    try {
      // Update trend history for this symbol
      this.updateTrendHistory(symbol, trend);

      // Get consecutive trend requirements from config
      const minConsecutive = config.trendFollowingMinConsecutiveTrends;
      const smaPeriod = config.trendFollowingSmaPeriod;
      const maxDistanceFromHigh = config.trendFollowingMaxDistanceFromHigh / 100; // Convert % to decimal

      // Need enough price history for SMA
      if (history.length < smaPeriod) {
        return null;
      }

      // Calculate SMA for price confirmation
      const closePrices = history.map(h => h.close);
      const sma = TechnicalIndicators.calculateSMA(closePrices, smaPeriod);

      // Check current volume (need some activity, not dead market)
      const currentVolume = history[history.length - 1].volume;
      const volumeRatio = currentVolume.dividedBy(avgVolume);

      // Minimum volume threshold (0.5x average - catches slow bleeds)
      if (volumeRatio.lessThan(this.config.volumeMultiplier)) {
        return null;
      }

      // Calculate recent high/low for distance check
      const recentPrices = history.slice(-smaPeriod);
      const recentHigh = Decimal.max(...recentPrices.map(p => p.high));
      const recentLow = Decimal.min(...recentPrices.map(p => p.low));

      // SHORT SIGNAL: Consistent DOWNTREND + price below SMA + within % of recent high
      if (this.hasConsecutiveTrend(symbol, 'DOWNTREND', minConsecutive)) {
        // Price must be below SMA (confirming downtrend)
        if (currentPrice.lessThan(sma)) {
          // Price must be within X% of recent high (not too deep in the move already)
          const distanceFromHigh = recentHigh.minus(currentPrice).dividedBy(recentHigh);

          if (distanceFromHigh.lessThanOrEqualTo(maxDistanceFromHigh)) {
            // Additional confirmation: price structure should show LOWER_LOWS
            if (priceStructure === 'LOWER_LOWS') {
              const entryPrice = currentPrice;
              const stopLoss = entryPrice.times(1 + this.config.trailingStopPercent / 100);

              // Calculate RSI for filtering
              const rsi = TechnicalIndicators.calculateRSI(history);

              // Don't SHORT at extreme oversold (< 30)
              if (rsi.lessThan(30)) {
                this.logger.debug(`${symbol}: TREND-FOLLOWING SHORT rejected - RSI ${rsi.toFixed(2)} too oversold`);
                return null;
              }

              let takeProfit: Decimal | undefined;
              if (this.config.takeProfitPercent) {
                takeProfit = entryPrice.times(1 - this.config.takeProfitPercent / 100);
              }

              const signal: Signal = {
                symbol,
                side: OrderSide.SELL,
                entryPrice,
                stopLoss,
                takeProfit,
                confidence: 0.65, // Lower confidence than breakouts
                reason: `TREND-FOLLOWING SHORT: ${minConsecutive} consecutive DOWNTREND checks, price < SMA(${smaPeriod}), LOWER_LOWS structure, ${distanceFromHigh.times(100).toFixed(1)}% from high, RSI: ${rsi.toFixed(2)}`,
              };

              this.logger.info({ signal }, `📉 TREND-FOLLOWING SHORT signal for ${symbol} (slow bleed)`);
              return signal;
            }
          }
        }
      }

      // LONG SIGNAL: Consistent UPTREND + price above SMA + within % of recent low
      if (this.hasConsecutiveTrend(symbol, 'UPTREND', minConsecutive)) {
        // Price must be above SMA (confirming uptrend)
        if (currentPrice.greaterThan(sma)) {
          // Price must be within X% of recent low (not too high in the move already)
          const distanceFromLow = currentPrice.minus(recentLow).dividedBy(recentLow);

          if (distanceFromLow.lessThanOrEqualTo(maxDistanceFromHigh)) {
            // Additional confirmation: price structure should show HIGHER_HIGHS
            if (priceStructure === 'HIGHER_HIGHS') {
              const entryPrice = currentPrice;
              const stopLoss = entryPrice.times(1 - this.config.trailingStopPercent / 100);

              // Calculate RSI for filtering
              const rsi = TechnicalIndicators.calculateRSI(history);

              // Don't LONG at extreme overbought (> 80)
              if (rsi.greaterThan(80)) {
                this.logger.debug(`${symbol}: TREND-FOLLOWING LONG rejected - RSI ${rsi.toFixed(2)} too overbought`);
                return null;
              }

              let takeProfit: Decimal | undefined;
              if (this.config.takeProfitPercent) {
                takeProfit = entryPrice.times(1 + this.config.takeProfitPercent / 100);
              }

              const signal: Signal = {
                symbol,
                side: OrderSide.BUY,
                entryPrice,
                stopLoss,
                takeProfit,
                confidence: 0.65, // Lower confidence than breakouts
                reason: `TREND-FOLLOWING LONG: ${minConsecutive} consecutive UPTREND checks, price > SMA(${smaPeriod}), HIGHER_HIGHS structure, ${distanceFromLow.times(100).toFixed(1)}% from low, RSI: ${rsi.toFixed(2)}`,
              };

              this.logger.info({ signal }, `📈 TREND-FOLLOWING LONG signal for ${symbol} (slow grind up)`);
              return signal;
            }
          }
        }
      }

      return null;
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to generate trend-following signal for ${symbol}`);
      return null;
    }
  }

  public async executeSignal(signal: Signal, customQuantity?: Decimal): Promise<void> {
    try {
      this.logger.info(`Executing signal for ${signal.symbol}: ${signal.side} @ ${signal.entryPrice}`);

      // Validate signal has all required fields
      if (!signal.entryPrice || !signal.stopLoss) {
        this.logger.error({ signal }, 'Invalid signal - missing required fields');
        return;
      }

      // Convert USD position size to coin quantity
      // positionSize is in USD, need to convert to coin units based on entry price
      let quantity: Decimal;
      if (customQuantity) {
        quantity = customQuantity;
      } else {
        const positionSizeUSD = new Decimal(this.config.positionSize);
        quantity = positionSizeUSD.dividedBy(signal.entryPrice);
        this.logger.info(`Position sizing: $${positionSizeUSD.toString()} / $${signal.entryPrice.toString()} = ${quantity.toString()} ${signal.symbol}`);
      }

      // Execute market order
      // Place market order (entry only)
      const order = await this.client.addOrder(
        signal.symbol,
        signal.side,
        quantity,
        OrderType.MARKET
      );

      this.logger.info(`Market order executed: ${order.id} for ${signal.symbol}`);

      // Send Telegram notification
      if (this.telegram) {
        await this.telegram.notifyPositionOpened(
          signal.symbol,
          signal.side,
          quantity.toString(),
          signal.entryPrice,
          signal.stopLoss,
          signal.takeProfit,
          signal.reason
        );
      }

      // Place separate LIMIT order for take profit
      if (signal.takeProfit) {
        try {
          const tpSide = signal.side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;

          // Round TP price to proper increment
          const tpPrice = this.roundToIncrement(signal.takeProfit, signal.symbol);

          const tpOrder = await this.client.addOrder(
            signal.symbol,
            tpSide,
            quantity,
            OrderType.LIMIT,
            tpPrice
          );
          this.logger.info(`Take profit order placed: ${tpOrder.id} at ${tpPrice.toString()}`);
        } catch (tpError) {
          this.logger.error({ error: tpError }, `Failed to place take profit order for ${signal.symbol}`);
        }
      }

      // NOTE: Enclave does not support STOP orders, using bot-monitored trailing stops only
      this.logger.info(`  - Stop Loss: ${signal.stopLoss.toString()} (bot-monitored trailing stop)`);
      if (signal.takeProfit) {
        this.logger.info(`  - Take Profit: ${signal.takeProfit.toString()} (LIMIT order placed)`);
      }

      this.activeSignals.set(signal.symbol, signal);

      // Initialize trailing stop for monitoring
      if (signal.side === OrderSide.BUY) {
        this.trailingStops.set(signal.symbol, {
          high: signal.entryPrice,
          stop: signal.stopLoss,
        });
      } else {
        // For shorts, track the "low" as high, and stop above current price
        this.trailingStops.set(signal.symbol, {
          high: signal.entryPrice, // This represents the lowest price for shorts
          stop: signal.stopLoss,
        });
      }

    } catch (error) {
      this.logger.error({ error, signal }, `Failed to execute signal for ${signal.symbol}`);
    }
  }

  public async updateTrailingStops(symbol: string): Promise<void> {
    const trailing = this.trailingStops.get(symbol);
    const signal = this.activeSignals.get(symbol);

    if (!trailing || !signal) {
      return;
    }

    try {
      // Get fresh position data for accurate current price and P&L
      const positions = await this.client.getPositions();
      const position = positions.find(p => p.symbol === symbol);

      if (!position) {
        // Position no longer exists, clean up tracking
        this.activeSignals.delete(symbol);
        this.trailingStops.delete(symbol);
        return;
      }

      // Use real position mark price for accurate stop loss calculations
      const currentPrice = position.markPrice || position.entryPrice;

      if (signal.side === OrderSide.BUY) {
        // Long position: trail stop upward
        if (currentPrice.greaterThan(trailing.high)) {
          const newHigh = currentPrice;
          const newStop = newHigh.times(1 - this.config.trailingStopPercent / 100);

          if (newStop.greaterThan(trailing.stop)) {
            this.trailingStops.set(symbol, {
              high: newHigh,
              stop: newStop,
            });

            this.logger.info(
              `Updated trailing stop for ${symbol}: ${newStop.toFixed(2)} (high: ${newHigh.toFixed(2)})`
            );

            // NOTE: Not updating exchange STOP order (Enclave doesn't support them)
          }
        }

        // Check if stop hit (use < not <=)
        if (currentPrice.lessThan(trailing.stop)) {
          await this.closePosition(symbol, 'Stop Loss Hit');
        }

        // Check if take profit hit (use > not >=)
        if (signal.takeProfit && currentPrice.greaterThan(signal.takeProfit)) {
          await this.closePosition(symbol, 'Take Profit Hit');
        }
      } else {
        // Short position: trail stop downward
        if (currentPrice.lessThan(trailing.high)) {
          const newLow = currentPrice;
          const newStop = newLow.times(1 + this.config.trailingStopPercent / 100);

          if (newStop.lessThan(trailing.stop)) {
            this.trailingStops.set(symbol, {
              high: newLow,
              stop: newStop,
            });

            this.logger.info(
              `Updated trailing stop for ${symbol}: ${newStop.toFixed(2)} (low: ${newLow.toFixed(2)})`
            );

            // NOTE: Not updating exchange STOP order (Enclave doesn't support them)
          }
        }

        // Check if stop hit (use > not >=)
        if (currentPrice.greaterThan(trailing.stop)) {
          await this.closePosition(symbol, 'Stop Loss Hit');
        }

        // Check if take profit hit (use < not <=)
        if (signal.takeProfit && currentPrice.lessThan(signal.takeProfit)) {
          await this.closePosition(symbol, 'Take Profit Hit');
        }
      }
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to update trailing stop for ${symbol}`);
    }
  }

  private async closePosition(symbol: string, reason: string = 'Manual Close'): Promise<void> {
    try {
      const signal = this.activeSignals.get(symbol);
      if (!signal) {
        return;
      }

      // Cancel all open orders for this symbol FIRST
      try {
        const openOrders = await this.client.getOpenOrders(symbol);
        for (const order of openOrders) {
          await this.client.cancelOrder(order.id);
          this.logger.info(`Cancelled order ${order.id} for ${symbol} (type: ${order.type}, side: ${order.side})`);
        }
      } catch (orderError) {
        this.logger.warn({ error: orderError, symbol }, `Failed to cancel some orders for ${symbol} - continuing with position close`);
      }

      const positions = await this.client.getPositions();
      const position = positions.find((p) => p.symbol === symbol);

      if (position) {
        const closeSide = position.side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
        const closePrice = position.markPrice || position.entryPrice;
        const pnl = position.realizedPnl ? position.realizedPnl.toNumber() : 0;

        await this.client.addOrder(
          symbol,
          closeSide,
          position.quantity,
          OrderType.MARKET
        );

        this.logger.info(`Position closed for ${symbol}: ${reason} at ${this.trailingStops.get(symbol)?.stop}`);

        // Send Telegram notification
        if (this.telegram) {
          await this.telegram.notifyPositionClosed(
            symbol,
            position.side,
            closePrice,
            pnl,
            reason
          );
        }
      }

      this.activeSignals.delete(symbol);
      this.trailingStops.delete(symbol);
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to close position for ${symbol}`);
    }
  }

  public getActiveSignals(): Map<string, Signal> {
    return this.activeSignals;
  }

  public async registerExistingPosition(symbol: string, side: OrderSide, entryPrice: Decimal, quantity: Decimal): Promise<void> {
    // Create a signal for the existing position
    const signal: Signal = {
      symbol,
      side,
      entryPrice,
      stopLoss: side === OrderSide.BUY
        ? entryPrice.times(1 - this.config.trailingStopPercent / 100)
        : entryPrice.times(1 + this.config.trailingStopPercent / 100),
      takeProfit: this.config.takeProfitPercent
        ? (side === OrderSide.BUY
            ? entryPrice.times(1 + this.config.takeProfitPercent / 100)
            : entryPrice.times(1 - this.config.takeProfitPercent / 100))
        : undefined,
      confidence: 1.0,
      reason: 'Existing position on restart',
    };

    this.activeSignals.set(symbol, signal);

    // Initialize trailing stop at entry price
    this.trailingStops.set(symbol, {
      high: entryPrice,
      stop: signal.stopLoss,
    });

    // Cancel any existing orders for this symbol first
    try {
      const existingOrders = await this.client.getOpenOrders(symbol);
      for (const order of existingOrders) {
        await this.client.cancelOrder(order.id);
        this.logger.info(`Cancelled existing order: ${order.id} for ${symbol}`);
      }
    } catch (error) {
      this.logger.warn({ error }, `Failed to cancel existing orders for ${symbol}`);
    }

    // Place protective orders for existing position
    try {
      // NOTE: Enclave doesn't support STOP orders, using bot-monitored stops only
      this.logger.info(`Using bot-monitored trailing stop at ${signal.stopLoss.toString()} for existing position`);

      // Place take profit order if configured
      if (signal.takeProfit) {
        const tpSide = side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
        const tpPrice = this.roundToIncrement(signal.takeProfit, symbol);
        const tpOrder = await this.client.addOrder(
          symbol,
          tpSide,
          quantity,
          OrderType.LIMIT,
          tpPrice
        );
        this.logger.info(`Take profit order placed for existing position: ${tpOrder.id} at ${tpPrice.toString()}`);
      }
    } catch (error) {
      this.logger.error({ error }, `Failed to place protective orders for existing position ${symbol}`);
    }

    this.logger.info(`Registered existing position: ${symbol} ${side} @ ${entryPrice.toString()}, TP: ${signal.takeProfit?.toString() || 'none'}, SL: ${signal.stopLoss.toString()}`);
  }

  public clearHistory(): void {
    this.priceHistory.clear();
    this.activeSignals.clear();
    this.trailingStops.clear();
  }
}