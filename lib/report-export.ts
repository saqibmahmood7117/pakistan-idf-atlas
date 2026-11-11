/** Browser-only report export. Loaded on demand so Word code stays out of initial rendering. */
export function escapeReportText(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

export function reportFileStem(value: string): string {
  return value.normalize("NFKC").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "precipitation";
}

export const REPORT_LAYOUT_CSS = `
@page{size:A4;margin:18mm 15mm;@top-left{content:"PAKISTAN IDF ATLAS / TECHNICAL ASSESSMENT";font:7pt Arial,sans-serif;color:#607681}@bottom-left{content:"Source, method and limitations form part of this assessment";font:7pt Arial,sans-serif;color:#607681}}
.report{font-family:Arial,Helvetica,sans-serif}.report p,.report li{font-size:10.5pt;line-height:1.6}
.report h1{letter-spacing:-.025em}.report h2{font-size:19pt}.report h3{font-size:13pt}
.report td{text-align:left;overflow-wrap:anywhere}.report-idf-table td{text-align:right;font-variant-numeric:tabular-nums}
.report tbody tr:nth-child(even){background:#f4f8fa}.report thead{background:#e8f2f3}
.report thead th{color:#173b5c}.report-decision{padding:18px 22px;border:1px solid #b9d2d6;background:#f3f8fa;border-radius:8px;margin:20px 0}
.report-decision h3{margin-top:0}.report-decision dl{display:grid;grid-template-columns:1fr 1fr;gap:12px;margin:0}
.report-decision dt{font-size:9pt;font-weight:bold;color:#0f766e}.report-decision dd{margin:4px 0;font-size:10pt;line-height:1.5}
.report-download-panel{max-width:1000px;margin:32px auto -30px;padding:20px 24px;border:1px solid #cbdadd;border-radius:12px;background:#fff}
.report-download-panel h2{margin:0 0 8px}.report-download-panel p{color:#405966;line-height:1.5}.report-actions a{background:#0f766e;color:#fff;padding:9px 13px;border-radius:8px;font-size:13px;font-weight:700;text-decoration:none}
@media(max-width:700px){.report-decision dl{grid-template-columns:1fr}.report-cover h1{font-size:25pt}}
@media print{
  .print-header,.print-footer{display:none!important}
  .report-cover{box-sizing:border-box;height:245mm;min-height:0!important;padding:12mm!important;overflow:visible}
  .report-cover h1{font-size:24pt}.report-cover-subtitle{font-size:11pt!important}.document-control{margin-top:5mm}
  .document-control div{padding:2mm 0}.document-control dd{font-size:9pt;overflow-wrap:anywhere}
  .report p,.report li{font-size:9.5pt;line-height:1.5}.report h2{font-size:17pt}.report h3{font-size:12pt}
  .report thead{display:table-header-group}.report table{table-layout:fixed;width:100%;min-width:0!important}
  .report th,.report td{overflow-wrap:anywhere;font-size:7.5pt}.report-source-table th{white-space:normal!important}
  .report-download-panel{display:none!important}.report-decision{break-inside:avoid;padding:4mm}
  .report-chart svg{display:block;width:100%;height:auto}.report-chart{break-inside:avoid}
  .report-contents{break-after:page}.report-actions{display:none!important}
}`;

export async function buildWordReport(root: HTMLElement, title: string): Promise<Blob> {
  const { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, HeadingLevel,
    WidthType, Header, Footer, PageNumber, ImageRun, AlignmentType } = await import("docx");
  type Block = InstanceType<typeof Paragraph> | InstanceType<typeof Table>;
  const text = (node: Element) => (node.textContent ?? "").replace(/\s+/g, " ").trim();
  const paragraph = (value: string, options = {}) => new Paragraph({
    children: [new TextRun(value)], spacing: { after: 120 }, ...options,
  });
  async function walk(element: Element): Promise<Block[]> {
    if (element.matches(".report-actions,.print-header,.print-footer,.report-brand-mark")) return [];
    if (element.tagName === "svg") {
      const svg = element as SVGSVGElement;
      const viewBox = svg.viewBox.baseVal;
      const width = viewBox.width || 900, height = viewBox.height || 500;
      const url = URL.createObjectURL(new Blob([new XMLSerializer().serializeToString(svg)], { type: "image/svg+xml" }));
      try {
        const image = new Image(); image.src = url; await image.decode();
        const canvas = document.createElement("canvas"); canvas.width = width * 2; canvas.height = height * 2;
        const context = canvas.getContext("2d");
        if (!context) throw new Error("Chart rendering is unavailable in this browser.");
        context.fillStyle = "white"; context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        const png = await new Promise<Blob>((resolve, reject) => canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error("Chart conversion failed.")), "image/png"));
        return [new Paragraph({ children: [new ImageRun({ type: "png", data: new Uint8Array(await png.arrayBuffer()), transformation: { width: 600, height: Math.round(600 * height / width) } })] })];
      } finally { URL.revokeObjectURL(url); }
    }
    if (element.tagName === "TABLE") {
      const table = element as HTMLTableElement;
      return [ ...(table.caption ? [paragraph(text(table.caption), { keepNext: true })] : []),
        new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: Array.from(table.rows, (row) => new TableRow({
          tableHeader: row.parentElement?.tagName === "THEAD", cantSplit: true,
          children: Array.from(row.cells, (cell) => new TableCell({
            columnSpan: cell.colSpan, rowSpan: cell.rowSpan,
            shading: cell.tagName === "TH" ? { fill: "E8F2F3" } : undefined,
            children: [paragraph(text(cell), { children: [new TextRun({ text: text(cell), bold: cell.tagName === "TH", size: 17 })] })],
          })),
        })) }),
      ];
    }
    if (/^H[1-3]$/.test(element.tagName)) {
      const heading = { H1: HeadingLevel.HEADING_1, H2: HeadingLevel.HEADING_2, H3: HeadingLevel.HEADING_3 }[element.tagName];
      return [paragraph(text(element), { heading, keepNext: true })];
    }
    if (element.tagName === "LI" && !element.querySelector("table")) return [paragraph(text(element), { bullet: { level: 0 } })];
    if (["P", "FIGCAPTION", "DT", "DD"].includes(element.tagName)) return [paragraph(text(element), element.tagName === "DT" ? { keepNext: true } : {})];
    if (!element.children.length) return text(element) ? [paragraph(text(element))] : [];
    const blocks: Block[] = [];
    if (element.matches(".report-contents,.section-break")) blocks.push(new Paragraph({ pageBreakBefore: true }));
    for (const child of Array.from(element.children)) blocks.push(...await walk(child));
    return blocks;
  }
  const children = await walk(root);
  return Packer.toBlob(new Document({
    title, creator: "Pakistan IDF Atlas", description: "Technical analysis record generated from the active Atlas selection",
    styles: { default: { document: { run: { font: "Calibri", size: 21, color: "263E4A" }, paragraph: { spacing: { line: 280 } } } } },
    sections: [{ properties: { page: { size: { width: 11906, height: 16838 }, margin: { top: 1020, bottom: 1020, left: 850, right: 850 } } },
      headers: { default: new Header({ children: [paragraph("PAKISTAN IDF ATLAS  /  TECHNICAL REPORT")] }) },
      footers: { default: new Footer({ children: [new Paragraph({ alignment: AlignmentType.RIGHT, children: [new TextRun("Page "), new TextRun({ children: [PageNumber.CURRENT] })] })] }) }, children,
    }],
  }));
}
