---
summary: confirm a deploy with rollout status before you report done
at: 2025-09-05
kind: recipe
---
Run `kubectl rollout status deployment/web -n example --timeout=120s` after the push. If it times out, read the pod events. The fix for the probe came in example-org/example-repo#12.
