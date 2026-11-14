import { runNamedTests, runStandalone, type NamedTest } from "./util.ts";
import { setTestWindowLayout } from "./winapi.ts";
import { testit as toc } from "./ad-hoc-virtual-toc.ts";
import { testit as favorites } from "./ad-hoc-virtual-favorites.ts";
import { testit as focus } from "./ad-hoc-virtual-tree-focus.ts";
import { testit as lifetime } from "./ad-hoc-tree-lifetime.ts";
import { testit as doubleClick } from "./ad-hoc-tree-double-click.ts";
import { testit as favoritesClick } from "./ad-hoc-favorites-click.ts";

export const treeTests: NamedTest[] = [
  ["ad-hoc-virtual-toc", toc],
  ["ad-hoc-virtual-favorites", favorites],
  ["ad-hoc-virtual-tree-focus", focus],
  ["ad-hoc-tree-lifetime", lifetime],
  ["ad-hoc-tree-double-click", doubleClick],
  ["ad-hoc-favorites-click", favoritesClick],
];

export async function testit(): Promise<void> {
  setTestWindowLayout("workArea");
  await runNamedTests(treeTests, { heading: "SolokPDF trees" });
}

if (import.meta.main) {
  await runStandalone(testit);
}
