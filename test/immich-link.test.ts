// The editor's paste field: which text counts as an Immich photo.
import { describe, expect, test } from "bun:test";
import { immichAssetId } from "../web/immich-link";

const ID = "0f9c3c1e-2b7a-4d52-9f51-0a1b2c3d4e5f";

describe("immichAssetId", () => {
  test("takes a photo page link, with or without album or person in front", () => {
    expect(immichAssetId(`https://photos.example.org/photos/${ID}`)).toBe(ID);
    expect(immichAssetId(`https://photos.example.org/albums/${ID.replace("0f9c", "1111")}/photos/${ID}?x=1`)).toBe(ID);
    expect(immichAssetId(`  https://h/people/${ID.replace("0f9c", "2222")}/photos/${ID}/ \n`)).toBe(ID);
  });

  test("takes the bare id, lower-cased", () => {
    expect(immichAssetId(ID.toUpperCase())).toBe(ID);
  });

  test("refuses everything else", () => {
    expect(immichAssetId("")).toBeNull();
    expect(immichAssetId("hallo")).toBeNull();
    expect(immichAssetId(`https://photos.example.org/albums/${ID}`)).toBeNull();
    expect(immichAssetId("https://photos.example.org/share/abcDEF123")).toBeNull();
    expect(immichAssetId(`https://photos.example.org/photos/${ID}x`)).toBeNull();
  });
});
