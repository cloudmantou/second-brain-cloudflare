import { describe, expect, it } from "vitest";
import {
  hourBucket,
  percentile,
  normalizeTelemetryConfig,
} from "../../src/telemetry";

describe("telemetry analytics helpers", () => {
  it("calculates a stable percentile for unsorted samples", () => {
    expect(percentile([30, 10, 20, 40], 0.5)).toBe(20);
    expect(percentile([30, 10, 20, 40], 0.95)).toBe(40);
    expect(percentile([], 0.95)).toBeNull();
  });

  it("normalizes privacy settings and clamps unsafe values", () => {
    expect(
      normalizeTelemetryConfig({
        telemetryEnabled: "false" as unknown as boolean,
        contentLogging: "invalid" as never,
        previewMaxChars: 999999,
        retentionDays: 0,
        storeModelResponses: "true" as unknown as boolean,
      })
    ).toEqual({
      telemetryEnabled: false,
      contentLogging: "metadata",
      previewMaxChars: 5000,
      retentionDays: 1,
      storeModelResponses: true,
    });
  });

  it("rounds timestamps down to UTC hour buckets", () => {
    expect(hourBucket(3_726_123)).toBe(3_600_000);
  });
});
