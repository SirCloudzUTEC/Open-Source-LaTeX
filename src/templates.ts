export interface Template {
  id: string;
  name: string;
  description: string;
  files: Record<string, string>;
}

const PREAMBLE_ES = String.raw`\usepackage[utf8]{inputenc}
\usepackage[T1]{fontenc}
\usepackage[spanish,es-noshorthands]{babel}
\usepackage{amsmath, amssymb, amsthm}
\usepackage{graphicx}
\usepackage[margin=2.5cm]{geometry}
\usepackage{hyperref}`;

const BIB = String.raw`@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The TeXbook},
  publisher = {Addison-Wesley},
  year      = {1984}
}

@article{lamport1994,
  author  = {Leslie Lamport},
  title   = {LaTeX: A Document Preparation System},
  journal = {Addison-Wesley},
  year    = {1994}
}
`;

export const TEMPLATES: Template[] = [
  {
    id: "article",
    name: "Artículo",
    description: "Documento con secciones, ecuaciones y bibliografía",
    files: {
      "main.tex": String.raw`\documentclass[11pt,a4paper]{article}
${PREAMBLE_ES}

\title{Título del artículo}
\author{Tu nombre}
\date{\today}

\begin{document}

\maketitle

\begin{abstract}
  Un resumen breve del trabajo.
\end{abstract}

\section{Introducción}\label{sec:intro}
Este es un documento de ejemplo. Puedes citar trabajos~\cite{knuth1984} y
referirte a secciones como la~\ref{sec:resultados}.

\section{Resultados}\label{sec:resultados}
La ecuación~\eqref{eq:euler} es una de las más conocidas:
\begin{equation}
  e^{i\pi} + 1 = 0 \label{eq:euler}
\end{equation}

\bibliographystyle{plain}
\bibliography{referencias}

\end{document}
`,
      "referencias.bib": BIB,
    },
  },
  {
    id: "report",
    name: "Informe / Tesis",
    description: "Capítulos en archivos separados con \\include",
    files: {
      "main.tex": String.raw`\documentclass[12pt,a4paper]{report}
${PREAMBLE_ES}

\title{Título del informe}
\author{Tu nombre}
\date{\today}

\begin{document}

\maketitle
\tableofcontents

\include{capitulos/introduccion}
\include{capitulos/metodologia}

\bibliographystyle{plain}
\bibliography{referencias}

\end{document}
`,
      "capitulos/introduccion.tex": String.raw`\chapter{Introducción}\label{cap:intro}

Texto de la introducción. Ver el capítulo~\ref{cap:metodo}.
`,
      "capitulos/metodologia.tex": String.raw`\chapter{Metodología}\label{cap:metodo}

\section{Datos}
Descripción de los datos~\cite{lamport1994}.
`,
      "referencias.bib": BIB,
      "figuras/.keep": "",
    },
  },
  {
    id: "beamer",
    name: "Presentación (Beamer)",
    description: "Diapositivas con el tema Madrid",
    files: {
      "main.tex": String.raw`\documentclass{beamer}
\usepackage[spanish]{babel}
\usetheme{Madrid}

\title{Título de la presentación}
\author{Tu nombre}
\date{\today}

\begin{document}

\begin{frame}
  \titlepage
\end{frame}

\begin{frame}{Contenido}
  \tableofcontents
\end{frame}

\section{Introducción}
\begin{frame}{Primera diapositiva}
  \begin{itemize}
    \item Un punto
    \item Otro punto \pause
    \item Aparece después
  \end{itemize}
\end{frame}

\end{document}
`,
    },
  },
  {
    id: "blank",
    name: "En blanco",
    description: "Lo mínimo para empezar",
    files: {
      "main.tex": String.raw`\documentclass{article}
\usepackage[spanish]{babel}

\begin{document}

Hola, mundo.

\end{document}
`,
    },
  },
];
