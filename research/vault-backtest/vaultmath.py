"""Exact integer port of contracts/sovereign-vault/src/lib.rs swap math.

Every operation mirrors the Rust: i128 division truncates toward zero
(tdiv), mul_div_ceil rounds up, and pow_sat saturates the same way. The
fee policy is pluggable so the same engine can run the proposal, flat
fees, and an Aquarius-style 0.1%-on-input pool for calibration.

`python3 vaultmath.py --check` replays the golden vectors that the contract
test `fee_math_matches_the_golden_vectors` asserts, and must match exactly.
"""
from dataclasses import dataclass, replace

ONE = 1_000_000_000
XLM_POOL, USDC_POOL = 0, 1


def tdiv(a: int, b: int) -> int:
    """Rust integer division (truncates toward zero)."""
    q = abs(a) // abs(b)
    return q if (a >= 0) == (b >= 0) else -q


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


@dataclass
class Policy:
    name: str
    kind: str = "dynamic"        # "dynamic" | "flat" | "aqua"
    floor: int = 10_000_000      # 1% in 9 decimals
    cap: int = 100_000_000       # 10%
    steepness: int = 100
    tau_secs: int = 7_200
    decay_per_sec: int = 999_861_121  # e^(-1/7200)
    flat: int = 10_000_000       # flat fee for kind == "flat" / "aqua"
    aqua_protocol_share: int = 50  # % of the aqua fee that leaves the pool

    def with_tau(self, tau):
        import math
        return replace(self, tau_secs=tau, decay_per_sec=round(math.exp(-1 / tau) * ONE))


def xlm_price(r) -> int:
    hx, x, hu, u = r
    num = u * hx * ONE
    den = hu * x
    p = num // den
    if p == 0:
        raise OverflowError("price underflow")
    return p


def fee_for_price(pol: Policy, price: int, anchor: int) -> int:
    num, den = (price, anchor) if price >= anchor else (anchor, price)
    ratio = (num * ONE + den - 1) // den  # rounds up, like the contract
    mult = pow_sat(ratio, pol.steepness, pol.cap * ONE // pol.floor)
    fee = pol.floor * mult // ONE
    return pol.cap if fee > pol.cap else fee


def anchor_now(pol: Policy, r, anchor_price: int, anchor_time: int, now: int) -> int:
    if now <= anchor_time:
        return anchor_price
    price = xlm_price(r)
    memory = pow_sat(pol.decay_per_sec, now - anchor_time, ONE)
    return price + tdiv((anchor_price - price) * memory, ONE)


def _pool(r, pool):
    return (r[0], r[1]) if pool == XLM_POOL else (r[2], r[3])


def _set(r, pool, h, q):
    return (h, q, r[2], r[3]) if pool == XLM_POOL else (r[0], r[1], h, q)


class TradeTooSmall(Exception):
    pass


def hop(pol: Policy, r, anchor: int, pool: int, hitz_in: bool, amount_in: int):
    rh, rq = _pool(r, pool)
    r_in, r_out = (rh, rq) if hitz_in else (rq, rh)
    if pol.kind == "aqua":
        # Fee withheld from the input, stays in the input reserve.
        fee_in = -(-amount_in * pol.flat // ONE)
        eff = amount_in - fee_in
        out = r_out * eff // (r_in + eff)
        if out <= 0:
            raise TradeTooSmall
        # Aquarius: half the fee stays in the pool, half leaves as protocol fee.
        protocol = fee_in * pol.aqua_protocol_share // 100
        new_in, new_out = r_in + amount_in - protocol, r_out - out
        h, q = (new_in, new_out) if hitz_in else (new_out, new_in)
        return _set(r, pool, h, q), out, pol.flat
    new_in = r_in + amount_in
    gross = r_out * amount_in // new_in
    if pol.kind == "flat":
        fee_rate = pol.flat
    else:
        h, q = (new_in, r_out - gross) if hitz_in else (r_out - gross, new_in)
        fee_rate = fee_for_price(pol, xlm_price(_set(r, pool, h, q)), anchor)
    fee_amount = -(-gross * fee_rate // ONE)
    out = gross - fee_amount
    if out <= 0:
        raise TradeTooSmall
    h, q = (new_in, r_out - out) if hitz_in else (r_out - out, new_in)
    return _set(r, pool, h, q), out, fee_rate


ROUTES = {
    "XLM->USDC": [(XLM_POOL, False), (USDC_POOL, True)],
    "USDC->XLM": [(USDC_POOL, False), (XLM_POOL, True)],
}


def run_route(pol: Policy, r, anchor: int, route: str, amount_in: int):
    fees = []
    amt = amount_in
    for pool, hitz_in in ROUTES[route]:
        r, amt, fr = hop(pol, r, anchor, pool, hitz_in, amt)
        fees.append(fr)
    return r, amt, fees


# ── Golden vectors (contracts/sovereign-vault/src/test.rs) ─────────────────
# (advance secs, token in, token out, amount in), then the expected
# (amount out, hitz_xlm, xlm, hitz_usdc, usdc, xlm_price, anchor, fee).
GOLDEN_RESERVES = (576_979_786_994_794, 108_590_621_387, 307_270_480_999_958, 12_733_312_293)
_U = 10_000_000
GOLDEN_STEPS = [
    (0, "xlm", "usdc", 50 * _U), (300, "usdc", "xlm", 10 * _U), (3_600, "xlm", "hitz", 100 * _U),
    (0, "hitz", "usdc", 1_000_000 * _U), (7_200, "usdc", "hitz", 5 * _U), (86_400, "xlm", "usdc", 500 * _U),
    (5, "xlm", "usdc", 3 * _U + 1_234), (1_800, "usdc", "xlm", 40 * _U), (17, "usdc", "xlm", 7 * _U),
    (100_000, "hitz", "xlm", 3_000_000 * _U), (61, "xlm", "usdc", _U), (3, "usdc", "xlm", 123_456_789),
]
GOLDEN_EXPECTED = [
    (95357378, 574401566309723, 109090621387, 309848701685029, 12637954915, 214760952, 220185558, 100000000),
    (445114018, 576778952628527, 108645507369, 307471315366225, 12737954915, 219934182, 219964176, 10137302),
    (4928942487090, 571850010141437, 109645507369, 307471315366225, 12737954915, 216065980, 219952374, 59460177),
    (361108511, 571850010141437, 109645507369, 317471315366225, 12376846404, 203327818, 219952374, 100000000),
    (1166910435081, 571850010141437, 109645507369, 316304404931144, 12426846404, 204902370, 209443648, 89540845),
    (741073549, 549404080033126, 114645507369, 338750335039455, 11685772855, 165315108, 204902397, 100000000),
    (4014738, 549274719191306, 114675508603, 338879695881275, 11681758117, 165113124, 204874915, 100000000),
    (1863074107, 559372313377171, 112812434496, 328782101695410, 12081758117, 182207380, 196079636, 100000000),
    (308451382, 561076862810049, 112503983114, 327077552262532, 12151758117, 185286099, 196046920, 100000000),
    (5139107508, 591076862810049, 107364875606, 327077552262532, 12151758117, 204536166, 185286108, 100000000),
    (1656337, 591027319639590, 107374875606, 327127095432991, 12150101780, 204441133, 185448510, 100000000),
    (481804063, 593988763503894, 106893071543, 324165651568687, 12273558569, 210393431, 185456422, 100000000),
]
_LEGS = {
    ("xlm", "usdc"): [(XLM_POOL, False), (USDC_POOL, True)], ("usdc", "xlm"): [(USDC_POOL, False), (XLM_POOL, True)],
    ("xlm", "hitz"): [(XLM_POOL, False)], ("hitz", "xlm"): [(XLM_POOL, True)],
    ("usdc", "hitz"): [(USDC_POOL, False)], ("hitz", "usdc"): [(USDC_POOL, True)],
}


def check_golden() -> bool:
    pol = Policy("proposal")
    r = GOLDEN_RESERVES
    now = 1_800_000_000
    anchor = (xlm_price(r), now)
    ok = True
    for (dt, tin, tout, amount), want in zip(GOLDEN_STEPS, GOLDEN_EXPECTED):
        now += dt
        a = anchor_now(pol, r, anchor[0], anchor[1], now)
        out = amount
        for pool, hitz_in in _LEGS[(tin, tout)]:
            r, out, _ = hop(pol, r, a, pool, hitz_in, out)
        anchor = (a, now)
        a_view = anchor_now(pol, r, anchor[0], anchor[1], now)
        got = (out, *r, xlm_price(r), a_view, fee_for_price(pol, xlm_price(r), a_view))
        if got != want:
            print("MISMATCH", got, want)
            ok = False
    return ok


if __name__ == "__main__":
    import sys
    if "--check" in sys.argv:
        good = check_golden()
        print("golden vectors: OK, port matches the contract" if good else "golden vectors: MISMATCH")
        sys.exit(0 if good else 1)
