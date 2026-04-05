# polymarket-trade-engine

Automated trading engine for Polymarket binary prediction markets (e.g. BTC Up/Down 5-minute).

- [**GUIDE.md**](docs/GUIDE.md) -- Strategy development guide covering CLI usage, configuration, engine architecture, and the full API reference.
- [**LEARNING.md**](docs/LEARNING.md) -- Introduction to prediction markets, order books, bids, asks, and how Polymarket works under the hood.

If you are not familiar with terms like order books, bids, asks, or how prediction markets work, start with [LEARNING.md](docs/LEARNING.md) first. Once you are comfortable with the fundamentals, follow [GUIDE.md](docs/GUIDE.md) for a detailed walkthrough on how to develop and test your own strategy.

#### Why another engine, what's the motivation?

The story is quite interesting, though it might feel tedious to those who simply want to use the engine. If you’re curious about how I discovered prediction markets and Polymarket, and what led me to build this engine, you can read more in [MOTIVATION.md](docs/MOTIVATION.md).


#### Why TypeScript?

Writing a trading engine in TypeScript or Python may make the project seem less serious, but that is not true. The real reason is that it does not matter much in this context. 5-minute markets have thin liquidity. At any given moment, the market typically contains <= 150k USDC worth of token liquidity on either side, compared to markets like Forex or stocks, which have trillions of dollars in liquidity. Additionally, all interactions happen through standard APIs over a CLOB, not via low-latency protocols like FIX.

While faster computation can be an advantage, it does not provide meaningful benefits in markets where order book activity itself is not extremely fast. In such cases, TypeScript and Python are still perfectly valid choices. I am most familiar with TypeScript, but there is no reason to assume the engine is slow simply because it uses an interpreted language.

### License

MIT
