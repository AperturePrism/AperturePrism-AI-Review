import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTheme } from "../hooks/useTheme";

let media: EventTarget & { matches: boolean };
function changeSystemTheme(light: boolean): void {
  media.matches = light;
  const event = new Event("change");
  Object.defineProperty(event, "matches", { value: light });
  act(() => media.dispatchEvent(event));
}

beforeEach(() => {
  localStorage.clear();
  media = Object.assign(new EventTarget(), { matches: true });
  vi.stubGlobal("matchMedia", vi.fn(() => media));
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("system theme preference", () => {
  it("follows OS changes without recording an explicit user preference", () => {
    const { result } = renderHook(() => useTheme());
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("ap.theme")).toBeNull();
    changeSystemTheme(false);
    expect(result.current.theme).toBe("dark");
    expect(document.documentElement.dataset.theme).toBe("dark");
    expect(localStorage.getItem("ap.theme")).toBeNull();
  });

  it("persists explicit choices and stops following OS changes", () => {
    const { result } = renderHook(() => useTheme());
    act(() => result.current.setTheme("dark"));
    expect(localStorage.getItem("ap.theme")).toBe("dark");
    changeSystemTheme(true);
    expect(result.current.theme).toBe("dark");
    act(() => result.current.toggle());
    expect(localStorage.getItem("ap.theme")).toBe("light");
    changeSystemTheme(false);
    expect(result.current.theme).toBe("light");
  });

  it("preserves functional double-toggle semantics within one React batch", () => {
    const { result } = renderHook(() => useTheme());
    act(() => {
      result.current.toggle();
      result.current.toggle();
    });
    expect(result.current.theme).toBe("light");
    expect(localStorage.getItem("ap.theme")).toBe("light");
    changeSystemTheme(false);
    expect(result.current.theme).toBe("light");
  });

  it("honors an existing valid stored choice", () => {
    localStorage.setItem("ap.theme", "dark");
    const { result } = renderHook(() => useTheme());
    changeSystemTheme(true);
    expect(result.current.theme).toBe("dark");
  });

  it("follows OS with blocked storage until explicitly changed in this session", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const { result } = renderHook(() => useTheme());
    changeSystemTheme(false);
    expect(result.current.theme).toBe("dark");
    act(() => result.current.setTheme("light"));
    changeSystemTheme(false);
    expect(result.current.theme).toBe("light");
  });
});
