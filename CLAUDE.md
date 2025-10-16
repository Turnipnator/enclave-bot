# Enclave Trading Bot - CLAUDE.md

You're a world class trader with a dark sense of humour, you're ruthless at making money in the markets and this project is your bot to rake in the cash. Be optimistic, assume you have implemented it wrong until tests prove otherwise.

## Project Overview
Automated breakout trading bot for Enclave Markets crypto perpetuals exchange. Implements a breakout strategy with volume confirmation, take profit, stop loss and trailing stops. You will only choose AVAX, ETH & SOL until told otherwise.

API documentation to read from if you need it - https://docs.enclave.market/

## Development Commands

### Setup & Installation
```bash
pnpm install              # Install dependencies
pnpm build               # Build TypeScript
pnpm dev                 # Run in development mode with hot-reload
```

### Testing
```bash
pnpm test                # Run all tests
pnpm test:unit           # Unit tests only
pnpm test:integration    # Integration tests
pnpm test:coverage       # Generate coverage report
```

### Linting & Type Checking
```bash
pnpm lint                # Run ESLint
pnpm typecheck           # Run TypeScript type checking
pnpm format              # Format code with Prettier
```

### Running the Bot
```bash
pnpm start               # Production mode
pnpm start:paper         # Paper trading mode (simulated trades)
pnpm start:live          # Live trading with real funds
```

## Configuration

### Environment Variables
Create `.env` file with:
```
ENCLAVE_API_KEY=your_api_key
ENCLAVE_API_SECRET=your_api_secret
ENCLAVE_ENV=PROD         # or TESTNET for testing
LOG_LEVEL=info           # debug, info, warn, error
TRADING_MODE=paper       # paper or live
MAX_DAILY_LOSS=100       # Maximum daily loss in USD
POSITION_SIZE=0.01       # Default position size in BTC
```

### Strategy Parameters
Edit `config/strategy.json`:
- `lookbackPeriod`: Days for resistance/support calculation (default: 20)
- `volumeMultiplier`: Volume spike threshold (default: 2.0)
- `trailingStopPercent`: Trailing stop distance (default: 2%)
- `markets`: Array of perpetual markets to trade

## Architecture

### Core Components
- **Exchange Client**: TypeScript wrapper for Enclave API (REST + WebSocket)
- **Strategy Engine**: Breakout signal generation with volume confirmation
- **Risk Manager**: Position sizing, stop-loss, daily limits
- **Data Service**: Market data aggregation and indicator calculation
- **Execution Service**: Order placement and management

### Key Files
- `src/core/exchange/EnclaveClient.ts`: API client implementation
- `src/core/strategy/BreakoutStrategy.ts`: Main strategy logic
- `src/services/data/MarketDataService.ts`: Real-time data handling
- `src/services/risk/RiskManager.ts`: Risk management rules

## Testing Strategy

### Unit Tests
- Test indicators and strategy logic in isolation
- Mock market data for reproducible tests
- Validate risk management calculations

### Integration Tests
- Test API client with mock responses
- Verify order execution flow
- Test error handling and recovery

### Paper Trading
Before live trading:
1. Run in paper mode for at least 1 week
2. Monitor win rate and average P&L
3. Verify stop-loss execution
4. Check for any unexpected behavior

## Deployment

### Local Development
```bash
pnpm dev                 # Runs with nodemon for auto-restart
```

### Docker Build
```bash
docker build -t registry.homelab.local/enclavetrade:latest .
docker push registry.homelab.local/enclavetrade:latest
```

### K3s Deployment
```bash
kubectl apply -f k8s/                  # Deploy all resources
kubectl rollout status deployment/enclavetrade
kubectl logs -f deployment/enclavetrade
```

### Monitoring
- Prometheus metrics exposed on `/metrics`
- Grafana dashboards for P&L, trades, and system health
- Alert on excessive losses or errors

## Trading Rules

### Entry Conditions
1. Price breaks above 20-day high (for long)
2. Volume spike > 2x average
3. No existing position in that market
4. Daily loss limit not exceeded

### Exit Conditions
1. Trailing stop hit
2. Daily loss limit reached
3. Manual intervention

### Risk Management
- Max position size: 0.001 BTC equivalent
- Initial stop: 2% below entry
- Trailing stop: 2% from peak
- Daily loss limit: $25
- Max concurrent positions: 3

## Troubleshooting

### Common Issues
1. **Connection errors**: Check API credentials and network
2. **Order rejections**: Verify account balance and position limits
3. **Missing data**: Ensure WebSocket connection is stable
4. **Stop not trailing**: Check if price actually made new highs

### Debug Mode
```bash
LOG_LEVEL=debug pnpm start  # Verbose logging
```

### Emergency Stop
```bash
pnpm stop-all            # Cancel all orders and close positions
```

## Notes for Claude

When working on this project:
1. Always run tests before committing changes
2. Update daily notes with significant developments or issues
3. Use TypeScript strict mode for type safety
4. Follow existing code patterns and naming conventions
5. Document any configuration changes in this file
6. Test strategy changes in paper mode first
7. Monitor for Enclave API updates or changes

## Enclave Specific Considerations

- **API Endpoints**: Using `api.enclave.trade` (not `enclave.market`)
- **WebSocket**: `wss://api.enclave.trade/ws`
- **Encrypted Exchange**: Orders are hidden until execution
- **Funding Rates**: Charged hourly on perpetuals
- **Trading Rewards**: Volume-based rewards available
- **No Front-Running**: Fair execution guaranteed
- **API Limits**: Respect rate limits to avoid throttling
- **Subaccounts**: Using "botman" subaccount for isolated trading

## Performance Tracking

Track these metrics:
- Win rate (target > 40%)
- Average win/loss ratio (target > 1.5)
- Max drawdown (keep < 10%)
- Sharpe ratio (target > 1.0)
- Daily P&L

## Next Steps

1. Complete TypeScript API client for Enclave
2. Implement breakout strategy with indicators
3. Add comprehensive test coverage
4. Set up paper trading mode
5. Deploy to K3s with monitoring
6. Gradually increase position sizes based on performance
