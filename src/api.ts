import { invoke } from "@tauri-apps/api/core";

export interface TreeEntry {
  name: string;
  path: string;
  is_dir: boolean;
  children: TreeEntry[];
}

export interface CompileResult {
  pdfPath: string | null;
  pdfUpdated: boolean;
  log: string;
  output: string;
  exitCode: number | null;
  durationMs: number;
  cancelled: boolean;
}

export interface SyncBox {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type Engine = "pdflatex" | "xelatex" | "lualatex";

export const api = {
  listTree: (root: string) => invoke<TreeEntry[]>("list_tree", { root }),
  readText: (path: string) => invoke<string>("read_text", { path }),
  writeText: (path: string, content: string) => invoke<void>("write_text", { path, content }),
  readBinary: async (path: string) => new Uint8Array(await invoke<ArrayBuffer>("read_binary", { path })),
  exists: (path: string) => invoke<boolean>("path_exists", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  rename: (from: string, to: string) => invoke<void>("rename_path", { from, to }),
  remove: (path: string) => invoke<void>("delete_path", { path }),
  copy: (from: string, to: string) => invoke<void>("copy_file", { from, to }),
  checkTools: () => invoke<[string, boolean][]>("check_tools"),
  compile: (root: string, main: string, engine: Engine) =>
    invoke<CompileResult>("compile", { root, main, engine }),
  stopCompile: () => invoke<boolean>("stop_compile"),
  cleanBuild: (root: string) => invoke<void>("clean_build", { root }),
  syncForward: (root: string, main: string, file: string, line: number, column: number) =>
    invoke<SyncBox | null>("synctex_forward", { root, main, file, line, column }),
  syncInverse: (root: string, main: string, page: number, x: number, y: number) =>
    invoke<{ file: string; line: number } | null>("synctex_inverse", { root, main, page, x, y }),
  wordCount: (main: string) => invoke<string>("word_count", { main }),
};

export function basename(p: string): string {
  return p.split("/").filter(Boolean).pop() ?? p;
}

export function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i <= 0 ? "/" : p.slice(0, i);
}

export function join(...parts: string[]): string {
  return parts.join("/").replace(/\/+/g, "/");
}

export function relative(root: string, p: string): string {
  return p.startsWith(root + "/") ? p.slice(root.length + 1) : p;
}
