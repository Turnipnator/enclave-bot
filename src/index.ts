import pino from 'pino';
import { config } from './config/config';
import { EnclaveClient } from './core/exchange/EnclaveClient';
import { BreakoutStrategy } from './core/strategy/BreakoutStrategy';
import { VolumeFarmingStrategy } from './core/strategy/VolumeFarmingStrategy';
import { RiskManager } from './core/risk/RiskManager';
import { BinanceDataService } from './services/data/BinanceDataService';
import { WebhookServer, TradingViewAlert } from './services/webhook/WebhookServer';
import { TelegramService, BotStatusProvider } from './services/telegram/TelegramService';
import Decimal from 'decimal.js';
import { OrderSide } from './core/exchange/types';

const logger = pino({
  name: 'EnclaveTradeBot',
  level: config.logLevel,
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:standard',
    },
  },
});

class TradingBot implements BotStatusProvider {
  private client: EnclaveClient;
  private breakoutStrategy: BreakoutStrategy;
  private volumeFarmingStrategy: VolumeFarmingStrategy;
  private riskManager!: RiskManager; // Initialized in initializeRiskManager()
  private webhookServer?: WebhookServer;
  private telegram: TelegramService;
  private running = false;
  private mainLoopInterval?: NodeJS.Timeout;
  private priceUpdateInterval?: NodeJS.Timeout;

  constructor() {
    this.client = new EnclaveClient(config.apiKey, config.apiSecret, config.environment, config.subaccountName);

    // Initialize Telegram service
    this.telegram = new TelegramService({
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      chatId: process.env.TELEGRAM_CHAT_ID || '',
      enabled: process.env.TELEGRAM_ENABLED === 'true',
    });

    // Register this bot as the status provider
    this.telegram.setStatusProvider(this);

    this.breakoutStrategy = new BreakoutStrategy(this.client, {
      lookbackPeriod: config.lookbackPeriod,
      volumeMultiplier: config.volumeMultiplier,
      trailingStopPercent: config.trailingStopPercent,
      positionSize: config.positionSize,
      useScalping: config.useScalping,
      breakoutBuffer: config.breakoutBuffer,
      takeProfitPercent: config.takeProfitPercent,
    }, this.telegram);

    this.volumeFarmingStrategy = new VolumeFarmingStrategy(this.client, {
      enableVolumeFarming: config.enableVolumeFarming,
      minTradeInterval: config.minTradeInterval,
      targetDailyTrades: config.targetDailyTrades,
      spreadTolerance: config.spreadTolerance,
      positionSize: config.positionSize,
      maxPositions: config.maxPositions,
    });

    // RiskManager will be initialized in initializeRiskManager() with proper balance
  }

  public async start(): Promise<void> {
    logger.info('Starting Enclave Trading Bot...');
    logger.info(`Trading Mode: ${config.tradingMode}`);
    logger.info(`Trading Pairs: ${config.tradingPairs.join(', ')}`);

    try {
      // Connect to WebSocket
      await this.client.connect();
      logger.info('Connected to Enclave Markets');

      // Initialize risk manager with current balance
      await this.initializeRiskManager();

      // Subscribe to market data
      for (const pair of config.tradingPairs) {
        this.subscribeToMarketData(pair);
      }

      // Initialize price history
      await this.initializePriceHistory();

      // Check for existing positions
      await this.checkExistingPositions();

      // Start webhook server if enabled (default to true if not specified)
      const enableWebhooks = process.env.ENABLE_WEBHOOKS !== 'false';
      if (enableWebhooks) {
        this.startWebhookServer();
      }

      // Start main trading loop
      this.running = true;
      this.startMainLoop();
      this.startPriceUpdateLoop();
      this.startStaleOrderCleanup();
      this.startHistoryRefreshLoop();

      logger.info('Trading bot started successfully');

      // Send Telegram notification and initialize tracking
      const balances = await this.client.getBalance();
      const balance = balances.find((b) => b.asset === 'USD') || {
        asset: 'USD',
        available: new Decimal(0),
        locked: new Decimal(0),
        total: new Decimal(0),
      };
      const currentBalance = balance.total.toNumber();

      this.telegram.setStartBalance(currentBalance);
      this.telegram.setDailyStartBalance(currentBalance);
      this.telegram.setWeeklyStartBalance(currentBalance);

      await this.telegram.notifyBotStarted(currentBalance);
    } catch (error) {
      logger.error({ error }, 'Failed to start trading bot');
      await this.telegram.notifyError(
        error instanceof Error ? error.message : String(error),
        'Bot startup failed'
      );
      process.exit(1);
    }
  }

  private startWebhookServer(): void {
    const port = process.env.WEBHOOK_PORT ? parseInt(process.env.WEBHOOK_PORT) : 3000;
    this.webhookServer = new WebhookServer(port);

    // Set up alert handler
    this.webhookServer.onAlert(async (alert: TradingViewAlert) => {
      try {
        const symbol = WebhookServer.mapSymbol(alert.ticker);
        logger.info({ alert, symbol }, 'Processing TradingView alert');

        // Check if we should act on this alert
        if (!config.tradingPairs.includes(symbol)) {
          logger.warn(`Symbol ${symbol} not in trading pairs, ignoring alert`);
          return;
        }

        // Check risk limits
        if (this.riskManager.shouldStopTrading()) {
          logger.warn('Risk manager has stopped trading, ignoring alert');
          return;
        }

        // Execute trade based on alert
        if (alert.action === 'buy' || alert.action === 'sell') {
          // Check for existing position before webhook execution
          const positions = await this.client.getPositions();
          const existingPosition = positions.find(p => p.symbol === symbol);
          if (existingPosition && existingPosition.quantity.greaterThan(0)) {
            logger.info(`Skipping webhook signal for ${symbol} - already have position (${existingPosition.quantity} qty)`);
            return;
          }

          const side = alert.action === 'buy' ? OrderSide.BUY : OrderSide.SELL;
          const signal = {
            symbol,
            side,
            entryPrice: alert.price ? new Decimal(alert.price) : await this.getCurrentPrice(symbol),
            stopLoss: new Decimal(0), // Will be calculated by strategy
            confidence: 0.8, // High confidence for manual alerts
            reason: `TradingView Alert: ${alert.strategy || 'manual'}`,
          };

          await this.breakoutStrategy.executeSignal(signal);
          logger.info({ signal }, 'Executed trade from TradingView alert');
        } else if (alert.action === 'close') {
          await this.client.closePosition(symbol);
          logger.info({ symbol }, 'Closed position from TradingView alert');
        }
      } catch (error) {
        logger.error({ error, alert }, 'Failed to process TradingView alert');
      }
    });

    this.webhookServer.start();
  }

  private async getCurrentPrice(symbol: string): Promise<Decimal> {
    const marketData = await this.client.getMarketData(symbol);
    return marketData.last;
  }

  private async initializeRiskManager(): Promise<void> {
    try {
      const balances = await this.client.getBalance();
      const balance = balances.find((b) => b.asset === 'USD') || {
        asset: 'USD',
        available: new Decimal(0),
        locked: new Decimal(0),
        total: new Decimal(0),
      };

      // Create a new RiskManager instance with current balance as initial balance
      // This ensures peak balance is set correctly from the start
      this.riskManager = new RiskManager({
        maxDailyLoss: config.maxDailyLoss,
        maxPositions: config.maxPositions,
        positionSize: config.positionSize,
        maxLeverage: config.maxLeverage,
        maxDrawdown: config.maxDrawdown,
      }, balance.total); // Pass current balance as initial balance

      // Explicitly reset peak balance to current balance to avoid stale drawdown calculations
      this.riskManager.resetPeakBalance(balance.total);

      // Get initial risk metrics to verify setup
      const positions = await this.client.getPositions();
      const metrics = this.riskManager.getRiskMetrics(positions, balance);

      logger.info(`Risk manager initialized with balance: ${balance.total.toString()}`);
      logger.info(`Initial drawdown: ${metrics.currentDrawdown.toFixed(2)}%`);
      logger.info(`Max allowed drawdown: ${config.maxDrawdown.toString()}%`);

      if (metrics.currentDrawdown.greaterThan(config.maxDrawdown)) {
        logger.error(`WARNING: Current drawdown (${metrics.currentDrawdown.toFixed(2)}%) exceeds limit (${config.maxDrawdown.toString()}%)`);
        logger.error('Trading will be blocked until drawdown is below limit');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to initialize risk manager');
    }
  }

  private async checkExistingPositions(): Promise<void> {
    try {
      const positions = await this.client.getPositions();
      if (positions.length > 0) {
        logger.info(`Found ${positions.length} existing position(s) on restart:`);
        for (const position of positions) {
          logger.info({
            symbol: position.symbol,
            side: position.side,
            quantity: position.quantity.toString(),
            entryPrice: position.entryPrice.toString(),
            unrealizedPnl: position.unrealizedPnl.toString(),
          }, `Existing position: ${position.symbol}`);

          // Register position with strategies so they can manage trailing stops
          if (this.breakoutStrategy) {
            await this.breakoutStrategy.registerExistingPosition(
              position.symbol,
              position.side,
              position.entryPrice,
              position.quantity
            );
            logger.info(`Registered ${position.symbol} with breakout strategy for trailing stop management`);
          }
        }
      } else {
        logger.info('No existing positions found on startup');
      }
    } catch (error) {
      logger.error({ error }, 'Failed to check existing positions');
    }
  }

  private subscribeToMarketData(symbol: string): void {
    // Subscribe to ticker updates
    this.client.subscribe(`ticker:${symbol}`, (data) => {
      logger.debug({ data, symbol }, `Ticker update for ${symbol}`);
    });

    // Subscribe to trade updates
    this.client.subscribe(`trades:${symbol}`, (data) => {
      logger.debug({ data, symbol }, `Trade update for ${symbol}`);
    });
  }

  private async initializePriceHistory(): Promise<void> {
    logger.info('Initializing price history...');

    const binanceService = new BinanceDataService();

    for (const pair of config.tradingPairs) {
      try {
        // Try to load historical data from Binance
        logger.info(`Loading historical data for ${pair} from Binance...`);
        const candles = await binanceService.getHistoricalCandles(pair, '5m', 100);

        if (candles.length > 0) {
          // Convert Binance candles to PriceData format
          const priceData = candles.map(candle => ({
            high: candle.high,
            low: candle.low,
            close: candle.close,
            volume: candle.volume,
            timestamp: new Date(candle.timestamp),
          }));

          this.breakoutStrategy.initializeWithHistoricalData(pair, priceData);
          logger.info(`Loaded ${candles.length} historical candles for ${pair}`);
        } else {
          // Fallback to original initialization if Binance fails
          logger.warn(`No historical data available for ${pair}, using real-time data only`);
          for (let i = 0; i < config.lookbackPeriod; i++) {
            await this.breakoutStrategy.updatePriceHistory(pair);
            await this.sleep(100); // Small delay to avoid rate limiting
          }
        }
      } catch (error) {
        const errorMsg = (error as Error).message;
        if (errorMsg.includes('not supported for historical data')) {
          logger.info(`${pair} not available on Binance, using real-time data only`);
        } else {
          logger.error({ error, pair }, `Failed to load historical data for ${pair}, falling back to real-time`);
        }
        // Fallback to original initialization
        for (let i = 0; i < config.lookbackPeriod; i++) {
          await this.breakoutStrategy.updatePriceHistory(pair);
          await this.sleep(100);
        }
      }
    }

    logger.info('Price history initialized');
  }

  private startMainLoop(): void {
    this.mainLoopInterval = setInterval(async () => {
      if (!this.running) return;

      try {
        await this.runTradingCycle();
      } catch (error) {
        logger.error({
          error: error instanceof Error ? {
            message: error.message,
            stack: error.stack,
            name: error.name
          } : error,
          errorString: String(error)
        }, 'Error in main trading loop');

        // Send Telegram alert for critical errors
        await this.telegram.notifyError(
          error instanceof Error ? error.message : String(error),
          'Main trading loop error'
        );
      }
    }, 5000); // Run every 5 seconds
  }

  private startPriceUpdateLoop(): void {
    this.priceUpdateInterval = setInterval(async () => {
      if (!this.running) return;

      try {
        // Only update trailing stops here since price history is updated in main loop
        for (const pair of config.tradingPairs) {
          await this.breakoutStrategy.updateTrailingStops(pair);
        }
      } catch (error) {
        logger.error({ error }, 'Error updating trailing stops');
      }
    }, 5000); // Update every 5 seconds - critical for stop loss protection
  }

  private startHistoryRefreshLoop(): void {
    // Reload fresh candles from Binance every hour to keep price history current
    // This fixes the stale data bug where bot analyzes old candles after hours of running
    setInterval(async () => {
      if (!this.running) return;

      try {
        logger.info('Refreshing price history from Binance...');
        const binanceService = new BinanceDataService();

        for (const pair of config.tradingPairs) {
          try {
            const candles = await binanceService.getHistoricalCandles(pair, '5m', 100);

            if (candles.length > 0) {
              const priceData = candles.map(candle => ({
                high: candle.high,
                low: candle.low,
                close: candle.close,
                volume: candle.volume,
                timestamp: new Date(candle.timestamp),
              }));

              this.breakoutStrategy.initializeWithHistoricalData(pair, priceData);
              logger.info(`Refreshed ${candles.length} candles for ${pair}`);
            }
          } catch (error) {
            logger.error({ error, pair }, `Failed to refresh history for ${pair}`);
          }
        }

        logger.info('Price history refresh complete');
      } catch (error) {
        logger.error({ error }, 'Error refreshing price history');
      }
    }, 60 * 60 * 1000); // Run every hour
  }

  private startStaleOrderCleanup(): void {
    // Run cleanup every minute to remove orders for closed positions
    setInterval(async () => {
      if (!this.running) return;

      try {
        const positions = await this.client.getPositions();
        const posSymbols = positions.map(p => p.symbol);
        const allOrders = await this.client.getOpenOrders();

        // Find symbols with orders but no position
        const symbolsWithOrders = [...new Set(allOrders.map(o => o.symbol))];
        const orphanedSymbols = symbolsWithOrders.filter(s => !posSymbols.includes(s));

        if (orphanedSymbols.length > 0) {
          logger.debug(`Found ${orphanedSymbols.length} symbols with stale orders (attempting cleanup)`);

          for (const symbol of orphanedSymbols) {
            const orphanOrders = allOrders.filter(o => o.symbol === symbol);

            for (const order of orphanOrders) {
              try {
                const cancelled = await this.client.cancelOrder(order.id);
                if (cancelled) {
                  logger.info(`✓ Cancelled stale order for ${symbol}`);
                }
              } catch (err) {
                // Ignore cancel errors - some orders may be locked
              }
            }
          }
        }

        // Also clean up wrong-side orders for existing positions
        for (const pos of positions) {
          const orders = allOrders.filter(o => o.symbol === pos.symbol);
          const wrongSide = pos.side; // Same side as position = wrong (can't close with same side)
          const wrongOrders = orders.filter(o => o.side === wrongSide);

          if (wrongOrders.length > 0) {
            logger.debug(`Attempting to cancel ${wrongOrders.length} wrong-side orders for ${pos.symbol}`);
            for (const order of wrongOrders) {
              try {
                const cancelled = await this.client.cancelOrder(order.id);
                if (cancelled) {
                  logger.info(`✓ Cancelled wrong-side order for ${pos.symbol}`);
                }
              } catch (err) {
                // Ignore cancel errors
              }
            }
          }
        }
      } catch (error) {
        logger.error({ error }, 'Error in stale order cleanup');
      }
    }, 60000); // Run every minute
  }

  private async runTradingCycle(): Promise<void> {
    // Check if we should stop trading
    if (this.riskManager.shouldStopTrading()) {
      logger.error('Risk manager triggered emergency stop');
      await this.stop();
      return;
    }

    // Get current positions and balance
    let positions, balances;
    try {
      logger.debug('Fetching positions...');
      positions = await this.client.getPositions();
      logger.debug({ positions }, 'Positions fetched');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
        } : error,
      }, 'Failed to get positions');
      throw error;
    }

    try {
      logger.debug('Fetching balance...');
      balances = await this.client.getBalance();
      logger.debug({ balances }, 'Balance fetched');
    } catch (error) {
      logger.error({
        error: error instanceof Error ? {
          message: error.message,
          stack: error.stack,
        } : error,
      }, 'Failed to get balance');
      throw error;
    }
    const balance = balances.find((b) => b.asset === 'USD') || {
      asset: 'USD',
      available: new Decimal(0),
      locked: new Decimal(0),
      total: new Decimal(0),
    };

    // Log current status
    const metrics = this.riskManager.getRiskMetrics(positions, balance);
    logger.info({
      positions: metrics.openPositions,
      dailyPnl: metrics.dailyPnl.toFixed(2),
      riskScore: metrics.riskScore,
      volumeFarmingProgress: `${this.volumeFarmingStrategy.getDailyTradeCount()}/${this.volumeFarmingStrategy.getTargetDailyTrades()}`,
    }, 'Trading Status');

    // Process each trading pair
    for (const pair of config.tradingPairs) {
      try {
        logger.debug(`Processing ${pair}...`);

        // Check for volume farming opportunities
        logger.debug(`Evaluating volume farming for ${pair}...`);
        if (await this.volumeFarmingStrategy.evaluate(pair)) {
          logger.debug(`Volume farming opportunity found for ${pair}`);
          if (config.tradingMode === 'live' || config.tradingMode === 'paper') {
            await this.volumeFarmingStrategy.executeFarmingTrade(pair);
          }
          continue; // Skip breakout strategy for this cycle
        }

        // DISABLED: updatePriceHistory() corrupts data by adding 24h summary as 5-min candles
        // Bot uses initial 100 candles from Binance which is sufficient (5 hours of 5-min data)
        // logger.debug(`Updating price history for ${pair}...`);
        // await this.breakoutStrategy.updatePriceHistory(pair);

        // Check for breakout signals
        logger.debug(`Generating breakout signal for ${pair}...`);
        const signal = await this.breakoutStrategy.generateSignal(pair);
        if (signal) {
          logger.debug(`Signal result for ${pair}: ${JSON.stringify({
            symbol: signal.symbol,
            side: signal.side,
            confidence: signal.confidence,
            reason: signal.reason
          })}`);
        } else {
          logger.debug(`Signal result for ${pair}: null`);
        }

        if (signal && signal.confidence > 0.5) {
          logger.debug(`Signal confidence above threshold for ${pair}: ${signal.confidence}`);

          // Check if we already have a position for this symbol
          const existingPosition = positions.find(p => p.symbol === pair);
          if (existingPosition && existingPosition.quantity.greaterThan(0)) {
            logger.info(`Skipping signal for ${pair} - already have position (${existingPosition.quantity} qty)`);
            continue;
          }

          // Use appropriate position size based on token price - targeting ~$30 per trade
          // Position sizes based on your preferences
          let tokenQuantity: Decimal;
          if (pair === 'BTC-USD.P') {
            // Your preference: 0.0002 BTC (~$13)
            tokenQuantity = new Decimal(0.0002);
          } else if (pair === 'ETH-USD.P') {
            // Fixed: 0.01 ETH minimum increment required by Enclave
            tokenQuantity = new Decimal(0.01);
          } else if (pair === 'SOL-USD.P') {
            // Your preference: 0.1 SOL (~$24)
            tokenQuantity = new Decimal(0.1);
          } else if (pair === 'AVAX-USD.P') {
            // Your preference: 1.0 AVAX (~$34)
            tokenQuantity = new Decimal(1.0);
          } else if (pair === 'XRP-USD.P') {
            // Your preference: 10 XRP (~$6.50)
            tokenQuantity = new Decimal(10);
          } else if (pair === 'BNB-USD.P') {
            // BNB: 0.05 BNB (~$35 at $700)
            tokenQuantity = new Decimal(0.05);
          } else if (pair === 'DOGE-USD.P') {
            // DOGE: 80 DOGE (~$24 at $0.30)
            tokenQuantity = new Decimal(80);
          } else if (pair === 'LINK-USD.P') {
            // LINK: 1 LINK (~$20 at $20)
            tokenQuantity = new Decimal(1);
          } else if (pair === 'SUI-USD.P') {
            // SUI: 6 SUI (~$24 at $4)
            tokenQuantity = new Decimal(6);
          } else if (pair === 'TON-USD.P') {
            // TON: 4 TON (~$24 at $6)
            tokenQuantity = new Decimal(4);
          } else if (pair === 'ADA-USD.P') {
            // ADA: 25 ADA (~$25 at $1)
            tokenQuantity = new Decimal(25);
          } else {
            // Safe default for any other pairs - $25 worth, rounded to 0.01
            const targetUsd = new Decimal(25);
            const rawQuantity = targetUsd.dividedBy(signal.entryPrice);
            tokenQuantity = rawQuantity.toDecimalPlaces(2); // Round to 2 decimals as safe default
          }

          const actualUsdAmount = tokenQuantity.times(signal.entryPrice);

          // Skip if we can't afford the position
          if (actualUsdAmount.greaterThan(balance.available)) {
            logger.warn(`Skipping ${pair}: Need ${actualUsdAmount.toFixed(2)} USD for ${tokenQuantity} tokens, available: ${balance.available.toFixed(2)} USD`);
            continue;
          }

          const requiredMargin = actualUsdAmount;

          logger.info(`Position sizing for ${pair}: Using ${actualUsdAmount.toFixed(2)} USD (${tokenQuantity} tokens @ ${signal.entryPrice})`);

          if (this.riskManager.canOpenPosition(positions, balance, requiredMargin)) {
            logger.debug(`Risk manager approved position for ${pair}`);
            // Calculate dynamic position size based on risk
            // const positionSize = this.riskManager.calculatePositionSize(
            //   balance,
            //   signal.entryPrice,
            //   signal.stopLoss
            // );

            // Update signal with calculated position size
            const updatedSignal = { ...signal };

            if (config.tradingMode === 'live') {
              logger.info(`Executing signal for ${pair}: ${JSON.stringify(updatedSignal)} with quantity ${tokenQuantity}`);
              await this.breakoutStrategy.executeSignal(updatedSignal, tokenQuantity);
            } else {
              logger.info(`[PAPER] Would execute signal: ${JSON.stringify(updatedSignal)} with quantity ${tokenQuantity}`);
            }
          } else {
            logger.debug(`Risk manager denied position for ${pair}`);
          }
        } else if (signal) {
          logger.debug(`Signal confidence too low for ${pair}: ${signal.confidence}`);
        } else {
          logger.debug(`No signal generated for ${pair}`);
        }
      } catch (error) {
        logger.error({ error, pair }, `Error processing ${pair}`);
      }
    }

    // Update PnL from closed positions
    for (const position of positions) {
      if (position.realizedPnl && !position.realizedPnl.isZero()) {
        this.riskManager.updatePnl(position.realizedPnl);
      }
    }
  }

  public async stop(): Promise<void> {
    logger.info('Stopping trading bot...');
    this.running = false;

    // Clear intervals
    if (this.mainLoopInterval) {
      clearInterval(this.mainLoopInterval);
    }
    if (this.priceUpdateInterval) {
      clearInterval(this.priceUpdateInterval);
    }

    // Get final balance and calculate total P&L
    let finalBalance = 0;
    let totalPnl = 0;
    try {
      const balances = await this.client.getBalance();
      const balance = balances.find((b) => b.asset === 'USD');
      if (balance) {
        finalBalance = balance.total.toNumber();
        // Calculate total P&L from start balance
        const startBalance = this.telegram['startBalance'] || 0;
        totalPnl = finalBalance - startBalance;
      }
    } catch (error) {
      logger.error({ error }, 'Error getting final balance');
    }

    // Close all positions if in live mode
    if (config.tradingMode === 'live') {
      try {
        const positions = await this.client.getPositions();
        for (const position of positions) {
          logger.info(`Closing position: ${position.symbol}`);
          await this.client.closePosition(position.symbol);
        }
      } catch (error) {
        logger.error({ error }, 'Error closing positions');
      }
    }

    // Disconnect from WebSocket
    this.client.disconnect();

    // Send Telegram notification
    await this.telegram.notifyBotStopped(finalBalance, totalPnl);

    logger.info('Trading bot stopped');
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  public async emergencyStop(): Promise<void> {
    logger.error('EMERGENCY STOP TRIGGERED');

    // Send Telegram alert
    await this.telegram.notifyError('Emergency stop triggered', 'CRITICAL: Bot emergency stop');

    // Cancel all open orders
    try {
      const openOrders = await this.client.getOpenOrders();
      for (const order of openOrders) {
        await this.client.cancelOrder(order.id);
        logger.info(`Cancelled order: ${order.id}`);
      }
    } catch (error) {
      logger.error({ error }, 'Error cancelling orders');
    }

    // Stop the bot
    await this.stop();
    process.exit(1);
  }

  // BotStatusProvider interface implementation
  async getStatus(): Promise<{
    balance: number;
    positions: Array<{
      symbol: string;
      side: string;
      quantity: string;
      entryPrice: string;
      unrealizedPnl: string;
    }>;
    dailyPnl: number;
    isRunning: boolean;
  }> {
    const balances = await this.client.getBalance();
    const balance = balances.find((b) => b.asset === 'USD') || {
      asset: 'USD',
      available: new Decimal(0),
      locked: new Decimal(0),
      total: new Decimal(0),
    };

    const positions = await this.client.getPositions();
    const metrics = this.riskManager.getRiskMetrics(positions, balance);

    return {
      balance: balance.total.toNumber(),
      positions: positions.map(p => ({
        symbol: p.symbol,
        side: p.side,
        quantity: p.quantity.toFixed(4),
        entryPrice: p.entryPrice.toFixed(2),
        unrealizedPnl: p.unrealizedPnl.toFixed(2),
      })),
      dailyPnl: metrics.dailyPnl.toNumber(),
      isRunning: this.running,
    };
  }

  async restart(): Promise<void> {
    logger.info('Restart requested via Telegram');
    await this.stop();
    setTimeout(() => {
      this.start().catch(error => {
        logger.error({ error }, 'Failed to restart bot');
      });
    }, 2000);
  }
}

// Main execution
const bot = new TradingBot();

// Handle graceful shutdown
process.on('SIGINT', async () => {
  logger.info('Received SIGINT, shutting down gracefully...');
  await bot.stop();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.info('Received SIGTERM, shutting down gracefully...');
  await bot.stop();
  process.exit(0);
});

// Handle uncaught errors
process.on('uncaughtException', async (error) => {
  logger.error({ error }, 'Uncaught exception');
  await bot.emergencyStop();
});

process.on('unhandledRejection', async (reason, promise) => {
  logger.error({ reason, promise }, 'Unhandled rejection');
  await bot.emergencyStop();
});

// Start the bot
bot.start().catch((error) => {
  logger.error({ error }, 'Failed to start bot');
  process.exit(1);
});