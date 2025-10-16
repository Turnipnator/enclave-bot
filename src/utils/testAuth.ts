#!/usr/bin/env ts-node

import { EnclaveClient } from '../core/exchange/EnclaveClient';
import { Environment } from '../core/exchange/types';
import pino from 'pino';
import * as dotenv from 'dotenv';

// Load environment variables
dotenv.config();

const logger = pino({ name: 'AuthTest' });

async function testAuthentication(): Promise<void> {
  const client = new EnclaveClient(
    process.env.ENCLAVE_API_KEY!,
    process.env.ENCLAVE_API_SECRET!,
    process.env.ENCLAVE_ENV === 'TESTNET' ? Environment.TESTNET : Environment.PROD
  );

  try {
    logger.info('Testing authenticated API calls...');

    // Test 1: Get positions (no query params)
    logger.info('Test 1: Getting all positions...');
    const positions = await client.getPositions();
    logger.info(`✓ Positions API call successful: ${positions.length} positions`);

    // Test 2: Get positions with query params (check if this also has issues)
    logger.info('Test 2: Getting positions for ETH-USD.P (with query params)...');
    const ethPositions = await client.getPositions('ETH-USD.P');
    logger.info(`✓ Positions with query params API call successful: ${ethPositions.length} ETH positions`);

    // Test 3: Get all orders (no query params)
    logger.info('Test 3: Getting all open orders...');
    const allOrders = await client.getOpenOrders();
    logger.info(`✓ All orders API call successful: ${allOrders.length} orders`);

    // Test 4: Get orders with query params (the main problematic case)
    logger.info('Test 4: Getting orders for ETH-USD.P (with query params)...');
    const ethOrders = await client.getOpenOrders('ETH-USD.P');
    logger.info(`✓ Orders with query params API call successful: ${ethOrders.length} ETH orders`);

    // Test 5: Get balance (no query params, but important for bot)
    logger.info('Test 5: Getting account balance...');
    const balance = await client.getBalance();
    logger.info(`✓ Balance API call successful: ${balance.length} balance entries`);

    logger.info('🎉 All authentication tests passed! The 401 error fix is working correctly.');

  } catch (error: any) {
    logger.error(`❌ Authentication test failed: ${error.message}`);
    if (error.response) {
      logger.error(`Status: ${error.response.status}`);
      logger.error(`Data: ${JSON.stringify(error.response.data)}`);
    }
    throw error;
  }
}

// Run the auth test if this file is executed directly
if (require.main === module) {
  testAuthentication()
    .then(() => {
      logger.info('✅ Authentication test completed successfully!');
      process.exit(0);
    })
    .catch((error) => {
      logger.error('❌ Authentication test failed:', error);
      process.exit(1);
    });
}

export { testAuthentication };