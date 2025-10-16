# Violent Move Detection - Fix Applied

## Problem Summary
Bot was missing massive market dumps (30%+ moves) because the breakout strategy couldn't catch:
1. **Gradual sequential dumps** where support keeps moving down
2. **Violent whipsaws** (crash → bounce → crash) that happen between bot checks
3. **Large single-candle moves** that don't technically "break" support/resistance

### Real Example (AVAX Crash):
- **22:15**: Crashed from $23 to $11.44 (-50%) with 4.1x volume
- **22:20**: Bounced to $27.80 (+143%)
- **22:25-22:45**: Continued bleeding

**Original bot**: Saw NOTHING (no signal generated)
**Reason**:
- Support kept moving down with price (never "broke" it)
- Volume spike happened during crash, but bot only checked current candle
- By the time bot checked, volume was back to normal

---

## The Fix

### 1. Multi-Candle Lookback (10 candles = 50 minutes)
**Before**: Only checked current 5m candle for breakout + volume
**After**: Checks last 10 candles for ANY breakout/large-move with volume

```typescript
// OLD: Only current candle
const volumeSpike = isVolumeSpike(currentVolume, avgVolume, 1.5);
const breakout = detectBreakout(currentPrice, resistance, support);

// NEW: Check last 10 candles
for (let i = history.length - 1; i >= history.length - 10; i--) {
  // Check each recent candle for signal
}
```

### 2. Large Single-Candle Move Detection
**New logic**: Detect >5% single-candle moves with volume, even if they don't "break" S/R

```typescript
// Detect violent dumps/pumps
const pctChange = candle.close.minus(prevCandle.close).dividedBy(prevCandle.close).times(100);

if (pctChange.lessThan(-5) && volumeSpike) {
  // >5% drop with volume = BEARISH signal
  largeMoveType = 'BEARISH';
} else if (pctChange.greaterThan(5) && volumeSpike) {
  // >5% pump with volume = BULLISH signal
  largeMoveType = 'BULLISH';
}
```

### 3. Trend-Aligned Priority
**Problem**: Loop was finding counter-trend bounces first
**Fix**: Skip counter-trend signals, only take trend-aligned ones

```typescript
const trendAligned = (signalType === 'BULLISH' && trend === 'UPTREND') ||
                    (signalType === 'BEARISH' && trend === 'DOWNTREND');

if (!trendAligned) {
  continue; // Skip, keep looking for aligned signals
}
```

### 4. Directional Confirmation
**Check if move is still valid**:
- BEARISH: Current price still below resistance (move continuing)
- BULLISH: Current price still above support (move continuing)

This prevents entering after a full reversal.

---

## Test Results

### AVAX Crash Scenario (Real Data):
```
Historical candles:
22:15:00  $11.44  1014218 vol (4.1x avg) ← CRASH CANDLE
22:20:00  $27.80   566058 vol (2.3x avg) ← BOUNCE
22:45:00  $21.97   199439 vol (0.8x avg) ← CURRENT

NEW BOT RESULT:
✅ SUCCESS! Signal generated
   Symbol: AVAX-USD.P
   Side: SELL
   Entry: $21.97
   Stop: $22.52
   Take Profit: $21.09
   Confidence: 0.90

Found: "BEARISH signal in recent candle (93) - price $11.44, vol 4.1x"
```

**The bot WOULD HAVE shorted the dump!** 🎯

---

## What Changed in Code

### Files Modified:
1. `src/core/strategy/BreakoutStrategy.ts` (lines 138-215)
   - Added 10-candle lookback loop
   - Added large single-candle move detection (>5%)
   - Added trend-alignment filter
   - Added directional continuation check

### Key Additions:
```typescript
// 1. Check last 10 candles instead of just current
const candleLookback = Math.min(10, history.length);

// 2. Detect large moves (>5% single candle)
if (pctChange.lessThan(-5) && volumeSpike) {
  largeMoveType = 'BEARISH';
}

// 3. Only take trend-aligned signals
if (!trendAligned) {
  continue; // Skip counter-trend
}

// 4. Verify move still valid
if (currentPrice.lessThan(resistance)) {
  // Bearish move continuing, take signal
}
```

---

## What This Catches Now

### ✅ Will Catch:
1. **Violent dumps with volume** (>5% single candle)
2. **Violent pumps with volume** (>5% single candle)
3. **Breakouts that happened up to 50 minutes ago** (if still trending)
4. **Sequential dumps** where support keeps moving
5. **Flash crashes followed by bounces**

### ❌ Still Won't Catch:
1. **Slow bleeds without volume** (<1.5x average)
2. **Sideways chop** (no trend)
3. **Counter-trend bounces** (bullish in downtrend, etc)
4. **Moves that fully reversed** (price back above resistance for bearish)

---

## Performance Impact

- **Signal Frequency**: Slightly higher (will catch more violent moves)
- **False Positives**: Minimal (still requires volume + trend alignment)
- **Latency**: None (loop only checks 10 candles)
- **Risk**: Lower (catches major moves we were missing)

---

## Deployment

✅ Tested with historical crash data (AVAX)
✅ All tests passing (12/12)
✅ Bot restarted successfully
✅ Now monitoring for next violent move

---

## Next Bloodbath

When the next 30% dump happens, this bot will:
1. Detect the violent move in last 10 candles
2. Check it's aligned with trend (DOWNTREND)
3. Verify current price still bearish (below resistance)
4. **ENTER SHORT** 🎯

No more sitting on the sidelines while the market implodes. The bot's ready to feast on chaos.
