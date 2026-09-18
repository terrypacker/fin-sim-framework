# FinSim Design and Technical Requirements

## General Rules
### Time
* Time should be tracked as UTC ms since epoch
* Time should be converted to a global timezone, which is selectable by the user and defaults to current timezone

---

## The index is generated

**Every document in this directory is listed, with its title, in
[`help/REFERENCE.md`](../help/REFERENCE.md) § Design documents.** The titles are read out
of the files themselves by `npm run help:build`, so a design doc added tomorrow appears
without anyone having remembered anything. `npm run help -- --find <text> --kind design`
searches the same index.

This file used to carry a hand-written index: ten links, each with a paragraph summarising
the document it linked to, out of the 116 documents here. It had drifted in both directions
at once — 106 documents were missing, and four of the ten it did list under *Unimplemented
Features* had long since shipped. That is the failure design 108 §2.1 measured and
[`108-help-system.md`](108-help-system.md) exists to end: a summary of an argument is a
second copy of that argument, and the argument changes without the filename changing.

So there is no summary column anywhere, here or in the generated index. Each document opens
with its own title and, increasingly, a **Status:** line — read that.

*(The removed summaries are in the git history, and each one's source document is the
better version of it.)*

---

## Ideas with no design document yet

Kept here because they exist nowhere else. Anything with a document belongs in the
generated index instead, not in a second list.

### Temporal Query Language
Temporal query language design — a DSL for querying “state across time, branches, and periods” in one unified way.

### Scenario Monte Carlo Improvements
* implementing a worker pool for parallel Monte Carlo
* Checkpoint-based Monte Carlo

### Journal System
* upgrade journaling to delta-based + compressed storage
