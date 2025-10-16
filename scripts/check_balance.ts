import { config } from '../src/config/config';
import { EnclaveClient } from '../src/core/exchange/EnclaveClient';

async function checkBalance() {
  try {
    console.log('Creating client with subaccount:', config.subaccountName);
    const client = new EnclaveClient(config.apiKey, config.apiSecret, config.environment, config.subaccountName);

    // Also try without subaccount
    console.log('Also checking main account...');
    const mainClient = new EnclaveClient(config.apiKey, config.apiSecret, config.environment);

    console.log('Fetching balance from subaccount...');
    const balances = await client.getBalance();

    console.log('Subaccount Balances:', JSON.stringify(balances, null, 2));

    console.log('Fetching balance from main account...');
    const mainBalances = await mainClient.getBalance();

    console.log('Main Account Balances:', JSON.stringify(mainBalances, null, 2));

    if (balances.length > 0) {
      const balance = balances[0];
      console.log(`Subaccount - Available: ${balance.available}, Total: ${balance.total}`);
    } else {
      console.log('No subaccount balances returned');
    }

    if (mainBalances.length > 0) {
      const balance = mainBalances[0];
      console.log(`Main Account - Available: ${balance.available}, Total: ${balance.total}`);
    } else {
      console.log('No main account balances returned');
    }
  } catch (error) {
    console.error('Error:', error);
  }
}

checkBalance();