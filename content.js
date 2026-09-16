/* 侧边分类导航 - 悬浮自动隐藏面板（content script）
 * 原理：在网页右侧注入隐形触发条 + 内嵌 sidepanel.html 的 iframe。
 * 鼠标在右缘停留到设定时长后面板滑出；移开后自动收起。
 * 仅在设置 panelMode === "float" 时启用。
 */
(() => {
  const STRIP_ID = "scn-edge-strip";
  const PANEL_ID = "scn-float-panel";
  const PANEL_WIDTH = 340;

  let cfg = { panelMode: "native", hoverDelaySec: 1 };
  let strip = null;
  let panel = null;
  let iframe = null;
  let showTimer = null;
  let hideTimer = null;

  function clearTimers() {
    if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
  }

  function destroy() {
    clearTimers();
    document.removeEventListener("keydown", onKeydown, true);
    strip?.remove(); strip = null;
    panel?.remove(); panel = null;
    iframe = null;
  }

  function build() {
    if (strip) return; // 已存在

    // 右缘触发条：6px 宽、几乎透明，常驻
    strip = document.createElement("div");
    strip.id = STRIP_ID;

    // 悬浮面板：默认移出屏幕右侧，打开时滑入
    panel = document.createElement("div");
    panel.id = PANEL_ID;
    panel.style.setProperty("--scn-width", PANEL_WIDTH + "px");

    strip.addEventListener("mouseenter", () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
      if (panel.classList.contains("scn-open")) return;
      showTimer = setTimeout(openPanel, Math.max(0, cfg.hoverDelaySec) * 1000);
    });
    strip.addEventListener("mouseleave", () => {
      if (showTimer) { clearTimeout(showTimer); showTimer = null; }
    });

    panel.addEventListener("mouseenter", () => {
      if (hideTimer) { clearTimeout(hideTimer); hideTimer = null; }
    });
    panel.addEventListener("mouseleave", () => {
      hideTimer = setTimeout(closePanel, 500); // 0.5s 缓冲，防止手滑
    });

    document.documentElement.appendChild(strip);
    document.documentElement.appendChild(panel);
    document.addEventListener("keydown", onKeydown, true);
  }

  function openPanel() {
    showTimer = null;
    if (!iframe) {
      iframe = document.createElement("iframe");
      iframe.src = chrome.runtime.getURL("sidepanel.html");
      iframe.setAttribute("allow", "clipboard-write");
      panel.appendChild(iframe);
    }
    panel.classList.add("scn-open");
    // 面板打开期间，触发条让位（避免遮挡面板右缘）
    strip.classList.add("scn-hidden");
  }

  function closePanel() {
    hideTimer = null;
    panel.classList.remove("scn-open");
    strip.classList.remove("scn-hidden");
  }

  function onKeydown(e) {
    if (e.key === "Escape" && panel?.classList.contains("scn-open")) closePanel();
  }

  async function apply() {
    const data = await chrome.storage.local.get("settings");
    const s = data.settings || {};
    cfg.panelMode = s.panelMode || "native";
    cfg.hoverDelaySec = typeof s.hoverDelaySec === "number" ? s.hoverDelaySec : 1;

    if (cfg.panelMode === "float") {
      build();
    } else {
      destroy();
    }
  }

  // 设置变更实时生效（无需刷新页面）
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes.settings) apply();
  });

  apply();
})();
