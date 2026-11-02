"""Exact integer port of the Sovereign Vault's swap math.

Mirrors contracts/sovereign-vault/src/lib.rs operation by operation: i128
division truncates toward zero (tdiv), ceilings round up where the contract
does, pow_sat saturates the same way, and ln and exp use the same series.
Any number of trusted assets, each with its own pool against HITZ.

The fee policy is pluggable, so the same engine also runs flat fees, an
Aquarius-style 0.1%-on-input pool for calibration, and `scope="pair"`: a
design the contract does not use, which prices a swap only on the pair it
trades (see detours.py for why it leaks).

`python3 vaultmath.py --check` replays the golden vectors that the contract
test `fee_math_matches_the_golden_vectors` asserts, and must match exactly.
"""
import math
from dataclasses import dataclass, replace
from functools import lru_cache
from typing import NamedTuple

ONE = 1_000_000_000              # 1.0 for fee rates and exchange rates
WAD = 1_000_000_000_000_000_000  # 1.0 for natural logs
LN2_WAD = 693_147_180_559_945_309
LN10_WAD = 2_302_585_092_994_045_684
MAX_ASSETS = 16
UPGRADE_DELAY_SECS = 7 * 24 * 60 * 60
HITZ = "HITZ"


class VaultError(Exception):
    """A contract error, by its name in lib.rs (TradeTooSmall, NotSeeded...)."""


# ── Fixed-point math ───────────────────────────────────────────────────────

def tdiv(a: int, b: int) -> int:
    """Rust integer division (truncates toward zero)."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


@lru_cache(maxsize=1 << 16)
def pow_sat(base: int, exp: int, cap: int) -> int:
    b = cap if base > cap else base
    e = exp
    acc = ONE
    while True:
        if e & 1:
            acc = acc * b // ONE
            if acc >= cap:
                return cap
        e >>= 1
        if e == 0 or acc == 0:
            return acc
        b = b * b // ONE
        if b > cap:
            b = cap


def _log2_parts(x: int):
    n = x.bit_length() - 1
    top = x >> (n - 60) if n >= 60 else x << (60 - n)
    return n, (top * WAD) >> 60


def _ln_near_one(r: int) -> int:
    z = tdiv((r - WAD) * WAD, r + WAD)
    z2 = z * z // WAD
    term, total, k = z, 0, 1
    while term != 0:
        total += tdiv(term, k)
        term = tdiv(term * z2, WAD)
        k += 2
    return 2 * total


def ln_ratio(a: int, b: int) -> int:
    """ln(a / b) in 18 decimals, for a, b > 0."""
    na, ma = _log2_parts(a)
    nb, mb = _log2_parts(b)
    return (na - nb) * LN2_WAD + _ln_near_one(ma * WAD // mb)


def exp_wad(x: int) -> int:
    """e^x in 18 decimals for x >= 0, rounded up."""
    if x == 0:
        return WAD
    n = x // LN2_WAD
    r = x - n * LN2_WAD
    term = total = WAD
    k = 1
    while term > 0:
        term = term * r // (k * WAD)
        total += term
        k += 1
    return (total + k) << n


# ── Policy ─────────────────────────────────────────────────────────────────

@dataclass(frozen=True)
class Policy:
    name: str
    kind: str = "dislocation"    # "dislocation" (the contract) | "flat" | "aqua"
    floor: int = 10_000_000      # 1% in 9 decimals
    cap: int = 100_000_000       # 10%
    steepness: int = 100
    decay_per_sec: int = 999_861_121  # e^(-1/7200): a 2-hour average
    depth_ratio: int = 8         # references hold >= 1/8 of the pool's HITZ
    scope: str = "worst"         # "worst" (the contract) | "pair" (comparison only)
    flat: int = 10_000_000       # fee for kind "flat" and "aqua"
    aqua_protocol_share: int = 50  # % of the aqua fee that leaves the pool

    def with_tau(self, tau_secs: int) -> "Policy":
        return replace(self, decay_per_sec=round(math.exp(-1 / tau_secs) * ONE))

    @property
    def cap_at(self) -> int:
        """|D| x steepness from which the fee is capped: ln(cap / floor)."""
        return LN10_WAD if self.cap == 10 * self.floor else ln_ratio(self.cap, self.floor)


CONTRACT = Policy("Contract: 1% floor, k=100, 2h")


def decayed(pol: Policy, deviation: int, elapsed: int) -> int:
    if elapsed == 0 or deviation == 0:
        return deviation
    return tdiv(deviation * pow_sat(pol.decay_per_sec, elapsed, ONE), ONE)


def fee_for_dislocation(pol: Policy, dislocation: int) -> int:
    x = abs(dislocation) * pol.steepness
    if x >= pol.cap_at:
        return pol.cap
    fee = (pol.floor * exp_wad(x) + WAD - 1) // WAD
    return pol.cap if fee > pol.cap else fee


def ln_price_change(hitz0: int, reserve0: int, hitz1: int, reserve1: int) -> int:
    return ln_ratio(reserve1, reserve0) + ln_ratio(hitz0, hitz1)


# ── Pools ──────────────────────────────────────────────────────────────────

class Pool(NamedTuple):
    asset: str
    hitz: int = 0
    reserve: int = 0
    deviation: int = 0  # ln(reserve / hitz) minus its average, as of `updated`
    updated: int = 0

    @property
    def seeded(self) -> bool:
        return self.hitz > 0 and self.reserve > 0


class PoolState(NamedTuple):
    asset: str
    hitz: int
    reserve: int
    deviation: int
    dislocation: int
    fee: int


class Hop(NamedTuple):
    pool: int
    hitz_in: bool
    amount_in: int
    amount_out: int
    dislocation: int
    fee_rate: int
    fee_amount: int


def new_vault(assets, now: int):
    """The constructor: one empty pool per asset, in order."""
    if not assets or len(assets) > MAX_ASSETS or HITZ in assets or len(set(assets)) != len(assets):
        raise VaultError("bad asset list")
    return tuple(Pool(a, updated=now) for a in assets)


def index(pools, asset: str) -> int:
    for i, p in enumerate(pools):
        if p.asset == asset:
            return i
    raise VaultError("InvalidPool")


def _set(pools, i: int, p: Pool):
    return pools[:i] + (p,) + pools[i + 1:]


def list_asset(pools, asset: str, now: int):
    """`list_asset` once the timelock has run: an empty pool at the end."""
    if asset == HITZ or any(p.asset == asset for p in pools):
        raise VaultError("DuplicateToken")
    if len(pools) >= MAX_ASSETS:
        raise VaultError("TooManyAssets")
    return pools + (Pool(asset, updated=now),)


def average_deviation(pol: Policy, pools, now: int) -> int:
    weighted = weight = 0
    for p in pools:
        if p.seeded:
            weighted += decayed(pol, p.deviation, now - p.updated) * p.hitz
            weight += p.hitz
    return tdiv(weighted, weight) if weight else 0


def seed(pol: Policy, pools, asset: str, hitz: int, amount: int, now: int):
    if hitz <= 0 or amount <= 0:
        raise VaultError("InvalidAmount")
    i = index(pools, asset)
    if pools[i].hitz or pools[i].reserve:
        raise VaultError("AlreadySeeded")
    return _set(pools, i, Pool(asset, hitz, amount, average_deviation(pol, pools, now), now))


def worst_dislocation(pol: Policy, pools, i: int, hitz: int, deviation: int, now: int, only=None) -> int:
    """D for pool i: its largest |dislocation| against a reference pool."""
    worst = 0
    for j, p in enumerate(pools):
        if j == i or not p.seeded or (only is not None and j != only):
            continue
        if p.hitz * pol.depth_ratio < hitz:
            continue
        gap = abs(deviation - decayed(pol, p.deviation, now - p.updated))
        if gap > worst:
            worst = gap
    return worst


def _sides(hitz_in: bool, new_in: int, new_out: int):
    return (new_in, new_out) if hitz_in else (new_out, new_in)


def hop(pol: Policy, pools, i: int, hitz_in: bool, amount_in: int, now: int, counterpart=None):
    """One constant-product leg through pool i. Returns (pools, Hop)."""
    p = pools[i]
    r_in, r_out = (p.hitz, p.reserve) if hitz_in else (p.reserve, p.hitz)
    if pol.kind == "aqua":
        # Fee withheld from the input; half stays in the pool, half leaves.
        fee_in = -(-amount_in * pol.flat // ONE)
        eff = amount_in - fee_in
        out = r_out * eff // (r_in + eff)
        if out <= 0:
            raise VaultError("TradeTooSmall")
        protocol = fee_in * pol.aqua_protocol_share // 100
        h, q = _sides(hitz_in, r_in + amount_in - protocol, r_out - out)
        return _set(pools, i, p._replace(hitz=h, reserve=q)), Hop(i, hitz_in, amount_in, out, 0, pol.flat, fee_in)
    new_in = r_in + amount_in
    gross = r_out * amount_in // new_in
    if pol.kind == "flat":
        dislocation, fee_rate = 0, pol.flat
    else:
        deviation_now = decayed(pol, p.deviation, now - p.updated)
        h_end, q_end = _sides(hitz_in, new_in, r_out - gross)
        deviation_end = deviation_now + ln_price_change(p.hitz, p.reserve, h_end, q_end)
        only = counterpart if pol.scope == "pair" else None
        dislocation = worst_dislocation(pol, pools, i, h_end, deviation_end, now, only)
        fee_rate = fee_for_dislocation(pol, dislocation)
    fee_amount = -(-gross * fee_rate // ONE)
    out = gross - fee_amount
    if out <= 0:
        raise VaultError("TradeTooSmall")
    h, q = _sides(hitz_in, new_in, r_out - out)
    if pol.kind == "flat":
        new = p._replace(hitz=h, reserve=q)
    else:
        new = Pool(p.asset, h, q, deviation_now + ln_price_change(p.hitz, p.reserve, h, q), now)
    return _set(pools, i, new), Hop(i, hitz_in, amount_in, out, dislocation, fee_rate, fee_amount)


def route(pools, token_in: str, token_out: str):
    def find(t):
        try:
            return index(pools, t)
        except VaultError:
            raise VaultError("UnsupportedPair") from None
    if token_in == HITZ and token_out != HITZ:
        legs = [(find(token_out), True)]
    elif token_out == HITZ and token_in != HITZ:
        legs = [(find(token_in), False)]
    elif token_in != token_out and token_in != HITZ:
        legs = [(find(token_in), False), (find(token_out), True)]
    else:
        raise VaultError("UnsupportedPair")
    for i, _ in legs:
        if not pools[i].seeded:
            raise VaultError("NotSeeded")
    return legs


def swap(pol: Policy, pools, token_in: str, token_out: str, amount_in: int, now: int):
    """Returns (pools, amount out, hops). `quote` is the same without keeping pools."""
    if amount_in <= 0:
        raise VaultError("InvalidAmount")
    legs = route(pools, token_in, token_out)
    hops, amount = [], amount_in
    for n, (i, hitz_in) in enumerate(legs):
        counterpart = legs[1 - n][0] if len(legs) == 2 else None
        pools, h = hop(pol, pools, i, hitz_in, amount, now, counterpart)
        hops.append(h)
        amount = h.amount_out
    return pools, amount, hops


# ── Views ──────────────────────────────────────────────────────────────────

def pool_state(pol: Policy, pools, i: int, now: int) -> PoolState:
    p = pools[i]
    if pol.kind != "dislocation":
        return PoolState(p.asset, p.hitz, p.reserve, 0, 0, pol.flat)
    deviation = decayed(pol, p.deviation, now - p.updated)
    dislocation = worst_dislocation(pol, pools, i, p.hitz, deviation, now) if p.seeded else 0
    return PoolState(p.asset, p.hitz, p.reserve, deviation, dislocation, fee_for_dislocation(pol, dislocation))


def rate(pools, base: str, quote: str) -> int:
    """How much `quote` one `base` is worth in the vault (9 decimals)."""
    b, q = pools[index(pools, base)], pools[index(pools, quote)]
    return q.reserve * b.hitz * ONE // (q.hitz * b.reserve)


def dislocation(pol: Policy, pools, base: str, quote: str, now: int) -> int:
    b, q = pools[index(pools, base)], pools[index(pools, quote)]
    return decayed(pol, q.deviation, now - q.updated) - decayed(pol, b.deviation, now - b.updated)


# ── Golden vectors (contracts/sovereign-vault/src/test.rs) ─────────────────
# XLM and USDC seeded, four swaps, EURC listed after the timelock and seeded,
# seven more swaps. Each row: amount out, then (hitz, reserve, deviation, fee)
# per pool in listing order, zeros before EURC is listed.
_U = 10_000_000
GOLDEN_START = 1_800_000_000
GOLDEN_SEEDS = [("XLM", 288_489_893_497_397, 54_295_310_693), ("USDC", 153_635_240_499_979, 6_366_656_146)]
GOLDEN_LISTED = ("EURC", 120_000_000_000_000, 4_300_000_000)
GOLDEN_FIRST = [(0, "XLM", "USDC", 50 * _U), (300, "USDC", "XLM", 10 * _U), (3_600, "XLM", HITZ, 100 * _U),
                (0, HITZ, "USDC", 1_000_000 * _U)]
GOLDEN_THEN = [(60, "EURC", "XLM", 20 * _U), (5, "XLM", "EURC", 3 * _U + 1_234), (1_800, "USDC", "EURC", 40 * _U),
               (17, HITZ, "EURC", 3_000_000 * _U), (100_000, "EURC", "USDC", 7 * _U), (61, "XLM", "USDC", _U),
               (3, "USDC", "XLM", 123_456_789)]
GOLDEN_ROWS = [
    (90583437, 286022114858658, 54795310693, 17757676649745520, 100000000, 156103019138718, 6276072709,
     -30264917526016470, 100000000, 0, 0, 0, 0),
    (440465227, 288366558038543, 54354845466, 798810344678132, 11175972, 153758575958833, 6376072709,
     1910620077562421, 11175972, 0, 0, 0, 0),
    (4688476682571, 283678081355972, 55354845466, 35107300848891364, 100000000, 153758575958833, 6376072709,
     1158849522909780, 100000000, 0, 0, 0, 0),
    (350422284, 283678081355972, 55354845466, 35107300848891364, 100000000, 163758575958833, 6025650425,
     -118377629224182636, 100000000, 0, 0, 0, 0),
    (0, 283678081355972, 55354845466, 0, 10000000, 163758575958833, 6025650425, 0, 10000000, 120000000000000,
     4300000000, 0, 10000000),
    (828946626, 288478081355971, 54525898840, -31867430416331614, 100000000, 163758575958833, 6025650425, 0,
     100000000, 115200000000001, 4500000000, 86284368597003772, 100000000),
    (5013225, 288335306173639, 54555900074, -30800191278960235, 100000000, 163758575958833, 6025650425, 0,
     100000000, 115342775182333, 4494986775, 83871198194729064, 100000000),
    (298078229, 288335306173639, 54555900074, -23987211698595394, 100000000, 154583926943411, 6425650425,
     121928511313954142, 100000000, 124517424197755, 4196908546, -79832891648938117, 100000000),
    (733357621, 288335306173639, 54555900074, -23930642003679640, 100000000, 154583926943411, 6425650425,
     121640964135581149, 100000000, 154517424197755, 3463550925, -487559680195334898, 100000000),
    (101258230, 288335306173639, 54555900074, -22206937912, 100000000, 157338832117009, 6324392195,
     -33548292640501588, 100000000, 151762519024157, 3533550925, 37998442183763223, 100000000),
    (1719938, 288287748674321, 54565900074, 348211191514682, 100000000, 157386389616327, 6322672257,
     -33839470698265265, 100000000, 151762519024157, 3533550925, 37677870758180204, 100000000),
    (457820900, 291000597942479, 54108079174, -17443781529266122, 100000000, 154673540348169, 6446129046,
     2899642351966819, 100000000, 151762519024157, 3533550925, 37662174931659568, 100000000),
]


def golden_rows(pol: Policy = CONTRACT):
    now = GOLDEN_START
    pools = new_vault([a for a, _, _ in GOLDEN_SEEDS], now)
    for asset, hitz, amount in GOLDEN_SEEDS:
        pools = seed(pol, pools, asset, hitz, amount, now)

    def row(pools, now, out):
        r = [out] + [0] * 12
        for i in range(len(pools)):
            s = pool_state(pol, pools, i, now)
            r[1 + 4 * i:5 + 4 * i] = [s.hitz, s.reserve, s.deviation, s.fee]
        return tuple(r)

    rows = []
    for dt, tin, tout, amount in GOLDEN_FIRST:
        now += dt
        pools, out, _ = swap(pol, pools, tin, tout, amount, now)
        rows.append(row(pools, now, out))
    now += UPGRADE_DELAY_SECS
    pools = list_asset(pools, GOLDEN_LISTED[0], now)
    pools = seed(pol, pools, *GOLDEN_LISTED, now)
    rows.append(row(pools, now, 0))
    for dt, tin, tout, amount in GOLDEN_THEN:
        now += dt
        pools, out, _ = swap(pol, pools, tin, tout, amount, now)
        rows.append(row(pools, now, out))
    return rows


def check_golden() -> bool:
    ok = True
    for n, (got, want) in enumerate(zip(golden_rows(), GOLDEN_ROWS)):
        if got != want:
            print(f"row {n}: MISMATCH\n  got  {got}\n  want {want}")
            ok = False
    return ok


if __name__ == "__main__":
    import sys
    if "--check" in sys.argv:
        good = check_golden()
        print("golden vectors: OK, port matches the contract" if good else "golden vectors: MISMATCH")
        sys.exit(0 if good else 1)
