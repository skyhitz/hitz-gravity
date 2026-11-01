"""Why a hop pays for its asset's worst pair, not only the pair it trades.

Three assets, X, C and U, each with a pool against HITZ. X is dislocated by
d against U and C sits halfway (d/2). A trader swaps X for U, either
directly or through C (X->C, then C->U).

- Contract ("worst"): every hop pays for its pool's most dislocated pair,
  whatever the route, so a detour only adds hops and always costs more.
- Alternative ("pair"): a swap pays only for the pair it trades. The detour
  then pays for two half-size dislocations instead of one full one, and the
  fee is convex in the dislocation, so the detour can come out cheaper: the
  fee leaks to whoever routes around it.

    python3 detours.py

Exact contract math (vaultmath.py); the "pair" scope exists only here.
"""
from dataclasses import replace

from vaultmath import CONTRACT, HITZ, WAD, Pool, swap

U = 10_000_000
NOW = 1_800_000_000
DEPTH = 1_000_000 * U  # each pool: 1M HITZ against 1M of its asset
PAIR = replace(CONTRACT, name="pair only", scope="pair")


def vault(d: float, c_depth: float):
    c = int(DEPTH * c_depth)
    return (Pool("X", DEPTH, DEPTH, int(d * WAD), NOW),
            Pool("C", c, c, int(d / 2 * WAD), NOW),
            Pool("U", DEPTH, DEPTH, 0, NOW))


def direct_and_detour(pol, d, c_depth, amount):
    _, direct, _ = swap(pol, vault(d, c_depth), "X", "U", amount, NOW)
    pools, mid, _ = swap(pol, vault(d, c_depth), "X", "C", amount, NOW)
    _, detour, _ = swap(pol, pools, "C", "U", mid, NOW)
    return direct, detour


def split(pol, d, c_depth, amount):
    """X->HITZ then HITZ->U as two swaps, against X->U in one."""
    _, one, _ = swap(pol, vault(d, c_depth), "X", "U", amount, NOW)
    pools, h, _ = swap(pol, vault(d, c_depth), "X", HITZ, amount, NOW)
    _, two, _ = swap(pol, pools, HITZ, "U", h, NOW)
    return one, two


def main():
    depths = (0.1, 1.0, 10.0)
    print("## Detour X->C->U against direct X->U\n")
    print("X is dislocated by d against U, and C sits halfway. Each cell is what the detour pays out relative to "
          "the direct swap: positive means routing around the fee pays (a leak). The C pool holds 0.1x, 1x or 10x "
          "the HITZ of the X and U pools.\n")
    print("| d | Trade (% of pool) | " + " | ".join(f"Pair-only, C {c:g}x" for c in depths) + " | "
          + " | ".join(f"Contract, C {c:g}x" for c in depths) + " |")
    print("|---|---|" + "---|" * 2 * len(depths))
    best = {PAIR.name: -1.0, CONTRACT.name: -1.0}
    for d in (0.005, 0.010, 0.015, 0.020, 0.030, 0.050):
        for frac in (0.0001, 0.001, 0.01):
            cells = []
            for pol in (PAIR, CONTRACT):
                for c_depth in depths:
                    direct, detour = direct_and_detour(pol, d, c_depth, int(DEPTH * frac))
                    edge = detour / direct - 1
                    best[pol.name] = max(best[pol.name], edge)
                    cells.append(f"**{edge:+.2%}**" if edge > 0 else f"{edge:+.2%}")
            print(f"| {d:.1%} | {frac:.2%} | " + " | ".join(cells) + " |")
    print(f"\nBest detour: pair-only pricing {best[PAIR.name]:+.2%}, the contract {best[CONTRACT.name]:+.2%} "
          "(a detour only adds hops).\n")

    same = all(len({*split(CONTRACT, d, 1.0, int(DEPTH * f))}) == 1
               for d in (0.0, 0.01, 0.03) for f in (0.0001, 0.01))
    print(f"Contract: X->HITZ then HITZ->U pays exactly what X->U pays: {same}.")


if __name__ == "__main__":
    main()
