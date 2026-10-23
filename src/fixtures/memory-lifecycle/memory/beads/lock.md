---
summary: an init on the shared tracker server takes a lock that stalls every repo
at: 2025-09-01
kind: fact
---
A tracker init on the shared server holds a global lock until it finishes. Run it once per repo, never in a loop over repos.
