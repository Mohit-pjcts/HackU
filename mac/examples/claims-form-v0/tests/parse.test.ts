import { expect, test } from "bun:test";
import { parseAmount, parseCategory, parseClaim, parseDate } from "../src/parse.ts";

const today = new Date(2026, 9, 3); // Sat 3 Oct 2026

test("dates are day/month (Hong Kong), never US order", () => {
  expect(parseDate("30/09/2026", today)).toBe("30/09/2026");
  expect(parseDate("6/10/2026", today)).toBe("06/10/2026"); // 6 October
  expect(parseDate("6/10", today)).toBe("06/10/2026");
  expect(parseDate("31/02/2026", today)).toBeNull(); // impossible date
  expect(parseDate("30 Sep", today)).toBe("30/09/2026");
  expect(parseDate("Sept 30 2026", today)).toBe("30/09/2026");
});

test("relative dates and weekdays", () => {
  expect(parseDate("tomorrow", today)).toBe("04/10/2026");
  expect(parseDate("聽日", today)).toBe("04/10/2026");
  expect(parseDate("yesterday", today)).toBe("02/10/2026");
  expect(parseDate("Fri", today)).toBe("09/10/2026"); // next Friday
  expect(parseDate("星期五", today)).toBe("09/10/2026");
});

test("ambiguous dates are refused, not guessed", () => {
  expect(parseDate("last Fri", today)).toBeNull();
  expect(parseDate("上個禮拜五", today)).toBeNull();
  expect(parseDate("sometime", today)).toBeNull();
});

test("amounts", () => {
  expect(parseAmount("HK$128.5")).toBe("128.50");
  expect(parseAmount("$42")).toBe("42.00");
  expect(parseAmount("128 dollars")).toBe("128.00");
  expect(parseAmount("一百二十八蚊")).toBe("128.00");
  expect(parseAmount("三百蚊")).toBe("300.00");
  expect(parseAmount("Chan, food, 66.80, 30/09/2026")).toBe("66.80"); // date digits are ignored
});

test("categories", () => {
  expect(parseCategory("tea reception")).toBe("Food");
  expect(parseCategory("taxi home")).toBe("Transport");
  expect(parseCategory("Printing")).toBe("Printing");
  expect(parseCategory("nothing relevant")).toBeNull();
});

test("a full claim", () => {
  const r = parseClaim("Chan Tai Man, food, 128.50, 30/09/2026, FPS", today);
  expect(r.claim).toEqual({ payee: "Chan Tai Man", amount: "128.50", date: "30/09/2026", category: "Food", paidBy: "FPS" });
});

test("problems become exceptions with reasons", () => {
  expect(parseClaim("Ho Mei, printing, 85, last Fri", today).problem?.code).toBe("unparseable_date");
  expect(parseClaim("Ho Mei, 85, 30/09/2026", today).problem?.code).toBe("missing_field");
});

test("an amount with a decimal point is not read as a date", () => {
  expect(parseDate("Lee, transport, 6.50, 01/10/2026", today)).toBe("01/10/2026");
  expect(parseAmount("Lee, transport, 6.50, 01/10/2026")).toBe("6.50");
});
