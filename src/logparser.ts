export type LogLevel = "error" | "warning" | "typesetting";

export interface LogEntry {
  level: LogLevel;
  message: string;
  file?: string;
  line?: number;
  context: string;
}

const FILE_LINE_ERROR = /^((?:\.|\/|[A-Za-z]:)[^:]*?\.\w+):(\d+): (.*)$/;
const WARNING = /^(?:LaTeX(?: Font)?|Package (\S+)|Class (\S+)|pdfTeX) [Ww]arning(?: \(\S+\))?: (.*)$/;
const BADBOX = /^((?:Over|Under)full \\[hv]box .*?)(?: in paragraph| in alignment| detected)? at lines? (\d+)/;
const INPUT_LINE = /on input line (\d+)/;
const FILE_TOKEN = /^(?:"([^"]+)"|((?:\.{1,2}\/|\/)[^\s()]*|[^\s()]+\.(?:tex|sty|cls|cfg|def|clo|fd|aux|toc|bbl|ltx|out|lof|lot|nav|snm|vrb|ind|gls|lua|cnf|mkii|dict)))/;

function normalize(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "." || part === "") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return (p.startsWith("/") ? "/" : "") + out.join("/");
}

function resolve(file: string, baseDir: string): string {
  return normalize(file.startsWith("/") ? file : `${baseDir}/${file}`);
}

/**
 * Parser del .log de TeX. Sigue la pila de archivos abiertos (paréntesis)
 * para atribuir warnings al archivo correcto. Asume max_print_line alto
 * (lo fija el backend), así que las rutas no vienen partidas.
 */
export function parseLog(log: string, mainFile: string): LogEntry[] {
  const baseDir = mainFile.slice(0, mainFile.lastIndexOf("/"));
  const lines = log.split("\n");
  const entries: LogEntry[] = [];
  const stack: (string | null)[] = [];
  const seen = new Set<string>();

  const currentFile = () => {
    for (let i = stack.length - 1; i >= 0; i--) {
      const f = stack[i];
      if (f && /\.(tex|ltx|bib)$/.test(f)) return f;
    }
    return mainFile;
  };

  const push = (e: LogEntry) => {
    const key = `${e.level}|${e.file}|${e.line}|${e.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push(e);
  };

  const trackFiles = (line: string) => {
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === "(") {
        const m = FILE_TOKEN.exec(line.slice(i + 1));
        if (m) {
          const f = m[1] ?? m[2];
          stack.push(resolve(f, baseDir));
          i += m[0].length;
        } else {
          stack.push(null);
        }
      } else if (ch === ")") {
        stack.pop();
      }
    }
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    let m = FILE_LINE_ERROR.exec(line);
    if (m) {
      const ctx: string[] = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 12); j++) {
        if (/^\s*$/.test(lines[j]) && ctx.length > 0) break;
        ctx.push(lines[j]);
        if (/^l\.\d+/.test(lines[j])) {
          if (lines[j + 1]?.trim()) ctx.push(lines[j + 1]);
          break;
        }
      }
      push({
        level: "error",
        message: m[3],
        file: resolve(m[1], baseDir),
        line: Number(m[2]),
        context: ctx.join("\n"),
      });
      continue;
    }

    if (line.startsWith("! ")) {
      let lineNo: number | undefined;
      const ctx: string[] = [];
      for (let j = i + 1; j < Math.min(lines.length, i + 15); j++) {
        ctx.push(lines[j]);
        const l = /^l\.(\d+)/.exec(lines[j]);
        if (l) {
          lineNo = Number(l[1]);
          break;
        }
      }
      push({ level: "error", message: line.slice(2), file: currentFile(), line: lineNo, context: ctx.join("\n") });
      continue;
    }

    m = WARNING.exec(line);
    if (m) {
      const pkg = m[1] ?? m[2];
      let msg = m[3];
      // Las líneas de continuación vienen prefijadas con "(paquete)".
      while (i + 1 < lines.length) {
        const next = lines[i + 1];
        const cont = pkg ? new RegExp(`^\\(${pkg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\)\\s*(.*)$`).exec(next) : null;
        if (cont) {
          msg += " " + cont[1];
          i++;
        } else if (!pkg && next.trim() && !/^(\(|\[|<|\)|LaTeX|Package|Overfull|Underfull)/.test(next) && !msg.endsWith(".")) {
          msg += " " + next.trim();
          i++;
        } else break;
      }
      const ln = INPUT_LINE.exec(msg);
      push({
        level: "warning",
        message: (pkg ? `[${pkg}] ` : "") + msg.replace(/\s+/g, " ").trim(),
        file: currentFile(),
        line: ln ? Number(ln[1]) : undefined,
        context: "",
      });
      continue;
    }

    m = BADBOX.exec(line);
    if (m) {
      push({ level: "typesetting", message: m[1], file: currentFile(), line: Number(m[2]), context: "" });
      // La línea siguiente suele contener texto tipografiado con paréntesis: la saltamos.
      i++;
      continue;
    }

    trackFiles(line);
  }

  if (/Emergency stop|Fatal error occurred/.test(log) && !entries.some((e) => e.level === "error")) {
    push({ level: "error", message: "Error fatal: no se generó el PDF", file: mainFile, context: "" });
  }

  const order: Record<LogLevel, number> = { error: 0, warning: 1, typesetting: 2 };
  return entries.sort((a, b) => order[a.level] - order[b.level]);
}

/** Errores de BibTeX/Biber que aparecen en la salida de latexmk, no en el .log. */
export function parseToolOutput(output: string): LogEntry[] {
  const entries: LogEntry[] = [];
  const lines = output.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const bib = /^(?:ERROR|WARN) - (.*)$/.exec(l);
    if (bib) {
      entries.push({ level: l.startsWith("ERROR") ? "error" : "warning", message: `[biber] ${bib[1]}`, context: "" });
      continue;
    }
    if (/^I couldn't open|^I found no|^Database file #\d+|^Warning--/.test(l)) {
      const where = /---line (\d+) of file (.*)$/.exec(lines[i + 1] ?? "");
      entries.push({
        level: l.startsWith("Warning--") ? "warning" : "error",
        message: `[bibtex] ${l.replace(/^Warning--/, "")}`,
        line: where ? Number(where[1]) : undefined,
        context: "",
      });
    }
  }
  return entries;
}
