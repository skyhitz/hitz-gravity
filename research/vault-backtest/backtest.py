"""Replay real minute prices through the vault's exact fee math.

An arbitrageur with unlimited flash-loan capital checks the vault every
step. For every ordered pair of listed assets whose vault exchange rate is
off the market by more than its costs, best edge first, it searches for the
most profitable trade size using the exact contract quote, executes it, and
repeats in the same step while anything stays profitable (which is how a
bot would split a big trade).

Costs: `hedge` is the fraction lost settling each non-USDC leg on an
external venue (fee + spread); `gas` is USD per swap call; `min_profit` is
the smallest USD profit a bot bothers with.
"""
import bisect
import datetime
import itertools
import json
import math
import os
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vaultmath import ONE, VaultError, pool_state, rate, swap  # noqa: E402

U = 10_000_000
NUMERAIRE = "USDC"


@dataclass
class Arb:
    hedge: float = 0.001
    gas: float = 0.002
    min_profit: float = 0.005
    max_calls: int = 8  # swap calls per step (splitting)

    def cost(self, asset):
        return 0.0 if asset == NUMERAIRE else self.hedge


@dataclass
class Result:
    policy: str
    swaps: int = 0
    steps_traded: int = 0
    volume_usd: float = 0.0
    arb_profit: float = 0.0
    fee_usd: float = 0.0
    arb_gross: float = 0.0
    v_start: float = 0.0
    v_end: float = 0.0
    v_hold_end: float = 0.0
    steps: int = 0
    floor_steps: int = 0
    lag: dict = field(default_factory=dict)        # asset -> sum of |vault / market - 1|
    pair_fee: dict = field(default_factory=dict)   # (a, b) -> sum of a small a->b swap's fee
    pair_swaps: dict = field(default_factory=dict)  # (a, b) -> arb swaps
    monthly: dict = field(default_factory=dict)
    final: tuple = ()

    def avg_lag(self, asset):
        return self.lag[asset] / self.steps

    def avg_pair_fee(self, a, b):
        return self.pair_fee[(a, b)] / self.steps


def load_candles(path):
    return [json.loads(line) for line in open(path)]


class Market:
    """Minute candles per asset, [open time, open, high, low, close, ...]; USDC is 1."""

    def __init__(self, series):
        self.series = series
        self.times = {a: [c[0] for c in cs] for a, cs in series.items()}

    def candle(self, asset, ts):
        i = bisect.bisect_right(self.times[asset], ts) - 1
        return self.series[asset][max(i, 0)]

    def path(self, ts, assets, how):
        """Prices inside the minute starting at ts: [(time, {asset: price})]."""
        cs = {a: self.candle(a, ts) for a in assets if a != NUMERAIRE}
        if how == "close":
            return [(ts + 59, {NUMERAIRE: 1.0, **{a: c[4] for a, c in cs.items()}})]
        steps = []
        for k, dt in enumerate((0, 20, 40, 59)):
            m = {NUMERAIRE: 1.0}
            for a, (_, o, h, lo, cl, *_) in cs.items():
                m[a] = (o, lo if cl >= o else h, h if cl >= o else lo, cl)[k]
            steps.append((ts + dt, m))
        return steps


def vault_value(pools, m):
    return sum(p.reserve / U * m[p.asset] for p in pools)


def profit_of(pol, pools, a, b, amount, m, arb, now):
    """USD profit of one a->b swap at market prices m (after hedge and gas)."""
    try:
        pools2, out, hops = swap(pol, pools, a, b, amount, now)
    except (VaultError, ZeroDivisionError):
        return -1e9, None
    p = out / U * m[b] * (1 - arb.cost(b)) - amount / U * m[a] * (1 + arb.cost(a)) - arb.gas
    return p, (pools2, out, hops)


def best_trade(pol, pools, a, b, m, arb, now):
    """Maximise profit over amount_in with a log grid + golden refinement."""
    reserve_in = next(p.reserve for p in pools if p.asset == a)
    lo, hi = math.log(max(reserve_in * 1e-7, 1000)), math.log(reserve_in * 0.5)
    grid = [lo + (hi - lo) * i / 40 for i in range(41)]
    vals = [profit_of(pol, pools, a, b, int(math.exp(x)), m, arb, now)[0] for x in grid]
    i = max(range(len(grid)), key=lambda k: vals[k])
    if vals[i] <= 0:
        return None
    lo_, hi_ = grid[max(i - 1, 0)], grid[min(i + 1, len(grid) - 1)]
    g = (math.sqrt(5) - 1) / 2
    for _ in range(30):
        c, d = hi_ - g * (hi_ - lo_), lo_ + g * (hi_ - lo_)
        if profit_of(pol, pools, a, b, int(math.exp(c)), m, arb, now)[0] > \
           profit_of(pol, pools, a, b, int(math.exp(d)), m, arb, now)[0]:
            hi_ = d
        else:
            lo_ = c
    amount = int(math.exp((lo_ + hi_) / 2))
    p, res = profit_of(pol, pools, a, b, amount, m, arb, now)
    if res is None or p < arb.min_profit:
        return None
    return amount, p, res


def small_swap_fees(pol, pools, now):
    """Each pool's fee for a very small hop now (9 decimals)."""
    return {p.asset: pool_state(pol, pools, i, now).fee for i, p in enumerate(pools)}


def edges(pools, fees, m, arb):
    """Ordered pairs whose marginal swap beats the costs, best edge first."""
    price = {p.asset: p.reserve / p.hitz for p in pools}  # asset per HITZ
    out = []
    for a, b in itertools.permutations(price, 2):
        keep = (1 - fees[a] / ONE) * (1 - fees[b] / ONE)
        edge = price[b] / price[a] * keep * m[b] * (1 - arb.cost(b)) / (m[a] * (1 + arb.cost(a))) - 1
        if edge > 0:
            out.append((edge, a, b))
    return sorted(out, reverse=True)


def month_of(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.UTC).strftime("%Y-%m")


def run(pol, pools0, market, t0, t1, arb, path="close"):
    """Trade `pools0` (seeded at t0) against `market` from t0 to t1."""
    pools = pools0
    assets = [p.asset for p in pools0]
    others = [a for a in assets if a != NUMERAIRE]
    lead = market.times[others[0]]
    start = bisect.bisect_left(lead, t0)
    m0 = market.path(lead[start], assets, "close")[0][1]
    res = Result(pol.name, v_start=vault_value(pools0, m0))
    res.lag = {a: 0.0 for a in others}
    pairs = list(itertools.combinations(assets, 2))
    res.pair_fee = {pr: 0.0 for pr in pairs}
    res.pair_swaps = {pr: 0 for pr in itertools.permutations(assets, 2)}
    m = m0
    for ts in lead[start:]:
        if ts >= t1:
            break
        seq = market.path(ts, assets, path)
        mth = month_of(ts)
        if mth not in res.monthly:
            # Snapshot the backing at the start of each month (exact, at market).
            m_open = market.path(ts, assets, "ohlc")[0][1]
            res.monthly[mth] = {"swaps": 0, "volume": 0.0, "arb": 0.0, "fee": 0.0,
                                "v_open": vault_value(pools, m_open), "hold_open": vault_value(pools0, m_open)}
        mm = res.monthly[mth]
        for now, m in seq:
            calls, traded = 0, False
            while calls < arb.max_calls:
                fees = small_swap_fees(pol, pools, now)
                done = False
                for _, a, b in edges(pools, fees, m, arb):
                    bt = best_trade(pol, pools, a, b, m, arb, now)
                    if not bt:
                        continue
                    amount, p, (pools2, out, hops) = bt
                    vol = amount / U * m[a]
                    fee_usd = vol * (1 - math.prod(1 - h.fee_rate / ONE for h in hops))
                    res.arb_gross += vault_value(pools, m) - vault_value(pools2, m)
                    pools = pools2
                    res.swaps += 1
                    res.volume_usd += vol
                    res.arb_profit += p
                    res.fee_usd += fee_usd
                    res.pair_swaps[(a, b)] += 1
                    mm["swaps"] += 1
                    mm["volume"] += vol
                    mm["arb"] += p
                    mm["fee"] += fee_usd
                    done = True
                    break
                if not done:
                    break
                calls += 1
                traded = True
            if traded:
                res.steps_traded += 1
            res.steps += 1
            usd = rate_usd(pools)
            for a in others:
                res.lag[a] += abs(usd[a] / m[a] - 1)
            fees = small_swap_fees(pol, pools, now)
            for a, b in pairs:
                res.pair_fee[(a, b)] += 1 - (1 - fees[a] / ONE) * (1 - fees[b] / ONE)
            if pol.kind == "dislocation" and max(fees.values()) <= pol.floor * 1001 // 1000:
                res.floor_steps += 1
    res.v_end = vault_value(pools, m)
    res.v_hold_end = vault_value(pools0, m)
    res.final = pools
    return res


def rate_usd(pools):
    """Each asset's vault price in USDC."""
    return {p.asset: rate(pools, p.asset, NUMERAIRE) / ONE for p in pools if p.asset != NUMERAIRE}
