---
summary: the build cache keys on the lockfile hash, so no manual clear is needed
at: 2025-09-12
kind: fact
---
The build cache uses the lockfile hash as its key. A lockfile change makes a new cache, so do not clear it by hand.
