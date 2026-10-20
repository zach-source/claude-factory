// The AX controller readiness rule. It imports nothing, so the policy broker image can hold it
// with src/broker.ts. src/ax.ts re-exports it.

export const CONTROLLER_UNKNOWN = 'AX executor unavailable: controller readiness could not be observed'

/** the reason AX cannot take a launch, from `kubectl get deployment ax-controller -o json`; undefined when ready */
export function controllerReadiness(json: string): string | undefined {
  try {
    const d = JSON.parse(json)
    const generation = d?.metadata?.generation
    const status = d?.status
    if (
      !d?.metadata?.deletionTimestamp &&
      Number.isSafeInteger(generation) &&
      generation > 0 &&
      Number.isSafeInteger(status?.observedGeneration) &&
      status.observedGeneration >= generation &&
      Number.isSafeInteger(d?.spec?.replicas) &&
      d.spec.replicas > 0 &&
      Number.isSafeInteger(status?.readyReplicas) &&
      status.readyReplicas > 0 &&
      Number.isSafeInteger(status?.availableReplicas) &&
      status.availableReplicas > 0
    )
      return undefined
    return 'AX executor unavailable: ax-system/ax-controller is not ready at its current generation'
  } catch {
    return CONTROLLER_UNKNOWN
  }
}
