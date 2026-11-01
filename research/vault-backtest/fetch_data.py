"""Download the public data the backtest needs into ./data (not committed).

  data/xlm_1m.jsonl          Binance XLMUSDC 1-minute candles:
                             [open time, open, high, low, close, quote volume]
  data/pool-<prefix>.jsonl   every event of the two Aquarius HITZ pools,
                             with the event body decoded

Sources: Binance's public market-data mirror and the Stellar Expert API.
Standard library only.

    python3 fetch_data.py [--until YYYY-MM-DD]
"""
import argparse
import base64
import datetime
import json
import os
import struct
import time
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(HERE, "data")

# The two Aquarius pools HITZ traded on until Oct 2, 2026.
POOLS = {
    "CCCDPF74BFBIHCBWCA3QX5R2UULH4VSJFOK6KL44KDKJS75ZKJJYUSPH": "HITZ/XLM",
    "CBMOEJUOKI72AXRPEQCRYSWDUBMI2LZEYVFJUTB256FO3WYSYSZI5F5A": "HITZ/USDC",
}
POOL_CREATED = datetime.datetime(2026, 4, 25, tzinfo=datetime.UTC)
STELLAR_EXPERT = "https://api.stellar.expert/explorer/public"
BINANCE = "https://data-api.binance.vision/api/v3/klines"


def get_json(url: str):
    # Stellar Expert's CDN rejects the default Python-urllib user agent.
    req = urllib.request.Request(url, headers={"User-Agent": "hitz-vault-backtest/1.0"})
    for attempt in range(5):
        try:
            with urllib.request.urlopen(req, timeout=60) as res:
                return json.load(res)
        except Exception:  # noqa: BLE001 - retry any transport error
            time.sleep(2 ** attempt)
    raise RuntimeError(f"failed: {url}")


def decode_scval(b: bytes, i: int = 0):
    """Decode the subset of XDR ScVal that pool event bodies use."""
    (t,) = struct.unpack_from(">i", b, i)
    i += 4
    if t == 0:  # bool
        (v,) = struct.unpack_from(">i", b, i)
        return bool(v), i + 4
    if t == 1:  # void
        return None, i
    if t in (3, 4):  # u32, i32
        return struct.unpack_from(">I" if t == 3 else ">i", b, i)[0], i + 4
    if t in (5, 6):  # u64, i64
        return struct.unpack_from(">Q" if t == 5 else ">q", b, i)[0], i + 8
    if t in (9, 10):  # u128, i128: hi then lo
        hi = struct.unpack_from(">Q" if t == 9 else ">q", b, i)[0]
        (lo,) = struct.unpack_from(">Q", b, i + 8)
        return (hi << 64) | lo, i + 16
    if t in (13, 14, 15):  # bytes, string, symbol: length + padded data
        (n,) = struct.unpack_from(">I", b, i)
        raw = b[i + 4:i + 4 + n]
        return (raw.hex() if t == 13 else raw.decode("utf-8", "replace")), i + 4 + ((n + 3) // 4) * 4
    if t == 18:  # address: account (key type + 32 bytes) or contract (32 bytes)
        (kind,) = struct.unpack_from(">i", b, i)
        return ("account" if kind == 0 else "contract"), i + (40 if kind == 0 else 36)
    if t == 16:  # vec (optional)
        (present,) = struct.unpack_from(">i", b, i)
        i += 4
        if not present:
            return None, i
        (n,) = struct.unpack_from(">I", b, i)
        i += 4
        out = []
        for _ in range(n):
            v, i = decode_scval(b, i)
            out.append(v)
        return out, i
    raise ValueError(f"unsupported ScVal type {t}")


def fetch_candles(until: datetime.datetime):
    path = os.path.join(DATA, "xlm_1m.jsonl")
    t = int(POOL_CREATED.timestamp() * 1000)
    end = int(until.timestamp() * 1000)
    n = 0
    with open(path, "w") as out:
        while t < end:
            rows = get_json(f"{BINANCE}?symbol=XLMUSDC&interval=1m&limit=1000&startTime={t}")
            if not rows:
                break
            for r in rows:
                if r[0] >= end:
                    break
                out.write(json.dumps([r[0] // 1000, float(r[1]), float(r[2]), float(r[3]), float(r[4]), float(r[7])]) + "\n")
                n += 1
            t = rows[-1][0] + 60_000
    print(f"{path}: {n} candles")


def fetch_pool_events():
    for address, label in POOLS.items():
        path = os.path.join(DATA, f"pool-{address[:8]}.jsonl")
        cursor, n = "", 0
        with open(path, "w") as out:
            while True:
                url = f"{STELLAR_EXPERT}/contract/{address}/events?order=asc&limit=200"
                if cursor:
                    url += f"&cursor={cursor}"
                records = get_json(url).get("_embedded", {}).get("records", [])
                for e in records:
                    try:
                        body, _ = decode_scval(base64.b64decode(e["bodyXdr"]))
                    except (ValueError, struct.error):
                        body = None  # not an event the backtest reads
                    out.write(json.dumps({
                        "id": e["id"], "ts": e["ts"], "name": e["topics"][0], "topics": e["topics"][1:],
                        "initiator": e.get("initiator"), "body": [str(v) if isinstance(v, int) else v for v in body]
                        if isinstance(body, list) else body,
                    }) + "\n")
                    n += 1
                if len(records) < 200:
                    break
                cursor = records[-1]["paging_token"]
                time.sleep(0.3)
        print(f"{path}: {n} events ({label})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--until", default=datetime.datetime.now(datetime.UTC).strftime("%Y-%m-%d"))
    args = ap.parse_args()
    os.makedirs(DATA, exist_ok=True)
    fetch_pool_events()
    fetch_candles(datetime.datetime.strptime(args.until, "%Y-%m-%d").replace(tzinfo=datetime.UTC))
