"""Backtest the Sovereign Vault fee against the real HITZ arbitrage history.

    python3 fetch_data.py            # once: pool events + XLM minute candles
    python3 vaultmath.py --check     # the port still matches the contract
    python3 run.py history           # what the real arbs did on Aquarius
    python3 run.py calibrate         # fit the arb cost model to that history
    python3 run.py compare           # fee policies on the real XLM path
    python3 run.py compare very-picky competitive   # arb cost sensitivity
    python3 run.py compare calibrated --ohlc        # intra-minute price paths
    python3 run.py retail            # what ordinary swaps pay, by depth

Results print as markdown tables. See README.md for the method.
"""
import bisect
import collections
import datetime
import itertools
import json
import os
import sys
from dataclasses import replace
from multiprocessing import Pool

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from backtest import Arb, load_candles, run  # noqa: E402
from vaultmath import XLM_POOL, Policy, hop, xlm_price  # noqa: E402

DATA = os.path.join(HERE, "data")
U = 10_000_000
XLM_SAC = "CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA"
USDC_SAC = "CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75"
HITZ = "CBAPZAZNNB4X3VPXV2LYA5RMV7XHXIVREES2GG7R5GUXDZ4R4CKOY4EU"
POOL_FILES = {"X": "pool-CCCDPF74.jsonl", "U": "pool-CBMOEJUO.jsonl"}  # HITZ/XLM, HITZ/USDC
SIM_END = datetime.datetime(2026, 10, 31, 23, 0, tzinfo=datetime.UTC)
CALIBRATED = Arb(hedge=0.003, gas=0.002, min_profit=0.003)
PCT = 10_000_000  # 1% in the vault's 9-decimal fixed point

_candles = None


def candles():
    global _candles
    if _candles is None:
        _candles = load_candles(os.path.join(DATA, "xlm_1m.jsonl"))
    return _candles


def events(pool):
    return [json.loads(l) for l in open(os.path.join(DATA, POOL_FILES[pool]))]


def month(ts):
    return datetime.datetime.fromtimestamp(ts, datetime.UTC).strftime("%Y-%m")


def market_at(ts):
    c = candles()
    i = bisect.bisect_right([r[0] for r in c], ts) - 1
    return c[max(i, 0)][4]


# ── History ─────────────────────────────────────────────────────────────────

def reconstruct():
    """Group pool trades by operation into XLM<->USDC cycles through HITZ."""
    times = [r[0] for r in candles()]
    trades = []
    for pool in "XU":
        for e in events(pool):
            if e["name"] == "trade":
                tin, tout, user = e["topics"]
                ain, aout, fee = (int(x) for x in e["body"])
                trades.append(dict(pool=pool, op=e["id"].split("-")[0], ts=e["ts"], tin=tin, tout=tout,
                                   user=user, initiator=e["initiator"], ain=ain, aout=aout))
    by_op = collections.defaultdict(list)
    for t in trades:
        by_op[t["op"]].append(t)
    cycles, one_sided = [], []
    for ts_ in by_op.values():
        m = candles()[max(bisect.bisect_right(times, ts_[0]["ts"]) - 1, 0)][4]
        if {t["pool"] for t in ts_} == {"X", "U"}:
            xlm_in = sum(t["ain"] for t in ts_ if t["tin"] == XLM_SAC) - sum(t["aout"] for t in ts_ if t["tout"] == XLM_SAC)
            usdc_in = sum(t["ain"] for t in ts_ if t["tin"] == USDC_SAC) - sum(t["aout"] for t in ts_ if t["tout"] == USDC_SAC)
            cycles.append(dict(ts=ts_[0]["ts"], user=ts_[0]["user"], initiator=ts_[0]["initiator"],
                               vol=abs(usdc_in) / U, extracted=-(xlm_in / U * m + usdc_in / U)))
        else:
            for t in ts_:
                q = XLM_SAC if t["pool"] == "X" else USDC_SAC
                amt = t["ain"] if t["tin"] == q else t["aout"]
                one_sided.append(dict(ts=t["ts"], usd=amt / U * (m if t["pool"] == "X" else 1)))
    return cycles, one_sided


def clean_window():
    """From the last liquidity change to the last trade: trades only."""
    t0, t1 = 0, 0
    for pool in "XU":
        for e in events(pool):
            if e["name"] in ("deposit_liquidity", "withdraw_liquidity"):
                t0 = max(t0, e["ts"] + 60)
            if e["name"] == "trade":
                t1 = max(t1, e["ts"] + 60)
    r = {}
    for pool in "XU":
        last = None
        for e in events(pool):
            if e["name"] == "update_reserves" and e["ts"] < t0:
                last = e
        a, b = (int(x) for x in last["body"])
        r[pool] = (b, a) if pool == "X" else (a, b)  # XLM pool stores (XLM, HITZ)
    return t0, t1, (r["X"][0], r["X"][1], r["U"][0], r["U"][1])


def cmd_history():
    cycles, one_sided = reconstruct()
    print("## What the arbs did on the Aquarius pools\n")
    print(f"{len(cycles)} XLM<->USDC cycles through HITZ, {len(one_sided)} one-sided HITZ trades "
          f"(${sum(t['usd'] for t in one_sided):.2f} in total).\n")
    print("| Month | Cycles | Volume | Extracted vs Binance | Median edge | 90th pct edge |")
    print("|---|---|---|---|---|---|")
    by = collections.defaultdict(list)
    for c in cycles:
        by[month(c["ts"])].append(c)
    for m, cs in sorted(by.items()):
        edges = sorted(c["extracted"] / c["vol"] for c in cs if c["vol"] > 0)
        print(f"| {m} | {len(cs)} | ${sum(c['vol'] for c in cs):,.2f} | ${sum(c['extracted'] for c in cs):.2f} | "
              f"{edges[len(edges) // 2]:.2%} | {edges[int(len(edges) * .9)]:.2%} |")
    print("\n| Bot (receiver… via signer…) | Cycles | Volume |\n|---|---|---|")
    top = collections.Counter((c["user"][:8], c["initiator"][:8]) for c in cycles).most_common(8)
    for (u, i), n in top:
        vol = sum(c["vol"] for c in cycles if c["user"][:8] == u and c["initiator"][:8] == i)
        print(f"| `{u}…` via `{i}…` | {n} | ${vol:,.2f} |")


# ── Calibration ─────────────────────────────────────────────────────────────

AQUA = Policy("Aquarius 0.1% (pool keeps half)", kind="aqua", flat=PCT // 10)


def _calib(args):
    hedge, minp = args
    t0, t1, r0 = clean_window()
    r = run(AQUA, r0, candles(), t0, t1, Arb(hedge=hedge, gas=0.002, min_profit=minp))
    return hedge, minp, r.steps_traded, r.volume_usd, r.arb_gross


def cmd_calibrate():
    t0, t1, r0 = clean_window()
    cycles, _ = reconstruct()
    real = [c for c in cycles if t0 <= c["ts"] < t1]
    target = (len(real), sum(c["vol"] for c in real), sum(c["extracted"] for c in real))
    with Pool() as p:
        rows = p.map(_calib, itertools.product([0.0005, 0.001, 0.002, 0.003, 0.004], [0.001, 0.003, 0.01]))
    score = lambda r: sum(abs(a - b) / b for a, b in zip(r[2:], target))  # noqa: E731
    print(f"## Calibration, {datetime.datetime.fromtimestamp(t0, datetime.UTC):%b %d} to "
          f"{datetime.datetime.fromtimestamp(t1, datetime.UTC):%b %d}\n")
    print(f"Real: {target[0]} cycles, ${target[1]:,.0f} volume, ${target[2]:.2f} extracted.\n")
    print("| Hedge cost | Min profit | Arb txs | Volume | Extracted | Fit error |\n|---|---|---|---|---|---|")
    for r in sorted(rows, key=score)[:6]:
        print(f"| {r[0]:.2%} | ${r[1]} | {r[2]} | ${r[3]:,.0f} | ${r[4]:.2f} | {score(r):.0%} |")


# ── Policy comparison ───────────────────────────────────────────────────────

BASE = Policy("Proposal: 1% floor, k=100, 2h")
POLICIES = [
    AQUA,
    Policy("Flat 0.3%", kind="flat", flat=3 * PCT // 10),
    Policy("Flat 1%", kind="flat", flat=PCT),
    BASE,
    replace(BASE, name="Dynamic, 3h memory").with_tau(10_800),
    replace(BASE, name="Dynamic, 6h memory").with_tau(21_600),
    replace(BASE, name="Dynamic, 0.5% floor", floor=PCT // 2),
    replace(BASE, name="Dynamic, k=50", steepness=50),
    replace(BASE, name="Dynamic, k=200", steepness=200),
]


ARBS = {
    "calibrated": CALIBRATED,
    "picky": Arb(hedge=0.003, gas=0.005, min_profit=0.01),        # 1c minimum, 0.5c gas
    "very-picky": Arb(hedge=0.003, gas=0.01, min_profit=0.03),    # 3c minimum, 1c gas
    "competitive": Arb(hedge=0.001, gas=0.002, min_profit=0.003),  # cheaper external leg
}


def _compare(args):
    pol, arb, path = args
    t0, _, r0 = clean_window()
    return run(pol, r0, candles(), t0, int(SIM_END.timestamp()), arb, path=path)


def cmd_compare(arb_names=("calibrated", "picky"), path="close"):
    """`run.py compare [arb ...] [--ohlc]`; arbs: calibrated, picky, very-picky, competitive."""
    for label in arb_names:
        arb = ARBS[label]
        with Pool() as p:
            res = p.map(_compare, [(pol, arb, path) for pol in POLICIES])
        aq = res[0]
        print(f"## Arbs: {label} ({arb}), {path} prices\n")
        print(f"Start: ${aq.v_start:,.2f} of XLM+USDC backing. Holding it untouched ends at ${aq.v_hold_end:,.2f}.\n")
        print("| Policy | Backing at end | vs holding | vs Aquarius | Arb txs | Extracted by arbs | Avg price lag |")
        print("|---|---|---|---|---|---|---|")
        for r in res:
            print(f"| {r.policy} | ${r.v_end:,.2f} | {r.v_end - r.v_hold_end:+.2f} | {r.v_end - aq.v_end:+.2f} | "
                  f"{r.steps_traded} | ${r.arb_gross:.2f} | {r.track_err_sum / r.track_err_n:.2%} |")
        print()
        if label == "calibrated" and path == "close":
            print("### Gain over holding, by month (exact)\n")
            months = sorted(res[0].monthly)
            print("| Month | " + " | ".join(r.policy for r in res[:6]) + " |")
            print("|---|" + "---|" * 6)
            for i, m in enumerate(months):
                cells = []
                for r in res[:6]:
                    mo = r.monthly
                    close = (mo[months[i + 1]]["v_open"] - mo[months[i + 1]]["hold_open"]) if i + 1 < len(months) \
                        else r.v_end - r.v_hold_end
                    cells.append(f"{close - (mo[m]['v_open'] - mo[m]['hold_open']):+.2f}")
                print(f"| {m} | " + " | ".join(cells) + " |")
            print()


# ── Retail cost ─────────────────────────────────────────────────────────────

def cmd_retail():
    m = market_at(int(SIM_END.timestamp()))
    last = {}
    for pool in "XU":
        for e in events(pool):
            if e["name"] == "update_reserves":
                last[pool] = e
    xa, hx = (int(v) for v in last["X"]["body"])
    hu, _ = (int(v) for v in last["U"]["body"])
    usdc = round(xa / hx * hu * m)  # seed at the market cross-rate
    base = (hx, xa, hu, usdc)
    hitz_usd = xa / hx * m
    pols = [AQUA, Policy("Flat 1%", kind="flat", flat=PCT), replace(BASE, name="k=50", steepness=50), BASE]
    print("## What an XLM -> HITZ swap costs (fee + price impact vs fair price)\n")
    print("| Backing | Size | " + " | ".join(p.name for p in pols) + " |\n|---|---|" + "---|" * len(pols))
    for scale in (1, 10, 30):
        r = tuple(v * scale for v in base)
        for usd in (5, 20, 100):
            cells = []
            for pol in pols:
                _, out, _ = hop(pol, r, xlm_price(r), XLM_POOL, False, int(usd / m * U))
                cells.append(f"{1 - out / U * hitz_usd / usd:.2%}")
            print(f"| ${r[1] / U * m + r[3] / U:,.0f} | ${usd} | " + " | ".join(cells) + " |")


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "history"
    if cmd == "compare":
        names = [a for a in sys.argv[2:] if not a.startswith("--")] or ["calibrated", "picky"]
        cmd_compare(names, "ohlc" if "--ohlc" in sys.argv else "close")
    else:
        {"history": cmd_history, "calibrate": cmd_calibrate, "retail": cmd_retail}[cmd]()
