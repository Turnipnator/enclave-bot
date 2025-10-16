#!/usr/bin/env tsx

import pino from 'pino';
import { config } from '../src/config/config';
import { EnclaveClient } from '../src/core/exchange/EnclaveClient';

const logger = pino({
  name: 'EmergencyStop',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true,
    },
  },
});

async function emergencyStop(): Promise<void> {
  logger.error('EMERGENCY STOP - Closing all positions and cancelling all orders');

  const client = new EnclaveClient(config.apiKey, config.apiSecret, config.environment);

  try {
    await client.connect();

    // Cancel all open orders
    const openOrders = await client.getOpenOrders();
    logger.info(`Found ${openOrders.length} open orders`);

    for (const order of openOrders) {
      try {
        await client.cancelOrder(order.id);
        logger.info(`Cancelled order: ${order.id} (${order.symbol} ${order.side} ${order.quantity})`);
      } catch (error) {
        logger.error(`Failed to cancel order ${order.id}:`, error);
      }
    }

    // Close all positions
    const positions = await client.getPositions();
    logger.info(`Found ${positions.length} open positions`);

    for (const position of positions) {
      try {
        await client.closePosition(position.symbol);
        logger.info(`Closed position: ${position.symbol} (${position.side} ${position.quantity})`);
      } catch (error) {
        logger.error(`Failed to close position ${position.symbol}:`, error);
      }
    }

    // Get final balance
    const balances = await client.getBalance();
    logger.info('Final balances:');
    for (const balance of balances) {
      logger.info(`  ${balance.asset}: ${balance.total.toFixed(4)}`);
    }

    client.disconnect();
    logger.info('Emergency stop completed');
  } catch (error) {
    logger.error('Emergency stop failed:', error);
    process.exit(1);
  }
}

emergencyStop()
  .then(() => process.exit(0))
  .catch((error) => {
    logger.error('Fatal error:', error);
    process.exit(1);
  });