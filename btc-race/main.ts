// Main bot: timed entry buy-and-hold style (entry bar baked as constant).
import { runBars, type BarsState, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const ENTRY_BAR = 12;
const MAX_SLIPPAGE_BPS = 200;

let bought = false;

await runBars({
  onBatch(state, batch) {
    const orders: (BuyInput | SellInput)[] = [];
    if (bought) return orders;
    for (const { symbol } of state.hello.symbols) {
      const held = state.positions.get(symbol);
      if (held !== undefined && held.qty > 0n) { bought = true; return orders; }
      if (batch.seq >= ENTRY_BAR) {
        const spend = state.cash;
        if (spend >= BigInt(state.hello.fees.min_notional_quote_units)) {
          orders.push({ side: 'buy', symbol, notional_quote_units: spend, max_slippage_bps: MAX_SLIPPAGE_BPS });
          bought = true;
        }
      }
    }
    return orders;
  },
});
