import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from "@codemirror/autocomplete";
import { defaultKeymap, history, historyKeymap, indentWithTab, toggleComment } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  HighlightStyle,
  indentOnInput,
  indentUnit,
  StreamLanguage,
  syntaxHighlighting,
} from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { lintGutter } from "@codemirror/lint";
import { highlightSelectionMatches, search, searchKeymap } from "@codemirror/search";
import { Compartment, EditorSelection, type Extension, Prec } from "@codemirror/state";
import {
  crosshairCursor,
  drawSelection,
  dropCursor,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { tags as t } from "@lezer/highlight";
import { latexCompletions } from "./latex";

export const wrapCompartment = new Compartment();
export const fontCompartment = new Compartment();
export const spellCompartment = new Compartment();

const latexLanguage = StreamLanguage.define(stex);

const highlight = HighlightStyle.define([
  { tag: t.tagName, color: "var(--tok-command)" },
  { tag: t.keyword, color: "var(--tok-keyword)", fontWeight: "600" },
  { tag: t.comment, color: "var(--tok-comment)", fontStyle: "italic" },
  { tag: [t.atom, t.bool], color: "var(--tok-atom)" },
  { tag: t.number, color: "var(--tok-number)" },
  { tag: t.string, color: "var(--tok-string)" },
  { tag: t.bracket, color: "var(--tok-bracket)" },
  { tag: [t.special(t.variableName), t.variableName], color: "var(--tok-env)" },
  { tag: t.invalid, color: "var(--danger)" },
]);

const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "var(--editor-bg)", color: "var(--text)" },
  ".cm-scroller": { fontFamily: "var(--mono)", lineHeight: "1.6" },
  ".cm-content": { caretColor: "var(--accent)", paddingBottom: "40vh" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  ".cm-gutters": {
    backgroundColor: "var(--editor-bg)",
    color: "var(--text-faint)",
    border: "none",
    paddingLeft: "4px",
  },
  ".cm-activeLine": { backgroundColor: "var(--active-line)" },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "var(--selection) !important",
  },
  ".cm-selectionMatch": { backgroundColor: "var(--selection-match)" },
  "&.cm-focused .cm-matchingBracket": { backgroundColor: "var(--selection-match)", outline: "none" },
  ".cm-panels": { backgroundColor: "var(--panel)", color: "var(--text)", borderColor: "var(--border)" },
  ".cm-tooltip": { backgroundColor: "var(--panel)", border: "1px solid var(--border)", borderRadius: "6px" },
  ".cm-tooltip-autocomplete > ul > li[aria-selected]": { backgroundColor: "var(--accent)", color: "white" },
  ".cm-completionDetail": { opacity: "0.6", fontStyle: "normal", marginLeft: "1em" },
  ".cm-foldPlaceholder": { backgroundColor: "var(--panel)", border: "1px solid var(--border)", color: "var(--text-dim)" },
});

/** Envuelve la selección con un comando, p. ej. \textbf{…}. */
function wrapWith(cmd: string) {
  return (view: EditorView) => {
    view.dispatch(
      view.state.changeByRange((range) => {
        const text = view.state.sliceDoc(range.from, range.to);
        const insert = `\\${cmd}{${text}}`;
        const cursor = range.from + cmd.length + 2;
        return {
          changes: { from: range.from, to: range.to, insert },
          range: range.empty
            ? EditorSelection.cursor(cursor)
            : EditorSelection.range(cursor, cursor + text.length),
        };
      }),
    );
    return true;
  };
}

export interface EditorHooks {
  onChange: () => void;
  save: () => void;
  compile: () => void;
  syncToPdf: () => void;
}

export function fontTheme(size: number) {
  return EditorView.theme({ "&": { fontSize: `${size}px` } });
}

export function spellcheck(on: boolean) {
  return EditorView.contentAttributes.of({ spellcheck: on ? "true" : "false", autocorrect: "off" });
}

export function createExtensions(hooks: EditorHooks, opts: { wrap: boolean; fontSize: number; spell: boolean }): Extension[] {
  return [
    Prec.highest(
      keymap.of([
        { key: "Mod-s", run: () => (hooks.save(), true), preventDefault: true },
        { key: "Mod-Enter", run: () => (hooks.compile(), true), preventDefault: true },
        { key: "Mod-j", run: () => (hooks.syncToPdf(), true), preventDefault: true },
        { key: "Mod-b", run: wrapWith("textbf") },
        { key: "Mod-i", run: wrapWith("textit") },
        { key: "Mod-u", run: wrapWith("underline") },
        { key: "Mod-/", run: toggleComment },
      ]),
    ),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    history(),
    foldGutter(),
    drawSelection(),
    dropCursor(),
    indentOnInput(),
    indentUnit.of("  "),
    bracketMatching(),
    closeBrackets(),
    autocompletion({ override: [latexCompletions], activateOnTyping: true, maxRenderedOptions: 80 }),
    rectangularSelection(),
    crosshairCursor(),
    highlightActiveLine(),
    highlightSelectionMatches(),
    search({ top: true }),
    lintGutter(),
    latexLanguage,
    // En LaTeX ' y " son texto (apóstrofes, comillas `` ''), no se autocierran.
    latexLanguage.data.of({ closeBrackets: { brackets: ["(", "[", "{", "$"] }, commentTokens: { line: "%" } }),
    syntaxHighlighting(highlight),
    theme,
    wrapCompartment.of(opts.wrap ? EditorView.lineWrapping : []),
    fontCompartment.of(fontTheme(opts.fontSize)),
    spellCompartment.of(spellcheck(opts.spell)),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      indentWithTab,
    ]),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) hooks.onChange();
    }),
  ];
}
