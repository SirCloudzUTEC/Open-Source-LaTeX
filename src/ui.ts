import { icon, type IconName } from "./icons";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {},
  ...children: (Node | string)[]
): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

export function $(id: string): HTMLElement {
  return document.getElementById(id)!;
}

export function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function toast(text: string, kind: "info" | "error" = "info", ms = 2600) {
  const t = el("div", { className: `toast ${kind}`, textContent: text });
  $("toast-root").appendChild(t);
  setTimeout(() => t.remove(), ms);
}

interface ModalAction {
  label: string;
  kind?: "primary" | "danger";
  /** Devuelve false para mantener el modal abierto. */
  run?: () => boolean | void | Promise<boolean | void>;
}

export function modal(opts: { title: string; body: Node; actions?: ModalAction[]; wide?: boolean; onClose?: () => void }) {
  const backdrop = el("div", { className: "modal-backdrop" });
  const box = el("div", { className: "modal" + (opts.wide ? " wide" : "") });
  const foot = el("div", { className: "modal-foot" });
  const close = () => {
    backdrop.remove();
    document.removeEventListener("keydown", onKey, true);
    opts.onClose?.();
  };
  const actions = opts.actions ?? [{ label: "Cerrar", kind: "primary" }];
  const buttons = actions.map((a) => {
    const b = el("button", { className: `btn ${a.kind ?? ""}`, textContent: a.label });
    b.onclick = async () => {
      if ((await a.run?.()) !== false) close();
    };
    return b;
  });
  foot.append(...buttons);
  box.append(el("div", { className: "modal-head", textContent: opts.title }), el("div", { className: "modal-body" }, opts.body), foot);
  backdrop.appendChild(box);
  backdrop.addEventListener("mousedown", (e) => {
    if (e.target === backdrop) close();
  });
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && !(e.target instanceof HTMLButtonElement) && !e.ctrlKey) {
      const primary = buttons[actions.findIndex((a) => a.kind === "primary" || a.kind === "danger")];
      if (primary) {
        e.preventDefault();
        primary.click();
      }
    }
  };
  document.addEventListener("keydown", onKey, true);
  $("modal-root").appendChild(backdrop);
  const first = box.querySelector<HTMLElement>("input, select");
  (first ?? buttons[buttons.length - 1])?.focus();
  if (first instanceof HTMLInputElement) {
    // Selecciona el nombre sin la extensión, como en los exploradores de archivos.
    const dot = first.value.lastIndexOf(".");
    first.setSelectionRange(0, dot > 0 ? dot : first.value.length);
  }
  return { close };
}

export function prompt(title: string, label: string, value = "", okLabel = "Aceptar"): Promise<string | null> {
  return new Promise((resolve) => {
    let result: string | null = null;
    const input = el("input", { type: "text", value, spellcheck: false });
    modal({
      title,
      body: el("div", {}, el("label", { className: "block", textContent: label }), input),
      actions: [
        { label: "Cancelar" },
        {
          label: okLabel,
          kind: "primary",
          run: () => {
            if (!input.value.trim()) return false;
            result = input.value.trim();
          },
        },
      ],
      onClose: () => resolve(result),
    });
  });
}

export function confirm(title: string, text: string, okLabel = "Aceptar", danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    let ok = false;
    modal({
      title,
      body: el("p", { textContent: text }),
      actions: [{ label: "Cancelar" }, { label: okLabel, kind: danger ? "danger" : "primary", run: () => void (ok = true) }],
      onClose: () => resolve(ok),
    });
  });
}

export interface MenuItem {
  label?: string;
  icon?: IconName;
  hint?: string;
  danger?: boolean;
  separator?: boolean;
  run?: () => void;
}

export function showMenu(items: MenuItem[], x: number, y: number) {
  const menu = $("menu");
  menu.innerHTML = "";
  for (const it of items) {
    if (it.separator) {
      menu.appendChild(el("div", { className: "menu-sep" }));
      continue;
    }
    const b = el("button", { className: "menu-item" + (it.danger ? " danger" : "") });
    b.innerHTML = (it.icon ? icon(it.icon, 15) : '<span style="width:15px"></span>') + `<span>${escapeHtml(it.label!)}</span>`;
    if (it.hint) b.appendChild(el("span", { className: "hint", textContent: it.hint }));
    b.onclick = () => {
      hideMenu();
      it.run?.();
    };
    menu.appendChild(b);
  }
  menu.hidden = false;
  const r = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - r.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - r.height - 8)}px`;
}

export function hideMenu() {
  $("menu").hidden = true;
}

document.addEventListener("mousedown", (e) => {
  if (!(e.target as HTMLElement).closest("#menu")) hideMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideMenu();
});
