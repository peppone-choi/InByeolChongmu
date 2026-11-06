import type { RoomDetail, Resources } from '../../src/domain/http-contract.js';
export function analysisIsStale(
  latest: RoomDetail['latest'] | undefined,
  resources: Resources | null,
) {
  if (!latest?.analysis || !resources) return false;
  if (latest.snapshots)
    return (['products', 'policies', 'orders'] as const).some(
      (key) => latest.snapshots![key] !== resources.snapshots[key],
    );
  return latest.analysis.evidence.some(
    (e) =>
      e.snapshot_id !==
      resources.snapshots[
        e.source_type === 'product'
          ? 'products'
          : e.source_type === 'policy'
            ? 'policies'
            : 'orders'
      ],
  );
}
