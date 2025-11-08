import "/@prismjs";

const overlayId = "__rc_error_overlay__";

const style = document.createElement("style");
style.textContent = `
  #${overlayId} {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.9);
    color: #fff;
    font-family: Menlo, Consolas, monospace;
    font-size: 14px;
    z-index: 999999;
    overflow: auto;
    padding: 24px;
    animation: fadeIn 0.2s ease-out;
  }
  @keyframes fadeIn { from {opacity: 0;} to {opacity: 1;} }
  #${overlayId} h2 { color: #ff6b6b; margin-bottom: 16px; }
  #${overlayId} pre { background: rgba(255,255,255,0.1); padding: 12px; border-radius: 6px; }
  #${overlayId} a { color: #9cf; text-decoration: underline; }
  #${overlayId} .frame { margin: 12px 0; }
  #${overlayId} .frame-file { color: #ffa500; cursor: pointer; font-weight: bold; margin-bottom: 4px; }
  .line-number { opacity: 0.5; margin-right: 10px; }
`;
document.head.appendChild(style);

async function mapStackFrame(frame) {
  const m = frame.match(/(\/src\/[^\s:]+):(\d+):(\d+)/);
  if (!m) return frame;
  const [, file, line, col] = m;
  const resp = await fetch(`/@source-map?file=${file}&line=${line}&column=${col}`);
  if (!resp.ok) return frame;
  const pos = await resp.json();
  if (pos.source) {
    return {
      file: pos.source,
      line: pos.line,
      column: pos.column,
      snippet: pos.snippet || ""
    };
  }
  return frame;
}

async function renderOverlay(err) {
  const overlay =
    document.getElementById(overlayId) ||
    document.body.appendChild(Object.assign(document.createElement("div"), { id: overlayId }));
  overlay.innerHTML = "";
  const title = document.createElement("h2");
  title.textContent = "🔥 " + (err.message || "Error");
  overlay.appendChild(title);

  const frames = (err.stack || "").split("\n").filter(l => /src\//.test(l));
  for (const frame of frames) {
    const mapped = await mapStackFrame(frame);
    if (typeof mapped === "string") continue;
    const frameEl = document.createElement("div");
    frameEl.className = "frame";

    const link = document.createElement("div");
    link.className = "frame-file";
    link.textContent = `${mapped.file}:${mapped.line}:${mapped.column}`;
    link.onclick = () =>
      window.open("vscode://file/" + location.origin.replace("http://", "") + mapped.file + ":" + mapped.line);
    frameEl.appendChild(link);

    if (mapped.snippet) {
      const pre = document.createElement("pre");
      pre.classList.add("language-jsx");
      pre.innerHTML = Prism.highlight(mapped.snippet, Prism.languages.jsx, "jsx");
      frameEl.appendChild(pre);
    }

    overlay.appendChild(frameEl);
  }
}

window.showErrorOverlay = (err) => renderOverlay(err);
window.clearErrorOverlay = () => document.getElementById(overlayId)?.remove();
