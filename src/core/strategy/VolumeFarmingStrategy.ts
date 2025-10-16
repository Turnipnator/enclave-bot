import Decimal from 'decimal.js';
import pino from 'pino';
import { EnclaveClient } from '../exchange/EnclaveClient';
import { OrderSide, OrderType, MarketData } from '../exchange/types';

export interface VolumeFarmingConfig {
  enableVolumeFarming: boolean;
  minTradeInterval: number; // seconds
  targetDailyTrades: number;
  spreadTolerance: Decimal;
  positionSize: Decimal;
  maxPositions: number;
}

export class VolumeFarmingStrategy {
  private readonly client: EnclaveClient;
  private readonly config: VolumeFarmingConfig;
  private readonly logger: pino.Logger;
  private lastTradeTimes: Map<string, Date> = new Map();
  private dailyTradeCount = 0;
  private dailyTradeCountResetTime: Date;

  constructor(client: EnclaveClient, config: VolumeFarmingConfig) {
    this.client = client;
    this.config = config;
    this.logger = pino({ name: 'VolumeFarmingStrategy' });
    this.dailyTradeCountResetTime = new Date();
  }

  public async evaluate(symbol: string): Promise<boolean> {
    if (!this.config.enableVolumeFarming) {
      return false;
    }

    this.resetDailyCounterIfNeeded();

    if (this.dailyTradeCount >= this.config.targetDailyTrades) {
      this.logger.debug(`Daily trade target reached: ${this.dailyTradeCount}`);
      return false;
    }

    const lastTradeTime = this.lastTradeTimes.get(symbol);
    if (lastTradeTime) {
      const timeSinceLastTrade = (Date.now() - lastTradeTime.getTime()) / 1000;
      if (timeSinceLastTrade < this.config.minTradeInterval) {
        return false;
      }
    }

    const positions = await this.client.getPositions();
    if (positions.length >= this.config.maxPositions) {
      this.logger.debug(`Max positions reached: ${positions.length}`);
      return false;
    }

    const marketData = await this.client.getMarketData(symbol);
    const spread = marketData.ask.minus(marketData.bid);
    const spreadPercent = spread.dividedBy(marketData.bid).times(100);

    if (spreadPercent.greaterThan(this.config.spreadTolerance)) {
      this.logger.debug(`Spread too wide: ${spreadPercent.toFixed(4)}%`);
      return false;
    }

    return true;
  }

  public async executeFarmingTrade(symbol: string): Promise<void> {
    try {
      const marketData = await this.client.getMarketData(symbol);

      // Skip trading if prices are invalid (0 or missing)
      if (marketData.bid.isZero() || marketData.ask.isZero()) {
        this.logger.debug(`Skipping ${symbol} - invalid market data (bid: ${marketData.bid}, ask: ${marketData.ask})`);
        return;
      }
      const positions = await this.client.getPositions();
      const currentPosition = positions.find((p) => p.symbol === symbol);

      let side: OrderSide;
      if (currentPosition) {
        // If we have a position, trade in the opposite direction to close/reduce it
        side = currentPosition.side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
      } else {
        // No position, alternate based on last trade or random
        const lastSide = this.getLastTradeSide(symbol);
        side = lastSide === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
      }

      // Place a limit order near the mid-price for better execution
      const midPrice = marketData.bid.plus(marketData.ask).dividedBy(2);
      const rawOrderPrice =
        side === OrderSide.BUY
          ? midPrice.minus(midPrice.times(0.0001)) // Slightly below mid for buy
          : midPrice.plus(midPrice.times(0.0001)); // Slightly above mid for sell

      // Round to whole dollars (quote increment = 1 for BTC perpetuals)
      const orderPrice = new Decimal(Math.round(rawOrderPrice.toNumber()));

      const order = await this.client.addOrder(
        symbol,
        side,
        this.config.positionSize,
        OrderType.LIMIT,
        orderPrice
      );

      this.logger.info(
        `Farming trade placed: ${symbol} ${side} ${this.config.positionSize} @ ${orderPrice}`
      );

      this.lastTradeTimes.set(symbol, new Date());
      this.dailyTradeCount++;
      this.setLastTradeSide(symbol, side);

      // Set a timeout to cancel the order if it doesn't fill quickly
      setTimeout(async () => {
        try {
          const orderStatus = await this.client.getOrder(order.id);
          if (orderStatus.status !== 'FILLED' && orderStatus.status !== 'PARTIALLY_FILLED') {
            await this.client.cancelOrder(order.id);
            this.logger.debug(`Cancelled unfilled farming order: ${order.id}`);
          }
        } catch (error) {
          this.logger.error({ error }, 'Error checking/cancelling farming order');
        }
      }, 5000); // Cancel after 5 seconds if not filled
    } catch (error) {
      const errorMsg = (error as Error).message;
      if (errorMsg.includes('No valid market data available')) {
        this.logger.debug(`Skipping ${symbol} - no market data available yet`);
      } else {
        this.logger.error({ error, symbol }, `Failed to execute farming trade for ${symbol}`);
      }
    }
  }

  public async executeScalpTrade(symbol: string, marketData: MarketData): Promise<void> {
    try {
      // Quick scalp: buy at bid, sell at ask for tiny profit
      const positions = await this.client.getPositions();
      const currentPosition = positions.find((p) => p.symbol === symbol);

      if (!currentPosition) {
        // Open a position at the bid (rounded to whole dollars)
        const bidPrice = new Decimal(Math.round(marketData.bid.toNumber()));
        await this.client.addOrder(
          symbol,
          OrderSide.BUY,
          this.config.positionSize,
          OrderType.LIMIT,
          bidPrice
        );

        this.logger.info(`Scalp buy placed: ${symbol} @ ${bidPrice}`);

        // Immediately place a sell order at the ask (rounded to whole dollars)
        setTimeout(async () => {
          const askPrice = new Decimal(Math.round(marketData.ask.toNumber()));
          await this.client.addOrder(
            symbol,
            OrderSide.SELL,
            this.config.positionSize,
            OrderType.LIMIT,
            askPrice
          );
          this.logger.info(`Scalp sell placed: ${symbol} @ ${askPrice}`);
        }, 1000);
      } else {
        // Close the position
        const side = currentPosition.side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;
        const rawPrice = side === OrderSide.SELL ? marketData.ask : marketData.bid;
        const price = new Decimal(Math.round(rawPrice.toNumber()));

        await this.client.addOrder(
          symbol,
          side,
          currentPosition.quantity,
          OrderType.LIMIT,
          price
        );

        this.logger.info(`Scalp close placed: ${symbol} ${side} @ ${price}`);
      }

      this.lastTradeTimes.set(symbol, new Date());
      this.dailyTradeCount++;
    } catch (error) {
      this.logger.error({ error, symbol }, `Failed to execute scalp trade for ${symbol}`);
    }
  }

  private resetDailyCounterIfNeeded(): void {
    const now = new Date();
    const resetTime = new Date(this.dailyTradeCountResetTime);
    resetTime.setDate(resetTime.getDate() + 1);

    if (now >= resetTime) {
      this.dailyTradeCount = 0;
      this.dailyTradeCountResetTime = now;
      this.logger.info('Daily trade counter reset');
    }
  }

  private lastTradeSides: Map<string, OrderSide> = new Map();

  private getLastTradeSide(symbol: string): OrderSide {
    return this.lastTradeSides.get(symbol) || OrderSide.BUY;
  }

  private setLastTradeSide(symbol: string, side: OrderSide): void {
    this.lastTradeSides.set(symbol, side);
  }

  public getDailyTradeCount(): number {
    return this.dailyTradeCount;
  }

  public getTargetDailyTrades(): number {
    return this.config.targetDailyTrades;
  }
}