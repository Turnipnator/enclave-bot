// Set test environment variables
process.env.ENCLAVE_API_KEY = 'test_api_key';
process.env.ENCLAVE_API_SECRET = 'test_api_secret';
process.env.ENCLAVE_ENV = 'TESTNET';
process.env.TRADING_MODE = 'paper';
process.env.LOG_LEVEL = 'error';

// Mock WebSocket
jest.mock('ws');

// Mock axios
jest.mock('axios');

// Global test timeout
jest.setTimeout(10000);