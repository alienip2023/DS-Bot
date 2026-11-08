# Gateway Slice 0 Probe — Tailnet

**Date**: 2026-11-08T09:25:32.471Z
**Method**: This test uses tailnet plain TCP (100.64.x.x), NOT ssh2 reverse tunnel.
**Hub IP**: 100.64.0.3 (Mac tailscale0)
**Tokens**: 200 × 20ms = ~4000ms stream, n=10 median

## Results

| Metric | Local Baseline | Tailnet (local) | Remote (dshtest-1) | Gate | Result |
|--------|---------------|-----------------|----------------|------|--------|
| TTFT (ms) | 0 | 0 | 1 | ≤ baseline + 300ms | ✅ PASS |
| 200-token total (ms) | 4216 | 4209 | 4235 | ≤ baseline × 1.5 | ✅ PASS |
| Abort propagation (ms) | — | 1 | — | ≤ 1000ms | ✅ PASS |
| Token count | 200 | 200 | 200-200 | === 200 | ✅ PASS |
| Connection est. (ms) | — | 2 | 42 | — | — |

## Raw data (sorted)

- Local TTFT: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
- Local total: [4193, 4201, 4203, 4211, 4214, 4216, 4217, 4226, 4234, 4247]
- Local tokens: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]
- Tailnet TTFT: [0, 0, 0, 0, 0, 0, 0, 0, 0, 1]
- Tailnet total: [4187, 4188, 4200, 4208, 4209, 4209, 4215, 4219, 4219, 4223]
- Tailnet tokens: [200, 200, 200, 200, 200, 200, 200, 200, 200, 200]
- Conn times: [1, 1, 2, 2, 2, 2, 2, 3, 3, 3]

## Remote verification

Remote node executed via external task; 3 iterations. See docs/evidence/slice0-remote-dshtest-1.txt.

Remote raw output file: docs/evidence/slice0-remote-dshtest-1.txt

Remote raw data:
```
[{"ttft":1,"total":4226,"conn":120,"cnt":200},{"ttft":1,"total":4235,"conn":42,"cnt":200},{"ttft":0,"total":4244,"conn":42,"cnt":200}]
```


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
