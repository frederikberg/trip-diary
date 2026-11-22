// Marks Immich media whose asset is trashed or deleted, so view links stop showing them, and
// clears the mark once the asset is back. An Immich that cannot be asked changes nothing.
import type { Store } from "./db";
import { type Immich, ImmichError } from "./immich";

/** Checks every Immich medium once; returns how many changed state. */
export async function sweepMedia(store: Store, immich: Immich, now: () => Date): Promise<number> {
  let changed = 0;
  const trips = new Set<number>();
  for (const m of store.immichMedia()) {
    let gone: boolean;
    try {
      await immich.asset(m.immich_id as string);
      gone = false;
    } catch (e) {
      if (!(e instanceof ImmichError) || e.status !== 404) return changed;
      gone = true;
    }
    if (gone === (m.unavailable_at != null)) continue;
    store.setUnavailable(m.id, gone ? now().toISOString() : null);
    trips.add(m.trip_id);
    changed++;
  }
  for (const t of trips) store.bump(t);
  return changed;
}
