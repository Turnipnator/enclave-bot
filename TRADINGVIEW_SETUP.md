# TradingView Alert Setup for Enclave Trading Bot

## Prerequisites
1. TradingView Pro/Pro+/Premium account (for webhook alerts)
2. Bot running with webhook server enabled (port 3000)
3. Tunnel setup (ngrok/Cloudflare) for external access

## Webhook URL Setup

### Local Testing
```
http://localhost:3000/webhook/tradingview
```

### With ngrok
```bash
# Install and run ngrok
brew install ngrok/ngrok/ngrok
ngrok http 3000

# Use the HTTPS URL provided, e.g.:
https://abc123.ngrok.io/webhook/tradingview
```

## Recommended Trading Signals

### 1. Breakout Strategy (Primary)
**Indicator:** Price crossing above/below resistance/support with volume confirmation

```pinescript
//@version=5
indicator("Enclave Breakout", overlay=true)

// Parameters
length = input.int(20, "Lookback Period")
volMultiplier = input.float(2.0, "Volume Multiplier")

// Calculate resistance and support
resistance = ta.highest(high, length)
support = ta.lowest(low, length)

// Volume spike detection
avgVolume = ta.sma(volume, 20)
volumeSpike = volume > avgVolume * volMultiplier

// Breakout conditions
bullishBreakout = close > resistance[1] and volumeSpike
bearishBreakout = close < support[1] and volumeSpike

// Plot signals
plotshape(bullishBreakout, style=shape.triangleup, location=location.belowbar, color=color.green, size=size.small)
plotshape(bearishBreakout, style=shape.triangledown, location=location.abovebar, color=color.red, size=size.small)

// Alert conditions
alertcondition(bullishBreakout, title="Bullish Breakout", message='{"ticker":"{{ticker}}","action":"buy","price":"{{close}}","strategy":"breakout"}')
alertcondition(bearishBreakout, title="Bearish Breakout", message='{"ticker":"{{ticker}}","action":"sell","price":"{{close}}","strategy":"breakout"}')
```

### 2. RSI Divergence
**Indicator:** RSI divergence from price action

```pinescript
//@version=5
indicator("RSI Divergence Alerts", overlay=false)

rsiLength = input.int(14, "RSI Length")
rsi = ta.rsi(close, rsiLength)

// Bullish divergence: price makes lower low, RSI makes higher low
bullishDiv = ta.lowest(low, 5) < ta.lowest(low[5], 5) and ta.lowest(rsi, 5) > ta.lowest(rsi[5], 5)

// Bearish divergence: price makes higher high, RSI makes lower high
bearishDiv = ta.highest(high, 5) > ta.highest(high[5], 5) and ta.highest(rsi, 5) < ta.highest(rsi[5], 5)

// Alert conditions
alertcondition(bullishDiv and rsi < 30, title="Bullish RSI Divergence", message='{"ticker":"{{ticker}}","action":"buy","price":"{{close}}","strategy":"rsi_divergence"}')
alertcondition(bearishDiv and rsi > 70, title="Bearish RSI Divergence", message='{"ticker":"{{ticker}}","action":"sell","price":"{{close}}","strategy":"rsi_divergence"}')
```

### 3. Bollinger Band Squeeze
**Indicator:** Volatility contraction followed by expansion

```pinescript
//@version=5
indicator("BB Squeeze", overlay=true)

length = input.int(20, "BB Length")
mult = input.float(2.0, "BB Multiplier")

basis = ta.sma(close, length)
dev = mult * ta.stdev(close, length)
upper = basis + dev
lower = basis - dev

// Squeeze detection
bbWidth = (upper - lower) / basis
squeeze = bbWidth < ta.lowest(bbWidth, 20)
expansion = bbWidth > bbWidth[1] and squeeze[1]

// Breakout direction
bullishExpansion = expansion and close > basis
bearishExpansion = expansion and close < basis

// Alert conditions
alertcondition(bullishExpansion, title="Bullish BB Expansion", message='{"ticker":"{{ticker}}","action":"buy","price":"{{close}}","strategy":"bb_squeeze"}')
alertcondition(bearishExpansion, title="Bearish BB Expansion", message='{"ticker":"{{ticker}}","action":"sell","price":"{{close}}","strategy":"bb_squeeze"}')
```

### 4. Volume Profile Breakout
**Indicator:** Breaking through high-volume nodes

```pinescript
//@version=5
indicator("Volume Profile Breakout", overlay=true)

// Detect unusually high volume
volThreshold = ta.sma(volume, 50) * 3
highVolume = volume > volThreshold

// Price momentum
momentum = close > close[1] and close > open

// Combined signal
signal = highVolume and momentum

alertcondition(signal, title="Volume Breakout", message='{"ticker":"{{ticker}}","action":"buy","price":"{{close}}","volume":"{{volume}}","strategy":"volume_breakout"}')
```

## Alert Configuration in TradingView

1. **Open Chart** for your desired pair (BTC/USDT, ETH/USDT, etc.)
2. **Add Indicator** from the scripts above
3. **Create Alert** (Alt+A or clock icon)
4. **Configure Alert:**
   - Condition: Select your indicator alert
   - Alert name: Descriptive name
   - Message: Use the JSON format from the indicator
   - Webhook URL: Your ngrok/tunnel URL
   - Check "Webhook URL" checkbox

### Alert Message Format
The bot expects JSON format:
```json
{
  "ticker": "BTCUSDT",
  "action": "buy",  // "buy", "sell", or "close"
  "price": "115000",
  "strategy": "breakout"
}
```

### Dynamic Variables in TradingView
- `{{ticker}}` - Symbol name
- `{{close}}` - Current close price
- `{{volume}}` - Current volume
- `{{time}}` - Current time
- `{{exchange}}` - Exchange name

## Testing Your Setup

### 1. Test Webhook Locally
```bash
curl -X POST http://localhost:3000/webhook/tradingview \
  -H "Content-Type: application/json" \
  -d '{"ticker":"BTCUSDT","action":"buy","price":"115000","strategy":"test"}'
```

### 2. Manual Trigger
```bash
# Trigger a buy order
curl -X POST http://localhost:3000/trigger/BTC-USD.P/buy

# Trigger a sell order
curl -X POST http://localhost:3000/trigger/BTC-USD.P/sell

# Close position
curl -X POST http://localhost:3000/trigger/BTC-USD.P/close
```

## Symbol Mapping
The bot automatically maps TradingView symbols to Enclave format:
- BTCUSDT → BTC-USD.P
- ETHUSDT → ETH-USD.P
- SOLUSDT → SOL-USD.P
- AVAXUSDT → AVAX-USD.P

## Risk Management
- Bot checks risk limits before executing webhook trades
- Daily loss limits apply to webhook trades
- Position sizing follows configured rules
- Trailing stops are automatically applied

## Monitoring
Check bot logs for webhook processing:
```bash
# Follow logs
tail -f logs/bot.log | grep -E "webhook|TradingView|alert"

# Check webhook server health
curl http://localhost:3000/health
```

## Best Practices
1. **Test in Paper Mode First** - Ensure alerts work correctly
2. **Use Stop Losses** - Add stop loss alerts in TradingView
3. **Limit Alert Frequency** - Avoid alert spam with "Once Per Bar Close"
4. **Monitor Position Size** - Bot respects max position limits
5. **Diversify Strategies** - Use multiple indicators for confirmation

## Troubleshooting

### Alert Not Received
- Check ngrok is running and URL is correct
- Verify TradingView webhook URL has trailing `/webhook/tradingview`
- Check bot logs for incoming requests
- Ensure webhook checkbox is checked in alert

### Trade Not Executed
- Check risk manager hasn't stopped trading
- Verify symbol is in configured trading pairs
- Check account balance and margin
- Review bot logs for error messages

### Position Not Closing
- Ensure position exists for the symbol
- Check API permissions for closing positions
- Verify symbol mapping is correct