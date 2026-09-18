---
id: perf
kind: panel
title: Performance
panels: [perf]
design: [78-simulation-telemetry-cost.md]
stamps:
  panel:perf: 2caa26
---

Where the time goes during a run: frame timing, average event and handler cost, and a
histogram of execution durations, sampled live.

Open it when playback is slow, when a Monte Carlo batch is taking longer than it
should, or after a change that added work to the step loop. The histogram is the
useful half — an average hides the shape, and a run that is fine except for a long
tail is a different problem from one that is uniformly slow.

It samples a bounded window rather than the whole run, so it stays cheap and tells
you about *now* rather than about the average since load. Clear resets the window,
which is what you want right before the thing you actually mean to measure.

Needs a run that is stepping; a paused simulation produces no samples.

Telemetry is the usual answer when the numbers are bad. Recording the journal,
history snapshots and bus traffic is most of the per-step cost, which is why the
headless runners offer a reduced level and the Monte Carlo path uses one. A panel
that reads the journal cannot work on a run made without it, so the trade is real
rather than free.
