"""Replay the real XLM/USDC minute path through the vault's exact fee math.

An arbitrageur with unlimited flash-loan capital checks the vault every
step. If the vault's XLM price is off the market by more than its costs,
it searches for the most profitable trade size using the exact contract
quote, executes it, and repeats in the same step while it stays
profitable (which is how a bot would split a big trade).

Costs: `hedge` is the fraction lost settling the other side on an external
venue (fee + spread); `gas` is USD per swap call; `min_profit` is the
smallest USD profit a bot bothers with.
"""
import bisect
import json
import math
import os
import sys
from dataclasses import dataclass, field

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from vaultmath import (ONE, Policy, TradeTooSmall, anchor_now, fee_for_price,  # noqa: E402
                       run_route, xlm_price)

U = 10_000_000


@dataclass
class Arb:
    hedge: float = 0.001
    gas: float = 0.002
    min_profit: float = 0.005
    max_calls: int = 8  # swap calls per step (splitting)


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
    track_err_sum: float = 0.0
    track_err_n: int = 0
    floor_steps: int = 0
    monthly: dict = field(default_factory=dict)


def load_candles(path):
    rows = [json.loads(l) for l in open(path)]
    return rows


def vault_value(r, m):
    return r[1] / U * m + r[3] / U


def profit_of(pol, r, anchor, route, amount, m, arb):
    """USD profit of one swap at market price m (after hedge + gas)."""
    try:
        r2, out, fees = run_route(pol, r, anchor, route, amount)
    except (TradeTooSmall, OverflowError, ZeroDivisionError):
        return -1e9, None
    if route == "XLM->USDC":
        p = out / U - amount / U * m * (1 + arb.hedge) - arb.gas
    else:
        p = out / U * m * (1 - arb.hedge) - amount / U - arb.gas
    return p, (r2, out, fees)


def best_trade(pol, r, anchor, route, m, arb):
    """Maximise profit over amount_in with a log grid + golden refinement."""
    reserve_in = r[1] if route == "XLM->USDC" else r[3]
    lo, hi = math.log(max(reserve_in * 1e-7, 1000)), math.log(reserve_in * 0.5)
    grid = [lo + (hi - lo) * i / 40 for i in range(41)]
    vals = [profit_of(pol, r, anchor, route, int(math.exp(x)), m, arb)[0] for x in grid]
    i = max(range(len(grid)), key=lambda k: vals[k])
    if vals[i] <= 0:
        return None
    a, b = grid[max(i - 1, 0)], grid[min(i + 1, len(grid) - 1)]
    g = (math.sqrt(5) - 1) / 2
    for _ in range(30):
        c, d = b - g * (b - a), a + g * (b - a)
        if profit_of(pol, r, anchor, route, int(math.exp(c)), m, arb)[0] > \
           profit_of(pol, r, anchor, route, int(math.exp(d)), m, arb)[0]:
            b = d
        else:
            a = c
    amt = int(math.exp((a + b) / 2))
    p, res = profit_of(pol, r, anchor, route, amt, m, arb)
    if res is None or p < arb.min_profit:
        return None
    return amt, p, res


def marginal_ok(pol, r, anchor, m, arb):
    """Cheap pre-check: can an infinitesimal trade beat the costs?"""
    p = xlm_price(r) / ONE
    if pol.kind == "aqua":
        f = pol.flat / ONE
    elif pol.kind == "flat":
        f = pol.flat / ONE
    else:
        f = fee_for_price(pol, xlm_price(r), anchor) / ONE
    keep = (1 - f) ** 2
    if p * keep > m * (1 + arb.hedge):
        return "XLM->USDC"
    if m * (1 - arb.hedge) * keep > p:
        return "USDC->XLM"
    return None


def month_of(ts):
    import datetime
    return datetime.datetime.fromtimestamp(ts, datetime.UTC).strftime("%Y-%m")


def run(pol: Policy, r0, candles, t0, t1, arb: Arb, path="close"):
    r = r0
    start = bisect.bisect_left([c[0] for c in candles], t0)
    m0 = candles[start][4]
    res = Result(pol.name, v_start=vault_value(r0, m0))
    A = (xlm_price(r0), candles[start][0])
    for c in candles[start:]:
        ts = c[0]
        if ts >= t1:
            break
        if path == "ohlc":
            o, h, l, cl = c[1], c[2], c[3], c[4]
            seq = [(ts, o), (ts + 20, l if cl >= o else h), (ts + 40, h if cl >= o else l), (ts + 59, cl)]
        else:
            seq = [(ts + 59, c[4])]
        mth = month_of(ts)
        if mth not in res.monthly:
            # Snapshot the backing at the start of each month (exact, at market).
            res.monthly[mth] = {"swaps": 0, "volume": 0.0, "arb": 0.0, "fee": 0.0,
                                "v_open": vault_value(r, c[1]), "hold_open": vault_value(r0, c[1])}
        mm = res.monthly[mth]
        for now, m in seq:
            anchor = anchor_now(pol, r, A[0], A[1], now)
            calls = 0
            traded = False
            while calls < arb.max_calls:
                route = marginal_ok(pol, r, anchor, m, arb)
                if not route:
                    break
                bt = best_trade(pol, r, anchor, route, m, arb)
                if not bt:
                    break
                amt, p, (r2, out, fees) = bt
                vol = amt / U * m if route == "XLM->USDC" else amt / U
                # Fee value retained by the vault, approx in USD.
                fee_usd = vol * (1 - math.prod(1 - f / ONE for f in fees))
                v_before = vault_value(r, m)
                res.arb_gross += v_before - vault_value(r2, m)
                r = r2
                A = (anchor, now)  # the contract stores the pre-trade anchor
                res.swaps += 1
                res.volume_usd += vol
                res.arb_profit += p
                res.fee_usd += fee_usd
                mm["swaps"] += 1
                mm["volume"] += vol
                mm["arb"] += p
                mm["fee"] += fee_usd
                calls += 1
                traded = True
            if traded:
                res.steps_traded += 1
            p_v = xlm_price(r) / ONE
            res.track_err_sum += abs(p_v / m - 1)
            res.track_err_n += 1
            if pol.kind == "dynamic" and fee_for_price(pol, xlm_price(r), anchor_now(pol, r, A[0], A[1], now)) <= pol.floor * 1001 // 1000:
                res.floor_steps += 1
        last_m = seq[-1][1]
    res.v_end = vault_value(r, last_m)
    res.v_hold_end = vault_value(r0, last_m)
    res.final_reserves = r
    return res
