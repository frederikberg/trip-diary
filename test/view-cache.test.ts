// A trip written to many times in a row (an import) keeps one built view per scope, not one per revision.
import { afterAll, expect, test } from "bun:test";
import { cachedViews } from "../src/server/view";
import { fakeImmich, onTrack, seedTrip, testApp } from "./helpers";

const immich = fakeImmich();
afterAll(() => immich.stop());

test("writes in a row replace the trip's built view instead of adding one per revision", async () => {
  const app = testApp(immich.url);
  await seedTrip(app);
  const before = cachedViews();
  for (let i = 0; i < 20; i++) {
    const r = await app.call("/api/admin/trips/sample/notes", {
      method: "POST",
      admin: true,
      json: onTrack(2, 0.02 * (i + 1)),
    });
    expect(r.status).toBe(201);
  }
  expect(cachedViews() - before).toBeLessThanOrEqual(2);
});
