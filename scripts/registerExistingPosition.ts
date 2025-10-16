#!/usr/bin/env npx tsx

import { EnclaveClient } from '../src/core/exchange/EnclaveClient';
import { BreakoutStrategy } from '../src/core/strategy/BreakoutStrategy';
import { OrderSide, Environment } from '../src/core/exchange/types';
import Decimal from 'decimal.js';
import pino from 'pino';

const logger = pino({ name: 'RegisterExistingPosition' });

async function registerExistingPosition() {
  const client = new EnclaveClient(
    'enclaveKeyId_712e935ac986ab440c5d9560f5253ba6',
    'enclaveApiSecret_07f314ed1491479fcd22e1a5f320309da558157a93536c4427db621d9613242d',
    Environment.PROD
  );

  const strategy = new BreakoutStrategy(client, {
    lookbackPeriod: 20,
    volumeMultiplier: 1.1,
    trailingStopPercent: 2.5,
    breakoutBuffer: 0.1,
    takeProfitPercent: 4,
    positionSize: new Decimal(30) // USD amount
  });

  try {
    // Get current positions
    const positions = await client.getPositions();
    logger.info(`Found ${positions.length} positions to register`);

    for (const position of positions) {
      logger.info(`Registering position: ${position.symbol} ${position.side} ${position.quantity?.toString()} @ $${position.entryPrice?.toString()}`);

      // Calculate TP/SL levels based on strategy config
      const stopLossPercent = position.side === OrderSide.BUY ? 0.975 : 1.025; // 2.5%
      const takeProfitPercent = position.side === OrderSide.BUY ? 1.04 : 0.96;  // 4%

      const stopLoss = position.entryPrice?.times(stopLossPercent);
      const takeProfit = position.entryPrice?.times(takeProfitPercent);

      if (!stopLoss || !takeProfit) {
        logger.error(`Could not calculate TP/SL for ${position.symbol}`);
        continue;
      }

      // Register the existing position with the strategy
      await strategy.registerExistingPosition(
        position.symbol,
        position.side,
        position.entryPrice,
        position.quantity,
        stopLoss,
        takeProfit
      );

      logger.info(`✅ Position registered with monitoring:`);
      logger.info(`   Entry: $${position.entryPrice?.toString()}`);
      logger.info(`   Stop Loss: $${stopLoss.toString()}`);
      logger.info(`   Take Profit: $${takeProfit.toString()}`);

      // Get current price to show status
      const marketData = await client.getMarketData(position.symbol);
      const currentPrice = marketData.last;
      const unrealizedPnl = position.unrealizedPnl || new Decimal(0);

      logger.info(`   Current Price: $${currentPrice.toString()}`);
      logger.info(`   Unrealized P&L: ${unrealizedPnl.toString()}`);

      // Check if position is already at risk
      if (position.side === OrderSide.BUY && currentPrice.lessThanOrEqualTo(stopLoss)) {
        logger.warn(`⚠️ Position is already below stop-loss level!`);
      }
    }

    logger.info(`🎯 All existing positions are now registered with the monitoring system`);
    logger.info(`The bot will now monitor these positions and execute stop-losses when needed`);

  } catch (error: any) {
    logger.error({
      error: error.message,
      response: error.response?.data
    }, 'Failed to register existing positions');
  }
}

registerExistingPosition().catch(console.error);