// The shipped config: placeholders that must be replaced, and the switches that keep the optional features off.
import { describe, expect, test } from "bun:test";
import { loadConfig } from "../src/server/config";

const SECRETS = { ADMIN_TOKEN: "admin-token-for-tests-0123456789", IMMICH_API_KEY: "key" };
const OWN = {
  TRIP_SERVER_PUBLIC_URL: "https://trip.mydomain.net",
  TRIP_IMMICH_URL: "http://immich-server:2283",
};

describe("loadConfig", () => {
  test("refuses to start while the public URL or the Immich URL is still a placeholder", () => {
    expect(() => loadConfig({ ...SECRETS })).toThrow("server.public_url still holds the placeholder");
    expect(() => loadConfig({ ...SECRETS, TRIP_SERVER_PUBLIC_URL: OWN.TRIP_SERVER_PUBLIC_URL })).toThrow(
      "immich.url still holds the placeholder",
    );
  });

  test("the shipped defaults with the two URLs set: no editing, no maps, no meeting point", () => {
    const c = loadConfig({ ...SECRETS, ...OWN });
    expect(c.auth.editor_from_header).toBe(false);
    expect(c.maps.enabled).toBe(false);
    expect(c.meet.enabled).toBe(false);
    expect(c.auth.identity_header).toBe("X-Auth-Request-Email");
    expect(c.auth.sign_out_path).toBe("/oauth2/sign_out");
  });

  test("the editing URL must be set once the header login is on", () => {
    const on = { ...SECRETS, ...OWN, TRIP_AUTH_EDITOR_FROM_HEADER: "true" };
    expect(() => loadConfig(on)).toThrow("server.edit_url still holds the placeholder");
    expect(loadConfig({ ...on, TRIP_SERVER_EDIT_URL: "https://trip-edit.mydomain.net" }).auth.editor_from_header).toBe(
      true,
    );
  });

  test("the meeting point needs the maps", () => {
    expect(() => loadConfig({ ...SECRETS, ...OWN, TRIP_MEET_ENABLED: "true" })).toThrow(
      "meet.enabled needs maps.enabled",
    );
    const c = loadConfig({ ...SECRETS, ...OWN, TRIP_MEET_ENABLED: "true", TRIP_MAPS_ENABLED: "true" });
    expect([c.maps.enabled, c.meet.enabled]).toEqual([true, true]);
  });

  test("the sign-out path is a path", () => {
    expect(() => loadConfig({ ...SECRETS, ...OWN, TRIP_AUTH_SIGN_OUT_PATH: "sign_out" })).toThrow("must start with /");
  });
});
