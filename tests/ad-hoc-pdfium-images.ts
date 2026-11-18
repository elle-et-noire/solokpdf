import { readFileSync, writeFileSync } from "node:fs";
import { testit as cmykSave } from "./cmyk-image-save.ts";
import { ControlCommand, withControlledSumatra } from "./control.ts";
import { testit as orientation } from "./issue-6214.ts";
import { assemblePdf, EXE, runStandalone, tmpPath } from "./util.ts";

// Solid red (8×8) and blue (9×7) JPEGs, with different original bytes.
const red = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAIAAgDAREAAhEBAxEB/8QAFAABAAAAAAAAAAAAAAAAAAAAB//EABQQAQAAAAAAAAAAAAAAAAAAAAD/xAAVAQEBAAAAAAAAAAAAAAAAAAAHCf/EABQRAQAAAAAAAAAAAAAAAAAAAAD/2gAMAwEAAhEDEQA/ABcLqZv/2Q==",
  "base64",
);
const blue = Buffer.from(
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/2wBDAQMDAwQDBAgEBAgQCwkLEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBD/wAARCAAHAAkDAREAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAj/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/8QAFgEBAQEAAAAAAAAAAAAAAAAAAAYJ/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAwDAQACEQMRAD8AiRpmjAH/2Q==",
  "base64",
);

function imageStream(jpeg: Buffer, width: number, height: number): string {
  return (
    `<< /Subtype /Image /Width ${width} /Height ${height} /ColorSpace /DeviceRGB ` +
    `/BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n${jpeg.toString("latin1")}\nendstream`
  );
}

async function overlappingImages(): Promise<void> {
  const pdfPath = tmpPath("pdfium-overlapping-images.pdf");
  const dataPath = tmpPath("pdfium-overlapping-image.jpg");
  const page = (contents: number) =>
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents ${contents} 0 R ` +
    "/Resources << /XObject << /Blue 7 0 R /Red 8 0 R /Clipped 11 0 R >> >> >>";
  const stream = (content: string, attributes = "") =>
    `<< ${attributes} /Length ${content.length} >>\nstream\n${content}\nendstream`;
  const redDraw = "q 120 0 0 120 40 40 cm /Red Do Q";
  writeFileSync(
    pdfPath,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R 4 0 R 9 0 R] /Count 3 >>",
      page(5),
      page(6),
      stream(`q 60 0 0 60 70 70 cm /Blue Do Q ${redDraw}`),
      stream(`q 120 0 0 120 40 40 cm /Blue Do Q ${redDraw}`),
      imageStream(blue, 9, 7),
      imageStream(red, 8, 8),
      page(10),
      stream(`q 1 0 0 1 70 70 cm /Clipped Do Q ${redDraw}`),
      stream(
        "q 60 0 0 60 0 0 cm /Blue Do Q",
        "/Subtype /Form /BBox [0 0 30 30] /Resources << /XObject << /Blue 7 0 R >> >>",
      ),
    ]),
    "latin1",
  );

  await withControlledSumatra(
    EXE,
    async (client) => {
      const failures: string[] = [];
      for (const [pageNo, name] of [
        [1, "contained"],
        [2, "coincident"],
        [3, "clipped form"],
      ] as const) {
        for (const [index, jpeg, w, h, bluePixel] of [
          [0, blue, 9, 7, true],
          [1, red, 8, 8, false],
        ] as const) {
          const [status, result] = await client.request(ControlCommand.TestImageOrientation, [
            pdfPath,
            pageNo,
            "",
            index,
            dataPath,
          ]);
          const raw = String(result).trim();
          const label = `${name} image ${index}`;
          if (status !== 0) {
            failures.push(`${label}: ${raw}`);
            continue;
          }
          const fields = Object.fromEntries(raw.split(/\s+/).map((field) => field.split("=")));
          const pixel = Number.parseInt(fields.tl ?? "", 16);
          const redChannel = pixel >> 16;
          const blueChannel = pixel & 255;
          const matchesColor = bluePixel ? blueChannel > 230 && redChannel < 40 : redChannel > 230 && blueChannel < 40;
          const matchesBitmap = Number(fields.w) === w && Number(fields.h) === h && matchesColor;
          const matchesData = readFileSync(dataPath).equals(jpeg);
          if (!matchesBitmap || !matchesData) {
            failures.push(`${label}: wrong image (expected ${w}×${h}, original bytes match=${matchesData}): ${raw}`);
            continue;
          }
          console.log(`  ${label}: pixels and original bytes match`);
        }
      }
      if (failures.length) throw new Error(failures.join("\n"));
    },
    [],
    { env: { ...process.env, SOLOKPDF_ENGINE: "pdfium" } },
  );
}

export async function testit(): Promise<void> {
  await cmykSave();
  await orientation();
  await overlappingImages();
}

if (import.meta.main) {
  await runStandalone(testit);
}
