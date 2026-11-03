import { readFileSync } from "node:fs";
import { runStandalone } from "./util.ts";

export async function testit(): Promise<void> {
  for (const [path, needle] of [
    ["src/base/Win.cpp", "SetWindowPos(hDlg, nullptr, rcDialog.x"],
    ["src/base/Win.cpp", "SetWindowPos(hwnd, nullptr, r.x, r.y, 0, 0"],
    ["src/AdvancedSettingsDialog.cpp", "SetWindowPos(hwnd, nullptr, r2.x"],
    ["src/ChangeThemeDialog.cpp", "SetWindowPos(hwnd, nullptr, r2.x"],
    ["src/DocumentProperties.cpp", "SetWindowPos(wnd->hwnd, nullptr, savedPos.x"],
    ["src/MergePdf.cpp", "SetWindowPos(hwnd, nullptr, 0, 0, dx, dy"],
    ["src/TabGroupsManage.cpp", "SetWindowPos(hwnd, nullptr, 0, 0, DpiScale"],
  ]) {
    const source = readFileSync(path!, "utf8");
    const start = source.indexOf(needle!);
    const end = source.indexOf(";", start);
    if (start < 0 || end < 0 || !source.slice(start, end).includes("SWP_NOACTIVATE")) {
      throw new Error(`${path}: positioning can activate a window`);
    }
  }
}

if (import.meta.main) await runStandalone(testit);
