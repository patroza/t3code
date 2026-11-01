// @effect-diagnostics nodeBuiltinImport:off - expectations mirror the host path joins the script under test performs.
import { assert, it } from "@effect/vitest";
import { PNG } from "pngjs";
import { MOBILE_DEFAULT_THEME_ID } from "@t3tools/shared/themePalettes";
import showcaseConfig from "./mobile-showcase.config.ts";

import type { ShowcaseStoreAssetSpec } from "./mobile-showcase.config.ts";
import {
  encodeAndroidPairingUrls,
  normalizeStorePng,
  parsePairingCredentialOutput,
  readPngMetadata,
  validateStoreAsset,
} from "./mobile-showcase.ts";

function rgbaPng(width: number, height: number): Buffer {
  const png = new PNG({ width, height });
  png.data.fill(255);
  return PNG.sync.write(png);
}

it("converts simulator RGBA captures to upload-safe 24-bit RGB PNGs", () => {
  const normalized = normalizeStorePng(rgbaPng(2, 3));
  assert.deepStrictEqual(readPngMetadata(normalized), {
    width: 2,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  });
});

const storeSpec: ShowcaseStoreAssetSpec = {
  store: "apple",
  directory: "fixture",
  width: 2,
  height: 3,
  minimumUploadCount: 1,
  maximumUploadCount: 10,
};

it("validates a complete RGB PNG from an offset byte view", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  const padded = Buffer.concat([Buffer.from([0]), bytes, Buffer.from([0])]);
  assert.deepStrictEqual(validateStoreAsset(storeSpec, padded.subarray(1, -1)), {
    width: 2,
    height: 3,
    bitDepth: 8,
    colorType: 2,
    hasAlpha: false,
  });
});

it("rejects PNG metadata without image data during store validation", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  assert.throws(
    () => validateStoreAsset(storeSpec, bytes.subarray(0, 26), "threads.png"),
    /threads\.png is not a valid PNG/,
  );
  assert.throws(() => validateStoreAsset(storeSpec, bytes.subarray(0, 33)), /is not a valid PNG/);
});

it("rejects a PNG truncated inside its image data", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  const imageData = bytes.indexOf("IDAT");
  assert.notEqual(imageData, -1);
  assert.throws(
    () => validateStoreAsset(storeSpec, bytes.subarray(0, imageData + 5)),
    /is not a valid PNG/,
  );
});

it("rejects a PNG with a corrupt image-data checksum", () => {
  const bytes = normalizeStorePng(rgbaPng(2, 3));
  const imageData = bytes.indexOf("IDAT");
  assert.notEqual(imageData, -1);
  const checksum = imageData + 4 + bytes.readUInt32BE(imageData - 4);
  bytes[checksum] = bytes.readUInt8(checksum) ^ 1;
  assert.throws(() => validateStoreAsset(storeSpec, bytes), /is not a valid PNG/);
});

it("reads multiline JSON from the pairing CLI", () => {
  assert.equal(
    parsePairingCredentialOutput('server log\n{\n  "credential": "PAIR-ME"\n}\n'),
    "PAIR-ME",
  );
});

it("encodes Android pairing URLs without shell-sensitive JSON quotes", () => {
  const urls = ["http://10.0.2.2:65164/#token=ONE", "http://10.0.2.2:65198/#token=TWO"];
  const encoded = encodeAndroidPairingUrls(urls);
  assert.equal(encoded.startsWith("json-uri:"), true);
  assert.deepStrictEqual(JSON.parse(decodeURIComponent(encoded.slice("json-uri:".length))), urls);
  assert.equal(encoded.includes('"'), false);
});

it("defaults every device to the app's own palette", () => {
  assert.equal(MOBILE_DEFAULT_THEME_ID, "t3-code");
  assert.equal(
    showcaseConfig.devices.every((device) => device.theme === MOBILE_DEFAULT_THEME_ID),
    true,
  );
});

it("configures every default device with an exact upload-ready store target", () => {
  assert.deepStrictEqual(
    showcaseConfig.devices.map((device) => [
      device.id,
      device.storeAsset.directory,
      device.storeAsset.width,
      device.storeAsset.height,
    ]),
    [
      ["iphone-6.9", "apple/iphone-6.9", 1320, 2868],
      ["iphone-6.5", "apple/iphone-6.5", 1284, 2778],
      ["iphone-duo-closed", "apple/iphone-duo-closed", 1398, 2034],
      ["iphone-duo-open", "apple/iphone-duo-open", 2853, 2007],
      ["ipad-13", "apple/ipad-13", 2064, 2752],
      ["pixel", "google-play/phone", 1080, 1920],
      ["android-tablet-7", "google-play/tablet-7", 1080, 1920],
      ["android-tablet-10", "google-play/tablet-10", 1440, 2560],
    ],
  );
});
