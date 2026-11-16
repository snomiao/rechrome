import { expect, test } from "bun:test";
import { nextChromeProfileFolder, planNewChromeProfile } from "./rechrome.ts";

test("nextChromeProfileFolder takes the first free Profile N, ignoring case", () => {
  expect(nextChromeProfileFolder([])).toBe("Profile 1");
  expect(nextChromeProfileFolder(["Default", "Profile 1", "profile 2", "Profile 4"])).toBe("Profile 3");
});

test("planNewChromeProfile names the new profile after the selector, in the next free folder", () => {
  expect(planNewChromeProfile(["Default", "Profile 1"], "Work")).toEqual({ dir: "Profile 2", name: "Work" });
  expect(planNewChromeProfile(["Default"], "  Work  ")).toEqual({ dir: "Profile 1", name: "Work" });
  expect(planNewChromeProfile(["Default"])).toEqual({ dir: "Profile 1" });
});

test("planNewChromeProfile uses a free \"Profile N\" selector as the folder itself", () => {
  expect(planNewChromeProfile(["Default", "Profile 1"], "profile 7")).toEqual({ dir: "Profile 7" });
  // Taken: create the next free folder and keep the selector as the name.
  expect(planNewChromeProfile(["Default", "Profile 1"], "Profile 1")).toEqual({ dir: "Profile 2", name: "Profile 1" });
});
