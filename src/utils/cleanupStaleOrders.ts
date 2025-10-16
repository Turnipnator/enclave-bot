#!/usr/bin/env ts-node

import { EnclaveClient } from '../core/exchange/EnclaveClient';
import { Environment } from '../core/exchange/types';
import pino from 'pino';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const logger = pino({ name: 'StaleOrderCleanup' });

interface OrderCleanupStats {
  totalOrders: number;
  currentPositions: string[];
  legitimateOrders: number;
  staleOrders: number;
  cancelledOrders: number;
  failedCancellations: string[];
}

async function cleanupStaleOrders(): Promise<OrderCleanupStats> {
  const stats: OrderCleanupStats = {
    totalOrders: 0,
    currentPositions: [],
    legitimateOrders: 0,
    staleOrders: 0,
    cancelledOrders: 0,
    failedCancellations: []
  };

  // Initialize Enclave client
  const client = new EnclaveClient(
    process.env.ENCLAVE_API_KEY!,
    process.env.ENCLAVE_API_SECRET!,
    process.env.ENCLAVE_ENV === 'TESTNET' ? Environment.TESTNET : Environment.PROD
  );

  try {
    logger.info('Starting stale order cleanup process...');

    // Get all current positions
    logger.info('Fetching current positions...');
    const positions = await client.getPositions();
    stats.currentPositions = positions.map(p => p.symbol);
    logger.info(`Found ${positions.length} current positions: ${stats.currentPositions.join(', ')}`);

    // Get all open orders
    logger.info('Fetching all open orders...');
    const allOrders = await client.getOpenOrders();
    stats.totalOrders = allOrders.length;
    logger.info(`Found ${stats.totalOrders} total open orders`);

    if (stats.totalOrders === 0) {
      logger.info('No open orders found - nothing to clean up');
      return stats;
    }

    // Group orders by symbol
    const ordersBySymbol: { [symbol: string]: any[] } = {};
    allOrders.forEach(order => {
      if (!ordersBySymbol[order.symbol]) {
        ordersBySymbol[order.symbol] = [];
      }
      ordersBySymbol[order.symbol].push(order);
    });

    logger.info('Orders by symbol:');
    Object.entries(ordersBySymbol).forEach(([symbol, orders]) => {
      logger.info(`  ${symbol}: ${orders.length} orders`);
      orders.forEach(order => {
        logger.info(`    - Order ${order.id}: ${order.type} ${order.side} ${order.quantity} @ ${order.price || 'market'}`);
      });
    });

    // Identify legitimate orders (should have orders for current positions only)
    for (const symbol of stats.currentPositions) {
      const ordersForSymbol = ordersBySymbol[symbol] || [];
      stats.legitimateOrders += ordersForSymbol.length;
      logger.info(`${symbol}: ${ordersForSymbol.length} legitimate orders (has active position)`);
    }

    // Identify stale orders (orders for symbols without positions)
    const staleOrderSymbols = Object.keys(ordersBySymbol).filter(symbol =>
      !stats.currentPositions.includes(symbol)
    );

    for (const symbol of staleOrderSymbols) {
      const staleOrdersForSymbol = ordersBySymbol[symbol];
      stats.staleOrders += staleOrdersForSymbol.length;
      logger.warn(`Found ${staleOrdersForSymbol.length} stale orders for ${symbol} (no active position)`);
    }

    logger.info(`Summary: ${stats.legitimateOrders} legitimate orders, ${stats.staleOrders} stale orders`);

    // Ask for confirmation before canceling stale orders
    if (stats.staleOrders > 0) {
      logger.warn(`WARNING: About to cancel ${stats.staleOrders} stale orders for symbols: ${staleOrderSymbols.join(', ')}`);

      // In production, you might want to add a confirmation prompt
      // For now, let's be safe and just log what would be cancelled
      const shouldCancel = process.env.FORCE_CANCEL_STALE_ORDERS === 'true';

      if (shouldCancel) {
        logger.info('FORCE_CANCEL_STALE_ORDERS=true, proceeding with cancellation...');

        // Cancel stale orders
        for (const symbol of staleOrderSymbols) {
          const ordersToCancel = ordersBySymbol[symbol];
          logger.info(`Cancelling ${ordersToCancel.length} stale orders for ${symbol}...`);

          for (const order of ordersToCancel) {
            try {
              const success = await client.cancelOrder(order.id);
              if (success) {
                stats.cancelledOrders++;
                logger.info(`✓ Cancelled stale order ${order.id} for ${symbol}`);
              } else {
                stats.failedCancellations.push(order.id);
                logger.error(`✗ Failed to cancel stale order ${order.id} for ${symbol}`);
              }
              // Add small delay to avoid rate limiting
              await new Promise(resolve => setTimeout(resolve, 100));
            } catch (error: any) {
              stats.failedCancellations.push(order.id);
              logger.error(`✗ Error cancelling stale order ${order.id} for ${symbol}: ${error.message}`);
            }
          }
        }
      } else {
        logger.info('DRY RUN MODE: Set FORCE_CANCEL_STALE_ORDERS=true to actually cancel orders');
        logger.info('Stale orders that would be cancelled:');
        for (const symbol of staleOrderSymbols) {
          const ordersToCancel = ordersBySymbol[symbol];
          ordersToCancel.forEach(order => {
            logger.info(`  - Would cancel: Order ${order.id} for ${symbol} (${order.type} ${order.side})`);
          });
        }
      }
    } else {
      logger.info('✓ No stale orders found - all orders are for symbols with active positions');
    }

  } catch (error: any) {
    logger.error(`Error during cleanup process: ${error.message}`);
    throw error;
  }

  return stats;
}

// Run the cleanup if this file is executed directly
if (require.main === module) {
  cleanupStaleOrders()
    .then((stats) => {
      logger.info('Cleanup completed successfully!');
      logger.info('Final statistics:');
      logger.info(`Total orders: ${stats.totalOrders}`);
      logger.info(`Current positions: ${stats.currentPositions.join(', ')}`);
      logger.info(`Legitimate orders: ${stats.legitimateOrders}`);
      logger.info(`Stale orders: ${stats.staleOrders}`);
      logger.info(`Cancelled orders: ${stats.cancelledOrders}`);
      if (stats.failedCancellations.length > 0) {
        logger.info(`Failed cancellations: ${stats.failedCancellations.join(', ')}`);
      }
      process.exit(0);
    })
    .catch((error) => {
      logger.error('Cleanup failed:', error);
      process.exit(1);
    });
}

export { cleanupStaleOrders };