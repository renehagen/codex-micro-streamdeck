import type { SessionStatus } from "./status.js";

export const STATUS_COLORS: Record<SessionStatus, string> = {
  idle: "#343434",
  unread: "#9BF396",
  thinking: "#9CD5FE",
  "needs-input": "#FFD0B8",
  error: "#FF7373"
};

const STATUS_MARKS: Record<SessionStatus, string> = {
  idle: `<circle cx="72" cy="93" r="5" fill="none" stroke="currentColor" stroke-width="3"/>`,
  unread: `<circle cx="72" cy="93" r="5" fill="currentColor"/>`,
  thinking: `<path d="M64 93a8 8 0 0 1 14-5M80 93a8 8 0 0 1-14 5" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round"/>`,
  "needs-input": `<path d="M72 86v9m0 5h.01" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>`,
  error: `<path d="m67 88 10 10m0-10L67 98" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round"/>`
};

export interface SessionKeyModel {
  slot: number;
  title: string;
  status: SessionStatus;
  selected: boolean;
}

export function renderSessionKey(model: SessionKeyModel): string {
  const color = STATUS_COLORS[model.status];
  const foreground = model.status === "idle" ? "#f7f7f4" : "#111111";
  const title = escapeXml(compactTitle(model.title));
  const selectedStroke = model.selected ? "#715CFF" : "rgba(0,0,0,.16)";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144">
    <defs>
      <linearGradient id="cap" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stop-color="#fafaf7"/><stop offset=".72" stop-color="#e7ebed"/><stop offset="1" stop-color="#cbd1d4"/>
      </linearGradient>
      <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
        <feDropShadow dx="0" dy="5" stdDeviation="4" flood-color="#000" flood-opacity=".35"/>
      </filter>
    </defs>
    <rect width="144" height="144" rx="18" fill="#080808"/>
    <g filter="url(#shadow)">
      <rect x="7" y="6" width="130" height="126" rx="23" fill="url(#cap)" stroke="${selectedStroke}" stroke-width="${model.selected ? 5 : 2}"/>
      <circle cx="72" cy="58" r="38" fill="${color}"/>
      <g color="${foreground}">
        <text x="72" y="69" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Inter,Arial,sans-serif" font-size="34" font-weight="700" fill="currentColor">${model.slot + 1}</text>
        ${STATUS_MARKS[model.status]}
      </g>
      <text x="72" y="119" text-anchor="middle" font-family="-apple-system,BlinkMacSystemFont,Inter,Arial,sans-serif" font-size="12" font-weight="650" fill="#181818">${title}</text>
    </g>
  </svg>`;
}

export function svgDataUri(svg: string): string {
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function compactTitle(value: string): string {
  const cleaned = value.replace(/\s+/gu, " ").trim();
  if (cleaned.length === 0) return "CODEX";
  return cleaned.length > 15 ? `${cleaned.slice(0, 14)}…` : cleaned;
}

function escapeXml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
