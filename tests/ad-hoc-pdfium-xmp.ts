import { writeFileSync } from "node:fs";
import { assemblePdf, runStandalone, tmpPath } from "./util.ts";
import { propertiesOf } from "./xmp-properties.ts";

export async function testit(): Promise<void> {
  const xml = `<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"><rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>SoloXmpTitle</dc:title><dc:subject><rdf:Bag><rdf:li>solo</rdf:li><rdf:li>pdf</rdf:li></rdf:Bag></dc:subject></rdf:Description></rdf:RDF></x:xmpmeta>`;
  const pdf = tmpPath("pdfium-xmp.pdf");
  writeFileSync(
    pdf,
    assemblePdf([
      "<< /Type /Catalog /Pages 2 0 R /Metadata 4 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 72 72] >>",
      `<< /Type /Metadata /Subtype /XML /Length ${xml.length} >>\nstream\n${xml}\nendstream`,
    ]),
    "latin1",
  );
  const props = await propertiesOf(pdf);
  if (props.title !== "SoloXmpTitle" || props.keywords !== "solo, pdf") {
    throw new Error(`PDFium XMP properties: ${JSON.stringify(props)}`);
  }
}

if (import.meta.main) {
  await runStandalone(testit);
}
