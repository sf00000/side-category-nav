/* 侧边分类导航 —— Side Panel 逻辑
 * 数据模型：树状结构，每个分类节点 = { id, name, collapsed, links[], children[] }
 */

const $ = (sel) => document.querySelector(sel);

const DEFAULT_SETTINGS = {
  indentEnabled: true,     // 是否启用固定缩进（子分类与链接按层级缩进）
  indentSize: 16,          // 每级缩进宽度(px)
  defaultCollapsed: false, // 新建分类默认折叠
  openInNewTab: true,      // 链接在新标签页打开
  aiProvider: "deepseek",  // AI 服务商
  aiKey: "",               // 用户自己的 API Key（仅存本地）
  aiModel: "",             // 自定义模型名，留空用默认
  aiMaxItems: 250,         // AI 整理单次处理的链接上限
  lastCategoryId: "",      // 「☆ 当前页」上次选择的分类
  panelMode: "native",     // 面板形态：native=原生侧栏长期固定 / float=悬浮自动隐藏
  hoverDelaySec: 1,        // 悬浮模式：鼠标在屏幕右缘停留多少秒后唤出
  maxIndentDepth: 4        // 缩进封顶层级：超过该深度后不再继续右缩，靠层级色条/导线区分
};

// 路线 A：用户自带 API Key，直连大模型，无后端
const AI_PROVIDERS = {
  deepseek: { name: "DeepSeek", type: "openai", url: "https://api.deepseek.com/v1/chat/completions", model: "deepseek-chat" },
  openai:   { name: "OpenAI",   type: "openai", url: "https://api.openai.com/v1/chat/completions",   model: "gpt-4o-mini" },
  claude:   { name: "Claude",   type: "claude", url: "https://api.anthropic.com/v1/messages",        model: "claude-3-5-haiku-latest" }
};

let state = { categories: [], settings: { ...DEFAULT_SETTINGS } };
let searchQuery = ""; // 实时搜索关键字（不持久化）

/* ---------------- 工具 ---------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

const escapeHtml = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));

const faviconUrl = (url) =>
  chrome.runtime.getURL("/_favicon/?pageUrl=" + encodeURIComponent(url) + "&size=32");

const hostOf = (url) => {
  try { return new URL(url).hostname; } catch { return url; }
};

/* ---------------- 树操作 ---------------- */
// 层级色条调色板：按深度循环，让不同层级一眼可辨（缩进封顶后主要靠它区分层级）
const DEPTH_COLORS = ["#2563eb", "#16a34a", "#ea580c", "#9333ea", "#db2777", "#0891b2"];
const depthColor = (depth) => DEPTH_COLORS[depth % DEPTH_COLORS.length];

function newCategory(name, collapsed) {
  return { id: uid(), name, collapsed, links: [], children: [] };
}

// 链接也是树：{ id, title, url, children[] }，children 里是子链接
function newLink(title, url) {
  return { id: uid(), title, url, children: [] };
}

// 在分类树中查找分类节点，返回 { node, parentList }
function findNode(id, list = state.categories, parentList = null) {
  for (const n of list) {
    if (n.id === id) return { node: n, parentList: parentList || list };
    const r = findNode(id, n.children, n.children);
    if (r) return r;
  }
  return null;
}

// 在全部链接树（含子链接）中查找链接，返回 { link, parentList, cat }
function findLink(id) {
  const inLinks = (links, cat) => {
    for (const l of links) {
      if (l.id === id) return { link: l, parentList: links, cat };
      const r = inLinks(l.children || [], cat);
      if (r) return r;
    }
    return null;
  };
  const walk = (cats) => {
    for (const c of cats) {
      const r = inLinks(c.links, c);
      if (r) return r;
      const r2 = walk(c.children);
      if (r2) return r2;
    }
    return null;
  };
  return walk(state.categories);
}

// 按 URL 找链接（AI 整理用），返回 { link, parentList, cat }
function findLinkByUrl(url) {
  const inLinks = (links, cat) => {
    for (const l of links) {
      if (l.url === url) return { link: l, parentList: links, cat };
      const r = inLinks(l.children || [], cat);
      if (r) return r;
    }
    return null;
  };
  const walk = (cats) => {
    for (const c of cats) {
      const r = inLinks(c.links, c);
      if (r) return r;
      const r2 = walk(c.children);
      if (r2) return r2;
    }
    return null;
  };
  return walk(state.categories);
}

// 查找某 URL 已存在的全部位置（全树、含子链接），返回路径数组
// 分类层级用 "/" 连接，子链接链用 " › " 连接（如 ["量化/数据", "量化 › 父链接"]）
// 用于收藏时的防重复提示；比较时忽略尾部斜杠
function findUrlLocations(url) {
  const norm = (u) => String(u || "").replace(/\/+$/, "");
  const target = norm(url);
  const paths = [];
  const walkLinks = (links, path) => {
    for (const l of links) {
      if (norm(l.url) === target) paths.push(path);
      walkLinks(l.children || [], path + " › " + l.title);
    }
  };
  const walk = (list, path) => {
    for (const n of list) {
      const p = path ? path + "/" + n.name : n.name;
      walkLinks(n.links, p);
      walk(n.children, p);
    }
  };
  walk(state.categories, "");
  return paths;
}

// 收藏防重复：已存在则弹窗提示位置并返回 true（表示重复，应中止）
function isDuplicateUrl(url) {
  const locs = findUrlLocations(url);
  if (locs.length === 0) return false;
  alert(
    `❌ 收藏失败：这个网址已经收藏过了\n\n` +
    locs.map((p) => "· " + p).join("\n") +
    `\n\n如需移动它，可用拖拽或 AI 整理。`
  );
  return true;
}

// id 是否位于分类 root 的子树中（含 root 自身）
function inSubtree(root, id) {
  if (root.id === id) return true;
  return root.children.some((c) => inSubtree(c, id));
}

// id 是否位于链接 root 的子链接树中（含 root 自身）
function inLinkSubtree(root, id) {
  if (root.id === id) return true;
  return (root.children || []).some((c) => inLinkSubtree(c, id));
}

// 统计链接树的链接数（含子链接，递归）
function countLinkTree(link) {
  return 1 + (link.children || []).reduce((s, c) => s + countLinkTree(c), 0);
}

// 统计分类子树中链接总数（含子链接，递归）
function countLinks(node) {
  const own = node.links.reduce((s, l) => s + countLinkTree(l), 0);
  return own + node.children.reduce((s, c) => s + countLinks(c), 0);
}

// 统计子树中分类总数（递归）
function countCategories(node) {
  return node.children.reduce((s, c) => s + 1 + countCategories(c), 0);
}

// 数据迁移：旧版数据没有 children 字段，补齐（分类与链接都补）
function migrate(list) {
  for (const n of list) {
    if (!Array.isArray(n.children)) n.children = [];
    if (!Array.isArray(n.links)) n.links = [];
    migrateLinks(n.links);
    migrate(n.children);
  }
}

function migrateLinks(links) {
  for (const l of links) {
    if (!Array.isArray(l.children)) l.children = [];
    migrateLinks(l.children);
  }
}

/* ---------------- 存储 ---------------- */
async function loadState() {
  const data = await chrome.storage.local.get(["categories", "settings"]);
  state.categories = Array.isArray(data.categories) ? data.categories : [];
  migrate(state.categories);
  state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
}

async function save() {
  await chrome.storage.local.set({
    categories: state.categories,
    settings: state.settings
  });
}

/* ---------------- 渲染 ---------------- */
function applySettingsToUI() {
  const s = state.settings;
  // 关闭固定缩进 = 把每级缩进宽度直接置 0
  document.documentElement.style.setProperty("--indent", (s.indentEnabled ? s.indentSize : 0) + "px");
  $("#setIndentEnabled").checked = s.indentEnabled;
  $("#setIndentSize").value = s.indentSize;
  $("#indentSizeLabel").textContent = s.indentSize + "px";
  $("#setDefaultCollapsed").checked = s.defaultCollapsed;
  $("#setOpenInNewTab").checked = s.openInNewTab;
  $("#setAiProvider").value = s.aiProvider;
  $("#setAiKey").value = s.aiKey;
  $("#setAiModel").value = s.aiModel;
  $("#setAiModel").placeholder = "默认：" + AI_PROVIDERS[s.aiProvider].model;
  $("#setAiMaxItems").value = s.aiMaxItems;
  $("#setPanelMode").value = s.panelMode;
  $("#setHoverDelay").value = s.hoverDelaySec;
  $("#setMaxIndentDepth").value = s.maxIndentDepth;
}

/* ---------------- 搜索过滤 ---------------- */
// 关键字高亮（先转义再包 <mark>，防注入）
function highlight(text) {
  const esc = escapeHtml(text);
  if (!searchQuery) return esc;
  const q = escapeHtml(searchQuery).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return esc.replace(new RegExp(q, "gi"), (m) => `<mark>${m}</mark>`);
}

// 递归过滤链接树：自身命中 → 保留整棵子链接；子孙命中 → 保留祖先链
function filterLinks(links, q) {
  const out = [];
  for (const l of links) {
    const self = l.title.toLowerCase().includes(q) || l.url.toLowerCase().includes(q);
    if (self) { out.push(l); continue; }
    const kids = filterLinks(l.children || [], q);
    if (kids.length > 0) out.push({ ...l, children: kids, collapsed: false });
  }
  return out;
}

// 递归过滤：分类名命中 → 保留整棵；否则按链接标题/网址过滤并下钻子分类
function filterTree(list, q) {
  const out = [];
  for (const cat of list) {
    if (cat.name.toLowerCase().includes(q)) {
      out.push({ ...cat, collapsed: false });
      continue;
    }
    const links = filterLinks(cat.links, q);
    const children = filterTree(cat.children, q);
    if (links.length > 0 || children.length > 0) {
      out.push({ ...cat, links, children, collapsed: false });
    }
  }
  return out;
}

function render() {
  const list = $("#categoryList");
  list.innerHTML = "";
  const q = searchQuery.trim().toLowerCase();
  const display = q ? filterTree(state.categories, q) : state.categories;

  const emptyEl = $("#emptyState");
  if (state.categories.length === 0) {
    emptyEl.classList.remove("hidden");
    emptyEl.querySelector("p").textContent = "还没有任何分类";
    emptyEl.querySelector(".dim").classList.remove("hidden");
  } else if (q && display.length === 0) {
    emptyEl.classList.remove("hidden");
    emptyEl.querySelector("p").textContent = `没有匹配「${searchQuery.trim()}」的链接或分类`;
    emptyEl.querySelector(".dim").classList.add("hidden");
  } else {
    emptyEl.classList.add("hidden");
  }

  display.forEach((cat) => list.appendChild(renderCategory(cat, 0, cat.name)));
}

// 缩进封顶：超过 maxIndentDepth 后不再继续右缩，防止深层级标题被顶出可视区
function effDepth(depth) {
  return Math.min(depth, state.settings.maxIndentDepth ?? 4);
}

function renderCategory(cat, depth, path) {
  const el = document.createElement("div");
  el.className = "category" + (cat.collapsed ? " collapsed" : "") + (depth > 0 ? " is-sub" : " is-root");
  el.dataset.id = cat.id;
  el.dataset.depth = depth;

  const d = effDepth(depth);
  const header = document.createElement("div");
  header.className = "cat-header";
  header.dataset.action = "toggle-cat";
  header.draggable = true;
  header.style.paddingLeft = `calc(8px + ${d} * var(--indent))`;
  header.title = path; // 完整路径 tooltip，标题被省略时也能看到层级
  header.innerHTML = `
    <span class="depth-bar" style="background:${depthColor(depth)}"></span>
    <span class="cat-arrow">▼</span>
    <span class="cat-name">${highlight(cat.name)}</span>
    <span class="cat-count">${countLinks(cat)}</span>
    <div class="cat-actions">
      <button data-action="cat-top" title="移到当前层级最前">⤒</button>
      <button data-action="cat-bottom" title="移到当前层级最后">⤓</button>
      <button data-action="add-link" title="添加链接">＋</button>
      <button data-action="add-subcat" title="新建子分类">⧉</button>
      <button data-action="rename-cat" title="重命名">✎</button>
      <button data-action="del-cat" class="danger" title="删除分类（含子分类）">✕</button>
    </div>
  `;
  el.appendChild(header);

  const body = document.createElement("div");
  body.className = "cat-body";
  // 树导线：子内容左侧一条竖线，对齐到父级箭头位置，直观表达从属关系
  body.style.setProperty("--guide-x", `calc(8px + ${d} * var(--indent) + 7px)`);

  cat.links.forEach((link) => renderLink(link, d + 1, 0, body, path));

  cat.children.forEach((child) =>
    body.appendChild(renderCategory(child, depth + 1, path + " / " + child.name)));

  el.appendChild(body);
  return el;
}

// 渲染链接行及其子链接（递归）。level = 缩进层级；linkDepth = 链接嵌套深度
function renderLink(link, level, linkDepth, container, path) {
  const hasKids = (link.children || []).length > 0;
  const wrap = document.createElement("div");
  wrap.className = "link-node" + (link.collapsed ? " collapsed" : "");

  const row = document.createElement("div");
  row.className = "link-row";
  row.dataset.linkId = link.id;
  row.draggable = true;
  row.style.paddingLeft = `calc(8px + ${level} * var(--indent))`;
  const isWebLink = /^https?:/i.test(link.url);
  row.innerHTML = `
    ${hasKids
      ? `<span class="link-arrow" data-action="toggle-link" title="展开/折叠子链接">▼</span>`
      : `<span class="link-arrow-spacer"></span>`}
    <span class="drag-handle">⠿</span>
    ${isWebLink
      ? `<img class="favicon" src="${faviconUrl(link.url)}" onerror="this.style.visibility='hidden'" />`
      : `<span class="favicon file-icon" title="本地文件">📄</span>`}
    <a href="${escapeHtml(link.url)}" title="${escapeHtml(link.title)}&#10;${escapeHtml(link.url)}"
       ${state.settings.openInNewTab ? 'target="_blank" rel="noopener"' : ""}>${highlight(link.title)}</a>
    ${hasKids ? `<span class="cat-count">${countLinkTree(link) - 1}</span>` : ""}
    <div class="link-actions">
      <button data-action="add-sublink" title="添加子链接">＋</button>
      <button data-action="edit-link" title="编辑">✎</button>
      <button data-action="del-link" class="danger" title="删除（含子链接）">✕</button>
    </div>
  `;
  wrap.appendChild(row);

  if (hasKids) {
    const sub = document.createElement("div");
    sub.className = "sublinks";
    sub.style.setProperty("--guide-x", `calc(8px + ${level} * var(--indent) + 7px)`);
    link.children.forEach((kid) => renderLink(kid, level + 1, linkDepth + 1, sub, path));
    wrap.appendChild(sub);
  }

  container.appendChild(wrap);
}

/* ---------------- 弹窗 ---------------- */
function openModal({ title, bodyHtml, onOk, onOpen }) {
  $("#modalTitle").textContent = title;
  $("#modalBody").innerHTML = bodyHtml;
  $("#modalMask").classList.remove("hidden");
  const firstInput = $("#modalBody input");
  if (firstInput) firstInput.focus();
  if (onOpen) onOpen($("#modalBody"));

  $("#modalOk").onclick = async () => {
    const ok = await onOk($("#modalBody"));
    if (ok !== false) closeModal();
  };
  $("#modalCancel").onclick = closeModal;
  $("#modalMask").onclick = (e) => { if (e.target.id === "modalMask") closeModal(); };
}

function closeModal() { $("#modalMask").classList.add("hidden"); }

/* ---------------- 分类操作 ---------------- */
// 把分类移到当前所在层级的最前(top)/最后(bottom)，层级不变
function moveCatToEdge(found, edge) {
  const { node, parentList } = found;
  const idx = parentList.indexOf(node);
  if (idx === -1) return;
  if (edge === "top" && idx === 0) return;
  if (edge === "bottom" && idx === parentList.length - 1) return;
  parentList.splice(idx, 1);
  if (edge === "top") parentList.unshift(node);
  else parentList.push(node);
  save().then(render);
}

function addCategory(parent) {
  openModal({
    title: parent ? `在「${parent.name}」下新建子分类` : "新建分类",
    bodyHtml: `<label>分类名称<input type="text" id="m-catName" placeholder="例如：量化研究" /></label>`,
    onOk: async (body) => {
      const name = body.querySelector("#m-catName").value.trim();
      if (!name) return false;
      const cat = newCategory(name, state.settings.defaultCollapsed);
      if (parent) {
        parent.children.unshift(cat); // 新建子分类排在最前
        parent.collapsed = false; // 展开父分类让新子分类可见
      } else {
        state.categories.unshift(cat); // 新建分类排在最前
      }
      await save();
      render();
    }
  });
}

function renameCategory(cat) {
  openModal({
    title: "重命名分类",
    bodyHtml: `<label>分类名称<input type="text" id="m-catName" value="${escapeHtml(cat.name)}" /></label>`,
    onOk: async (body) => {
      const name = body.querySelector("#m-catName").value.trim();
      if (!name) return false;
      cat.name = name;
      await save();
      render();
    }
  });
}

function deleteCategory(cat) {
  const subCount = countCategories(cat);
  const linkCount = countLinks(cat);
  openModal({
    title: "删除分类",
    bodyHtml: `<p class="note">确定删除分类「${escapeHtml(cat.name)}」吗？<br/>将一并删除 ${subCount} 个子分类、共 ${linkCount} 个链接，且不可恢复。</p>`,
    onOk: async () => {
      const found = findNode(cat.id);
      if (found) {
        const i = found.parentList.findIndex((n) => n.id === cat.id);
        found.parentList.splice(i, 1);
      }
      await save();
      render();
    }
  });
}

/* ---------------- 链接操作 ---------------- */
function linkFormHtml({ title = "", url = "" } = {}) {
  return `
    <label>标题（必填，面板里显示的名字）
      <input type="text" id="m-linkTitle" required placeholder="例如：东方财富 - 沪深行情" value="${escapeHtml(title)}" />
    </label>
    <label>网址 / 路径
      <input type="text" id="m-linkUrl" placeholder="https://... 或本地绝对路径 /Users/.../a.html" value="${escapeHtml(url)}" />
    </label>
    <p class="note">💡 支持网页网址和本地文件绝对路径（自动转为 file://）。如果目标网页正开在标签页里，填完会自动带入它的标题。</p>
  `;
}

// 归一化用户输入的网址：
// · file:// 或 http(s):// 直接返回
// · 绝对路径（/Users/... 或 C:\...）→ file:// URL，支持收藏本地 HTML/PDF 等文件
// · 其他（如 example.com）→ 补 https://
function normalizeInputUrl(raw) {
  const url = raw.trim();
  if (!url) return null;
  if (/^(https?|file):\/\//i.test(url)) return url;
  if (/^\//.test(url) || /^[a-zA-Z]:[\\/]/.test(url)) {
    try { return new URL("file://" + url.replace(/\\/g, "/")).href; }
    catch { return "file://" + encodeURI(url.replace(/\\/g, "/")); }
  }
  return "https://" + url;
}

function readLinkForm(body) {
  const url = normalizeInputUrl(body.querySelector("#m-linkUrl").value);
  const title = body.querySelector("#m-linkTitle").value.trim();
  if (!url) return null;
  if (!title) return null; // 标题必填，不允许只存一个裸链接
  return { title, url };
}

// 网址输入完后，从已打开的标签页里匹配标题并自动填入
function attachTabTitleAutofill(body) {
  const urlInput = body.querySelector("#m-linkUrl");
  const titleInput = body.querySelector("#m-linkTitle");
  if (!urlInput || !titleInput) return;
  urlInput.addEventListener("change", async () => {
    if (titleInput.value.trim()) return;
    const url = normalizeInputUrl(urlInput.value);
    if (!url) return;
    try {
      const tabs = await chrome.tabs.query({});
      const norm = (u) => (u || "").replace(/\/+$/, "");
      const hit = tabs.find((t) => t.url && norm(t.url) === norm(url));
      if (hit && hit.title) titleInput.value = hit.title;
    } catch { /* 忽略，手动填即可 */ }
  });
}

function addLink(cat, preset) {
  openModal({
    title: `添加链接到「${cat.name}」`,
    bodyHtml: linkFormHtml(preset),
    onOpen: attachTabTitleAutofill,
    onOk: async (body) => {
      const data = readLinkForm(body);
      if (!data) {
        alert("标题和网址都要填写，面板里只认标题。");
        return false;
      }
      if (isDuplicateUrl(data.url)) return false;
      cat.links.push(newLink(data.title, data.url));
      await save();
      render();
    }
  });
}

// 在某个链接下添加子链接（链接也是树，可无限嵌套）
function addSubLink(parentLink) {
  openModal({
    title: `在「${parentLink.title}」下添加子链接`,
    bodyHtml: linkFormHtml(),
    onOpen: attachTabTitleAutofill,
    onOk: async (body) => {
      const data = readLinkForm(body);
      if (!data) {
        alert("标题和网址都要填写，面板里只认标题。");
        return false;
      }
      if (isDuplicateUrl(data.url)) return false;
      parentLink.children.push(newLink(data.title, data.url));
      parentLink.collapsed = false; // 展开父链接让新子链接可见
      await save();
      render();
    }
  });
}

function editLink(cat, link) {
  openModal({
    title: "编辑链接",
    bodyHtml: linkFormHtml(link),
    onOpen: attachTabTitleAutofill,
    onOk: async (body) => {
      const data = readLinkForm(body);
      if (!data) {
        alert("标题和网址都要填写，面板里只认标题。");
        return false;
      }
      // 改了网址时做全局防重（旧网址所在位置就是本链接自己，天然被排除）
      if (data.url !== link.url && isDuplicateUrl(data.url)) return false;
      Object.assign(link, data);
      await save();
      render();
    }
  });
}

/* ---------------- 收藏当前页 ---------------- */
// 把树拍平成带层级的选项列表
function flattenTree(list, depth = 0, out = []) {
  for (const n of list) {
    out.push({ node: n, depth });
    flattenTree(n.children, depth + 1, out);
  }
  return out;
}

async function addCurrentPage() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !tab.url || !/^(https?|file):/i.test(tab.url)) {
    alert("当前页面无法收藏（仅支持 http/https/file 页面）。本地文件收藏需先在 chrome://extensions 里给本扩展开启「允许访问文件网址」。");
    return;
  }
  if (state.categories.length === 0) {
    alert("请先点击「＋ 分类」创建一个分类。");
    return;
  }
  const flat = flattenTree(state.categories);
  // 记住上次选择的分类，下次默认选中
  const lastId = state.settings.lastCategoryId;
  const lastExists = lastId && flat.some(({ node }) => node.id === lastId);
  const options = flat
    .map(({ node, depth }) =>
      `<option value="${node.id}"${node.id === lastId && lastExists ? " selected" : ""}>${"　".repeat(depth)}${escapeHtml(node.name)}</option>`)
    .join("");
  openModal({
    title: "收藏当前页",
    bodyHtml: `
      <label>添加到分类
        <select id="m-catSelect">${options}</select>
      </label>
      ${linkFormHtml({ title: tab.title || "", url: tab.url })}
    `,
    onOk: async (body) => {
      const data = readLinkForm(body);
      if (!data) {
        alert("标题和网址都要填写，面板里只认标题。");
        return false;
      }
      const found = findNode(body.querySelector("#m-catSelect").value);
      if (!found) return false;
      if (isDuplicateUrl(data.url)) return false;
      found.node.links.push(newLink(data.title, data.url));
      state.settings.lastCategoryId = found.node.id; // 记住本次选择
      await save();
      render();
    }
  });
}

/* ---------------- AI 整理 ---------------- */
async function callAI(userPrompt) {
  const s = state.settings;
  const p = AI_PROVIDERS[s.aiProvider];
  if (!s.aiKey) throw new Error("尚未配置 API Key");
  const model = s.aiModel.trim() || p.model;
  const sys = "你是网页收藏整理助手，只输出 JSON，不输出任何其他文字。";

  let resp;
  if (p.type === "openai") {
    resp = await fetch(p.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": "Bearer " + s.aiKey },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: sys },
          { role: "user", content: userPrompt }
        ],
        temperature: 0.2,
        max_tokens: 8192 // 250 条建议的 JSON 可能很长，防止输出被截断
      })
    });
  } else {
    // Claude：浏览器直连需要显式声明 dangerous-direct-browser-access
    resp = await fetch(p.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": s.aiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-dangerous-direct-browser-access": "true"
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        system: sys,
        messages: [{ role: "user", content: userPrompt }]
      })
    });
  }

  if (!resp.ok) {
    const detail = (await resp.text()).slice(0, 200);
    throw new Error(`${p.name} API 返回 ${resp.status}：${detail}`);
  }
  const data = await resp.json();
  return p.type === "openai" ? data.choices[0].message.content : data.content[0].text;
}

// 收集全部链接及其当前分类路径（含子链接，子链接随父链接一起参与整理）
function collectItems() {
  const items = [];
  const collectLinks = (links, path) => {
    for (const l of links) {
      items.push({ title: l.title, url: l.url, current: path });
      collectLinks(l.children || [], path);
    }
  };
  const walk = (list, path) => {
    for (const n of list) {
      const p = path ? path + "/" + n.name : n.name;
      collectLinks(n.links, p);
      walk(n.children, p);
    }
  };
  walk(state.categories, "");
  return items;
}

// 按分类路径解析节点；不存在则返回 null
function resolvePath(path) {
  const parts = String(path).split("/").map((s) => s.trim()).filter(Boolean);
  let list = state.categories, node = null;
  for (const part of parts) {
    node = list.find((c) => c.name === part);
    if (!node) return null;
    list = node.children;
  }
  return node;
}

function applyAiMoves(moves) {
  for (const m of moves) {
    // 找到链接（含子链接）当前所在位置
    const found = findLinkByUrl(m.url);
    if (!found) continue;

    // 解析目标分类
    let target = null;
    if (m.to.startsWith("新建：")) {
      const name = m.to.slice(3).trim();
      if (!name) continue;
      target = state.categories.find((c) => c.name === name);
      if (!target) {
        target = newCategory(name, false);
        state.categories.push(target);
      }
    } else {
      target = resolvePath(m.to);
      if (!target) continue; // 模型给了不存在的路径，跳过
    }

    const i = found.parentList.indexOf(found.link);
    if (i < 0) continue;
    found.parentList.splice(i, 1);
    target.links.push(found.link); // 链接连同其子链接整棵移动
    target.collapsed = false;
  }
}

// 解析模型输出：先尝试整体解析 JSON 数组；若输出被截断（Unterminated），
// 退化为逐对象抢救——解析所有完整的 {...}，丢弃不完整的尾部。
function parseMovesJson(text) {
  const cleaned = text.replace(/```(?:json)?/g, "");
  const arrMatch = cleaned.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return { items: JSON.parse(arrMatch[0]), truncated: false }; } catch { /* 落入抢救逻辑 */ }
  }
  const items = [];
  const re = /\{[^{}]*\}/g;
  let m;
  while ((m = re.exec(cleaned)) !== null) {
    try {
      const obj = JSON.parse(m[0]);
      if (obj && obj.url && obj.category) items.push(obj);
    } catch { /* 跳过损坏对象 */ }
  }
  return { items, truncated: true };
}

async function aiOrganize() {
  const s = state.settings;
  if (!s.aiKey) {
    $("#settingsPanel").classList.remove("hidden");
    alert("请先在设置里填写 AI 的 API Key（仅存本地，不会上传到任何服务器）。");
    return;
  }
  const items = collectItems();
  const limit = state.settings.aiMaxItems || 250;
  if (items.length === 0) { alert("还没有任何链接可整理。"); return; }
  if (items.length > limit) {
    alert(`当前共 ${items.length} 个链接，超过单次上限 ${limit} 条（可在设置中调整，用于控制 Token 消耗）。请先手动归置一部分。`);
    return;
  }
  const catPaths = [...new Set(items.map((i) => i.current))];

  openModal({
    title: "AI 整理收藏",
    bodyHtml: `<p class="note" id="aiStatus">正在调用 ${AI_PROVIDERS[s.aiProvider].name}（${items.length} 个链接），请稍候…</p>`,
    onOk: () => {}
  });
  const okBtn = $("#modalOk");
  okBtn.style.display = "none";

  const prompt =
    `我有以下网页收藏，每行格式：标题 | 网址 | 当前分类。\n` +
    `现有分类：${catPaths.map((c) => "「" + c + "」").join("、")}\n\n` +
    `请判断每个网页最合适的分类，规则：\n` +
    `1. 优先归入现有分类之一（用完整路径表示，如 "量化/数据"）；\n` +
    `2. 都不合适时输出 "新建：<分类名>"；\n` +
    `3. 只有确实需要变动的才输出，保持原样的不要输出。\n\n` +
    `收藏列表：\n${items.map((it, i) => `${i + 1}. ${it.title} | ${it.url} | ${it.current}`).join("\n")}\n\n` +
    `严格输出 JSON 数组：[{"url":"...","category":"..."}]，不要输出任何其他内容。`;

  try {
    const text = await callAI(prompt);
    const { items: json, truncated } = parseMovesJson(text);

    const moves = [];
    for (const item of json) {
      const it = items.find((x) => x.url === item.url);
      if (!it || !item.category) continue;
      const to = String(item.category).trim();
      if (to === it.current) continue;
      moves.push({ url: it.url, title: it.title, from: it.current, to });
    }

    if (moves.length === 0) {
      $("#aiStatus").textContent = truncated
        ? "模型输出不完整且未能恢复任何建议，请重试（或减少链接数量）。"
        : "AI 认为当前分类已经合理，无需调整。";
      return;
    }

    // 每条建议一个勾选框，人工逐条确认后只应用选中的
    $("#aiStatus").innerHTML =
      `<p class="note">` +
      (truncated ? `⚠️ 模型输出被截断，已恢复其中完整的建议。<br/>` : "") +
      `AI 建议调整 <b>${moves.length}</b> 个链接，勾选要应用的（默认全选）：</p>` +
      `<div class="ai-moves">` +
      moves.map((m, i) =>
        `<label class="ai-move">
          <input type="checkbox" data-move-idx="${i}" checked />
          <span class="ai-move-text">${escapeHtml(m.title)}<br/>
            <span class="dim">${escapeHtml(m.from)} → <b>${escapeHtml(m.to)}</b></span>
          </span>
        </label>`).join("") +
      `</div>
      <div class="ai-moves-tools">
        <button type="button" id="aiCheckAll">全选</button>
        <button type="button" id="aiUncheckAll">全不选</button>
      </div>`;

    $("#aiCheckAll").onclick = () =>
      document.querySelectorAll("[data-move-idx]").forEach((c) => (c.checked = true));
    $("#aiUncheckAll").onclick = () =>
      document.querySelectorAll("[data-move-idx]").forEach((c) => (c.checked = false));

    okBtn.style.display = "";
    okBtn.textContent = "应用选中项";
    okBtn.onclick = async () => {
      const selected = moves.filter((_, i) =>
        document.querySelector(`[data-move-idx="${i}"]`)?.checked);
      if (selected.length === 0) {
        alert("没有勾选任何调整项。");
        return;
      }
      applyAiMoves(selected);
      await save();
      render();
      okBtn.textContent = "确定";
      closeModal();
      alert(`已应用 ${selected.length} 条调整。`);
    };
  } catch (err) {
    $("#aiStatus").textContent = "调用失败：" + err.message;
  }
}

/* ---------------- 分类导出 / 导入（Markdown 明文格式） ----------------
   格式约定（人可直接阅读，也可被本插件无损解析还原）：
     # 分类名          —— 1 级标题 = 分类（可多层 ## 嵌套子分类）
     - [标题](网址)    —— 列表项 = 链接；缩进 2 空格 = 下一级子链接
 */
function escapeMd(s) {
  return String(s).replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}
function unescapeMd(s) {
  return String(s).replace(/\\([\[\]()\\])/g, "$1");
}

function sanitizeFilename(name) {
  const s = String(name || "").replace(/[\\/:*?"<>|\s]+/g, "_").replace(/^\.+/, "");
  return (s.slice(0, 40) || "category");
}

function categoryToMarkdown(cat) {
  const out = [`# ${escapeMd(cat.name)}`];
  const walkLinks = (links, indent) => {
    for (const l of links) {
      // 括号/空格在 Markdown 链接里有语法含义，转义成百分号编码
      const url = String(l.url)
        .replace(/\(/g, "%28").replace(/\)/g, "%29").replace(/\s+/g, "%20");
      out.push(`${"  ".repeat(indent)}- [${escapeMd(l.title)}](${url})`);
      if (l.children && l.children.length) walkLinks(l.children, indent + 1);
    }
  };
  const walkCat = (c, level) => {
    walkLinks(c.links, 0);
    for (const ch of c.children) {
      out.push("", `${"#".repeat(level + 1)} ${escapeMd(ch.name)}`);
      walkCat(ch, level + 1);
    }
  };
  walkCat(cat, 1);
  return out.join("\n") + "\n";
}

function parseCategoryMarkdown(text) {
  let root = null;
  const stack = []; // 未闭合的标题层级 { level, cat }
  const addLink = (cat, depth, title, url) => {
    // _chain[0] 是分类本身（链接进 .links），其后每层是当前深度的末级链接（子链接进其 .children）
    const chain = cat._chain || (cat._chain = [{ isRoot: true, cat }]);
    const idx = Math.max(0, Math.min(depth, chain.length - 1));
    const link = newLink(title, url);
    const container = chain[idx];
    if (container.isRoot) container.cat.links.push(link);
    else container.children.push(link);
    chain.length = idx + 1;
    chain.push(link);
  };
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, "");
    if (!line.trim() || line.trim().startsWith("```")) continue;
    const h = line.match(/^(#{1,6})\s+(.+)$/);
    if (h) {
      const level = h[1].length;
      const cat = newCategory(unescapeMd(h[2].trim()), false);
      if (!root) {
        root = cat;
      } else {
        while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
        const parent = stack.length ? stack[stack.length - 1].cat : root;
        parent.children.push(cat);
      }
      stack.push({ level, cat });
      continue;
    }
    const m = line.match(/^(\s*)-\s+\[(.+?)\]\((.+)\)\s*$/);
    if (m && root) {
      const top = stack[stack.length - 1];
      if (!top) continue; // 标题前的散落链接行，忽略
      const indent = m[1].replace(/\t/g, "  ").length;
      // 还原导出时为绕开 Markdown 括号语法做的转义
      const url = m[3].trim().replace(/%28/g, "(").replace(/%29/g, ")");
      addLink(top.cat, Math.floor(indent / 2), unescapeMd(m[2].trim()), url);
    }
  }
  const clean = (c) => { delete c._chain; c.children.forEach(clean); };
  if (root) clean(root);
  return root;
}

async function exportCategory(cat) {
  if (countLinks(cat) === 0 && countCategories(cat) === 0) {
    alert("该分类是空的，没有可导出的内容。");
    return;
  }
  const md = categoryToMarkdown(cat);
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
  const filename = `side-nav-${sanitizeFilename(cat.name)}-${stamp}.md`;
  try {
    const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    // saveAs: true → 弹出系统「存储为」对话框，可自选保存目录
    await chrome.downloads.download({ url, filename, saveAs: true });
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (err) {
    alert("导出失败：" + (err && err.message ? err.message : err));
  }
}

function importCategoryFile() {
  const input = document.createElement("input");
  input.type = "file";
  input.accept = ".md,.markdown,.mdown,.mkd,text/markdown,text/plain";
  input.onchange = () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      let cat = null;
      try { cat = parseCategoryMarkdown(reader.result); } catch { /* 格式错误 */ }
      if (!cat) {
        alert("无法识别文件内容：需要本插件导出的 Markdown 格式（# 分类名 + ## 子分类 + - [标题](网址) 列表）。");
        return;
      }
      confirmImportCategory(cat);
    };
    reader.readAsText(file, "utf-8");
  };
  input.click();
}

// 收集某分类子树内全部 URL（含子链接），用于合并去重；忽略尾部斜杠
function collectSubtreeUrls(cat) {
  const urls = new Set();
  const norm = (u) => String(u).replace(/\/+$/, "");
  const walkLinks = (links) => links.forEach((l) => {
    urls.add(norm(l.url));
    if (l.children && l.children.length) walkLinks(l.children);
  });
  const walk = (c) => { walkLinks(c.links); c.children.forEach(walk); };
  walk(cat);
  return urls;
}

// 把 src 合并进 dst：链接按 URL 去重，子分类按名称递归合并
function mergeCategory(src, dst) {
  const urls = collectSubtreeUrls(dst);
  const norm = (u) => String(u).replace(/\/+$/, "");
  const walkLinks = (links) => {
    for (const l of links) {
      const key = norm(l.url);
      if (urls.has(key)) {
        // 本体已存在，但其子链接可能仍有新增，逐个检查
        if (l.children && l.children.length) walkLinks(l.children);
      } else {
        dst.links.push(l);
        urls.add(key);
      }
    }
  };
  walkLinks(src.links);
  for (const child of src.children) {
    const existing = dst.children.find((c) => c.name === child.name);
    if (existing) mergeCategory(child, existing);
    else dst.children.push(child);
  }
  dst.collapsed = false;
}

function confirmImportCategory(cat) {
  const linkCount = countLinks(cat);
  const subCount = countCategories(cat);

  // 同名检测：在现有全树（任意层级）中查找同名分类
  const sameName = [];
  const walkNames = (list) => list.forEach((c) => {
    if (c.name === cat.name) sameName.push(c);
    walkNames(c.children);
  });
  walkNames(state.categories);

  const dupHtml = sameName.length
    ? `<p class="note">⚠️ 已存在同名分类「${escapeHtml(cat.name)}」（共 ${sameName.length} 处）。请选择处理方式：</p>
       <label style="display:block;margin:6px 0;">
         <input type="radio" name="impMode" value="merge" checked />
         合并到现有分类（网址重复的自动跳过）
       </label>
       <label style="display:block;margin:6px 0;">
         <input type="radio" name="impMode" value="copy" />
         保留两者（作为独立分类导入，同名共存）
       </label>`
    : `<p class="note">没有发现同名分类，将作为新分类导入。</p>`;

  openModal({
    title: "导入分类",
    bodyHtml: `<p>「<b>${escapeHtml(cat.name)}</b>」：${linkCount} 个链接${subCount ? `，${subCount} 个子分类` : ""}。</p>${dupHtml}`,
    onOk: async (body) => {
      if (sameName.length) {
        const checked = body.querySelector('input[name="impMode"]:checked');
        if (checked && checked.value === "copy") {
          state.categories.push(cat);
        } else {
          mergeCategory(cat, sameName[0]);
        }
      } else {
        state.categories.push(cat);
      }
      await save();
      render();
    }
  });
}


// 收集整棵树中已存在的 URL 与标题（含子链接），用于导入去重
function collectExistingKeys() {
  const urls = new Set(), titles = new Set();
  const walkLinks = (links) => links.forEach((l) => {
    urls.add(l.url); titles.add(l.title);
    walkLinks(l.children || []);
  });
  const walk = (list) => list.forEach((n) => {
    walkLinks(n.links);
    walk(n.children);
  });
  walk(state.categories);
  return { urls, titles };
}

/* ---------------- 从收藏夹导入（递归保留层级） ---------------- */
function bookmarkFolderToCategory(folder, skip) {
  const cat = newCategory(folder.title || "未命名", state.settings.defaultCollapsed);
  for (const n of folder.children || []) {
    if (n.url) {
      const link = newLink(n.title || hostOf(n.url), n.url);
      if (skip && skip(link)) continue;
      cat.links.push(link);
    } else if (n.children) {
      cat.children.push(bookmarkFolderToCategory(n, skip));
    }
  }
  return cat;
}

function importFromBookmarks() {
  openModal({
    title: "从浏览器收藏夹导入",
    bodyHtml: `<p class="note">导入规则：<br/>· 书签栏下的文件夹 → 递归导入为分类树（子文件夹变成子分类）<br/>· 直接散放在书签栏上的单个收藏 → 归入「书签栏（散置链接）」分类<br/>· <b>URL 或标题已存在于面板中的链接一律跳过</b>（与 AI 归类结果不冲突）。</p>`,
    onOk: async () => {
      const tree = await chrome.bookmarks.getTree();
      const bar = tree[0]?.children?.find((n) => n.id === "1") || tree[0]?.children?.[0];
      if (!bar || !bar.children) return;

      const existing = new Set(state.categories.map((c) => c.name));
      const keys = collectExistingKeys();
      let skipped = 0;
      const skip = (link) => {
        if (keys.urls.has(link.url) || keys.titles.has(link.title)) { skipped++; return true; }
        keys.urls.add(link.url);
        keys.titles.add(link.title);
        return false;
      };
      let addedFolders = 0;
      let addedLoose = 0;

      // 1) 文件夹 → 分类树
      for (const folder of bar.children) {
        if (folder.url || !folder.children) continue;
        if (existing.has(folder.title)) continue;
        const cat = bookmarkFolderToCategory(folder, skip);
        if (countLinks(cat) === 0) continue;
        state.categories.push(cat);
        existing.add(cat.name);
        addedFolders++;
      }

      // 2) 散置的单个收藏 → 归入「书签栏（散置链接）」
      const LOOSE_NAME = "书签栏（散置链接）";
      const looseLinks = bar.children
        .filter((n) => n.url)
        .map((n) => newLink(n.title || hostOf(n.url), n.url))
        .filter((l) => !skip(l));
      if (looseLinks.length > 0) {
        let looseCat = state.categories.find((c) => c.name === LOOSE_NAME);
        if (!looseCat) {
          looseCat = newCategory(LOOSE_NAME, state.settings.defaultCollapsed);
          state.categories.push(looseCat);
        }
        for (const link of looseLinks) {
          looseCat.links.push(link);
          addedLoose++;
        }
      }

      await save();
      render();
      if (addedFolders === 0 && addedLoose === 0) {
        alert(skipped > 0
          ? `没有可导入的新内容（${skipped} 个链接已存在，已跳过）。`
          : "没有可导入的内容（收藏夹为空）。");
      } else {
        alert(`导入完成：${addedFolders} 个分类，${addedLoose} 个散置链接` +
          (skipped > 0 ? `（跳过 ${skipped} 个已存在的链接）` : "") + "。");
      }
    }
  });
}

/* ---------------- 拖拽排序 ---------------- */
let dragCtx = null; // { kind: 'category'|'link', id }

function clearDropHints() {
  document.querySelectorAll(".drop-before, .drop-after, .drop-into").forEach((el) =>
    el.classList.remove("drop-before", "drop-after", "drop-into"));
}

// 根据鼠标在行内的纵向位置决定落点：上 1/3 前插，中 1/3 放入，下 1/3 后插
function dropZone(e, el, allowInto) {
  const r = el.getBoundingClientRect();
  const ratio = (e.clientY - r.top) / r.height;
  if (allowInto) {
    if (ratio < 0.3) return "before";
    if (ratio > 0.7) return "after";
    return "into";
  }
  return ratio < 0.5 ? "before" : "after";
}

function bindDragEvents() {
  const list = $("#categoryList");

  list.addEventListener("dragstart", (e) => {
    const row = e.target.closest(".link-row");
    const header = e.target.closest(".cat-header");
    if (row) {
      dragCtx = { kind: "link", id: row.dataset.linkId };
    } else if (header) {
      dragCtx = { kind: "category", id: header.parentElement.dataset.id };
    } else {
      dragCtx = null;
      return;
    }
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "");
  });

  list.addEventListener("dragover", (e) => {
    if (!dragCtx) return;
    const header = e.target.closest(".cat-header");
    const row = e.target.closest(".link-row");
    clearDropHints();

    if (header) {
      const targetId = header.parentElement.dataset.id;
      // 分类不能放进自己或自己的后代
      if (dragCtx.kind === "category") {
        const src = findNode(dragCtx.id);
        if (!src || inSubtree(src.node, targetId)) return;
      }
      const zone = dropZone(e, header, true);
      header.classList.add("drop-" + zone);
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    } else if (row && dragCtx.kind === "link") {
      if (row.dataset.linkId === dragCtx.id) return;
      // 链接不能放进自己或自己的子孙链接
      const src = findLink(dragCtx.id);
      if (src && inLinkSubtree(src.link, row.dataset.linkId)) return;
      const zone = dropZone(e, row, true); // 三段落点：前 / 成为子链接 / 后
      row.classList.add("drop-" + zone);
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  });

  list.addEventListener("dragleave", (e) => {
    if (!list.contains(e.relatedTarget)) clearDropHints();
  });

  list.addEventListener("drop", async (e) => {
    if (!dragCtx) return;
    e.preventDefault();
    const header = e.target.closest(".cat-header");
    const row = e.target.closest(".link-row");

    if (dragCtx.kind === "category" && header) {
      await dropCategory(dragCtx.id, header.parentElement.dataset.id, dropZone(e, header, true));
    } else if (dragCtx.kind === "link" && row) {
      await dropLinkOnLink(dragCtx.id, row.dataset.linkId, dropZone(e, row, true));
    } else if (dragCtx.kind === "link" && header) {
      await dropLinkOnCategory(dragCtx.id, header.parentElement.dataset.id);
    }

    clearDropHints();
    dragCtx = null;
    render();
  });

  list.addEventListener("dragend", () => {
    clearDropHints();
    dragCtx = null;
  });
}

// 移动分类到目标分类的 前/后/内部
async function dropCategory(srcId, targetId, zone) {
  const src = findNode(srcId);
  const target = findNode(targetId);
  if (!src || !target) return;
  if (inSubtree(src.node, targetId)) return; // 防止拖进自己的子树

  // 先从原位置摘除
  const i = src.parentList.findIndex((n) => n.id === srcId);
  src.parentList.splice(i, 1);

  if (zone === "into") {
    target.node.children.push(src.node);
    target.node.collapsed = false;
  } else {
    // 摘除后重新定位目标（同一列表时索引可能已变化）
    const t = findNode(targetId);
    const j = t.parentList.findIndex((n) => n.id === targetId);
    t.parentList.splice(zone === "before" ? j : j + 1, 0, src.node);
  }
  await save();
}

// 链接拖到另一条链接的 前/后/内部（内部 = 成为它的子链接）
async function dropLinkOnLink(srcId, targetId, zone) {
  if (srcId === targetId) return;
  const src = findLink(srcId);
  if (!src) return;
  if (inLinkSubtree(src.link, targetId)) return; // 防止拖进自己的子链接树

  const si = src.parentList.findIndex((l) => l.id === srcId);
  if (si < 0) return;
  const [link] = src.parentList.splice(si, 1);

  if (zone === "into") {
    const target = findLink(targetId);
    if (!target) return;
    target.link.children.push(link);
    target.link.collapsed = false;
  } else {
    // 摘除后重新定位目标
    const t = findLink(targetId);
    if (!t) return;
    const ti = t.parentList.findIndex((l) => l.id === targetId);
    t.parentList.splice(zone === "before" ? ti : ti + 1, 0, link);
  }
  await save();
}

// 链接拖到分类标题 → 移入该分类（成为其顶层链接）
async function dropLinkOnCategory(srcId, targetCatId) {
  const src = findLink(srcId);
  const target = findNode(targetCatId);
  if (!src || !target) return;
  if (src.cat && src.cat.id === targetCatId && src.parentList === src.cat.links) return; // 已在该分类顶层

  const si = src.parentList.findIndex((l) => l.id === srcId);
  if (si < 0) return;
  const [link] = src.parentList.splice(si, 1);
  target.node.links.push(link);
  target.node.collapsed = false;
  await save();
}

/* ---------------- 导出 / 恢复 JSON 备份 ---------------- */
function exportBackup() {
  const data = {
    app: "side-category-nav",
    version: 1,
    exportedAt: new Date().toISOString(),
    categories: state.categories,
    settings: state.settings
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  a.href = url;
  a.download = `side-nav-backup-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

function importBackup(file) {
  const reader = new FileReader();
  reader.onload = () => {
    let data;
    try {
      data = JSON.parse(reader.result);
    } catch {
      alert("备份文件不是合法的 JSON，恢复失败。");
      return;
    }
    if (!data || !Array.isArray(data.categories)) {
      alert("备份文件格式不正确（缺少 categories 字段），恢复失败。");
      return;
    }
    // 统计备份内容（含子链接），让用户确认
    let linkCount = 0, catCount = 0;
    const walkLinks = (links) => links.forEach((l) => { linkCount++; walkLinks(l.children || []); });
    const walk = (list) => list.forEach((n) => {
      catCount++;
      walkLinks(n.links || []);
      walk(n.children || []);
    });
    walk(data.categories);

    openModal({
      title: "恢复备份",
      bodyHtml: `<p class="note">备份内容：${catCount} 个分类、${linkCount} 个链接` +
        (data.exportedAt ? `（导出于 ${new Date(data.exportedAt).toLocaleString("zh-CN")}）` : "") +
        `。<br/><b>恢复将覆盖当前所有分类与设置，且不可撤销。</b>建议先导出当前数据。</p>`,
      onOk: async () => {
        migrate(data.categories); // 兼容旧版本结构
        state.categories = data.categories;
        state.settings = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
        await save();
        applySettingsToUI();
        render();
        alert("恢复完成。");
      }
    });
  };
  reader.readAsText(file);
}

/* ---------------- 事件绑定 ---------------- */
function bindEvents() {
  // 列表点击事件委托
  $("#categoryList").addEventListener("click", (e) => {
    const btn = e.target.closest("[data-action]");
    if (!btn) return;
    const action = btn.dataset.action;
    if (action === "toggle-cat" && e.target.closest(".cat-actions")) return; // 点在操作按钮上不算折叠

    const catEl = e.target.closest(".category");
    const found = findNode(catEl?.dataset.id);
    if (!found) return;
    const cat = found.node;

    switch (action) {
      case "toggle-cat":
        cat.collapsed = !cat.collapsed;
        save().then(render);
        break;
      case "add-link": addLink(cat); break;
      case "add-subcat": addCategory(cat); break;
      case "rename-cat": renameCategory(cat); break;
      case "del-cat": deleteCategory(cat); break;
      case "cat-top": moveCatToEdge(found, "top"); break;
      case "cat-bottom": moveCatToEdge(found, "bottom"); break;
      case "cat-export": exportCategory(cat); break;
      case "toggle-link": {
        const hit = findLink(e.target.closest(".link-row")?.dataset.linkId);
        if (hit) {
          hit.link.collapsed = !hit.link.collapsed;
          save().then(render);
        }
        break;
      }
      case "add-sublink": {
        const hit = findLink(e.target.closest(".link-row")?.dataset.linkId);
        if (hit) addSubLink(hit.link);
        break;
      }
      case "edit-link": {
        const hit = findLink(e.target.closest(".link-row")?.dataset.linkId);
        if (hit) editLink(hit.cat, hit.link);
        break;
      }
      case "del-link": {
        const hit = findLink(e.target.closest(".link-row")?.dataset.linkId);
        if (hit) {
          const subCount = countLinkTree(hit.link) - 1;
          if (subCount > 0 && !confirm(`该链接下还有 ${subCount} 个子链接，将一并删除，确定吗？`)) break;
          const i = hit.parentList.findIndex((l) => l.id === hit.link.id);
          if (i >= 0) hit.parentList.splice(i, 1);
          save().then(render);
        }
        break;
      }
    }
  });

  bindDragEvents();

  // 搜索
  $("#searchInput").addEventListener("input", (e) => {
    searchQuery = e.target.value;
    $("#searchClear").classList.toggle("hidden", !searchQuery);
    render();
  });
  $("#searchClear").onclick = () => {
    searchQuery = "";
    $("#searchInput").value = "";
    $("#searchClear").classList.add("hidden");
    render();
  };

  // 备份 / 恢复
  $("#btnExport").onclick = exportBackup;
  $("#btnImportBackup").onclick = () => $("#backupFileInput").click();
  $("#backupFileInput").onchange = (e) => {
    const file = e.target.files[0];
    if (file) importBackup(file);
    e.target.value = ""; // 允许重复选择同一文件
  };

  // 工具栏
  $("#btnAddPage").onclick = addCurrentPage;
  $("#btnAiOrganize").onclick = aiOrganize;
  $("#btnAddCategory").onclick = () => addCategory(null);
  $("#btnImport").onclick = importFromBookmarks;
  $("#btnImportFile").onclick = importCategoryFile;
  $("#btnSettings").onclick = () => $("#settingsPanel").classList.toggle("hidden");
  $("#btnExpandAll").onclick = () => {
    const walk = (list) => list.forEach((c) => { c.collapsed = false; walk(c.children); });
    walk(state.categories);
    save().then(render);
  };
  $("#btnCollapseAll").onclick = () => {
    const walk = (list) => list.forEach((c) => { c.collapsed = true; walk(c.children); });
    walk(state.categories);
    save().then(render);
  };

  // 设置
  $("#setIndentEnabled").onchange = async (e) => {
    state.settings.indentEnabled = e.target.checked;
    await save();
    applySettingsToUI();
  };
  $("#setIndentSize").oninput = async (e) => {
    state.settings.indentSize = Number(e.target.value);
    await save();
    applySettingsToUI();
  };
  $("#setDefaultCollapsed").onchange = async (e) => {
    state.settings.defaultCollapsed = e.target.checked;
    await save();
  };
  $("#setOpenInNewTab").onchange = async (e) => {
    state.settings.openInNewTab = e.target.checked;
    await save();
    render();
  };

  // 面板形态
  $("#setPanelMode").onchange = async (e) => {
    state.settings.panelMode = e.target.value;
    await save();
  };
  $("#setHoverDelay").onchange = async (e) => {
    let v = parseFloat(e.target.value);
    if (isNaN(v)) v = 1;
    v = Math.min(120, Math.max(0, v));
    e.target.value = v;
    state.settings.hoverDelaySec = v;
    await save();
  };
  $("#setMaxIndentDepth").onchange = async (e) => {
    let v = parseInt(e.target.value, 10);
    if (isNaN(v)) v = 4;
    v = Math.min(8, Math.max(1, v));
    e.target.value = v;
    state.settings.maxIndentDepth = v;
    await save();
    render();
  };

  // AI 设置
  $("#setAiProvider").onchange = async (e) => {
    state.settings.aiProvider = e.target.value;
    await save();
    applySettingsToUI(); // 刷新默认模型占位提示
  };
  $("#setAiKey").onchange = async (e) => {
    state.settings.aiKey = e.target.value.trim();
    await save();
  };
  $("#setAiModel").onchange = async (e) => {
    state.settings.aiModel = e.target.value.trim();
    await save();
  };
  $("#setAiMaxItems").onchange = async (e) => {
    const v = Math.max(10, Math.min(500, Number(e.target.value) || 250));
    state.settings.aiMaxItems = v;
    e.target.value = v;
    await save();
  };
}

/* ---------------- 启动 ---------------- */
(async function init() {
  await loadState();
  applySettingsToUI();
  render();
  bindEvents();
})();
