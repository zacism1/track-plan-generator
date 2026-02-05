const el = (id) => document.getElementById(id);

const inputs = {
  title: el("titleInput"),
  items: el("itemsInput"),
  from: el("fromInput"),
  to: el("toInput"),
  segment: el("segmentInput"),
  topTrack: el("topTrackInput"),
  bottomTrack: el("bottomTrackInput"),
  markers: el("markersInput"),
  parser: el("parserInput"),
  pdf: el("pdfInput"),
};

const svgHost = el("svgHost");
const status = el("status");
const pageSelect = el("pageSelect");
const textDump = el("textDump");
const pdfStats = el("pdfStats");

let pdfExtract = null;

const example = {
  title: "47km Supersite Summary",
  items: [
    "Rerail 1000m through 47km supersite including new .",
    "Maintenance tamp through supersite extents.",
    "Remove and replace weigh bridge and WILD",
    "Video Imaging/Rail BAM/WCM disconnection and reconnection",
    "Test and commissioning for all asset protection & monitoring equipment",
  ].join("\n"),
  from: "WAN:P11A",
  to: "WAS:P11B",
  segment: "47.00km Supersite",
  topTrack: "Up Main",
  bottomTrack: "Down Main",
  markers: inputs.markers.value,
};

function parseMarkers(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [kmRaw, label = "", side = "top", icon = "signal"] = line.split(",");
      const km = Number.parseFloat(kmRaw);
      return {
        km: Number.isFinite(km) ? km : null,
        label: label.trim(),
        side: side.trim(),
        icon: icon.trim(),
      };
    })
    .filter((m) => m.km !== null);
}

function inferIcon(label) {
  const low = label.toLowerCase();
  if (low.includes("bridge") || low.includes("creek")) return "bridge";
  if (low.includes("detector") || low.includes("wild")) return "detector";
  if (low.includes("imaging") || low.includes("monitor") || low.includes("weigh")) return "note";
  return "signal";
}

function parsePdfTextLines(items) {
  const lines = new Map();
  items.forEach((item) => {
    const y = Math.round(item.transform[5] / 2) * 2;
    const x = item.transform[4];
    const str = item.str.trim();
    if (!str) return;
    if (!lines.has(y)) lines.set(y, []);
    lines.get(y).push({ str, x });
  });
  return Array.from(lines.entries())
    .sort((a, b) => b[0] - a[0])
    .map(([y, parts]) => ({
      y,
      parts: parts.sort((a, b) => a.x - b.x).map((p) => p.str),
    }));
}

function parseMarkersFromLines(lines) {
  const markers = [];
  const kmRegex = /(\d{1,3}\.\d{1,3})\\s*km/i;
  lines.forEach((line) => {
    const joined = line.parts.join(" ");
    const match = joined.match(kmRegex);
    if (!match) return;
    const km = Number.parseFloat(match[1]);
    if (!Number.isFinite(km)) return;

    let label = "";
    const kmIndex = line.parts.findIndex((p) => kmRegex.test(p));
    if (kmIndex !== -1) {
      label = line.parts[kmIndex + 1] || line.parts[kmIndex - 1] || "";
      if (label && label.match(kmRegex)) label = "";
    }
    if (!label) {
      const filtered = line.parts.filter((p) => !kmRegex.test(p));
      label = filtered.join(" ").trim();
    }

    markers.push({
      km,
      label,
      y: line.y,
    });
  });

  if (!markers.length) return [];
  const ys = markers.map((m) => m.y).sort((a, b) => a - b);
  const median = ys[Math.floor(ys.length / 2)];
  return markers.map((m) => ({
    km: m.km,
    label: m.label,
    side: m.y >= median ? "top" : "bottom",
    icon: inferIcon(m.label),
  }));
}

function extractTitleAndItems(lines) {
  let title = "";
  const items = [];
  lines.forEach((line) => {
    const text = line.parts.join(" ").trim();
    if (!title && /summary/i.test(text)) title = text;
    if (/^[\\u25A1\\u25A0\\u2610\\-\\u2022]/.test(text)) {
      items.push(text.replace(/^[\\u25A1\\u25A0\\u2610\\-\\u2022]\\s*/, ""));
    }
  });
  return { title, items };
}

async function importPdf() {
  const file = inputs.pdf.files[0];
  if (!file) {
    status.textContent = "Select a PDF to import.";
    return;
  }
  if (!window.pdfjsLib) {
    status.textContent = "PDF parser not loaded.";
    return;
  }

  status.textContent = "Reading PDF…";
  const buffer = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buffer }).promise;

  const allLines = [];
  const linesByPage = [];
  let totalItems = 0;
  for (let i = 1; i <= pdf.numPages; i += 1) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    totalItems += content.items.length;
    const lines = parsePdfTextLines(content.items);
    allLines.push(...lines);
    linesByPage.push(lines);
  }

  const { title, items } = extractTitleAndItems(allLines);
  if (title) inputs.title.value = title;
  if (items.length) inputs.items.value = items.join("\\n");

  const markers = parseMarkersFromLines(allLines);
  if (markers.length) {
    inputs.markers.value = markers
      .map((m) => `${m.km.toFixed(3)},${m.label || ""},${m.side},${m.icon}`)
      .join("\\n");
  }

  pdfExtract = {
    pageCount: pdf.numPages,
    totalItems,
    linesByPage,
  };
  updateDiagnostics();

  status.textContent = markers.length
    ? `Imported ${markers.length} markers from PDF.`
    : "PDF imported, but no km markers detected.";
  render();
}

function updateDiagnostics() {
  if (!pdfExtract) return;
  pageSelect.innerHTML = "";
  for (let i = 0; i < pdfExtract.pageCount; i += 1) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Page ${i + 1}`;
    pageSelect.append(opt);
  }
  const avgItems = Math.round(pdfExtract.totalItems / pdfExtract.pageCount);
  pdfStats.textContent = `Extracted ${pdfExtract.totalItems} text items across ${pdfExtract.pageCount} pages (avg ${avgItems} per page).`;
  updateTextDump();
}

function updateTextDump() {
  if (!pdfExtract) return;
  const index = Number.parseInt(pageSelect.value, 10) || 0;
  const lines = pdfExtract.linesByPage[index] || [];
  textDump.value = lines
    .map((line) => line.parts.join(" ").trim())
    .filter(Boolean)
    .slice(0, 80)
    .join("\\n");
}

function parseInputSentence(sentence) {
  const match = sentence.match(/between\s+([^\s]+)\s+and\s+([^\s]+)/i);
  if (match) {
    inputs.from.value = match[1];
    inputs.to.value = match[2];
  }
}

function markerX(km, minKm, maxKm, left, right) {
  const span = maxKm - minKm || 1;
  return left + ((km - minKm) / span) * (right - left);
}

function svgElement(tag, attrs = {}, content = "") {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attrs).forEach(([key, value]) => el.setAttribute(key, value));
  if (content) el.textContent = content;
  return el;
}

function render() {
  const title = inputs.title.value.trim() || "Track Summary";
  const items = inputs.items.value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  const markers = parseMarkers(inputs.markers.value);
  if (!markers.length) {
    status.textContent = "Add at least one marker to render.";
    return;
  }

  const kms = markers.map((m) => m.km);
  const minKm = Math.min(...kms);
  const maxKm = Math.max(...kms);

  const width = 980;
  const height = 540;
  const topY = 280;
  const bottomY = 360;
  const leftMargin = 80;
  const rightMargin = width - 80;

  svgHost.innerHTML = "";
  const svg = svgElement("svg", {
    viewBox: `0 0 ${width} ${height}`,
    width: width,
    height: height,
  });

  const defs = svgElement("defs");
  const gradient = svgElement("linearGradient", {
    id: "summaryGrad",
    x1: "0",
    x2: "0",
    y1: "0",
    y2: "1",
  });
  gradient.append(
    svgElement("stop", { offset: "0%", "stop-color": "#fde8df" }),
    svgElement("stop", { offset: "100%", "stop-color": "#f7b69b" })
  );
  defs.append(gradient);
  svg.append(defs);

  svg.append(
    svgElement("rect", {
      x: 120,
      y: 24,
      width: width - 240,
      height: 140,
      rx: 6,
      fill: "url(#summaryGrad)",
      stroke: "#b56a52",
      "stroke-width": 2,
    })
  );

  svg.append(
    svgElement(
      "text",
      {
        x: width / 2,
        y: 54,
        "text-anchor": "middle",
        "font-size": "20",
        "font-family": "Avenir Next, Futura, Gill Sans, sans-serif",
      },
      title
    )
  );

  items.slice(0, 6).forEach((item, i) => {
    const y = 80 + i * 18;
    svg.append(
      svgElement(
        "text",
        {
          x: 150,
          y,
          "font-size": "13",
          "font-family": "Iowan Old Style, Palatino, serif",
        },
        `\u25A1 ${item}`
      )
    );
  });

  svg.append(
    svgElement("rect", {
      x: 40,
      y: 210,
      width: width - 80,
      height: 260,
      fill: "#fff",
      stroke: "#3f3a35",
      "stroke-width": 2,
    })
  );

  svg.append(
    svgElement("line", {
      x1: leftMargin,
      y1: topY,
      x2: rightMargin,
      y2: topY,
      stroke: "#3f3a35",
      "stroke-width": 2,
    })
  );

  svg.append(
    svgElement("line", {
      x1: leftMargin,
      y1: bottomY,
      x2: rightMargin,
      y2: bottomY,
      stroke: "#3f3a35",
      "stroke-width": 2,
    })
  );

  svg.append(
    svgElement(
      "text",
      {
        x: leftMargin,
        y: topY - 14,
        "font-size": "12",
        "font-family": "Avenir Next, Futura, Gill Sans, sans-serif",
      },
      inputs.topTrack.value || "Top Track"
    )
  );

  svg.append(
    svgElement(
      "text",
      {
        x: leftMargin,
        y: bottomY + 24,
        "font-size": "12",
        "font-family": "Avenir Next, Futura, Gill Sans, sans-serif",
      },
      inputs.bottomTrack.value || "Bottom Track"
    )
  );

  const segmentX = (leftMargin + rightMargin) / 2;
  svg.append(
    svgElement("rect", {
      x: segmentX - 26,
      y: topY - 50,
      width: 52,
      height: 160,
      fill: "#f3c09e",
      stroke: "#c47a58",
      "stroke-width": 1.5,
    })
  );
  svg.append(
    svgElement(
      "text",
      {
        x: segmentX,
        y: topY + 40,
        "text-anchor": "middle",
        "font-size": "11",
        "font-family": "Avenir Next, Futura, Gill Sans, sans-serif",
        transform: `rotate(90 ${segmentX} ${topY + 40})`,
      },
      inputs.segment.value || "Segment"
    )
  );

  markers.forEach((marker) => {
    const x = markerX(marker.km, minKm, maxKm, leftMargin, rightMargin);
    let y = topY;
    if (marker.side === "bottom") y = bottomY;
    if (marker.side === "mid") y = (topY + bottomY) / 2;

    if (marker.icon === "signal") {
      svg.append(svgElement("circle", { cx: x, cy: y, r: 6, fill: "#6d655c" }));
      svg.append(svgElement("line", { x1: x + 8, y1: y, x2: x + 22, y2: y, stroke: "#6d655c", "stroke-width": 2 }));
    } else if (marker.icon === "detector") {
      svg.append(svgElement("rect", { x: x - 8, y: y - 8, width: 16, height: 16, fill: "#f7b69b", stroke: "#b56a52", "stroke-width": 1.5 }));
    } else if (marker.icon === "bridge") {
      svg.append(svgElement("rect", { x: x - 10, y: topY - 60, width: 20, height: 120, fill: "#f3c09e", stroke: "#c47a58", "stroke-width": 1.5 }));
    } else {
      svg.append(svgElement("circle", { cx: x, cy: y, r: 4, fill: "#d96b46" }));
    }

    const labelY = marker.side === "bottom" ? y + 22 : y - 14;
    svg.append(
      svgElement(
        "text",
        {
          x,
          y: labelY,
          "text-anchor": "middle",
          "font-size": "10",
          "font-family": "Iowan Old Style, Palatino, serif",
          fill: "#3f3a35",
        },
        `${marker.km.toFixed(2)} ${marker.label}`.trim()
      )
    );
  });

  const fromText = inputs.from.value.trim();
  const toText = inputs.to.value.trim();
  if (fromText || toText) {
    svg.append(
      svgElement(
        "text",
        {
          x: width - 110,
          y: 230,
          "text-anchor": "end",
          "font-size": "11",
          "font-family": "Avenir Next, Futura, Gill Sans, sans-serif",
          fill: "#6d655c",
        },
        `Between ${fromText || "?"} and ${toText || "?"}`
      )
    );
  }

  svgHost.append(svg);
  status.textContent = `Rendered ${markers.length} markers from ${minKm.toFixed(2)} to ${maxKm.toFixed(2)} km.`;
}

function downloadSVG() {
  const svg = svgHost.querySelector("svg");
  if (!svg) return;
  const serializer = new XMLSerializer();
  const blob = new Blob([serializer.serializeToString(svg)], { type: "image/svg+xml" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "track-diagram.svg";
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function downloadPNG() {
  const svg = svgHost.querySelector("svg");
  if (!svg) return;
  const svgData = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(svgBlob);
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement("canvas");
    canvas.width = svg.viewBox.baseVal.width;
    canvas.height = svg.viewBox.baseVal.height;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, 0, 0);
    URL.revokeObjectURL(url);
    canvas.toBlob((blob) => {
      const link = document.createElement("a");
      link.href = URL.createObjectURL(blob);
      link.download = "track-diagram.png";
      document.body.append(link);
      link.click();
      link.remove();
    });
  };
  img.src = url;
}

el("renderBtn").addEventListener("click", render);
el("downloadSvg").addEventListener("click", downloadSVG);
el("downloadPng").addEventListener("click", downloadPNG);
el("loadExample").addEventListener("click", () => {
  inputs.title.value = example.title;
  inputs.items.value = example.items;
  inputs.from.value = example.from;
  inputs.to.value = example.to;
  inputs.segment.value = example.segment;
  inputs.topTrack.value = example.topTrack;
  inputs.bottomTrack.value = example.bottomTrack;
  inputs.markers.value = example.markers;
  render();
});

el("importPdf").addEventListener("click", () => {
  importPdf().catch((err) => {
    console.error(err);
    status.textContent = "PDF import failed. Check console.";
  });
});

el("exportJson").addEventListener("click", () => {
  const payload = {
    title: inputs.title.value.trim(),
    items: inputs.items.value.split("\n").map((l) => l.trim()).filter(Boolean),
    from: inputs.from.value.trim(),
    to: inputs.to.value.trim(),
    segment: inputs.segment.value.trim(),
    topTrack: inputs.topTrack.value.trim(),
    bottomTrack: inputs.bottomTrack.value.trim(),
    markers: parseMarkers(inputs.markers.value),
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = "track-data.json";
  document.body.append(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

pageSelect.addEventListener("change", updateTextDump);

inputs.parser.addEventListener("change", () => {
  if (inputs.parser.value.trim()) {
    parseInputSentence(inputs.parser.value.trim());
  }
});

render();
