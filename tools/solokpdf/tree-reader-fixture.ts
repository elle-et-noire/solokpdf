import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, join } from "node:path";
import { assemblePdf } from "../../tests/util";

const dir = resolve(".work/tree-reader-check");
const pdf = join(dir, "tree-reader-check.pdf");
const appdata = join(dir, "appdata");
mkdirSync(appdata, { recursive: true });
writeFileSync(
  pdf,
  assemblePdf([
    "<< /Type /Catalog /Pages 2 0 R /Outlines 6 0 R /PageMode /UseOutlines >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>",
    "<< /Type /Outlines /First 7 0 R /Last 9 0 R /Count 3 >>",
    "<< /Title (First) /Parent 6 0 R /Next 8 0 R /Dest [3 0 R /Fit] >>",
    "<< /Title (Second) /Parent 6 0 R /Prev 7 0 R /Next 9 0 R /First 10 0 R /Last 10 0 R /Count -1 /Dest [4 0 R /Fit] >>",
    "<< /Title (Third) /Parent 6 0 R /Prev 8 0 R /Dest [5 0 R /Fit] >>",
    "<< /Title (Nested) /Parent 8 0 R /Dest [5 0 R /Fit] >>",
  ]),
);
writeFileSync(
  join(appdata, "SolokPDF-settings.txt"),
  `ShowToc = true\nShowFavorites = true\nUiLanguage = en\nFileStates [\n  [\n    FilePath = ${pdf}\n    Favorites [\n      [\n        Name = First favorite\n        PageNo = 1\n      ]\n      [\n        Name = Third favorite\n        PageNo = 3\n      ]\n    ]\n  ]\n]\n`,
);
console.log(`PDF: ${pdf}\nApp data: ${appdata}`);
