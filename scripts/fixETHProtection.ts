#!/usr/bin/env npx tsx

import { EnclaveClient } from '../src/core/exchange/EnclaveClient';
import { OrderSide, OrderType, Environment } from '../src/core/exchange/types';
import Decimal from 'decimal.js';

const client = new EnclaveClient(
  'enclaveKeyId_712e935ac986ab440c5d9560f5253ba6',
  'enclaveApiSecret_07f314ed1491479fcd22e1a5f320309da558157a93536c4427db621d9613242d',
  Environment.PROD
);

async function fixETHProtection() {
  try {
    console.log('🔧 Adding Missing TP Protection for ETH Position...\n');

    // Get ETH position details
    const positions = await client.getPositions();
    const ethPos = positions.find(p => p.symbol === 'ETH-USD.P');

    if (!ethPos) {
      console.log('❌ ETH position not found');
      return;
    }

    const entryPrice = parseFloat(ethPos.entryPrice?.toString() || '0');
    const quantity = ethPos.quantity;

    console.log(`📊 ETH Position: ${quantity?.toString()} @ $${entryPrice.toFixed(2)}`);

    // Calculate 4% take profit with proper rounding (ETH uses 0.1 increment)
    const tpRaw = entryPrice * 1.04;
    const tpRounded = Math.round(tpRaw * 10) / 10; // Round to 0.1
    const takeProfitPrice = new Decimal(tpRounded);

    console.log(`🎯 Take Profit Level: $${takeProfitPrice.toFixed(2)} (+4%)`);

    // Check if TP order already exists
    const orders = await client.getOpenOrders();
    const ethLimitOrders = orders.filter(o => o.symbol === 'ETH-USD.P' && o.type === 'LIMIT' && o.side === 'SELL');

    if (ethLimitOrders.length > 0) {
      console.log('⚠️ ETH already has LIMIT orders:');
      ethLimitOrders.forEach(o => {
        console.log(`  ${o.side} ${o.quantity?.toString()} @ $${o.price?.toString()}`);
      });
      console.log('Skipping TP order placement');
      return;
    }

    // Place LIMIT sell order for take profit
    console.log('\n📈 Placing Take Profit LIMIT order...');
    const tpOrder = await client.addOrder(
      'ETH-USD.P',
      OrderSide.SELL,
      quantity,
      OrderType.LIMIT,
      takeProfitPrice
    );

    console.log(`✅ ETH Take Profit order placed successfully!`);
    console.log(`   Order ID: ${tpOrder.id}`);
    console.log(`   Price: $${takeProfitPrice.toFixed(2)}`);
    console.log(`   Quantity: ${quantity?.toString()} ETH`);

    // Get current price to show distance
    const marketData = await client.getMarketData('ETH-USD.P');
    const currentPrice = parseFloat(marketData.last.toString());
    const distanceToTP = ((takeProfitPrice.toNumber() - currentPrice) / currentPrice * 100);

    console.log(`\n📊 Status:`);
    console.log(`   Current Price: $${currentPrice.toFixed(2)}`);
    console.log(`   Distance to TP: ${distanceToTP.toFixed(2)}%`);
    console.log(`   ETH position is now protected!`);

  } catch (error: any) {
    console.error('❌ Failed to add ETH protection:', error.message);
    if (error.response?.data) {
      console.error('API Error:', error.response.data);
    }
  }
}

fixETHProtection().catch(console.error);