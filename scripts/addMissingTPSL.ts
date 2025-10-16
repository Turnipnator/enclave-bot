#!/usr/bin/env npx tsx

import { EnclaveClient } from '../src/core/exchange/EnclaveClient';
import { OrderSide, OrderType, Environment } from '../src/core/exchange/types';
import Decimal from 'decimal.js';
import pino from 'pino';

const logger = pino({ name: 'AddMissingTPSL' });

async function addMissingTPSL() {
  const client = new EnclaveClient(
    'enclaveKeyId_712e935ac986ab440c5d9560f5253ba6',
    'enclaveApiSecret_07f314ed1491479fcd22e1a5f320309da558157a93536c4427db621d9613242d',
    Environment.PROD,
    'bot'
  );

  try {
    // Get current positions
    const positions = await client.getPositions();
    logger.info(`Found ${positions.length} positions`);

    // Get existing orders to avoid duplicates
    const existingOrders = await client.getOpenOrders();
    logger.info(`Found ${existingOrders.length} existing orders`);

    for (const position of positions) {
      const { symbol, side, entryPrice, quantity } = position;
      logger.info(`Processing position: ${symbol} ${side} ${quantity} @ ${entryPrice}`);

      // Check if this position already has protective orders
      const hasStopLoss = existingOrders.some(order =>
        order.symbol === symbol &&
        order.type === OrderType.STOP &&
        order.side !== side
      );

      const hasTakeProfit = existingOrders.some(order =>
        order.symbol === symbol &&
        order.type === OrderType.LIMIT &&
        order.side !== side
      );

      if (hasStopLoss && hasTakeProfit) {
        logger.info(`${symbol} already has both TP and SL orders`);
        continue;
      }

      // Calculate stop loss (2.5% from entry)
      const stopLossPrice = side === OrderSide.BUY
        ? entryPrice.times(0.975)  // 2.5% below entry for longs
        : entryPrice.times(1.025); // 2.5% above entry for shorts

      // Calculate take profit (4% from entry)
      const takeProfitPrice = side === OrderSide.BUY
        ? entryPrice.times(1.04)   // 4% above entry for longs
        : entryPrice.times(0.96);  // 4% below entry for shorts

      const oppositeSide = side === OrderSide.BUY ? OrderSide.SELL : OrderSide.BUY;

      // Place stop loss if missing
      if (!hasStopLoss) {
        try {
          const stopOrder = await client.addOrder(
            symbol,
            oppositeSide,
            quantity,
            OrderType.STOP,
            stopLossPrice
          );
          logger.info(`✅ Stop loss placed: ${stopOrder.id} at ${stopLossPrice.toFixed(2)}`);
        } catch (error: any) {
          logger.error({ error: error.message }, `❌ Failed to place stop loss for ${symbol}`);
        }
      }

      // Place take profit if missing
      if (!hasTakeProfit) {
        try {
          const tpOrder = await client.addOrder(
            symbol,
            oppositeSide,
            quantity,
            OrderType.LIMIT,
            takeProfitPrice
          );
          logger.info(`✅ Take profit placed: ${tpOrder.id} at ${takeProfitPrice.toFixed(2)}`);
        } catch (error: any) {
          logger.error({ error: error.message }, `❌ Failed to place take profit for ${symbol}`);
        }
      }
    }

    // Show final status
    const finalOrders = await client.getOpenOrders();
    logger.info(`\n🎯 Final status: ${finalOrders.length} total orders`);
    for (const order of finalOrders) {
      logger.info(`  ${order.symbol} ${order.side} ${order.type} @ ${order.price || 'MARKET'}`);
    }

  } catch (error: any) {
    logger.error({
      error: error.message,
      stack: error.stack,
      response: error.response?.data
    }, 'Failed to add missing TP/SL orders');
  }
}

// Run the script
addMissingTPSL().catch(console.error);