import { describe, it, expect } from "vitest";
import { __modelIntegrationTest } from "../hooks/compaction.js";

describe("model-integration compaction metadata", () => {
  it("uses pi-native willRetry metadata for overflow retry compaction", () => {
    const result = __modelIntegrationTest.formatCompactionMode({
      reason: "overflow",
      willRetry: true,
    });

    expect(result).toBe("overflow, retrying");
  });

  it("uses pi-native reason metadata for threshold compaction", () => {
    const result = __modelIntegrationTest.formatCompactionMode({
      reason: "threshold",
      willRetry: false,
    });

    expect(result).toBe("threshold");
  });

  it("uses pi-native reason metadata for manual compaction", () => {
    const result = __modelIntegrationTest.formatCompactionMode({
      reason: "manual",
      willRetry: false,
    });

    expect(result).toBe("manual");
  });
});
