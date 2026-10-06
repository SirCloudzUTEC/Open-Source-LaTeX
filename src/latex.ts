import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  snippetCompletion,
} from "@codemirror/autocomplete";

/** Índice del proyecto que alimenta el autocompletado. Lo actualiza main.ts. */
export const projectIndex = {
  labels: new Map<string, string>(), // etiqueta → archivo
  citations: new Map<string, string>(), // clave → título/descr
  files: [] as string[], // rutas relativas al directorio del archivo principal
  macros: new Set<string>(),
};

const CMDS: [string, string?, string?][] = [
  // [comando, snippet (sin la barra), detalle]
  ["section", "section{${1}}", "Sección"],
  ["section*", "section*{${1}}", "Sección sin número"],
  ["subsection", "subsection{${1}}", "Subsección"],
  ["subsubsection", "subsubsection{${1}}", "Subsubsección"],
  ["chapter", "chapter{${1}}", "Capítulo"],
  ["part", "part{${1}}"],
  ["paragraph", "paragraph{${1}}"],
  ["textbf", "textbf{${1}}", "Negrita"],
  ["textit", "textit{${1}}", "Cursiva"],
  ["underline", "underline{${1}}", "Subrayado"],
  ["emph", "emph{${1}}", "Énfasis"],
  ["texttt", "texttt{${1}}", "Monoespaciado"],
  ["textsc", "textsc{${1}}", "Versalitas"],
  ["textrm", "textrm{${1}}"],
  ["textsf", "textsf{${1}}"],
  ["textcolor", "textcolor{${1:red}}{${2}}", "Texto en color"],
  ["href", "href{${1:url}}{${2:texto}}", "Enlace"],
  ["url", "url{${1}}"],
  ["footnote", "footnote{${1}}", "Nota al pie"],
  ["label", "label{${1}}", "Etiqueta"],
  ["ref", "ref{${1}}", "Referencia"],
  ["eqref", "eqref{${1}}", "Referencia a ecuación"],
  ["pageref", "pageref{${1}}"],
  ["autoref", "autoref{${1}}"],
  ["cref", "cref{${1}}"],
  ["cite", "cite{${1}}", "Cita"],
  ["citep", "citep{${1}}"],
  ["citet", "citet{${1}}"],
  ["parencite", "parencite{${1}}"],
  ["textcite", "textcite{${1}}"],
  ["input", "input{${1}}", "Incluir archivo"],
  ["include", "include{${1}}", "Incluir capítulo"],
  ["includegraphics", "includegraphics[width=${1:\\linewidth}]{${2}}", "Imagen"],
  ["caption", "caption{${1}}", "Leyenda"],
  ["centering", undefined],
  ["item", "item ${1}", "Elemento de lista"],
  ["usepackage", "usepackage{${1}}", "Cargar paquete"],
  ["documentclass", "documentclass{${1:article}}"],
  ["title", "title{${1}}"],
  ["author", "author{${1}}"],
  ["date", "date{${1:\\today}}"],
  ["maketitle", undefined],
  ["tableofcontents", undefined, "Índice"],
  ["listoffigures", undefined],
  ["listoftables", undefined],
  ["newpage", undefined],
  ["clearpage", undefined],
  ["noindent", undefined],
  ["vspace", "vspace{${1:1em}}"],
  ["hspace", "hspace{${1:1em}}"],
  ["newcommand", "newcommand{\\${1:nombre}}[${2:1}]{${3}}", "Definir comando"],
  ["renewcommand", "renewcommand{\\${1}}{${2}}"],
  ["bibliography", "bibliography{${1}}"],
  ["bibliographystyle", "bibliographystyle{${1:plain}}"],
  ["addbibresource", "addbibresource{${1}}"],
  ["printbibliography", undefined],
  ["today", undefined],
  ["frac", "frac{${1}}{${2}}", "Fracción"],
  ["dfrac", "dfrac{${1}}{${2}}"],
  ["sqrt", "sqrt{${1}}", "Raíz"],
  ["sum", "sum_{${1:i=1}}^{${2:n}}", "Sumatoria"],
  ["prod", "prod_{${1:i=1}}^{${2:n}}"],
  ["int", "int_{${1:a}}^{${2:b}}", "Integral"],
  ["iint", undefined],
  ["oint", undefined],
  ["lim", "lim_{${1:x \\to \\infty}}", "Límite"],
  ["infty", undefined],
  ["partial", undefined],
  ["nabla", undefined],
  ["cdot", undefined],
  ["cdots", undefined],
  ["ldots", undefined],
  ["times", undefined],
  ["leq", undefined],
  ["geq", undefined],
  ["neq", undefined],
  ["approx", undefined],
  ["equiv", undefined],
  ["in", undefined],
  ["notin", undefined],
  ["subset", undefined],
  ["subseteq", undefined],
  ["cup", undefined],
  ["cap", undefined],
  ["forall", undefined],
  ["exists", undefined],
  ["rightarrow", undefined],
  ["Rightarrow", undefined],
  ["leftrightarrow", undefined],
  ["Leftrightarrow", undefined],
  ["to", undefined],
  ["mapsto", undefined],
  ["mathbb", "mathbb{${1}}", "Pizarra (ℝ, ℕ…)"],
  ["mathcal", "mathcal{${1}}"],
  ["mathbf", "mathbf{${1}}"],
  ["mathrm", "mathrm{${1}}"],
  ["text", "text{${1}}"],
  ["operatorname", "operatorname{${1}}"],
  ["left(", "left( ${1} \\right)", "Paréntesis ajustables"],
  ["left[", "left[ ${1} \\right]"],
  ["left\\{", "left\\\\{ ${1} \\right\\\\}"],
  ["hat", "hat{${1}}"],
  ["bar", "bar{${1}}"],
  ["vec", "vec{${1}}"],
  ["dot", "dot{${1}}"],
  ["tilde", "tilde{${1}}"],
  ["overline", "overline{${1}}"],
  ["underbrace", "underbrace{${1}}_{${2}}"],
  ["binom", "binom{${1}}{${2}}"],
  ["alpha"], ["beta"], ["gamma"], ["Gamma"], ["delta"], ["Delta"], ["epsilon"], ["varepsilon"],
  ["zeta"], ["eta"], ["theta"], ["Theta"], ["iota"], ["kappa"], ["lambda"], ["Lambda"], ["mu"],
  ["nu"], ["xi"], ["Xi"], ["pi"], ["Pi"], ["rho"], ["sigma"], ["Sigma"], ["tau"], ["upsilon"],
  ["phi"], ["varphi"], ["Phi"], ["chi"], ["psi"], ["Psi"], ["omega"], ["Omega"],
  ["hline"], ["toprule"], ["midrule"], ["bottomrule"],
  ["multicolumn", "multicolumn{${1:2}}{${2:c}}{${3}}"],
  ["frametitle", "frametitle{${1}}", "Título de diapositiva"],
  ["pause"],
  ["tikz", "tikz{${1}}"],
  ["draw", "draw ${1} -- ${2};"],
  ["node", "node[${1}] at (${2:0,0}) {${3}};"],
];

const ENVS: [string, string?][] = [
  ["itemize", "\t\\item ${}"],
  ["enumerate", "\t\\item ${}"],
  ["description", "\t\\item[${1}] ${}"],
  ["equation", "\t${}"],
  ["equation*", "\t${}"],
  ["align", "\t${} \\\\"],
  ["align*", "\t${}"],
  ["gather", "\t${}"],
  ["multline", "\t${}"],
  ["cases", "\t${} & \\text{si } \\\\"],
  ["matrix", "\t${}"],
  ["pmatrix", "\t${}"],
  ["bmatrix", "\t${}"],
  ["figure", "\t\\centering\n\t\\includegraphics[width=0.8\\linewidth]{${1}}\n\t\\caption{${2}}\n\t\\label{fig:${3}}"],
  ["table", "\t\\centering\n\t\\begin{tabular}{${1:c c}}\n\t\t${}\n\t\\end{tabular}\n\t\\caption{${2}}\n\t\\label{tab:${3}}"],
  ["tabular", "\t${}"],
  ["center", "\t${}"],
  ["flushleft", "\t${}"],
  ["flushright", "\t${}"],
  ["minipage", "\t${}"],
  ["quote", "\t${}"],
  ["verbatim", "${}"],
  ["lstlisting", "${}"],
  ["minted", "${}"],
  ["abstract", "\t${}"],
  ["proof", "\t${}"],
  ["theorem", "\t${}"],
  ["lemma", "\t${}"],
  ["definition", "\t${}"],
  ["frame", "\t\\frametitle{${1}}\n\t${}"],
  ["columns", "\t\\column{0.5\\textwidth}\n\t${}"],
  ["tikzpicture", "\t${}"],
  ["document", "${}"],
  ["thebibliography", "\t\\bibitem{${1}} ${}"],
];

const FILE_EXTS: Record<string, RegExp> = {
  input: /\.tex$/,
  include: /\.tex$/,
  subfile: /\.tex$/,
  includegraphics: /\.(png|jpe?g|pdf|eps|svg)$/i,
  includepdf: /\.pdf$/i,
  bibliography: /\.bib$/,
  addbibresource: /\.bib$/,
  lstinputlisting: /./,
  inputminted: /./,
};

const commandOptions: Completion[] = CMDS.map(([name, snippet, detail]) =>
  snippet
    ? snippetCompletion("\\" + snippet, { label: "\\" + name, detail, type: "function" })
    : { label: "\\" + name, detail, type: "keyword" },
);

const envNames = ENVS.map(([e]) => e);

export function latexCompletions(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  const after = line.text.slice(ctx.pos - line.from);
  // Si el autocierre ya puso "}", la opción debe reemplazarla.
  const closeLen = after.startsWith("}") ? 1 : 0;

  let m = /\\(?:[a-zA-Z]*ref|[cC]ref|vref)\{([^}]*)$/.exec(before);
  if (m) {
    return {
      from: ctx.pos - m[1].length,
      options: [...projectIndex.labels].map(([label, file]) => ({ label, detail: file, type: "variable" })),
      validFor: /^[^}]*$/,
    };
  }

  m = /\\[a-zA-Z]*cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{(?:[^}]*,\s*)?([^},]*)$/.exec(before);
  if (m) {
    return {
      from: ctx.pos - m[1].length,
      options: [...projectIndex.citations].map(([key, info]) => ({ label: key, detail: info, type: "text" })),
      validFor: /^[^},]*$/,
    };
  }

  m = /\\(input|include|includegraphics|includepdf|subfile|bibliography|addbibresource|lstinputlisting|inputminted)(?:\[[^\]]*\])?(?:\{[^}]*\})?\{([^}]*)$/.exec(before);
  if (m) {
    const cmd = m[1];
    const re = FILE_EXTS[cmd];
    const stripExt = cmd === "input" || cmd === "include" || cmd === "bibliography" || cmd === "subfile";
    return {
      from: ctx.pos - m[2].length,
      options: projectIndex.files
        .filter((f) => re.test(f))
        .map((f) => ({ label: stripExt ? f.replace(/\.(tex|bib)$/, "") : f, type: "file" })),
      validFor: /^[^}]*$/,
    };
  }

  m = /\\(begin|end)\{([a-zA-Z*]*)$/.exec(before);
  if (m) {
    const isBegin = m[1] === "begin";
    const from = ctx.pos - m[2].length;
    return {
      from,
      options: envNames.map((env) => {
        const body = ENVS.find(([e]) => e === env)?.[1] ?? "\t${}";
        if (!isBegin) return { label: env, type: "type" };
        const indent = /^\s*/.exec(line.text)![0];
        const tpl = `${env}}\n${body}\n\\end{${env}}`.replace(/\n/g, "\n" + indent);
        const snip = snippetCompletion(tpl, { label: env, type: "type", detail: "entorno" });
        return {
          ...snip,
          apply: (view, completion, f, t) => (snip.apply as Function)(view, completion, f, t + closeLen),
        } as Completion;
      }),
      validFor: /^[a-zA-Z*]*$/,
    };
  }

  m = /\\([a-zA-Z@]*)$/.exec(before);
  if (m && (m[1].length > 0 || ctx.explicit)) {
    const macros: Completion[] = [...projectIndex.macros].map((name) => ({
      label: "\\" + name,
      detail: "definido en el proyecto",
      type: "function",
    }));
    return {
      from: ctx.pos - m[1].length - 1,
      options: [...commandOptions, ...macros],
      validFor: /^\\[a-zA-Z@]*$/,
    };
  }
  return null;
}

/** Extrae etiquetas, citas de .bib y macros definidas. */
export function indexTexSource(text: string, file: string) {
  for (const m of text.matchAll(/\\label\{([^}]+)\}/g)) projectIndex.labels.set(m[1], file);
  for (const m of text.matchAll(/\\(?:re)?newcommand\*?\{?\\([a-zA-Z@]+)/g)) projectIndex.macros.add(m[1]);
  for (const m of text.matchAll(/\\DeclareMathOperator\*?\{?\\([a-zA-Z]+)/g)) projectIndex.macros.add(m[1]);
  for (const m of text.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^}]+)\}/g)) projectIndex.citations.set(m[1], file);
}

export function indexBibSource(text: string) {
  for (const m of text.matchAll(/@(\w+)\s*\{\s*([^,\s]+)\s*,([\s\S]*?)(?=\n\s*@|\s*$)/g)) {
    if (/^(comment|string|preamble)$/i.test(m[1])) continue;
    const title = /title\s*=\s*[{"]+([^}"]+)/i.exec(m[3])?.[1] ?? m[1];
    projectIndex.citations.set(m[2], title.slice(0, 60));
  }
}

export interface OutlineItem {
  level: number;
  title: string;
  file: string;
  line: number;
}

const SECTION_LEVELS: Record<string, number> = {
  part: 0,
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  frametitle: 4,
};

/**
 * Outline de todo el proyecto siguiendo \input/\include desde el archivo principal.
 * `getText` devuelve el contenido (en memoria si está abierto) de una ruta absoluta.
 */
export function buildOutline(main: string, getText: (path: string) => string | undefined): OutlineItem[] {
  const items: OutlineItem[] = [];
  const visited = new Set<string>();
  const mainDir = main.slice(0, main.lastIndexOf("/"));

  const visit = (file: string) => {
    if (visited.has(file)) return;
    visited.add(file);
    const text = getText(file);
    if (text === undefined) return;
    text.split("\n").forEach((raw, i) => {
      const line = raw.replace(/(^|[^\\])%.*$/, "$1");
      const re = /\\(part|chapter|section|subsection|subsubsection|paragraph|frametitle)\*?(?:\[[^\]]*\])?\{((?:[^{}]|\{[^{}]*\})*)\}|\\(?:input|include|subfile)\{([^}]+)\}/g;
      for (const m of line.matchAll(re)) {
        if (m[1]) {
          items.push({ level: SECTION_LEVELS[m[1]], title: m[2].replace(/\\[a-zA-Z]+\s*/g, "").replace(/[{}]/g, ""), file, line: i + 1 });
        } else if (m[3]) {
          const target = m[3].trim();
          visit(`${mainDir}/${target.endsWith(".tex") ? target : target + ".tex"}`.replace(/\/\.\//g, "/"));
        }
      }
    });
  };
  visit(main);
  return items;
}
