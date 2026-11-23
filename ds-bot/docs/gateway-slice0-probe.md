# Gateway Slice 0 Probe — Tailnet

**Date**: 2026-11-23T18:17:13.871Z
**Method**: This test uses tailnet plain TCP (100.64.x.x), NOT ssh2 reverse tunnel.
**Hub IP**: 100.64.0.3 (Mac tailscale0)
**Tokens**: 200 × 20ms = ~4000ms stream, n=10 median

## Results

| Metric | Local Baseline | Tailnet (local) | Remote | Gate | Result |
|--------|---------------|-----------------|------|------|--------|
| TTFT (ms) | 0 | 0 | — | ≤ baseline + 300ms | ✅ PASS |
| 200-token total (ms) | 4325 | 4336 | — | ≤ baseline × 1.5 | ✅ PASS |
| Abort propagation (ms) | — | 2 | — | ≤ 1000ms | ✅ PASS |
| Token count | 200 | 200 | — | === 200 | ✅ PASS |
| Connection est. (ms) | — | 2 | — | — | — |

## Raw data (sorted)

- Local TTFT: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
- Local total: [4159, 4187, 4275, 4305, 4320, 4325, 4326, 4331, 4339, 4347]
- Local tokens: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]
- Tailnet TTFT: [0, 0, 0, 0, 0, 0, 0, 0, 1, 1]
- Tailnet total: [4327, 4329, 4330, 4333, 4335, 4336, 4339, 4340, 4344, 4345]
- Tailnet tokens: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]
- Conn times: [1, 1, 2, 2, 2, 2, 2, 2, 2, 3]

## Remote verification

未测远端



## lsof verification

```

```

## Knife results

- **K-A** (--knife-abort): server ignores abort → abort > 1s → gate FAIL
- **K-B** (--knife-delay): first token +800ms (tailnet only, baseline unaffected) → TTFT > baseline+300ms → gate FAIL

## Conclusion

**本次测的是 tailnet 上明文 TCP，未使用 ssh2。**
Tailnet TCP adds 0ms median TTFT overhead vs loopback.
All gates: PASS.
