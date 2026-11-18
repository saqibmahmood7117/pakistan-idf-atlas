"use client";

import { useState } from "react";

type ChartFormat = "png" | "svg";
const SVG_NAMESPACE = "http://www.w3.org/2000/svg";
const PNG_WIDTH = 2400;

async function exportChart(svg: SVGSVGElement, title: string, format: ChartFormat) {
  const { width, height } = svg.viewBox.baseVal;
  if (width <= 0 || height <= 0) throw new Error("The chart has no exportable dimensions.");

  const copy = svg.cloneNode(true) as SVGSVGElement;
  copy.setAttribute("width", String(width));
  copy.setAttribute("height", String(height));
  copy.setAttribute("role", "img");
  copy.setAttribute("aria-label", title);
  copy.querySelectorAll("[data-chart-transient]").forEach(element => element.remove());
  copy.querySelectorAll("[data-export-radius]").forEach(element => {
    element.setAttribute("r", element.getAttribute("data-export-radius")!);
    element.removeAttribute("data-export-radius");
  });
  copy.querySelectorAll("[tabindex]").forEach(element => element.removeAttribute("tabindex"));
  const heading = document.createElementNS(SVG_NAMESPACE, "title");
  heading.textContent = title;
  copy.prepend(heading);

  const vector = new Blob([new XMLSerializer().serializeToString(copy)], { type: "image/svg+xml;charset=utf-8" });
  if (format === "svg") return vector;

  const url = URL.createObjectURL(vector);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();

    const canvas = document.createElement("canvas");
    canvas.width = PNG_WIDTH;
    canvas.height = Math.round(PNG_WIDTH * height / width);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("The browser could not prepare the image.");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);

    return await new Promise<Blob>((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error("The browser could not save the PNG."));
      }, "image/png");
    });
  } finally {
    URL.revokeObjectURL(url);
  }
}

export default function IdfChartDownload({ svgId, fileStem, title, unit, onSave }: {
  svgId: string;
  fileStem: string;
  title: string;
  unit: "mm/hr" | "inch/hr";
  onSave: (blob: Blob, name: string) => void;
}) {
  const [pending, setPending] = useState<ChartFormat | null>(null);
  const [error, setError] = useState("");

  async function download(format: ChartFormat) {
    setError("");
    setPending(format);
    try {
      const svg = document.getElementById(svgId);
      if (!(svg instanceof SVGSVGElement)) {
        setError("The chart is unavailable.");
        return;
      }
      const blob = await exportChart(svg, title, format);
      onSave(blob, `${fileStem}.${format}`);
    } catch {
      setError(`Could not prepare the ${format.toUpperCase()} download. Try again or choose the other format.`);
    } finally {
      setPending(null);
    }
  }

  return <div className="idf-chart-download">
    <div role="group" aria-label={`Download rainfall chart in ${unit}`} className="idf-chart-download-options">
      <span>Download chart</span>
      <button type="button" disabled={pending !== null} onClick={() => void download("png")}
        aria-label={`Download ${unit} chart as PNG`} title="High-resolution PNG image">
        {pending === "png" ? "Preparing…" : "PNG"}
      </button>
      <button type="button" disabled={pending !== null} onClick={() => void download("svg")}
        aria-label={`Download ${unit} chart as SVG`} title="Scalable SVG vector">
        {pending === "svg" ? "Preparing…" : "SVG"}
      </button>
    </div>
    {error && <p role="alert">{error}</p>}
  </div>;
}
