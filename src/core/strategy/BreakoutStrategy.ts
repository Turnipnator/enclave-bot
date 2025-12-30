import Decimal from 'decimal.js';
import pino from 'pino';
import * as fs from 'fs';
import * as path from 'path';
import { EnclaveClient } from '../exchange/EnclaveClient';
import { OrderSide, OrderType } from '../exchange/types';
import { TechnicalIndicators, PriceData } from '../indicators/TechnicalIndicators';
import { config } from '../../config/config';
import { TelegramService } from '../../services/telegram/TelegramService';

// Persisted trailing stop state interface
interface PersistedTrailingStop {
  high: string;
  stop: string;
  partialProfitTaken: boolean;
  updatedAt: string;
}

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
  // Loss Cooldown: Prevent revenge trading after stop loss hits
  // Winners can re-enter immediately (momentum continuation)
  private lossCooldowns: Map<string, number> = new Map(); // symbol -> timestamp when loss occurred
  // Failed Signal Cooldown: Prevent spam when order execution fails
  private failedSignalCooldowns: Map<string, number> = new Map(); // symbol -> timestamp when order failed
  private readonly FAILED_SIGNAL_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes cooldown on failed orders
  // Trailing Stop Health Monitoring: Track last successful check to detect failures
  private lastTrailingStopCheck: Map<string, number> = new Map(); // symbol -> timestamp
  private trailingStopFailureAlerted = false; // Prevent spam alerts
  // Track when positions were opened to avoid false alerts on new positions
  private positionOpenedAt: Map<string, number> = new Map(); // symbol -> timestamp
  private readonly NEW_POSITION_GRACE_PERIOD_MS = 30 * 1000; // 30 second grace period for new positions

  // =============================================================================
  // MOMENTUM STRATEGY PARAMETERS (from winning Binance bot - 13/13 wins!)
  // =============================================================================
  // Core philosophy: Don't be greedy. Lock in small profits quickly and re-enter
  // if conditions remain favorable. "Rinse and repeat" approach.
  // =============================================================================

  private partialProfitTaken: Map<string, boolean> = new Map(); // symbol -> has taken profit

  // Take Profit: 1.3% - small enough to hit frequently, large enough to cover fees
  private readonly TAKE_PROFIT_THRESHOLD = 1.3;
  private readonly TAKE_PROFIT_CLOSE_PERCENT = 100; // Close 100% of position (full exit)

  // Stop Loss: 5% - wide enough to survive noise, tight enough to limit damage
  // With our strict entry filters (0.60+ momentum), stops rarely get hit
  private readonly STOP_LOSS_PERCENT = 5;

  // Momentum Score: Only enter on strong signals (0.60+)
  // Below 0.50 = weak/neutral (too risky)
  // 0.50-0.59 = moderate (still too risky)
  // 0.60-0.69 = strong (our entry zone)
  // 0.70+ = very strong (excellent entry)
  private readonly MOMENTUM_THRESHOLD = 0.60;

  // Volume Confirmation: 1.5x average minimum
  private readonly VOLUME_MULTIPLIER = 1.5;

  // Cooldown: 20 minutes AFTER LOSSES ONLY (winners can re-enter immediately)
  private readonly LOSS_COOLDOWN_MS = 20 * 60 * 1000; // 20 minutes

  // Trailing Stop Persistence: File path for persisting trailing stop state across restarts
  private readonly TRAILING_STOPS_FILE = path.join(process.cwd(), 'data', 'trailing_stops.json');

  constructor(client: EnclaveClient, strategyConfig: BreakoutConfig, telegram?: TelegramService) {
    this.client = client;
    this.config = strategyConfig;
    this.telegram = telegram;
    this.logger = pino({ name: 'BreakoutStrategy', level: config.logLevel });

    // Load persisted trailing stops on startup
    this.loadTrailingStops();
  }

  /**
   * Save trailing stop state to disk for persistence across restarts
   */
  private saveTrailingStops(): void {
    try {
      const dataDir = path.dirname(this.TRAILING_STOPS_FILE);
      if (!fs.existsSync(dataDir)) {
        fs.mkdirSync(dataDir, { recursive: true });
      }

      const state: Record<string, PersistedTrailingStop> = {};
      this.trailingStops.forEach((value, symbol) => {
        state[symbol] = {
          high: value.high.toString(),
          stop: value.stop.toString(),
          partialProfitTaken: this.partialProfitTaken.get(symbol) || false,
          updatedAt: new Date().toISOString(),
        };
      });

      fs.writeFileSync(this.TRAILING_STOPS_FILE, JSON.stringify(state, null, 2));
      this.logger.debug(`Saved trailing stops to disk: ${Object.keys(state).length} positions`);
    } catch (error) {
      this.logger.error({ error }, 'Failed to save trailing stops to disk');
    }
  }

  /**
   * Load trailing stop state from disk on startup
   */
  private loadTrailingStops(): void {
    try {
      if (!fs.existsSync(this.TRAILING_STOPS_FILE)) {
        this.logger.info('No persisted trailing stops found - starting fresh');
        return;
      }

      const data = fs.readFileSync(this.TRAILING_STOPS_FILE, 'utf-8');
      const state: Record<string, PersistedTrailingStop> = JSON.parse(data);

      for (const [symbol, value] of Object.entries(state)) {
        this.trailingStops.set(symbol, {
          high: new Decimal(value.high),
          stop: new Decimal(value.stop),
        });
        // Restore partial profit taken state
        if (value.partialProfitTaken) {
          this.partialProfitTaken.set(symbol, true);
          this.logger.info(`📁 Loaded persisted trailing stop for ${symbol}: high=${value.high}, stop=${value.stop}, partialTaken=YES`);
        } else {
          this.logger.info(`📁 Loaded persisted trailing stop for ${symbol}: high=${value.high}, stop=${value.stop}, partialTaken=NO`);
        }
      }

      this.logger.info(`Loaded ${Object.keys(state).length} trailing stops from disk`);
    } catch (error) {
      this.logger.error({ error }, 'Failed to load trailing stops from disk - starting fresh');
    }
  }

  /**
   * Remove a trailing stop from persistence (when position is closed)
   */
  private removePersistedTrailingStop(symbol: string): void {
    this.trailingStops.delete(symbol);
    this.saveTrailingStops();
  }

  /**
   * Get stop loss percentage - fixed 2% for all pairs (scalping mode)
   * Previous tiered system was 6-10% based on volatility, now using tight stops
   */
  private getTrailingStopPercent(_symbol: string): number {
    return this.STOP_LOSS_PERCENT; // Fixed 2% for all pairs
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
    } else if (symbol === 'ARENA-USD.P') {
      increment = 0.000001; // 6 decimal places
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

  /**
   * Round quantity to market's minimum size increment
   * Returns null if the quantity rounds to 0 (too small to trade)
   */
  private roundToSizeIncrement(quantity: Decimal, symbol: string): Decimal | null {
    let increment: number;

    // Size increments from Enclave API /v1/markets
    // Note: Most markets require whole number quantities
    if (symbol === 'BTC-USD.P') {
      increment = 0.001; // 3 decimal places
    } else if (symbol === 'ETH-USD.P') {
      increment = 0.01; // 2 decimal places
    } else if (symbol === 'SOL-USD.P') {
      increment = 0.1; // 1 decimal place
    } else if (symbol === 'AVAX-USD.P') {
      increment = 1; // Whole numbers
    } else if (symbol === 'XRP-USD.P') {
      increment = 1; // Whole numbers
    } else if (symbol === 'BNB-USD.P') {
      increment = 0.01; // 2 decimal places
    } else if (symbol === 'DOGE-USD.P') {
      increment = 1; // Whole numbers
    } else if (symbol === 'LINK-USD.P') {
      increment = 0.1; // 1 decimal place
    } else if (symbol === 'SUI-USD.P') {
      increment = 1; // Whole numbers
    } else if (symbol === 'ARENA-USD.P') {
      increment = 1; // Whole numbers
    } else if (symbol === 'HYPE-USD.P') {
      increment = 0.1; // 1 decimal place
    } else if (symbol === 'NXP-USD.P') {
      increment = 1; // Whole numbers
    } else if (symbol === 'TON-USD.P') {
      increment = 0.1; // 1 decimal place
    } else if (symbol === 'ADA-USD.P') {
      increment = 1; // Whole numbers
    } else {
      increment = 1; // Default to whole numbers for safety
    }

    const qtyNumber = quantity.toNumber();
    const rounded = Math.floor(qtyNumber / increment) * increment; // Use floor to avoid over-sizing

    if (rounded <= 0) {
      this.logger.warn(`${symbol}: Quantity ${qtyNumber} rounds to 0 with increment ${increment} - too small to trade`);
      return null;
    }

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

    // Need 200 candles for full EMA stack (EMA200)
    const minRequired = 200;
    if (!history || history.length < minRequired) {
      this.logger.debug(`Insufficient price history for ${symbol}. Have: ${history?.length || 0}, need: ${minRequired}`);
      return null;
    }

    // CRITICAL: Check if we already have an active position/signal for this symbol
    if (this.activeSignals.has(symbol)) {
      this.logger.debug(`Already have active signal for ${symbol} - skipping`);
      return null;
    }

    // Check loss cooldown - prevent revenge trading after stops
    // NOTE: Winners can re-enter immediately (no cooldown on wins)
    const cooldownTimestamp = this.lossCooldowns.get(symbol);
    if (cooldownTimestamp) {
      const timeElapsed = Date.now() - cooldownTimestamp;
      if (timeElapsed < this.LOSS_COOLDOWN_MS) {
        const minutesRemaining = Math.ceil((this.LOSS_COOLDOWN_MS - timeElapsed) / 60000);
        this.logger.info(`⏱️  ${symbol} BLOCKED by loss cooldown - ${minutesRemaining} min remaining`);
        return null;
      } else {
        // Cooldown expired, remove it
        this.lossCooldowns.delete(symbol);
        this.logger.info(`✅ Loss cooldown expired for ${symbol} - can trade again`);
      }
    }

    // Check failed signal cooldown - prevent spam when orders keep failing
    const failedCooldown = this.failedSignalCooldowns.get(symbol);
    if (failedCooldown) {
      const timeElapsed = Date.now() - failedCooldown;
      if (timeElapsed < this.FAILED_SIGNAL_COOLDOWN_MS) {
        const minutesRemaining = Math.ceil((this.FAILED_SIGNAL_COOLDOWN_MS - timeElapsed) / 60000);
        this.logger.debug(`⏱️  ${symbol} BLOCKED by failed signal cooldown - ${minutesRemaining} min remaining`);
        return null;
      } else {
        // Cooldown expired, remove it
        this.failedSignalCooldowns.delete(symbol);
        this.logger.info(`✅ Failed signal cooldown expired for ${symbol} - can retry`);
      }
    }

    try {
      const closePrices = history.map(p => p.close);
      const currentPrice = closePrices[closePrices.length - 1];

      // Use second-to-last candle for volume (last candle is incomplete/partial)
      // The most recent candle from Binance is still accumulating volume mid-candle
      const lastCompleteCandle = history[history.length - 2];
      const lastCompleteVolume = lastCompleteCandle.volume;

      // =========================================================================
      // STEP 1: TREND DETECTION (EMA Stack)
      // BULLISH: EMA20 > EMA50 > EMA200 = go LONG
      // BEARISH: EMA20 < EMA50 < EMA200 = go SHORT
      // SIDEWAYS: Mixed alignment = NO TRADE (chops you up)
      // =========================================================================
      const emaStackTrend = TechnicalIndicators.detectEMAStack(closePrices);

      if (emaStackTrend === 'SIDEWAYS') {
        this.logger.debug(`${symbol}: EMA stack is SIDEWAYS - no trade (choppy market)`);
        return null;
      }

      const direction = emaStackTrend === 'BULLISH' ? 'LONG' : 'SHORT';

      // =========================================================================
      // STEP 2: VOLUME CONFIRMATION (1.5x average)
      // No volume = no conviction = no trade
      // Using second-to-last candle (complete) vs average of complete candles
      // =========================================================================
      const avgVolume = TechnicalIndicators.calculateAverageVolume(
        history.slice(0, -1), // Exclude incomplete last candle from average
        20
      );
      const volumeRatio = lastCompleteVolume.dividedBy(avgVolume);

      if (volumeRatio.lessThan(this.VOLUME_MULTIPLIER)) {
        this.logger.debug(`${symbol}: Volume ${volumeRatio.toFixed(2)}x below ${this.VOLUME_MULTIPLIER}x threshold - no trade`);
        return null;
      }

      // =========================================================================
      // STEP 3: MOMENTUM SCORE (>= 0.60 required)
      // Composite of RSI, MACD, EMAs, Bollinger, Stochastic
      // =========================================================================
      const { score, components } = TechnicalIndicators.calculateMomentumScore(history, direction);

      this.logger.debug(`${symbol} momentum: ${score.toFixed(2)} (${direction}) - RSI:${components.rsi?.toFixed(2)}, MACD:${components.macd?.toFixed(2)}, EMA:${components.ema?.toFixed(2)}, BB:${components.bollinger?.toFixed(2)}, Stoch:${components.stochastic?.toFixed(2)}`);

      if (score.lessThan(this.MOMENTUM_THRESHOLD)) {
        this.logger.debug(`${symbol}: Momentum ${score.toFixed(2)} below ${this.MOMENTUM_THRESHOLD} threshold - no trade`);
        return null;
      }

      // =========================================================================
      // STEP 4: PRICE STRUCTURE CONFIRMATION
      // Don't go LONG in LOWER_LOWS, don't go SHORT in HIGHER_HIGHS
      // =========================================================================
      const priceStructure = TechnicalIndicators.detectPriceStructure(history, 10);

      if (direction === 'LONG' && priceStructure === 'LOWER_LOWS') {
        this.logger.info(`${symbol}: ${direction} signal REJECTED - price structure shows LOWER_LOWS`);
        return null;
      }

      if (direction === 'SHORT' && priceStructure === 'HIGHER_HIGHS') {
        this.logger.info(`${symbol}: ${direction} signal REJECTED - price structure shows HIGHER_HIGHS`);
        return null;
      }

      if (priceStructure === 'CHOPPY') {
        this.logger.info(`${symbol}: ${direction} signal REJECTED - market structure is CHOPPY`);
        return null;
      }

      // =========================================================================
      // STEP 5: GENERATE SIGNAL
      // All filters passed - this is a high-quality entry!
      // =========================================================================
      const side = direction === 'LONG' ? OrderSide.BUY : OrderSide.SELL;
      const entryPrice = currentPrice;

      // Stop loss: 5% (wide enough to survive noise)
      const stopLoss = direction === 'LONG'
        ? entryPrice.times(1 - this.STOP_LOSS_PERCENT / 100)
        : entryPrice.times(1 + this.STOP_LOSS_PERCENT / 100);

      // Take profit: 1.3% (lock in small wins quickly)
      const takeProfit = direction === 'LONG'
        ? entryPrice.times(1 + this.TAKE_PROFIT_THRESHOLD / 100)
        : entryPrice.times(1 - this.TAKE_PROFIT_THRESHOLD / 100);

      // Confidence = momentum score (already validated >= 0.60)
      const confidence = score.toNumber();

      const signal: Signal = {
        symbol,
        side,
        entryPrice,
        stopLoss,
        takeProfit,
        confidence,
        reason: `MOMENTUM ${direction}: score=${score.toFixed(2)}, EMA=${emaStackTrend}, vol=${volumeRatio.toFixed(1)}x, structure=${priceStructure}`,
      };

      this.logger.info({ signal, components }, `✅ MOMENTUM Signal generated for ${symbol}: ${side} (score: ${score.toFixed(2)}, vol: ${volumeRatio.toFixed(1)}x)`);

      // NOTE: Telegram notification is sent AFTER successful order execution in executeSignal()
      // This prevents spam when orders fail to execute

      return signal;
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

  public async executeSignal(signal: Signal, customQuantity?: Decimal): Promise<void> {
    try {
      this.logger.info(`Executing signal for ${signal.symbol}: ${signal.side} @ ${signal.entryPrice}`);

      // CRITICAL: Double-check we don't already have a position for this symbol
      if (this.activeSignals.has(signal.symbol)) {
        this.logger.warn(`🚫 BLOCKED: Already have active signal for ${signal.symbol} - preventing duplicate position`);
        return;
      }

      // CRITICAL: Check loss cooldown one more time at execution
      const cooldownTimestamp = this.lossCooldowns.get(signal.symbol);
      if (cooldownTimestamp) {
        const timeElapsed = Date.now() - cooldownTimestamp;
        if (timeElapsed < this.LOSS_COOLDOWN_MS) {
          const minutesRemaining = Math.ceil((this.LOSS_COOLDOWN_MS - timeElapsed) / 60000);
          this.logger.warn(`🚫 BLOCKED: ${signal.symbol} in loss cooldown - ${minutesRemaining} min remaining`);
          return;
        }
      }

      // CRITICAL: Check if position already exists on exchange
      const existingPositions = await this.client.getPositions();
      const existingPosition = existingPositions.find(p => p.symbol === signal.symbol);
      if (existingPosition) {
        this.logger.warn(`🚫 BLOCKED: Position already exists for ${signal.symbol} on exchange - registering it instead`);
        // Register it so we can track it
        await this.registerExistingPosition(signal.symbol, existingPosition.side, existingPosition.entryPrice, existingPosition.quantity);
        return;
      }

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
        const rawQuantity = positionSizeUSD.dividedBy(signal.entryPrice);
        this.logger.info(`Position sizing: $${positionSizeUSD.toString()} / $${signal.entryPrice.toString()} = ${rawQuantity.toString()} ${signal.symbol}`);

        // Round to market's minimum size increment
        const roundedQuantity = this.roundToSizeIncrement(rawQuantity, signal.symbol);
        if (!roundedQuantity) {
          this.logger.warn(`${signal.symbol}: Position size too small after rounding - skipping`);
          return;
        }
        quantity = roundedQuantity;
        this.logger.info(`Rounded quantity to ${quantity.toString()} for ${signal.symbol}`);
      }

      // CRITICAL: Mark signal as pending BEFORE order execution to prevent regeneration spam
      // If order fails, we'll clean this up below
      // Also set positionOpenedAt to prevent health check race condition
      this.activeSignals.set(signal.symbol, signal);
      this.positionOpenedAt.set(signal.symbol, Date.now());

      // Execute market order
      // Place market order (entry only)
      let order;
      try {
        order = await this.client.addOrder(
          signal.symbol,
          signal.side,
          quantity,
          OrderType.MARKET
        );
      } catch (orderError) {
        // Order failed - remove from active signals and add cooldown to prevent spam
        this.activeSignals.delete(signal.symbol);
        this.positionOpenedAt.delete(signal.symbol); // Clean up to prevent stale state
        this.failedSignalCooldowns.set(signal.symbol, Date.now());
        this.logger.error({ error: orderError, signal }, `Order execution failed for ${signal.symbol} - cooldown for ${this.FAILED_SIGNAL_COOLDOWN_MS / 60000} minutes`);
        return;
      }

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

      // NOTE: activeSignals and positionOpenedAt already set above before order execution

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

      // Persist the new trailing stop to disk
      this.saveTrailingStops();

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
        // Position no longer exists - check if it was a TP win or a loss
        // If our TP limit order is gone (filled), it was a take profit
        // If TP order still exists, position was closed for another reason (stop, manual)
        const openOrders = await this.client.getOpenOrders(symbol);
        const tpOrderExists = openOrders.some(o => o.type === OrderType.LIMIT);

        if (!tpOrderExists && signal.takeProfit) {
          // TP order filled - this was a WIN!
          this.logger.info(`💰 ${symbol} TP order filled - position closed in profit!`);

          // Calculate approximate P&L (based on entry vs TP price)
          const pnl = signal.side === OrderSide.BUY
            ? signal.takeProfit.minus(signal.entryPrice).times(this.config.positionSize.dividedBy(signal.entryPrice)).toNumber()
            : signal.entryPrice.minus(signal.takeProfit).times(this.config.positionSize.dividedBy(signal.entryPrice)).toNumber();

          // Send Telegram notification for the win
          if (this.telegram) {
            await this.telegram.notifyPositionClosed(
              symbol,
              signal.side,
              signal.takeProfit,
              pnl,
              'Take Profit Hit (Limit Order Filled)'
            );
          }

          // NO cooldown on wins - can re-enter immediately if momentum continues
          this.logger.info(`✅ ${symbol} closed in profit - can re-enter immediately if momentum continues`);
        } else {
          // Position closed for another reason (stop loss, manual close, etc.)
          this.logger.warn(`Position for ${symbol} no longer exists - was likely stopped out or closed manually`);

          // Set cooldown to prevent immediate re-entry whipsaw
          this.lossCooldowns.set(symbol, Date.now());
          this.logger.info(`⏱️  Loss cooldown activated for ${symbol} (closed externally) - no re-entry for ${this.LOSS_COOLDOWN_MS / 60000} minutes`);

          // Cancel any remaining orders for this symbol
          for (const order of openOrders) {
            try {
              await this.client.cancelOrder(order.id);
              this.logger.info(`Cancelled orphaned order ${order.id} for ${symbol}`);
            } catch (e) {
              this.logger.warn({ error: e }, `Failed to cancel order ${order.id}`);
            }
          }
        }

        this.activeSignals.delete(symbol);
        this.removePersistedTrailingStop(symbol);
        this.partialProfitTaken.delete(symbol);
        this.positionOpenedAt.delete(symbol);
        this.lastTrailingStopCheck.delete(symbol);
        return;
      }

      // Use real position mark price for accurate stop loss calculations
      const currentPrice = position.markPrice || position.entryPrice;

      // Record successful check for health monitoring
      this.lastTrailingStopCheck.set(symbol, Date.now());

      // Debug logging to diagnose trailing stop issues
      this.logger.debug(`${symbol} trailing check: price=${currentPrice.toString()}, high=${trailing.high.toString()}, stop=${trailing.stop.toString()}, side=${signal.side}`);

      if (signal.side === OrderSide.BUY) {
        // Long position: trail stop upward
        if (currentPrice.greaterThan(trailing.high)) {
          const newHigh = currentPrice;
          const newStop = newHigh.times(1 - this.getTrailingStopPercent(symbol) / 100);

          this.logger.debug(`${symbol} price made new high! Old: ${trailing.high.toString()}, New: ${newHigh.toString()}, newStop: ${newStop.toString()}, oldStop: ${trailing.stop.toString()}`);

          if (newStop.greaterThan(trailing.stop)) {
            this.trailingStops.set(symbol, {
              high: newHigh,
              stop: newStop,
            });

            this.logger.info(
              `✅ Updated trailing stop for ${symbol}: ${newStop.toFixed(2)} (high: ${newHigh.toFixed(2)})`
            );

            // Persist the updated trailing stop to disk
            this.saveTrailingStops();

            // NOTE: Not updating exchange STOP order (Enclave doesn't support them)
          }
        }

        // Check for take profit (LONG: price above entry)
        if (!this.partialProfitTaken.get(symbol)) {
          const profitPercent = currentPrice.minus(signal.entryPrice).dividedBy(signal.entryPrice).times(100).toNumber();
          if (profitPercent >= this.TAKE_PROFIT_THRESHOLD) {
            this.logger.info(`💰 ${symbol} hit ${profitPercent.toFixed(2)}% profit - taking profit!`);
            await this.closePartialPosition(symbol, position, profitPercent);
          } else if (profitPercent > 0) {
            this.logger.debug(`${symbol} profit check: ${profitPercent.toFixed(2)}% (need ${this.TAKE_PROFIT_THRESHOLD}% for TP)`);
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
          const newStop = newLow.times(1 + this.getTrailingStopPercent(symbol) / 100);

          if (newStop.lessThan(trailing.stop)) {
            this.trailingStops.set(symbol, {
              high: newLow,
              stop: newStop,
            });

            this.logger.info(
              `Updated trailing stop for ${symbol}: ${newStop.toFixed(2)} (low: ${newLow.toFixed(2)})`
            );

            // Persist the updated trailing stop to disk
            this.saveTrailingStops();

            // NOTE: Not updating exchange STOP order (Enclave doesn't support them)
          }
        }

        // Check for take profit (SHORT: price below entry)
        if (!this.partialProfitTaken.get(symbol)) {
          const profitPercent = signal.entryPrice.minus(currentPrice).dividedBy(signal.entryPrice).times(100).toNumber();
          if (profitPercent >= this.TAKE_PROFIT_THRESHOLD) {
            this.logger.info(`💰 ${symbol} hit ${profitPercent.toFixed(2)}% profit - taking profit!`);
            await this.closePartialPosition(symbol, position, profitPercent);
          } else if (profitPercent > 0) {
            this.logger.debug(`${symbol} profit check: ${profitPercent.toFixed(2)}% (need ${this.TAKE_PROFIT_THRESHOLD}% for TP)`);
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

  /**
   * Close position at take profit target (100% exit)
   */
  private async closePartialPosition(symbol: string, position: { side: OrderSide; quantity: Decimal; entryPrice: Decimal; markPrice: Decimal }, profitPercent: number): Promise<void> {
    try {
      const closeQuantity = position.quantity.times(this.TAKE_PROFIT_CLOSE_PERCENT / 100);

      if (closeQuantity.lessThanOrEqualTo(0)) {
        this.logger.warn(`${symbol}: Close quantity too small, skipping`);
        return;
      }

      const closeSide = position.side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
      const closePrice = position.markPrice || position.entryPrice;

      // Calculate profit
      const pnl = position.side === OrderSide.BUY
        ? closePrice.minus(position.entryPrice).times(closeQuantity).toNumber()
        : position.entryPrice.minus(closePrice).times(closeQuantity).toNumber();

      this.logger.info(`💰 Taking profit on ${symbol}: closing ${closeQuantity.toString()} @ ${closePrice.toString()}, P&L: $${pnl.toFixed(2)}`);

      // Place reduce-only market order
      await this.client.addOrder(
        symbol,
        closeSide,
        closeQuantity,
        OrderType.MARKET
      );

      // Mark as closed and persist
      this.partialProfitTaken.set(symbol, true);
      this.saveTrailingStops();

      // Send Telegram notification
      if (this.telegram) {
        await this.telegram.sendMessage(
          `💰 *Take Profit Hit!*\n\n` +
          `${symbol.replace('-USD.P', '')}\n` +
          `Closed: ${closeQuantity.toString()}\n` +
          `Profit: +${profitPercent.toFixed(2)}%\n` +
          `P&L: $${pnl.toFixed(2)}`
        );
      }

      this.logger.info(`✅ Take profit hit for ${symbol}, position closed`);
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to take profit for ${symbol}`);
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

        // Calculate P&L manually instead of trusting API's unrealizedPnl (which is often 0 or stale)
        // LONG: profit when price goes up (closePrice > entryPrice)
        // SHORT: profit when price goes down (entryPrice > closePrice)
        const pnl = position.side === OrderSide.BUY
          ? closePrice.minus(position.entryPrice).times(position.quantity).toNumber()
          : position.entryPrice.minus(closePrice).times(position.quantity).toNumber();

        this.logger.info(`Closing ${symbol} position: entry=${position.entryPrice.toString()}, close=${closePrice.toString()}, qty=${position.quantity.toString()}, calculated P&L=$${pnl.toFixed(2)}`);

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

      // Set cooldown ONLY if this was a LOSS (stop loss hit)
      // Winners (Take Profit Hit) can re-enter immediately for momentum continuation
      if (reason === 'Stop Loss Hit') {
        this.lossCooldowns.set(symbol, Date.now());
        this.logger.info(`⏱️  Loss cooldown activated for ${symbol} - no re-entry for ${this.LOSS_COOLDOWN_MS / 60000} minutes`);
      } else if (reason === 'Take Profit Hit') {
        // NO COOLDOWN ON WINS - can re-enter immediately if signal still valid
        this.logger.info(`✅ ${symbol} closed in profit - can re-enter immediately if momentum continues`);
      }

      this.activeSignals.delete(symbol);
      this.removePersistedTrailingStop(symbol);
      this.partialProfitTaken.delete(symbol);
      this.positionOpenedAt.delete(symbol);
      this.lastTrailingStopCheck.delete(symbol);
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to close position for ${symbol}`);
    }
  }

  public getActiveSignals(): Map<string, Signal> {
    return this.activeSignals;
  }

  public async registerExistingPosition(symbol: string, side: OrderSide, entryPrice: Decimal, quantity: Decimal): Promise<void> {
    // Create a signal for the existing position using tiered trailing stop
    const trailingStopPct = this.getTrailingStopPercent(symbol);
    const signal: Signal = {
      symbol,
      side,
      entryPrice,
      stopLoss: side === OrderSide.BUY
        ? entryPrice.times(1 - trailingStopPct / 100)
        : entryPrice.times(1 + trailingStopPct / 100),
      takeProfit: this.config.takeProfitPercent
        ? (side === OrderSide.BUY
            ? entryPrice.times(1 + this.config.takeProfitPercent / 100)
            : entryPrice.times(1 - this.config.takeProfitPercent / 100))
        : undefined,
      confidence: 1.0,
      reason: 'Existing position on restart',
    };

    this.activeSignals.set(symbol, signal);
    this.positionOpenedAt.set(symbol, Date.now()); // Track when registered for health check grace period

    // Check if we have a persisted trailing stop from before restart
    const existingTrailing = this.trailingStops.get(symbol);
    if (existingTrailing) {
      // Use the persisted high (don't reset to entry price!)
      this.logger.info(`📁 Using persisted trailing stop for ${symbol}: high=${existingTrailing.high.toString()}, stop=${existingTrailing.stop.toString()}`);

      // Update the signal's stopLoss to match the persisted stop level
      signal.stopLoss = existingTrailing.stop;
    } else {
      // No persisted state - initialize trailing stop at entry price
      this.trailingStops.set(symbol, {
        high: entryPrice,
        stop: signal.stopLoss,
      });
      this.logger.info(`Initialized new trailing stop for ${symbol} at entry price: ${entryPrice.toString()}`);
      this.saveTrailingStops();
    }

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

    this.logger.info(`Registered existing position: ${symbol} ${side} @ ${entryPrice.toString()}, SL: ${signal.stopLoss.toString()} (${trailingStopPct}% tiered stop)`);
  }

  /**
   * Health check for trailing stops - detects if they've stopped working
   * Call this periodically (e.g., every 60 seconds) to monitor health
   * Sends Telegram alert if trailing stops haven't been checked recently
   */
  public async checkTrailingStopHealth(): Promise<void> {
    const now = Date.now();
    const STALE_THRESHOLD_MS = 60 * 1000; // 60 seconds - should check every 5s, so 60s means problem

    // Check each active position
    for (const [symbol] of this.activeSignals.entries()) {
      const lastCheck = this.lastTrailingStopCheck.get(symbol);

      if (!lastCheck) {
        // Position has never been checked - but give new positions a grace period
        const openedAt = this.positionOpenedAt.get(symbol);
        const timeSinceOpened = openedAt ? now - openedAt : Infinity;

        if (timeSinceOpened < this.NEW_POSITION_GRACE_PERIOD_MS) {
          // New position, still within grace period - don't alert yet
          this.logger.debug(`${symbol}: New position within grace period (${Math.round(timeSinceOpened / 1000)}s old), skipping health check`);
          continue;
        }

        // Position has been open longer than grace period but never checked - this is bad!
        if (!this.trailingStopFailureAlerted) {
          const message = `🚨 CRITICAL: Trailing stop for ${symbol} has NEVER been checked! Position is unprotected!`;
          this.logger.error(message);
          if (this.telegram) {
            await this.telegram.sendMessage(message);
          }
          this.trailingStopFailureAlerted = true;
        }
        continue;
      }

      const timeSinceCheck = now - lastCheck;
      if (timeSinceCheck > STALE_THRESHOLD_MS) {
        // Trailing stop hasn't been checked in over 60 seconds - something is wrong
        if (!this.trailingStopFailureAlerted) {
          const minutesStale = Math.round(timeSinceCheck / 60000);
          const message = `🚨 CRITICAL: Trailing stops have FAILED!\n\n${symbol} not checked for ${minutesStale} minutes.\n\nYour positions are UNPROTECTED.\n\nRestart the bot immediately!`;
          this.logger.error(message);
          if (this.telegram) {
            await this.telegram.sendMessage(message);
          }
          this.trailingStopFailureAlerted = true;
        }
      } else {
        // Trailing stops are working - reset alert flag
        this.trailingStopFailureAlerted = false;
      }
    }
  }

  public clearHistory(): void {
    this.priceHistory.clear();
    this.activeSignals.clear();
    this.trailingStops.clear();
    this.positionOpenedAt.clear();
    this.lastTrailingStopCheck.clear();
  }
}