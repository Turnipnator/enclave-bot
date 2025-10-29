# Enclave Trading Bot

An automated cryptocurrency trading bot for [Enclave Markets](https://enclave.market) perpetuals exchange, featuring breakout strategies, volume farming, and TradingView webhook integration.

![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Node.js](https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=node.js&logoColor=white)
![Docker](https://img.shields.io/badge/Docker-2496ED?style=for-the-badge&logo=docker&logoColor=white)
![Kubernetes](https://img.shields.io/badge/Kubernetes-326CE5?style=for-the-badge&logo=kubernetes&logoColor=white)

## ✨ Features

- 🚀 **Breakout Trading Strategy** - Detects price breakouts with volume confirmation
- 📊 **Technical Indicators** - RSI, Bollinger Bands, ATR, SMA, EMA
- 🎯 **Volume Farming** - Automated high-frequency trading for rewards/points
- 🔔 **TradingView Integration** - Accept webhook alerts for external signals
- 📈 **Historical Data Loading** - Fetches OHLCV data from Binance for strategy initialization
- 🛡️ **Risk Management** - Position sizing, stop-loss, daily loss limits
- 🔄 **Position Recovery** - Automatically detects and manages existing positions on restart
- 🌐 **WebSocket Real-time Data** - Live market data streaming
- ☁️ **Cloud Native** - Docker containerized with Kubernetes deployment

## 🔗 Getting Started with Enclave Markets

This bot trades on **[Enclave Markets](https://enclave.trade?ref=turnipnator)** - a next-generation encrypted perpetuals exchange o$

- 🔐 **Fully Encrypted Order Book** - Your trades are hidden from MEV bots and front-runners
- 💰 **Trading Rewards** - Earn points and fee discounts through volume-based rewards
- ⚡ **Low Fees** - Competitive maker/taker fees with additional referral discounts
- 🛡️ **Fair Execution** - No information leakage, true DeFi privacy

### Sign Up with Referral Benefits

**Use this referral link to get started:** [https://enclave.trade?ref=turnipnator](https://enclave.trade?ref=turnipnator)

## 🚀 Quick Start

### Prerequisites

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- Enclave Markets account with API credentials
- (Optional) TradingView Pro for webhook alerts
- (Optional) Docker & Kubernetes for deployment

### Installation

```bash
# Clone the repository
git clone https://github.com/yourusername/enclavetrade.git
cd enclavetrade

# Install dependencies
pnpm install

# Configure environment
cp .env.example .env
# Edit .env with your API credentials

# Run the bot
pnpm dev          # Development mode
pnpm start:paper  # Paper trading
pnpm start:live   # Live trading (use with caution!)

# Emergency stop (cancel all orders and close positions)
pnpm stop-all
```

```

## 📡 TradingView Webhook Integration

### Setup Webhook Endpoint

1. **Local Testing with ngrok**:
```bash
ngrok http 3000
# Use the HTTPS URL in TradingView
```

2. **Production with Kubernetes**:
```bash
# Deploy with ngrok sidecar (see k8s/deployment-ngrok.yaml)
kubectl apply -f k8s/deployment-ngrok.yaml
```

### TradingView Alert Format
```json
{
  "ticker": "{{ticker}}",
  "action": "buy",
  "price": "{{close}}",
  "strategy": "breakout"
}
```

See [TRADINGVIEW_SETUP.md](TRADINGVIEW_SETUP.md) for complete webhook setup instructions.

## 🧪 Testing

```bash
# Run all tests
pnpm test

# Run with coverage
pnpm test:coverage

# Linting and type checking
pnpm lint
pnpm typecheck
```

## 📦 Deployment

### Docker

```bash
# Build for linux/amd64 (for Kubernetes)
docker buildx build --platform linux/amd64 -t enclavetrade:latest .

# Run locally
docker run -d --env-file .env -p 3000:3000 enclavetrade:latest
```

### Kubernetes

```bash
# Create namespace and secrets
kubectl create namespace enclavetrade
kubectl create secret generic enclavetrade-secrets --from-env-file=.env -n enclavetrade

# Deploy application
kubectl apply -f k8s/deployment-with-tunnel.yaml

# Check status
kubectl get pods -n enclavetrade
kubectl logs -n enclavetrade deployment/enclavetrade -f
```

## 📊 Configuration

### Environment Variables

| Variable | Description | Default | Required |
|----------|-------------|---------|----------|
| `ENCLAVE_API_KEY` | Enclave API Key | - | ✅ |
| `ENCLAVE_API_SECRET` | Enclave API Secret | - | ✅ |
| `ENCLAVE_ENV` | Environment (PROD/TESTNET) | PROD | ❌ |
| `TRADING_MODE` | Trading mode (paper/live) | paper | ❌ |
| `TRADING_PAIRS` | Comma-separated pairs | BTC-USD.P | ❌ |
| `POSITION_SIZE` | Position size per trade | 0.001 | ❌ |
| `MAX_DAILY_LOSS` | Maximum daily loss (USD) | 50 | ❌ |
| `LOG_LEVEL` | Logging level | info | ❌ |

## 🏗️ Project Structure

```
enclavetrade/
├── src/
│   ├── core/
│   │   ├── exchange/      # Enclave API client
│   │   ├── indicators/    # Technical indicators
│   │   ├── risk/         # Risk management
│   │   └── strategy/      # Trading strategies
│   ├── services/
│   │   ├── data/         # Historical data (Binance)
│   │   └── webhook/      # TradingView webhooks
│   └── config/           # Configuration
├── tests/                # Unit tests
├── k8s/                  # Kubernetes manifests
├── scripts/              # Utility scripts
└── docs/                 # Documentation
```

## 🛡️ Security

- ✅ No API keys or secrets in code
- ✅ Environment variables for sensitive data
- ✅ `.gitignore` configured properly
- ✅ Secrets management for Kubernetes
- ✅ Non-root Docker container
- ✅ Health checks and monitoring

## ⚠️ Risk Warning

**USE AT YOUR OWN RISK**

This bot is for educational purposes. Cryptocurrency trading carries substantial risk of loss. The authors are not responsible for any financial losses incurred through use of this software. Always:
- Start with paper trading
- Use small position sizes
- Set conservative risk limits
- Monitor the bot regularly
- Have an emergency stop plan

## 📝 Documentation

- [TRADINGVIEW_SETUP.md](TRADINGVIEW_SETUP.md) - Complete TradingView webhook guide
- [CLAUDE.md](CLAUDE.md) - Development guidelines and architecture
- [API Documentation](https://docs.enclave.market) - Enclave Markets API

## 🤝 Contributing

Contributions are welcome! Please:
1. Fork the repository
2. Create a feature branch
3. Write tests for new features
4. Ensure all tests pass
5. Submit a pull request

## 📄 License

MIT License - see [LICENSE](LICENSE) file for details.

## 🙏 Acknowledgments

- Built for the [Enclave Markets](https://enclave.market) community
- Uses [Binance API](https://binance-docs.github.io/apidocs/) for historical data
- Inspired by various open-source trading bots

---

**Remember**: Always test thoroughly with paper trading before using real funds!
