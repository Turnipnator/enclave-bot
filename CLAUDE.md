# Enclave Trading Bot - Claude Code Instructions

## CRITICAL RULES

1. **DO NOT modify the trading strategy** - The momentum threshold (0.70), TP (1.3%), SL (5%), and LONG-only approach mirror the proven Binance bot strategy. Do not change unless explicitly requested.

2. **Always backup before significant changes** - Create a backup on VPS before modifying core logic.

3. **Test on VPS after changes** - Always verify the container is healthy after deployment.

---

## Project Overview

This is a cryptocurrency perpetuals trading bot for Enclave Markets exchange. It uses a momentum-based breakout strategy aligned with the successful Binance bot approach.

### Strategy (Aligned with Binance Bot)
- **Direction**: LONG only (shorts disabled)
- **Momentum Threshold**: 0.70
- **Take Profit**: 1.3%
- **Stop Loss**: 5% trailing stop
- **Position Size**: $100 per trade

---

## Project Structure

```
enclavebot-master/
├── src/
│   ├── index.ts                    # Main entry point
│   ├── core/
│   │   ├── exchange/
│   │   │   └── EnclaveClient.ts    # API client (REST + WebSocket)
│   │   ├── strategy/
│   │   │   └── BreakoutStrategy.ts # THE strategy - don't touch unless asked
│   │   ├── indicators/             # Technical indicators
│   │   └── risk/                   # Risk management
│   ├── services/
│   │   ├── data/                   # Market data handling
│   │   └── risk/                   # Risk manager service
│   ├── config/                     # Configuration
│   └── utils/                      # Utilities
├── data/                           # Runtime data (persisted)
│   └── trailing_stops.json         # Trailing stop state
├── logs/                           # Log files
├── docker-compose.yml              # Container configuration
├── Dockerfile                      # Build instructions
├── .env                            # Secrets and config (not in git)
├── package.json                    # Dependencies
└── tsconfig.json                   # TypeScript config
```

---

## Trading Strategy (DO NOT MODIFY)

### Entry Criteria
- EMA Stack: Bullish trend (EMA 20 > 50 > 200)
- Momentum Score: >= 0.70
- Volume: >= 1.5x average
- Direction: LONG only (BEARISH signals return null)

### Exit Criteria
- Take Profit: 1.3% gain
- Stop Loss: 5% trailing stop
- Tracks highest price and trails down

### Key Code Values (in BreakoutStrategy.ts)
```typescript
private readonly TAKE_PROFIT_THRESHOLD = 1.3;
private readonly STOP_LOSS_PERCENT = 5;
private readonly MOMENTUM_THRESHOLD = 0.70;
```

### LONG Only Mode
```typescript
if (emaStackTrend === 'BEARISH') {
  this.logger.debug(`${symbol}: EMA stack is BEARISH - LONG only mode, no shorts`);
  return null;
}
```

---

## Configuration

### Environment Variables (.env)
```bash
# API Keys
ENCLAVE_API_KEY=xxx
ENCLAVE_API_SECRET=xxx
ENCLAVE_ENV=PROD

# Trading
TRADING_MODE=live
TRADING_PAIRS=BTC-USD.P,ETH-USD.P,SOL-USD.P,AVAX-USD.P,XRP-USD.P,BNB-USD.P,DOGE-USD.P,LINK-USD.P,SUI-USD.P
POSITION_SIZE=100           # $100 per position
MAX_POSITIONS=6
MAX_DAILY_LOSS=30

# Strategy
LOOKBACK_PERIOD=20
VOLUME_MULTIPLIER=1.5       # Require 1.5x volume
TRAILING_STOP_PERCENT=5

# Telegram
TELEGRAM_BOT_TOKEN=xxx
TELEGRAM_CHAT_ID=xxx
TELEGRAM_ENABLED=true

# Logging
LOG_LEVEL=debug
```

---

## VPS Deployment

### Server Details
- **VPS**: Contabo (same as Binance bot)
- **IP**: 109.199.105.63
- **Path**: /opt/enclave-bot
- **Container**: enclave-trading-bot

### SSH Access
```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63
```

### Standard Deploy (after code changes)
```bash
# 1. Commit and push locally
git add . && git commit -m "message" && git push origin main

# 2. Sync VPS and rebuild
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "cd /opt/enclave-bot && git fetch origin main && git reset --hard origin/main && docker compose down && docker compose build && docker compose up -d"
```

### Quick Restart (no code changes)
```bash
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "cd /opt/enclave-bot && docker compose restart"
```

### Check Status
```bash
# Container health
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker ps | grep enclave"

# Recent logs
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker logs --tail 50 enclave-trading-bot"

# Check for errors
ssh -i ~/.ssh/id_ed25519_vps root@109.199.105.63 "docker logs enclave-trading-bot 2>&1 | grep -i error | tail -10"
```

---

## Development Commands

### Local Development
```bash
pnpm install              # Install dependencies
pnpm build               # Build TypeScript
pnpm dev                 # Run with hot-reload
```

### Testing
```bash
pnpm test                # Run all tests
pnpm test:unit           # Unit tests only
pnpm typecheck           # TypeScript type checking
pnpm lint                # ESLint
```

### Emergency Stop
```bash
pnpm stop-all            # Cancel all orders and close positions
```

---

## Telegram Integration

Bot sends notifications for:
- Trade opened (entry price, size, stop loss)
- Trade closed (P&L, reason)
- Errors and alerts

---

## Docker Configuration

### Logging (prevents disk fill)
```yaml
logging:
  driver: "json-file"
  options:
    max-size: "10m"
    max-file: "3"
```

### Resource Limits
- CPU: 1.0 core max
- Memory: 512MB max

### Health Check
Basic Node.js health check every 30 seconds.

### Data Persistence
- `./logs` mounted to `/app/logs`
- `./data` mounted to `/app/data`

---

## Enclave Exchange Specifics

- **API Endpoint**: `api.enclave.trade`
- **WebSocket**: `wss://api.enclave.trade/ws`
- **Perpetuals Format**: `BTC-USD.P`, `ETH-USD.P`, etc.
- **Encrypted Exchange**: Orders hidden until execution
- **Funding Rates**: Hourly on perpetuals
- **Subaccount**: Using "Bot" subaccount for isolation
- **API Docs**: https://docs.enclave.market/

---

## Common Tasks

### Check why no trades are happening
```bash
docker logs enclave-trading-bot 2>&1 | grep -i 'momentum\|threshold\|signal' | tail -20
```

### Adjust position sizing
Edit `.env`:
```bash
POSITION_SIZE=100  # USD amount per position
```

### Check open positions
```bash
docker logs enclave-trading-bot 2>&1 | grep -i 'position\|opened\|closed' | tail -20
```

### View WebSocket status
```bash
docker logs enclave-trading-bot 2>&1 | grep -i 'websocket\|connected\|disconnected' | tail -10
```

---

## Troubleshooting

### Container keeps restarting
```bash
docker logs --tail 100 enclave-trading-bot
```

### WebSocket disconnections
The bot has built-in reconnection logic. If persistent, check:
- Network stability
- Enclave exchange status
- API rate limits

### No signals generating
- Check if market is in consolidation (low momentum)
- Verify WebSocket is receiving data
- Check volume multiplier isn't too high

### API errors
Usually rate limiting. The bot has retry logic with exponential backoff.

---

## Other Bots on Same VPS

For reference:
- **Binance Bot**: /opt/Binance_Bot (Python, most mature)
- **Hyperliquid Bot**: /opt/hyperliquid-bot (TypeScript)
- **Gold Bot**: /opt/Oanda_Gold

All use similar patterns: Docker Compose, Telegram notifications, momentum strategies.

---

## Key Differences from Binance Bot

| Aspect | Binance Bot | Enclave Bot |
|--------|-------------|-------------|
| Language | Python | TypeScript |
| Exchange | Binance Spot | Enclave Perpetuals |
| Position Size | ~$200 (20% of balance) | $100 fixed |
| Data Feed | REST polling | WebSocket real-time |
| Leverage | None (spot) | Available (not used) |

---

## Notes for Claude

When working on this project:
1. **TypeScript strict mode** - Follow existing type patterns
2. **Use pnpm** - Not npm or yarn
3. **Test in paper mode first** - Set `TRADING_MODE=paper`
4. **Match Binance bot patterns** - Keep strategies aligned
5. **Check WebSocket health** - Core to data feed
6. **Respect rate limits** - Enclave has API throttling
