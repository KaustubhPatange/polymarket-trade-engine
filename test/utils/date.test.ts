import { describe, test, expect } from "bun:test";
import { toIST } from "../../utils/date.ts";

describe("toIST", () => {
  test("converts timestamp to IST string", () => {
    const result = toIST(0);
    expect(result).toContain("1/1/1970");
    expect(result).toContain("05:30:00");
  });

  test("converts ISO string to IST string", () => {
    const result = toIST("2024-01-15T12:00:00Z");
    expect(result).toContain("17:30:00");
  });

  test("uses 24-hour format", () => {
    const result = toIST(0);
    expect(result.toLowerCase()).not.toContain("am");
    expect(result.toLowerCase()).not.toContain("pm");
  });
});
