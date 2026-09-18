---
id: randomness-and-seeds
kind: concept
title: Randomness and Seeds
panels: [mc-config, mc-runs]
params: [randomSeed, rngStreams]
design: [74-stochastic-return-paths.md]
stamps:
  param:randomSeed: 7a100c
  param:rngStreams: 85e3c6
  panel:mc-config: 2c8dce
  panel:mc-runs: aca7d2
---

Every stochastic process in the simulation draws from one seeded generator, so a run
is reproducible: same scenario, same seed, byte-identical result. That is what makes
a golden fixture possible and what makes any A/B trustworthy.

The subtlety is **how** the draws are shared, and it is the difference between a
valid comparison and a confounded one.

By default the processes take numbers from a single cursor in whatever order they
happen to ask. That is fine for one run. It is a trap for two: change a policy so
that one extra draw happens early — an extra sale, a shifted event — and every later
process gets a *different number than it would have*. The two arms then differ by
your change **and** by the entire realised future, and the difference you measure is
mostly the second one.

Turning on per-process streams fixes that. Each process draws from its own
year-keyed stream, so two scenarios differing in policy experience the same realised
world, and what is left between them is the policy. Anything that calls itself a
paired comparison should have this on.

Matching seeds across arms is *not* the same thing and is a common way to get this
wrong: the same seed gives you the same numbers, but a shifted draw order hands them
out on different dates, which is a different path wearing the right label.

A single run with randomness enabled is one sample, not a result. Use
[Monte Carlo](../panels/mc-config.md) when the question is about the distribution.
