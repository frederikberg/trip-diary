// The Immich asset id in what the editor pastes: a photo page link or the bare id.
const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const BARE = new RegExp(`^${UUID}$`, "i");
const PAGE = new RegExp(`/photos/(${UUID})/?$`, "i");

/** `https://<host>/photos/<id>`, with any album or person in front and any query, or the id itself; null for anything else. */
export function immichAssetId(input: string): string | null {
  const s = input.trim();
  if (BARE.test(s)) return s.toLowerCase();
  try {
    const m = PAGE.exec(new URL(s).pathname);
    return m ? (m[1] as string).toLowerCase() : null;
  } catch {
    return null;
  }
}
