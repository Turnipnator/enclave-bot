#!/usr/bin/env npx tsx

import { EnclaveClient } from '../src/core/exchange/EnclaveClient';
import { Environment } from '../src/core/exchange/types';

const client = new EnclaveClient(
  'enclaveKeyId_712e935ac986ab440c5d9560f5253ba6',
  'enclaveApiSecret_07f314ed1491479fcd22e1a5f320309da558157a93536c4427db621d9613242d',
  Environment.PROD
);

async function cleanupSOLOrders() {
  try {
    console.log('🧹 Cleaning Up Excess SOL TP Orders...\n');

    // Get SOL position details
    const positions = await client.getPositions();
    const solPos = positions.find(p => p.symbol === 'SOL-USD.P');

    if (!solPos) {
      console.log('❌ SOL position not found');
      return;
    }

    const positionSize = parseFloat(solPos.quantity?.toString() || '0');
    console.log(`📊 SOL Position: ${positionSize} SOL`);

    // Get all SOL LIMIT orders
    const orders = await client.getOpenOrders();
    const solLimitOrders = orders.filter(o =>
      o.symbol === 'SOL-USD.P' &&
      o.type === 'LIMIT' &&
      o.side === 'SELL' &&
      o.status === 'OPEN'
    );

    console.log(`🎯 Found ${solLimitOrders.length} SOL LIMIT sell orders:`);
    solLimitOrders.forEach((order, index) => {
      console.log(`  ${index + 1}. ${order.id} - ${order.quantity?.toString()} @ $${order.price?.toString()}`);
    });

    // Calculate how many orders we need (should be 1 for the position size)
    const neededOrders = 1; // Only need 1 TP order for the 0.1 SOL position
    const excessOrders = solLimitOrders.length - neededOrders;

    if (excessOrders <= 0) {
      console.log('✅ No excess orders to cancel');
      return;
    }

    console.log(`\n🚨 Need to cancel ${excessOrders} excess orders (keeping ${neededOrders})`);

    // Cancel excess orders (keep the first one, cancel the rest)
    const ordersToCancel = solLimitOrders.slice(1); // Skip first order, cancel the rest

    for (let i = 0; i < ordersToCancel.length; i++) {
      const order = ordersToCancel[i];
      try {
        console.log(`Cancelling order ${i + 1}/${ordersToCancel.length}: ${order.id}...`);
        const success = await client.cancelOrder(order.id);
        if (success) {
          console.log(`✅ Cancelled order ${order.id}`);
        } else {
          console.log(`⚠️ Failed to cancel order ${order.id}`);
        }
      } catch (error: any) {
        console.error(`❌ Error cancelling ${order.id}: ${error.message}`);
      }
    }

    // Verify final state
    console.log('\n📊 Final SOL Order Status:');
    const finalOrders = await client.getOpenOrders();
    const finalSolOrders = finalOrders.filter(o =>
      o.symbol === 'SOL-USD.P' &&
      o.type === 'LIMIT' &&
      o.side === 'SELL' &&
      o.status === 'OPEN'
    );

    console.log(`Remaining SOL LIMIT orders: ${finalSolOrders.length}`);
    finalSolOrders.forEach(order => {
      console.log(`  ${order.id} - ${order.quantity?.toString()} @ $${order.price?.toString()}`);
    });

    if (finalSolOrders.length === 1) {
      console.log('✅ SOL position now has correct TP protection!');
    } else {
      console.log(`⚠️ SOL still has ${finalSolOrders.length} orders - may need manual cleanup`);
    }

  } catch (error: any) {
    console.error('❌ Failed to cleanup SOL orders:', error.message);
  }
}

cleanupSOLOrders().catch(console.error);