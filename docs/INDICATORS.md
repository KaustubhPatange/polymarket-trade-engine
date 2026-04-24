# Indicators

All indicators update on a **fixed 1-second interval** regardless of how fast the loop runs or whether BTC price changed. This means period=14 always means "last 14 seconds."

---

## RSI (Relative Strength Index) on Gap

**File:** `engine/strategy/late-entry.ts` (inlined)

### What it measures

RSI measures the momentum of the gap (`btcPrice - priceToBeat`). It answers: *is the gap consistently growing or shrinking over the last N price changes?*

Since `priceToBeat` is fixed per slot, changes in the gap are identical to changes in BTC price. RSI on gap = RSI on BTC price direction.

### How it works

Each second, compute the change in gap:

```
delta = gap(now) - gap(1s ago)
gain  = delta > 0 ? delta : 0
loss  = delta < 0 ? |delta| : 0
```

**Seed phase** (first 14 periods): simple average of gains and losses to establish the initial baseline.

```
avg_gain = sum(gains[0..13]) / 14
avg_loss = sum(losses[0..13]) / 14
```

**Subsequent periods**: Wilder's smoothing:

```
avg_gain = (prev_avg_gain × 13 + gain) / 14
avg_loss = (prev_avg_loss × 13 + loss) / 14

RS  = avg_gain / avg_loss
RSI = 100 - (100 / (1 + RS))
```

The smoothing means a single bad tick contributes only 1/14th weight — one-second spikes barely move it.

### Interpretation

RSI is **direction-aware** — the same value means different things depending on which side the gap is on.

| RSI | Gap positive (UP territory) | Gap negative (DOWN territory) |
|---|---|---|
| > 70 (UP trend) | Green — RSI confirms UP, gap expanding | Red — RSI opposes DOWN, gap recovering toward zero |
| < 30 (DOWN trend) | Red — RSI opposes UP, gap shrinking | Green — RSI confirms DOWN, gap expanding downward |
| 30–70 (neutral) | Yellow — no clear trend, oscillating | Yellow — no clear trend, oscillating |

### Use in stop-loss suppression

RSI is used as a second layer of confirmation alongside the instantaneous gap check:

```
UP position   → rsiConfirmsMomentum if RSI >= 50
DOWN position → rsiConfirmsMomentum if RSI <= 50
```

Stop-loss windows:
- **remaining 80–20s**: suppress if gap confirms OR RSI confirms momentum
- **remaining < 20s**: suppress on gap confirmation only (not enough time for RSI to matter)

### When you see reversal (RSI < 30)

Reversal only appears when a previously large gap has been **consistently shrinking** over 14 seconds. A brief oval dip that recovers won't move RSI much. You need sustained gap contraction to reach < 30 — which is exactly the signal that a position is genuinely reversing.

---

## ATR (Average True Range)

**File:** `engine/strategy/late-entry.ts` (inlined)

### What it measures

ATR measures how much BTC price moves per second on average — the current volatility. It answers: *how jumpy is BTC right now?*

Note: this is a simplified ATR computed on raw price ticks, not OHLC candles. The formula is structurally identical to standard ATR (Wilder's smoothing of absolute moves) but the input is tick-to-tick changes rather than candle high-low range.

### How it works

Each second:

```
TR   = |btcPrice(now) - btcPrice(1s ago)|   // absolute dollar move
ATR  = (prev_ATR × 13 + TR) / 14           // Wilder's smoothing
```

### Interpretation

| ATR | Meaning |
|---|---|
| $1–5 | Low volatility — BTC moving slowly |
| $5–15 | Normal volatility |
| $15–30 | High volatility — BTC making large moves per second |
| > $30 | Very high volatility — significant market event |

### Safety ratio

The display shows `Safety: Nx` which is:

```
safety = abs(gap) / ATR
```

This answers: *how many average BTC moves would it take to close the gap?*

| Safety | Meaning |
|---|---|
| > 10x | Very safe — gap is large relative to current volatility |
| 3–10x | Moderate — gap could close with sustained movement |
| 1–3x | Risky — a few large ticks could flip the outcome |
| < 1x | Dangerous — gap is within normal noise range, outcome uncertain |

### Combined with time remaining

Safety alone is incomplete — it must be read alongside remaining time:

| Safety | Time left | Assessment |
|---|---|---|
| 2x | 250s | Risky — plenty of time for BTC to close the gap |
| 2x | 10s | Fine — not enough time for 2 average moves |
| 10x | 250s | Safe — BTC would need 10 sustained moves against you |
| 10x | 10s | Very safe — essentially guaranteed |

---

## RTV (Rolling Tick Volatility)

**File:** `engine/strategy/late-entry.ts` (inlined)

### What it measures

RTV measures the average absolute BTC price move per second over a rolling 30-second window. It answers: *how much is BTC jumping around right now, independent of direction?*

This is distinct from ATR — ATR uses Wilder's smoothing over a longer history, while RTV is a plain rolling average of recent ticks with no smoothing bias.

### How it works

Each second, append the latest BTC price to a sliding window of up to 30 prices. Compute the mean absolute tick:

```
sum = Σ |price[i] - price[i-1]|   for all consecutive pairs in window
RTV = sum / (window_size - 1)
```

The window slides — prices older than 30 seconds are dropped. Returns `null` until at least 3 prices are available.

### Interpretation

| RTV | Meaning |
|---|---|
| < $1 | Very quiet — BTC barely moving tick-to-tick |
| $1–5 | Normal activity |
| > $5 | Choppy — large per-second swings, gap less predictable |

### Relationship to ATR

Both ATR and RTV measure BTC volatility per second, but:
- **ATR** smooths via Wilder's exponential average over 14 periods — slow to react, stable signal
- **RTV** is a plain rolling mean over the last 30 ticks — faster to react, more sensitive to recent bursts

---

## PGR (Peak Gap Ratio)

**File:** `engine/strategy/late-entry.ts` (inlined)

### What it measures

PGR measures how much of the slot's strongest move is still intact. It answers: *has the gap faded significantly from its peak, signaling momentum exhaustion?*

### How it works

Each second, track the maximum absolute gap seen this slot:

```
peakAbsGap = max(peakAbsGap, |gap|)
PGR        = |currentGap| / peakAbsGap
```

Reset to 0 between slots via `reset()`.

### Interpretation

| PGR | Meaning |
|---|---|
| 0.90–1.00 | Fresh/strong — gap near its peak, move has full conviction |
| 0.75–0.90 | Normal fluctuation — some fade, still acceptable for entry |
| < 0.75 | Momentum exhaustion — gap has lost 25%+ from peak, entry blocked |

### Why it matters

A gap of $84 with gapSafety of 91x looks safe in isolation. But if the peak gap was $126, that $84 represents a 33% fade — the move is exhausting. Markets that fade this much often continue declining into a full reversal.

**Real example:** BTC rallied $126 above priceToBeat by x=135, then slowly bled to $84 by x=210 (PGR=0.67). Case 4 triggered because ATR was low and gapSafety was high. But the fading gap signaled the move was dying — BTC then crashed $80 in the final seconds, triggering stop-loss. PGR < 0.75 would have blocked the entry.

### Use in entry gating

PGR is used as a pre-entry filter in the entry monitor. Case 4 requires:

```
peakGapRatio >= 0.75
```

If PGR is below 0.75, entry is blocked — the gap has faded too much from its peak, regardless of how safe the instantaneous indicators look.

---

## Display

```
Indicators: ATR: $8.23  |  Safety: 9.1x  |  RTV: $3.12  |  PGR: 0.85
```

RSI is color-coded based on whether it confirms or opposes the current gap direction:
- Green — RSI supports the current gap side holding
- Red — RSI is working against the current gap side
- Yellow — neutral, no clear momentum
