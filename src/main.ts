import { setDiagnostics, type Diagnostic } from "@codemirror/lint";
import { EditorSelection, EditorState, StateEffect, StateField } from "@codemirror/state";
import { Decoration, EditorView } from "@codemirror/view";
import { documentDir, homeDir } from "@tauri-apps/api/path";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { api, basename, dirname, join, relative, type CompileResult, type Engine, type TreeEntry } from "./api";
import { createExtensions, fontCompartment, fontTheme, spellcheck, spellCompartment, wrapCompartment } from "./editor";
import { fileIcon, icon } from "./icons";
import { buildOutline, indexBibSource, indexTexSource, projectIndex } from "./latex";
import { parseLog, parseToolOutput, type LogEntry } from "./logparser";
import { PdfViewer } from "./pdfview";
import { TEMPLATES } from "./templates";
import { $, confirm, el, escapeHtml, modal, prompt, showMenu, toast, type MenuItem } from "./ui";

// ---------------------------------------------------------------------------
// Estado y preferencias
// ---------------------------------------------------------------------------

type Mode = "live" | "manual";

interface Settings {
  theme: "system" | "light" | "dark";
  fontSize: number;
  wrap: boolean;
  spell: boolean;
  liveDelay: number;
  mode: Mode;
}

interface ProjectPrefs {
  main?: string | null;
  engine?: Engine;
  tabs?: string[];
  current?: string | null;
}

interface OpenFile {
  state: EditorState;
  saved: string;
}

const TEXT_RE = /\.(tex|bib|sty|cls|bst|bbx|cbx|lbx|dtx|ins|ltx|txt|md|cfg|def|csv|dat|tsv|json|ya?ml|lua|py|tikz|pgf|latexmkrc|gitignore|log)$/i;
const IMAGE_RE = /\.(png|jpe?g|gif|svg|webp|bmp)$/i;
const INDEXED_RE = /\.(tex|bib|ltx)$/i;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function store(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* almacenamiento no disponible: no es crítico */
  }
}

const settings: Settings = load("settings", {
  theme: "system",
  fontSize: 14,
  wrap: true,
  spell: false,
  liveDelay: 700,
  mode: "live",
} as Settings);

const S = {
  root: null as string | null,
  tree: [] as TreeEntry[],
  flatFiles: [] as string[],
  collapsed: new Set<string>(),
  selectedDir: null as string | null,
  open: new Map<string, OpenFile>(),
  diskTexts: new Map<string, string>(),
  tabs: [] as string[],
  current: null as string | null,
  main: null as string | null,
  engine: "pdflatex" as Engine,
  compiling: false,
  pending: false,
  lastResult: null as CompileResult | null,
  entries: [] as LogEntry[],
  logsVisible: false,
  previewUrl: null as string | null,
};

const prefsKey = () => `project:${S.root}`;
function saveProjectPrefs() {
  if (!S.root) return;
  store(prefsKey(), { main: S.main, engine: S.engine, tabs: S.tabs, current: S.current } satisfies ProjectPrefs);
}

// ---------------------------------------------------------------------------
// Editor y visor
// ---------------------------------------------------------------------------

let liveTimer: number | undefined;
let indexTimer: number | undefined;

function onDocChange() {
  if (!S.current) return;
  const f = S.open.get(S.current);
  if (f) f.state = view.state;
  updateDirtyMarks();
  clearTimeout(indexTimer);
  indexTimer = window.setTimeout(() => {
    rebuildIndex();
    renderOutline();
  }, 350);
  if (settings.mode === "live") {
    clearTimeout(liveTimer);
    liveTimer = window.setTimeout(() => void compile(), settings.liveDelay);
  }
}

const editorExtensions = createExtensions({ onChange: onDocChange }, settings);

// Decoración temporal para resaltar la línea destino de SyncTeX o de un error.
const flashEffect = StateEffect.define<number | null>();
const flashField = StateField.define({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(flashEffect)) {
        deco = e.value === null ? Decoration.none : Decoration.set([Decoration.line({ class: "cm-flash" }).range(e.value)]);
      }
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

const view = new EditorView({ parent: $("editor"), state: EditorState.create({ doc: "", extensions: [...editorExtensions, flashField] }) });

const pdf = new PdfViewer($("pdf"));
pdf.onStatus = (page, total, pct) => {
  $("page-info").textContent = `${page} / ${total}`;
  $("zoom-info").textContent = `${pct}%`;
};
pdf.onInverseSync = async (page, x, y) => {
  if (!S.root || !S.main) return;
  const res = await api.syncInverse(S.root, S.main, page, x, y).catch(() => null);
  if (!res) return toast("SyncTeX no encontró esa posición");
  const file =
    S.flatFiles.find((f) => f === res.file) ??
    S.flatFiles.find((f) => res.file.endsWith("/" + relative(S.root!, f)));
  if (!file) return toast(`Archivo fuera del proyecto: ${basename(res.file)}`);
  await openFile(file);
  goToLine(res.line);
};

function newState(doc: string) {
  return EditorState.create({ doc, extensions: [...editorExtensions, flashField] });
}

function goToLine(line: number, flash = true) {
  const doc = view.state.doc;
  const l = doc.line(Math.max(1, Math.min(line, doc.lines)));
  view.dispatch({
    selection: EditorSelection.cursor(l.from),
    effects: [EditorView.scrollIntoView(l.from, { y: "center" }), ...(flash ? [flashEffect.of(l.from)] : [])],
  });
  view.focus();
  if (flash) setTimeout(() => view.dispatch({ effects: flashEffect.of(null) }), 1700);
}

function diagnosticsFor(path: string, state: EditorState): Diagnostic[] {
  const doc = state.doc;
  return S.entries
    .filter((e) => e.file === path && e.line)
    .map((e) => {
      const l = doc.line(Math.min(e.line!, doc.lines));
      return {
        from: l.from,
        to: l.to,
        severity: e.level === "error" ? "error" : e.level === "warning" ? "warning" : "info",
        message: e.message,
        source: "LaTeX",
      } satisfies Diagnostic;
    });
}

function applyDiagnostics() {
  if (!S.current || !S.open.has(S.current)) return;
  view.dispatch(setDiagnostics(view.state, diagnosticsFor(S.current, view.state)));
}

// ---------------------------------------------------------------------------
// Archivos
// ---------------------------------------------------------------------------

function isDirty(path: string) {
  const f = S.open.get(path);
  return !!f && f.state.doc.toString() !== f.saved;
}

function anyDirty() {
  return [...S.open.keys()].some(isDirty);
}

function textOf(path: string): string | undefined {
  const f = S.open.get(path);
  if (f) return path === S.current ? view.state.doc.toString() : f.state.doc.toString();
  return S.diskTexts.get(path);
}

async function openFile(path: string) {
  if (S.current === path) return;
  if (S.current && S.open.has(S.current)) S.open.get(S.current)!.state = view.state;

  if (!S.tabs.includes(path)) S.tabs.push(path);
  S.current = path;
  const preview = $("preview");

  if (IMAGE_RE.test(path) || /\.pdf$/i.test(path)) {
    if (S.previewUrl) URL.revokeObjectURL(S.previewUrl);
    preview.innerHTML = "";
    if (IMAGE_RE.test(path)) {
      const bytes = await api.readBinary(path);
      const type = /\.svg$/i.test(path) ? "image/svg+xml" : "image/" + path.split(".").pop()!.toLowerCase().replace("jpg", "jpeg");
      S.previewUrl = URL.createObjectURL(new Blob([bytes as BlobPart], { type }));
      preview.appendChild(el("img", { src: S.previewUrl, alt: basename(path) }));
    } else {
      preview.appendChild(el("p", { className: "muted", textContent: `${basename(path)} — los PDF incluidos se ven en el documento compilado.` }));
    }
    preview.hidden = false;
  } else if (TEXT_RE.test(path) || !/\.[a-z0-9]+$/i.test(basename(path))) {
    let f = S.open.get(path);
    if (!f) {
      const text = await api.readText(path).catch((e) => {
        toast(String(e), "error");
        return null;
      });
      if (text === null) return closeTab(path);
      f = { state: newState(text), saved: text };
      S.open.set(path, f);
    }
    preview.hidden = true;
    view.setState(f.state);
    applyDiagnostics();
    view.focus();
  } else {
    preview.innerHTML = "";
    preview.appendChild(el("p", { className: "muted", textContent: "Este tipo de archivo no se puede editar aquí." }));
    preview.hidden = false;
  }
  renderTabs();
  renderTree();
  saveProjectPrefs();
}

function closeTab(path: string) {
  const doClose = () => {
    const idx = S.tabs.indexOf(path);
    if (idx < 0) return;
    S.tabs.splice(idx, 1);
    if (!isDirty(path)) S.open.delete(path);
    if (S.current === path) {
      S.current = null;
      const next = S.tabs[idx] ?? S.tabs[idx - 1];
      if (next) void openFile(next);
      else {
        view.setState(newState(""));
        $("preview").hidden = true;
      }
    }
    renderTabs();
    renderTree();
    saveProjectPrefs();
  };
  if (isDirty(path)) {
    void confirm("Cambios sin guardar", `${basename(path)} tiene cambios sin guardar. ¿Guardarlos antes de cerrar?`, "Guardar").then(async (ok) => {
      if (ok) await saveFile(path);
      else {
        const f = S.open.get(path)!;
        f.state = newState(f.saved);
      }
      doClose();
    });
  } else doClose();
}

async function saveFile(path: string) {
  const f = S.open.get(path);
  if (!f) return;
  if (path === S.current) f.state = view.state;
  const content = f.state.doc.toString();
  if (content === f.saved) return;
  await api.writeText(path, content);
  f.saved = content;
  if (INDEXED_RE.test(path)) S.diskTexts.set(path, content);
}

async function saveAll() {
  try {
    await Promise.all([...S.open.keys()].map(saveFile));
  } catch (e) {
    toast(`No se pudo guardar: ${e}`, "error");
    throw e;
  }
  updateDirtyMarks();
}

function updateDirtyMarks() {
  document.querySelectorAll<HTMLElement>(".tab").forEach((t) => t.classList.toggle("dirty", isDirty(t.dataset.path!)));
  document.querySelectorAll<HTMLElement>(".tree-row[data-file]").forEach((r) => {
    const has = isDirty(r.dataset.path!);
    const dot = r.querySelector(".dirty");
    if (has && !dot) r.appendChild(el("span", { className: "dirty" }));
    else if (!has && dot) dot.remove();
  });
}

function flatten(entries: TreeEntry[], out: string[] = []) {
  for (const e of entries) {
    if (e.is_dir) flatten(e.children, out);
    else out.push(e.path);
  }
  return out;
}

async function refreshTree() {
  if (!S.root) return;
  S.tree = await api.listTree(S.root);
  S.flatFiles = flatten(S.tree);
  const mainDir = S.main ? dirname(S.main) : S.root;
  projectIndex.files = S.flatFiles.map((f) => relative(mainDir, f));
  renderTree();
  renderMainSelect();
}

async function loadProjectTexts() {
  S.diskTexts.clear();
  await Promise.all(
    S.flatFiles.filter((f) => INDEXED_RE.test(f)).map(async (f) => S.diskTexts.set(f, await api.readText(f).catch(() => ""))),
  );
}

function rebuildIndex() {
  projectIndex.labels.clear();
  projectIndex.citations.clear();
  projectIndex.macros.clear();
  for (const f of S.flatFiles) {
    if (!INDEXED_RE.test(f)) continue;
    const text = textOf(f) ?? "";
    if (/\.bib$/i.test(f)) indexBibSource(text);
    else indexTexSource(text, relative(S.root!, f));
  }
}

function detectMain(): string | null {
  const texs = S.flatFiles.filter((f) => /\.tex$/i.test(f));
  const withClass = texs.filter((f) => /^[^%\n]*\\documentclass/m.test(S.diskTexts.get(f) ?? ""));
  const pick = (list: string[]) =>
    list.find((f) => basename(f) === "main.tex" && dirname(f) === S.root) ??
    list.find((f) => dirname(f) === S.root) ??
    list[0];
  return pick(withClass) ?? pick(texs) ?? null;
}

// ---------------------------------------------------------------------------
// Proyectos
// ---------------------------------------------------------------------------

interface Recent {
  path: string;
  name: string;
  at: number;
}

function recents(): Recent[] {
  try {
    return JSON.parse(localStorage.getItem("recents") ?? "[]");
  } catch {
    return [];
  }
}

function pushRecent(path: string) {
  const list = recents().filter((r) => r.path !== path);
  list.unshift({ path, name: basename(path), at: Date.now() });
  store("recents", list.slice(0, 15));
}

async function openProject(root: string) {
  if (!(await api.exists(root))) {
    toast("La carpeta ya no existe", "error");
    store("recents", recents().filter((r) => r.path !== root));
    renderRecents();
    return;
  }
  S.root = root;
  S.open.clear();
  S.tabs = [];
  S.current = null;
  S.entries = [];
  S.lastResult = null;
  S.collapsed.clear();
  S.selectedDir = null;
  pdf.clear();
  $("pdf-empty").hidden = false;
  setStatus("idle");

  await refreshTree();
  await loadProjectTexts();
  const prefs = load<ProjectPrefs>(prefsKey(), {});
  S.main = prefs.main && S.flatFiles.includes(prefs.main) ? prefs.main : detectMain();
  S.engine = prefs.engine ?? guessEngine();
  (document.getElementById("engine-select") as HTMLSelectElement).value = S.engine;
  await refreshTree();
  rebuildIndex();

  pushRecent(root);
  $("project-name").textContent = basename(root);
  $("project-name").title = root;
  getCurrentWindow().setTitle(`${basename(root)} — LocalTeX`).catch(() => {});
  $("welcome").hidden = true;
  $("app").hidden = false;

  const tabs = (prefs.tabs ?? []).filter((t) => S.flatFiles.includes(t));
  for (const t of tabs) S.tabs.push(t);
  const first = prefs.current && S.flatFiles.includes(prefs.current) ? prefs.current : S.main;
  if (first) await openFile(first);
  renderTabs();
  renderOutline();
  renderLogs();

  // Si ya existe un PDF de una sesión anterior, compilar lo actualiza rápido (latexmk es incremental).
  if (S.main) void compile();
}

function guessEngine(): Engine {
  const text = S.main ? (S.diskTexts.get(S.main) ?? "") : "";
  if (/\\usepackage(\[[^\]]*\])?\{(fontspec|unicode-math|polyglossia)\}/.test(text)) return "xelatex";
  if (/\\usepackage(\[[^\]]*\])?\{luacode\}|\\directlua/.test(text)) return "lualatex";
  return "pdflatex";
}

async function chooseFolder() {
  const dir = await openDialog({ directory: true, title: "Abrir carpeta de proyecto" });
  if (typeof dir === "string") await openProject(dir);
}

async function goHome() {
  if (anyDirty() && !(await confirm("Cambios sin guardar", "Hay archivos sin guardar. ¿Guardar antes de salir?", "Guardar"))) {
    // El usuario prefirió no guardar: seguimos igual.
  } else await saveAll().catch(() => {});
  S.root = null;
  $("app").hidden = true;
  $("welcome").hidden = false;
  getCurrentWindow().setTitle("LocalTeX").catch(() => {});
  renderRecents();
}

async function newProjectDialog() {
  const defaultParent = localStorage.getItem("lastParent") ?? (await documentDir().catch(() => homeDir()));
  let selected = TEMPLATES[0].id;
  const name = el("input", { type: "text", value: "nuevo-proyecto", spellcheck: false });
  const parent = el("input", { type: "text", value: defaultParent, spellcheck: false });
  const browse = el("button", { className: "btn", textContent: "Elegir…" });
  browse.onclick = async () => {
    const d = await openDialog({ directory: true, defaultPath: parent.value });
    if (typeof d === "string") parent.value = d;
  };
  const grid = el("div", { className: "templates" });
  for (const t of TEMPLATES) {
    const card = el("div", { className: "template" + (t.id === selected ? " selected" : "") }, el("b", { textContent: t.name }), el("span", { textContent: t.description }));
    card.onclick = () => {
      selected = t.id;
      grid.querySelectorAll(".template").forEach((c) => c.classList.remove("selected"));
      card.classList.add("selected");
    };
    grid.appendChild(card);
  }
  modal({
    title: "Nuevo proyecto",
    body: el(
      "div",
      {},
      el("label", { className: "block", textContent: "Nombre" }),
      name,
      el("label", { className: "block", textContent: "Ubicación" }),
      el("div", { className: "path-row" }, parent, browse),
      el("label", { className: "block", textContent: "Plantilla" }),
      grid,
    ),
    actions: [
      { label: "Cancelar" },
      {
        label: "Crear proyecto",
        kind: "primary",
        run: async () => {
          const n = name.value.trim().replace(/[\/\\]/g, "-");
          if (!n || !parent.value.trim()) return false;
          const root = join(parent.value.trim(), n);
          if (await api.exists(root)) {
            toast("Ya existe una carpeta con ese nombre", "error");
            return false;
          }
          const tpl = TEMPLATES.find((t) => t.id === selected)!;
          await api.createDir(root);
          for (const [rel, content] of Object.entries(tpl.files)) {
            if (rel.endsWith("/.keep")) await api.createDir(join(root, dirname(rel)));
            else await api.writeText(join(root, rel), content);
          }
          localStorage.setItem("lastParent", parent.value.trim());
          void openProject(root);
        },
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Compilación
// ---------------------------------------------------------------------------

function setStatus(kind: "idle" | "compiling" | "done" | "fail", text = "") {
  const st = $("status");
  const btn = $("btn-compile");
  st.className = "status";
  btn.classList.toggle("compiling", kind === "compiling");
  btn.innerHTML = kind === "compiling" ? `${icon("refresh", 15)} Compilando` : `${icon("play", 14)} Compilar`;
  if (kind === "idle") st.textContent = "";
  else if (kind === "compiling") st.textContent = "";
  else {
    const errors = S.entries.filter((e) => e.level === "error").length;
    const warns = S.entries.filter((e) => e.level === "warning").length;
    if (kind === "fail" || errors) {
      st.classList.add("err");
      st.innerHTML = `${icon("alert", 14)} ${text || `${errors} error${errors === 1 ? "" : "es"}`}`;
    } else if (warns) {
      st.classList.add("warn");
      st.innerHTML = `${icon("check", 14)} ${text} · ${warns} aviso${warns === 1 ? "" : "s"}`;
    } else {
      st.classList.add("ok");
      st.innerHTML = `${icon("check", 14)} ${text}`;
    }
  }
}

async function compile() {
  clearTimeout(liveTimer);
  if (!S.root || !S.main) {
    if (S.root) toast("Elige un archivo principal (.tex) para compilar");
    return;
  }
  if (S.compiling) {
    S.pending = true;
    return;
  }
  S.compiling = true;
  setStatus("compiling");
  try {
    await saveAll();
    const main = S.main;
    const res = await api.compile(S.root, main, S.engine);
    if (S.root === null || main !== S.main) return;
    S.lastResult = res;
    if (res.cancelled) {
      S.entries = [];
      setStatus("fail", "Detenida");
      return;
    }
    S.entries = [...parseLog(res.log, main), ...parseToolOutput(res.output)];
    if (res.pdfPath && (res.pdfUpdated || !pdf.hasDocument)) {
      const bytes = await api.readBinary(res.pdfPath);
      await pdf.load(bytes);
      $("pdf-empty").hidden = true;
    }
    if (!res.pdfPath && !res.log) {
      S.entries.unshift({ level: "error", message: "latexmk no produjo salida. Revisa el log completo.", context: res.output.slice(-2000) });
    }
    setStatus("done", `${(res.durationMs / 1000).toFixed(1)} s`);
    applyDiagnostics();
    renderLogs();
    updateLogsBadge();
  } catch (e) {
    S.entries = [{ level: "error", message: String(e), context: "" }];
    setStatus("fail", "Falló");
    renderLogs();
    updateLogsBadge();
  } finally {
    S.compiling = false;
    if (S.pending) {
      S.pending = false;
      void compile();
    }
  }
}

async function syncForward() {
  if (!S.root || !S.main || !S.current || !S.open.has(S.current)) return;
  if (!pdf.hasDocument) return toast("Compila primero");
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const box = await api.syncForward(S.root, S.main, S.current, line.number, pos - line.from + 1).catch(() => null);
  if (box) pdf.highlight(box);
  else toast("SyncTeX no encontró esta línea en el PDF");
}

function updateLogsBadge() {
  const btn = $("btn-logs");
  btn.querySelector(".badge")?.remove();
  const errors = S.entries.filter((e) => e.level === "error").length;
  const warns = S.entries.filter((e) => e.level === "warning").length;
  if (errors) btn.appendChild(el("span", { className: "badge", textContent: String(errors) }));
  else if (warns) btn.appendChild(el("span", { className: "badge warn", textContent: String(warns) }));
}

function toggleLogs(show = !S.logsVisible) {
  S.logsVisible = show;
  $("logs").hidden = !show;
  $("btn-logs").classList.toggle("active", show);
  if (show) renderLogs();
}

function renderLogs() {
  const box = $("logs");
  if (!S.logsVisible) return;
  box.innerHTML = "";
  const counts = (lvl: string) => S.entries.filter((e) => e.level === lvl).length;
  const head = el("div", { className: "logs-head" });
  head.append(
    el("span", { className: "title", textContent: `Errores (${counts("error")}) · Avisos (${counts("warning")}) · Cajas (${counts("typesetting")})` }),
  );
  const raw = el("button", { className: "btn", textContent: "Log completo" });
  raw.onclick = showRawLog;
  const closeBtn = el("button", { className: "icon-btn" });
  closeBtn.innerHTML = icon("x");
  closeBtn.title = "Volver al PDF";
  closeBtn.onclick = () => toggleLogs(false);
  head.append(raw, closeBtn);
  box.appendChild(head);

  if (!S.lastResult) {
    box.appendChild(el("div", { className: "log-empty muted", textContent: "Aún no se ha compilado." }));
    return;
  }
  if (!S.entries.length) {
    box.appendChild(el("div", { className: "log-empty", textContent: "Sin errores ni avisos ✓" }));
    return;
  }
  for (const e of S.entries) {
    const item = el("div", { className: `log-entry ${e.level}` });
    const h = el("div", { className: "head" });
    h.append(el("span", { className: "msg", textContent: e.message }));
    if (e.file) h.append(el("span", { className: "loc", textContent: `${relative(S.root!, e.file)}${e.line ? ":" + e.line : ""}` }));
    h.onclick = async () => {
      if (e.file && S.flatFiles.includes(e.file)) {
        await openFile(e.file);
        if (e.line) goToLine(e.line);
      }
    };
    item.append(h);
    if (e.context.trim()) item.append(el("pre", { textContent: e.context }));
    box.appendChild(item);
  }
}

function showRawLog() {
  const r = S.lastResult;
  const pre = el("pre", { className: "raw-log", textContent: r ? `${r.log}\n\n──── salida de latexmk ────\n${r.output}` : "Sin log." });
  modal({ title: "Log completo", body: pre, wide: true });
  requestAnimationFrame(() => (pre.scrollTop = pre.scrollHeight));
}

// ---------------------------------------------------------------------------
// Render de la interfaz
// ---------------------------------------------------------------------------

function renderTabs() {
  const box = $("tabs");
  box.innerHTML = "";
  for (const p of S.tabs) {
    const t = el("div", { className: "tab" + (p === S.current ? " active" : "") + (isDirty(p) ? " dirty" : "") });
    t.dataset.path = p;
    t.title = relative(S.root ?? "", p);
    t.innerHTML = `${fileIcon(p)}<span>${escapeHtml(basename(p))}</span>`;
    const close = el("span", { className: "close", title: "Cerrar" });
    close.innerHTML = icon("x", 13);
    close.onclick = (e) => {
      e.stopPropagation();
      closeTab(p);
    };
    t.appendChild(close);
    t.onclick = () => void openFile(p);
    t.onauxclick = (e) => e.button === 1 && closeTab(p);
    box.appendChild(t);
  }
  box.querySelector(".tab.active")?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function renderTree() {
  const box = $("tree");
  const scroll = box.scrollTop;
  box.innerHTML = "";
  const build = (entries: TreeEntry[], depth: number): HTMLUListElement => {
    const ul = el("ul");
    for (const e of entries) {
      const li = el("li");
      const row = el("div", { className: "tree-row" });
      row.dataset.path = e.path;
      row.style.paddingLeft = `${6 + depth * 14}px`;
      if (e.is_dir) {
        const open = !S.collapsed.has(e.path);
        row.dataset.dir = "1";
        row.innerHTML = `<span class="chev">${icon(open ? "chevronDown" : "chevronRight", 13)}</span><span class="ficon">${icon("folder", 15)}</span><span class="name">${escapeHtml(e.name)}</span>`;
        row.onclick = () => {
          S.selectedDir = e.path;
          if (open) S.collapsed.add(e.path);
          else S.collapsed.delete(e.path);
          renderTree();
        };
        li.appendChild(row);
        if (open) li.appendChild(build(e.children, depth + 1));
      } else {
        row.dataset.file = "1";
        if (e.path === S.current) row.classList.add("active");
        row.innerHTML = `<span class="chev"></span><span class="ficon">${fileIcon(e.name)}</span><span class="name">${escapeHtml(e.name)}</span>`;
        if (e.path === S.main) row.appendChild(el("span", { className: "tag", textContent: "MAIN", title: "Archivo principal" }));
        if (isDirty(e.path)) row.appendChild(el("span", { className: "dirty" }));
        row.onclick = () => {
          S.selectedDir = dirname(e.path);
          void openFile(e.path);
        };
      }
      row.oncontextmenu = (ev) => {
        ev.preventDefault();
        treeMenu(e, ev.clientX, ev.clientY);
      };
      if (!e.is_dir) li.appendChild(row);
      ul.appendChild(li);
    }
    return ul;
  };
  box.appendChild(build(S.tree, 0));
  box.scrollTop = scroll;
}

function treeMenu(e: TreeEntry | null, x: number, y: number) {
  const dir = e ? (e.is_dir ? e.path : dirname(e.path)) : S.root!;
  const items: MenuItem[] = [
    { label: "Nuevo archivo", icon: "filePlus", run: () => void newFile(dir) },
    { label: "Nueva carpeta", icon: "folderPlus", run: () => void newFolder(dir) },
    { label: "Importar archivos…", icon: "upload", run: () => void importFiles(dir) },
  ];
  if (e) {
    items.push({ separator: true });
    if (!e.is_dir && /\.tex$/i.test(e.path) && e.path !== S.main) {
      items.push({ label: "Usar como archivo principal", icon: "star", run: () => setMain(e.path) });
    }
    items.push(
      { label: "Renombrar", icon: "pencil", hint: "F2", run: () => void renamePath(e.path) },
      { label: "Eliminar", icon: "trash", danger: true, run: () => void deletePath(e.path) },
    );
  }
  showMenu(items, x, y);
}

function renderMainSelect() {
  const sel = $("main-select") as HTMLSelectElement;
  sel.innerHTML = "";
  const texs = S.flatFiles.filter((f) => /\.tex$/i.test(f));
  if (!texs.length) sel.appendChild(el("option", { textContent: "(sin .tex)", value: "" }));
  for (const f of texs) sel.appendChild(el("option", { value: f, textContent: relative(S.root!, f), selected: f === S.main }));
}

function setMain(path: string) {
  S.main = path;
  S.entries = [];
  saveProjectPrefs();
  renderTree();
  renderMainSelect();
  renderOutline();
  pdf.clear();
  $("pdf-empty").hidden = false;
  void compile();
}

function renderOutline() {
  const box = $("outline");
  box.innerHTML = "";
  if (!S.main) return;
  const items = buildOutline(S.main, textOf);
  const minLevel = Math.min(...items.map((i) => i.level));
  for (const it of items) {
    const row = el("div", { className: `outline-item l${it.level}`, textContent: it.title || "(sin título)" });
    row.style.paddingLeft = `${8 + (it.level - minLevel) * 12}px`;
    row.title = `${relative(S.root!, it.file)}:${it.line}`;
    row.onclick = async () => {
      await openFile(it.file);
      goToLine(it.line);
    };
    box.appendChild(row);
  }
}

function renderRecents() {
  const ul = $("recent-list");
  ul.innerHTML = "";
  for (const r of recents()) {
    const li = el("li");
    li.innerHTML = `<span class="ficon">${icon("folder", 18)}</span><div class="r-text"><div class="r-name">${escapeHtml(r.name)}</div><div class="r-path">${escapeHtml(r.path)}</div></div>`;
    const rm = el("button", { className: "icon-btn sm", title: "Quitar de recientes" });
    rm.innerHTML = icon("x", 14);
    rm.onclick = (e) => {
      e.stopPropagation();
      store("recents", recents().filter((x) => x.path !== r.path));
      renderRecents();
    };
    li.appendChild(rm);
    li.onclick = () => void openProject(r.path);
    ul.appendChild(li);
  }
}

function renderMode() {
  document.querySelectorAll<HTMLButtonElement>("#mode-toggle button").forEach((b) => {
    b.setAttribute("aria-checked", String(b.dataset.mode === settings.mode));
  });
}

// ---------------------------------------------------------------------------
// Operaciones sobre archivos
// ---------------------------------------------------------------------------

function targetDir() {
  return S.selectedDir ?? (S.current ? dirname(S.current) : S.root!);
}

async function newFile(dir = targetDir()) {
  const name = await prompt("Nuevo archivo", `En ${relative(S.root!, dir) || "/"}`, "nuevo.tex", "Crear");
  if (!name) return;
  const path = join(dir, name);
  if (await api.exists(path)) return toast("Ese archivo ya existe", "error");
  await api.writeText(path, "");
  S.diskTexts.set(path, "");
  await refreshTree();
  await openFile(path);
}

async function newFolder(dir = targetDir()) {
  const name = await prompt("Nueva carpeta", `En ${relative(S.root!, dir) || "/"}`, "carpeta", "Crear");
  if (!name) return;
  await api.createDir(join(dir, name));
  await refreshTree();
}

function remap(oldPath: string, newPath: string) {
  const fix = (p: string) => (p === oldPath || p.startsWith(oldPath + "/") ? newPath + p.slice(oldPath.length) : p);
  S.open = new Map([...S.open].map(([k, v]) => [fix(k), v]));
  S.diskTexts = new Map([...S.diskTexts].map(([k, v]) => [fix(k), v]));
  S.tabs = S.tabs.map(fix);
  if (S.current) S.current = fix(S.current);
  if (S.main) S.main = fix(S.main);
}

async function renamePath(path: string) {
  const name = await prompt("Renombrar", "Nuevo nombre", basename(path), "Renombrar");
  if (!name || name === basename(path)) return;
  const to = join(dirname(path), name);
  try {
    await saveAll();
    await api.rename(path, to);
  } catch (e) {
    return toast(String(e), "error");
  }
  remap(path, to);
  saveProjectPrefs();
  await refreshTree();
  renderTabs();
}

async function deletePath(path: string) {
  if (!(await confirm("Eliminar", `¿Eliminar «${relative(S.root!, path)}»? No se puede deshacer.`, "Eliminar", true))) return;
  try {
    await api.remove(path);
  } catch (e) {
    return toast(String(e), "error");
  }
  for (const t of [...S.tabs]) {
    if (t === path || t.startsWith(path + "/")) {
      S.open.delete(t);
      closeTab(t);
    }
  }
  for (const k of [...S.diskTexts.keys()]) if (k === path || k.startsWith(path + "/")) S.diskTexts.delete(k);
  if (S.main && (S.main === path || S.main.startsWith(path + "/"))) S.main = null;
  await refreshTree();
  if (!S.main) {
    S.main = detectMain();
    renderMainSelect();
  }
  saveProjectPrefs();
}

async function copyInto(paths: string[], dir: string) {
  for (const p of paths) {
    let dest = join(dir, basename(p));
    if (dest === p) continue;
    if (await api.exists(dest)) {
      const dot = basename(p).lastIndexOf(".");
      const stem = dot > 0 ? basename(p).slice(0, dot) : basename(p);
      const ext = dot > 0 ? basename(p).slice(dot) : "";
      let i = 1;
      while (await api.exists((dest = join(dir, `${stem}-${i}${ext}`)))) i++;
    }
    await api.copy(p, dest).catch((e) => toast(String(e), "error"));
  }
  await refreshTree();
  await loadProjectTexts();
  rebuildIndex();
  toast(`${paths.length} archivo${paths.length === 1 ? "" : "s"} importado${paths.length === 1 ? "" : "s"}`);
}

async function importFiles(dir = targetDir()) {
  const files = await openDialog({ multiple: true, title: "Importar archivos al proyecto" });
  if (!files) return;
  await copyInto(Array.isArray(files) ? files : [files], dir);
}

async function exportPdf() {
  const src = S.lastResult?.pdfPath;
  if (!src) return toast("Compila primero para tener un PDF");
  const stem = S.main ? basename(S.main).replace(/\.tex$/i, "") : "documento";
  const dest = await saveDialog({ defaultPath: join(S.root!, `${stem}.pdf`), filters: [{ name: "PDF", extensions: ["pdf"] }] });
  if (!dest) return;
  await api.copy(src, dest);
  toast(`PDF guardado en ${dest}`);
}

async function wordCount() {
  if (!S.main) return;
  await saveAll();
  const out = await api.wordCount(S.main).catch((e) => String(e));
  modal({ title: "Conteo de palabras (texcount)", body: el("pre", { className: "raw-log", textContent: out }) });
}

/** Recarga archivos modificados fuera de la app (git, otro editor…). */
async function checkExternalChanges() {
  if (!S.root) return;
  const before = S.flatFiles.join("\n");
  await refreshTree();
  for (const [path, f] of S.open) {
    const disk = await api.readText(path).catch(() => null);
    if (disk === null || disk === f.saved) continue;
    if (isDirty(path)) continue; // no pisamos cambios locales sin guardar
    f.saved = disk;
    f.state = newState(disk);
    if (path === S.current) {
      const sel = Math.min(view.state.selection.main.head, disk.length);
      const scroll = view.scrollDOM.scrollTop;
      view.setState(f.state);
      view.dispatch({ selection: EditorSelection.cursor(sel) });
      view.scrollDOM.scrollTop = scroll;
      applyDiagnostics();
    }
  }
  if (before !== S.flatFiles.join("\n")) await loadProjectTexts();
  rebuildIndex();
  renderOutline();
}

// ---------------------------------------------------------------------------
// Ajustes y ayuda
// ---------------------------------------------------------------------------

function applyTheme() {
  const dark = settings.theme === "dark" || (settings.theme === "system" && matchMedia("(prefers-color-scheme: dark)").matches);
  document.documentElement.dataset.theme = dark ? "dark" : "light";
}

function saveSettings() {
  store("settings", settings);
}

function settingsDialog() {
  const row = (title: string, desc: string, control: HTMLElement) =>
    el("div", { className: "setting-row" }, el("div", {}, el("div", { textContent: title }), el("small", { textContent: desc })), control);

  const theme = el("select");
  for (const [v, l] of [["system", "Sistema"], ["light", "Claro"], ["dark", "Oscuro"]]) theme.appendChild(el("option", { value: v, textContent: l, selected: settings.theme === v }));
  theme.onchange = () => {
    settings.theme = theme.value as Settings["theme"];
    applyTheme();
    saveSettings();
  };

  const font = el("input", { type: "number", min: "10", max: "28", value: String(settings.fontSize) });
  font.oninput = () => {
    settings.fontSize = Math.min(28, Math.max(10, Number(font.value) || 14));
    view.dispatch({ effects: fontCompartment.reconfigure(fontTheme(settings.fontSize)) });
    saveSettings();
  };

  const wrap = el("input", { type: "checkbox", checked: settings.wrap });
  wrap.onchange = () => {
    settings.wrap = wrap.checked;
    view.dispatch({ effects: wrapCompartment.reconfigure(settings.wrap ? EditorView.lineWrapping : []) });
    saveSettings();
  };

  const spell = el("input", { type: "checkbox", checked: settings.spell });
  spell.onchange = () => {
    settings.spell = spell.checked;
    view.dispatch({ effects: spellCompartment.reconfigure(spellcheck(settings.spell)) });
    saveSettings();
  };

  const delay = el("input", { type: "number", min: "150", max: "5000", step: "50", value: String(settings.liveDelay) });
  delay.oninput = () => {
    settings.liveDelay = Math.min(5000, Math.max(150, Number(delay.value) || 700));
    saveSettings();
  };

  const clean = el("button", { className: "btn", textContent: "Limpiar" });
  clean.onclick = () => void cleanAndCompile();

  modal({
    title: "Ajustes",
    body: el(
      "div",
      {},
      row("Tema", "Apariencia de la aplicación", theme),
      row("Tamaño de fuente", "Del editor, en píxeles", font),
      row("Ajuste de línea", "Partir líneas largas en el editor", wrap),
      row("Corrector ortográfico", "Usa el diccionario del sistema", spell),
      row("Retardo en modo Auto", "Milisegundos sin escribir antes de recompilar", delay),
      row("Archivos auxiliares", "Borra .aux, .bbl, etc. y recompila desde cero", clean),
    ),
    actions: [
      { label: "Atajos de teclado", run: () => void setTimeout(shortcutsDialog) },
      { label: "Cerrar", kind: "primary" },
    ],
  });
}

function shortcutsDialog() {
  const list: [string, string][] = [
    ["Ctrl+S", "Guardar (y compilar en modo Manual)"],
    ["Ctrl+Enter", "Compilar"],
    ["Ctrl+J", "Ir del código al PDF (SyncTeX)"],
    ["Doble clic en PDF", "Ir del PDF al código"],
    ["Ctrl+P", "Abrir archivo rápido"],
    ["Ctrl+O", "Abrir carpeta"],
    ["Ctrl+B / Ctrl+I / Ctrl+U", "Negrita / cursiva / subrayado"],
    ["Ctrl+/", "Comentar / descomentar"],
    ["Ctrl+F / Ctrl+H", "Buscar / reemplazar"],
    ["Ctrl+Espacio", "Autocompletar"],
    ["Ctrl+rueda (PDF)", "Zoom"],
    ["F2", "Renombrar archivo actual"],
  ];
  const grid = el("div", { className: "shortcuts" });
  for (const [k, d] of list) grid.append(el("span", {}, ...k.split(" / ").flatMap((x, i) => (i ? [" / ", el("kbd", { textContent: x })] : [el("kbd", { textContent: x })]))), el("span", { textContent: d }));
  modal({ title: "Atajos de teclado", body: grid });
}

function quickOpen() {
  if (!S.root) return;
  const input = el("input", { type: "text", placeholder: "Nombre de archivo…", spellcheck: false });
  const list = el("div", { className: "quick-list" });
  let sel = 0;
  let matches: string[] = [];
  const score = (f: string, q: string) => {
    const rel = relative(S.root!, f).toLowerCase();
    let i = 0;
    for (const ch of q) {
      i = rel.indexOf(ch, i);
      if (i < 0) return -1;
      i++;
    }
    return basename(rel).includes(q) ? 2 : 1;
  };
  const render = () => {
    const q = input.value.toLowerCase().replace(/\s/g, "");
    matches = S.flatFiles
      .map((f) => [f, score(f, q)] as const)
      .filter(([, s]) => s >= 0)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 40)
      .map(([f]) => f);
    sel = Math.min(sel, Math.max(0, matches.length - 1));
    list.innerHTML = "";
    matches.forEach((f, i) => {
      const it = el("div", { className: "quick-item" + (i === sel ? " sel" : "") });
      it.innerHTML = `${fileIcon(f)}<span>${escapeHtml(relative(S.root!, f))}</span>`;
      it.onclick = () => {
        m.close();
        void openFile(f);
      };
      list.appendChild(it);
    });
  };
  input.oninput = () => {
    sel = 0;
    render();
  };
  input.onkeydown = (e) => {
    if (e.key === "ArrowDown") sel = Math.min(sel + 1, matches.length - 1);
    else if (e.key === "ArrowUp") sel = Math.max(sel - 1, 0);
    else if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      if (matches[sel]) {
        m.close();
        void openFile(matches[sel]);
      }
      return;
    } else return;
    e.preventDefault();
    render();
    list.querySelector(".sel")?.scrollIntoView({ block: "nearest" });
  };
  const m = modal({ title: "Abrir archivo", body: el("div", {}, input, list), actions: [] });
  render();
}

async function cleanAndCompile() {
  if (!S.root) return;
  await api.cleanBuild(S.root);
  pdf.clear();
  $("pdf-empty").hidden = false;
  toast("Archivos auxiliares eliminados");
  void compile();
}

// ---------------------------------------------------------------------------
// Redimensionado de paneles
// ---------------------------------------------------------------------------

function setupResizers() {
  const root = document.documentElement;
  const layout = load("layout", { sidebar: 240, pdf: 0, outline: 0 });
  if (layout.sidebar) root.style.setProperty("--sidebar-w", `${layout.sidebar}px`);
  if (layout.pdf) root.style.setProperty("--pdf-w", `${layout.pdf}px`);
  if (layout.outline) root.style.setProperty("--outline-h", `${layout.outline}px`);

  const drag = (handle: HTMLElement, cls: string, onMove: (e: PointerEvent) => void) => {
    handle.addEventListener("pointerdown", (e) => {
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add("dragging");
      document.body.classList.add(cls);
      const move = (ev: PointerEvent) => onMove(ev);
      const up = () => {
        handle.removeEventListener("pointermove", move);
        handle.removeEventListener("pointerup", up);
        handle.classList.remove("dragging");
        document.body.classList.remove(cls);
        store("layout", layout);
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", up);
    });
  };

  drag($("resizer-left"), "resizing", (e) => {
    layout.sidebar = Math.max(160, Math.min(520, e.clientX));
    root.style.setProperty("--sidebar-w", `${layout.sidebar}px`);
  });
  drag($("resizer-right"), "resizing", (e) => {
    const total = $("workspace").getBoundingClientRect().right;
    layout.pdf = Math.max(240, Math.min(window.innerWidth - 420, total - e.clientX));
    root.style.setProperty("--pdf-w", `${layout.pdf}px`);
  });
  drag($("outline-resizer"), "resizing-row", (e) => {
    const sb = $("sidebar").getBoundingClientRect();
    layout.outline = Math.max(40, Math.min(sb.height - 120, sb.bottom - e.clientY));
    root.style.setProperty("--outline-h", `${layout.outline}px`);
  });
}

// ---------------------------------------------------------------------------
// Arranque
// ---------------------------------------------------------------------------

function setIcons() {
  const set = (id: string, html: string) => ($(id).innerHTML = html);
  set("w-open", `${icon("folderOpen")} Abrir carpeta`);
  set("w-new", `${icon("filePlus")} Nuevo proyecto`);
  set("btn-home", icon("home", 18));
  set("btn-compile-menu", icon("chevronDown", 14));
  set("btn-logs", icon("terminal", 18));
  set("btn-words", icon("hash", 18));
  set("btn-export", icon("download", 18));
  set("btn-settings", icon("settings", 18));
  set("btn-new-file", icon("filePlus", 15));
  set("btn-new-folder", icon("folderPlus", 15));
  set("btn-upload", icon("upload", 15));
  set("btn-refresh", icon("refresh", 14));
  set("btn-sync", icon("arrowRight", 15));
  set("btn-zoom-out", icon("minus", 15));
  set("btn-zoom-in", icon("plus", 15));
  set("btn-fit-width", icon("fitWidth", 15));
  set("btn-fit-page", icon("fitPage", 15));
  const [live, manual] = document.querySelectorAll<HTMLButtonElement>("#mode-toggle button");
  live.innerHTML = `${icon("zap", 13)} Auto`;
  live.title = "Recompila mientras escribes";
  manual.innerHTML = `${icon("keyboard", 13)} Ctrl+S`;
  manual.title = "Recompila solo al guardar (Ctrl+S)";
}

function bindEvents() {
  $("w-open").onclick = () => void chooseFolder();
  $("w-new").onclick = () => void newProjectDialog();
  $("btn-home").onclick = () => void goHome();
  $("btn-compile").onclick = () => void compile();
  $("btn-compile-menu").onclick = (e) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
    showMenu(
      [
        { label: "Compilar", icon: "play", hint: "Ctrl+Enter", run: () => void compile() },
        { label: "Recompilar desde cero", icon: "refresh", run: () => void cleanAndCompile() },
        { label: "Detener compilación", icon: "stop", run: () => void api.stopCompile() },
        { separator: true },
        { label: "Ver log completo", icon: "terminal", run: showRawLog },
      ],
      r.left - 150,
      r.bottom + 4,
    );
  };
  $("status").onclick = () => S.entries.length && toggleLogs(true);
  $("btn-logs").onclick = () => toggleLogs();
  $("btn-words").onclick = () => void wordCount();
  $("btn-export").onclick = () => void exportPdf();
  $("btn-settings").onclick = settingsDialog;
  $("btn-new-file").onclick = () => void newFile();
  $("btn-new-folder").onclick = () => void newFolder();
  $("btn-upload").onclick = () => void importFiles();
  $("btn-refresh").onclick = () => void checkExternalChanges();
  $("btn-sync").onclick = () => void syncForward();
  $("btn-zoom-in").onclick = () => pdf.zoomBy(1.15);
  $("btn-zoom-out").onclick = () => pdf.zoomBy(1 / 1.15);
  $("btn-fit-width").onclick = () => pdf.setZoom("fit-width");
  $("btn-fit-page").onclick = () => pdf.setZoom("fit-page");
  $("tree").oncontextmenu = (e) => {
    if ((e.target as HTMLElement).closest(".tree-row")) return;
    e.preventDefault();
    S.selectedDir = S.root;
    treeMenu(null, e.clientX, e.clientY);
  };

  ($("main-select") as HTMLSelectElement).onchange = (e) => {
    const v = (e.target as HTMLSelectElement).value;
    if (v) setMain(v);
  };
  ($("engine-select") as HTMLSelectElement).onchange = (e) => {
    S.engine = (e.target as HTMLSelectElement).value as Engine;
    saveProjectPrefs();
    void compile();
  };
  document.querySelectorAll<HTMLButtonElement>("#mode-toggle button").forEach((b) => {
    b.onclick = () => {
      settings.mode = b.dataset.mode as Mode;
      saveSettings();
      renderMode();
      toast(settings.mode === "live" ? "Modo Auto: el PDF se actualiza mientras escribes" : "Modo Ctrl+S: el PDF se actualiza al guardar");
      if (settings.mode === "live" && anyDirty()) void compile();
    };
  });

  // Atajos globales (fase de captura: funcionan aunque el foco esté en el PDF).
  window.addEventListener(
    "keydown",
    (e) => {
      if ($("modal-root").childElementCount || !S.root) {
        if (e.ctrlKey && e.key.toLowerCase() === "o" && !$("modal-root").childElementCount) {
          e.preventDefault();
          void chooseFolder();
        }
        return;
      }
      const k = e.key.toLowerCase();
      const handled = (fn: () => void) => {
        e.preventDefault();
        e.stopPropagation();
        fn();
      };
      if (e.ctrlKey && !e.altKey && k === "s") {
        handled(() => {
          clearTimeout(liveTimer);
          void saveAll().then(compile);
        });
      } else if (e.ctrlKey && e.key === "Enter") handled(() => void compile());
      else if (e.ctrlKey && k === "j") handled(() => void syncForward());
      else if (e.ctrlKey && k === "p") handled(quickOpen);
      else if (e.ctrlKey && k === "o") handled(() => void chooseFolder());
      else if (e.key === "F2" && S.current) handled(() => void renamePath(S.current!));
    },
    true,
  );

  window.addEventListener("focus", () => void checkExternalChanges());
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

  // Arrastrar archivos desde el sistema al árbol.
  void getCurrentWebview().onDragDropEvent((ev) => {
    const tree = $("tree");
    if (!S.root) return;
    const p = ev.payload;
    const targetAt = (pos: { x: number; y: number }) => {
      const dpr = window.devicePixelRatio || 1;
      const elAt = document.elementFromPoint(pos.x / dpr, pos.y / dpr);
      const row = elAt?.closest<HTMLElement>(".tree-row");
      if (row) return row.dataset.dir ? row.dataset.path! : dirname(row.dataset.path!);
      return elAt?.closest("#sidebar") ? S.root! : null;
    };
    if (p.type === "over") tree.classList.toggle("drop-target", targetAt(p.position) !== null);
    else if (p.type === "leave") tree.classList.remove("drop-target");
    else if (p.type === "drop") {
      tree.classList.remove("drop-target");
      void copyInto(p.paths, targetAt(p.position) ?? S.root);
    }
  });

  void getCurrentWindow().onCloseRequested(async (e) => {
    if (!anyDirty()) return;
    const choice = await new Promise<"save" | "discard" | "cancel">((resolve) => {
      let c: "save" | "discard" | "cancel" = "cancel";
      modal({
        title: "Cambios sin guardar",
        body: el("p", { textContent: "Hay archivos con cambios sin guardar." }),
        actions: [
          { label: "Salir sin guardar", run: () => void (c = "discard") },
          { label: "Cancelar" },
          { label: "Guardar y salir", kind: "primary", run: () => void (c = "save") },
        ],
        onClose: () => resolve(c),
      });
    });
    if (choice === "cancel") e.preventDefault();
    else if (choice === "save") await saveAll().catch(() => e.preventDefault());
  });
}

async function init() {
  applyTheme();
  setIcons();
  renderMode();
  setupResizers();
  bindEvents();
  renderRecents();
  setStatus("idle");

  const tools = await api.checkTools().catch(() => [] as [string, boolean][]);
  const missing = tools.filter(([, ok]) => !ok).map(([t]) => t);
  if (missing.includes("latexmk") || missing.includes("pdflatex")) {
    const w = $("tool-warning");
    w.hidden = false;
    w.textContent = `Faltan herramientas de TeX: ${missing.join(", ")}. Instala TeX Live (p. ej. sudo dnf install texlive-scheme-medium latexmk).`;
  }

  const last = recents()[0];
  if (last && localStorage.getItem("reopenLast") !== "false" && (await api.exists(last.path))) await openProject(last.path);
}

void init();
