import * as pdfjs from "pdfjs-dist";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import type { SyncBox } from "./api";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
// Un solo worker para todas las recompilaciones: crear uno por PDF cuesta ~100 ms.
const sharedWorker = new pdfjs.PDFWorker();

export type ZoomMode = "fit-width" | "fit-page" | number;

interface PageSlot {
  el: HTMLDivElement;
  canvas: HTMLCanvasElement | null;
  page: PDFPageProxy;
  renderedScale: number;
  rendering: boolean;
}

/**
 * Visor PDF con renderizado diferido. Al cargar un PDF nuevo construye las
 * páginas fuera de pantalla, pinta las visibles y recién entonces reemplaza
 * las anteriores: así la recompilación en vivo no parpadea ni pierde el scroll.
 */
export class PdfViewer {
  private doc: PDFDocumentProxy | null = null;
  private task: PDFDocumentLoadingTask | null = null;
  private slots: PageSlot[] = [];
  private pagesEl: HTMLDivElement;
  private observer: IntersectionObserver;
  private zoom: ZoomMode = "fit-width";
  private scale = 1;
  private loadToken = 0;
  onInverseSync: (page: number, x: number, y: number) => void = () => {};
  onStatus: (page: number, total: number, scalePct: number) => void = () => {};

  constructor(private container: HTMLElement) {
    this.pagesEl = this.makePagesEl();
    container.appendChild(this.pagesEl);
    this.observer = this.makeObserver();
    new ResizeObserver(() => {
      if (this.zoom === "fit-width" || this.zoom === "fit-page") this.applyZoom();
    }).observe(container);
    container.addEventListener("scroll", () => this.reportStatus(), { passive: true });
    container.addEventListener(
      "wheel",
      (e) => {
        if (!e.ctrlKey) return;
        e.preventDefault();
        this.setZoom(this.scale * (e.deltaY < 0 ? 1.1 : 1 / 1.1));
      },
      { passive: false },
    );
  }

  get hasDocument() {
    return this.doc !== null;
  }

  get numPages() {
    return this.doc?.numPages ?? 0;
  }

  private makePagesEl() {
    const el = document.createElement("div");
    el.className = "pdf-pages";
    return el;
  }

  private makeObserver() {
    return new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const slot = this.slots.find((s) => s.el === e.target);
          if (slot) void this.renderSlot(slot);
        }
      },
      { root: this.container, rootMargin: "600px 0px" },
    );
  }

  async load(data: Uint8Array) {
    const token = ++this.loadToken;
    const task = pdfjs.getDocument({ data, worker: sharedWorker });
    const doc = await task.promise;
    if (token !== this.loadToken) {
      void task.destroy();
      return;
    }

    // Posición relativa actual, para restaurarla en el documento nuevo.
    const anchor = this.currentAnchor();

    const pages = await Promise.all(Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)));
    if (token !== this.loadToken || !pages.length) {
      void task.destroy();
      return;
    }

    const oldTask = this.task;
    this.task = task;
    const oldPagesEl = this.pagesEl;
    this.doc = doc;
    this.scale = this.computeScale(pages[0]);

    const newPagesEl = this.makePagesEl();
    const slots: PageSlot[] = pages.map((page) => {
      const el = document.createElement("div");
      el.className = "pdf-page";
      el.dataset.page = String(page.pageNumber);
      newPagesEl.appendChild(el);
      return { el, canvas: null, page, renderedScale: 0, rendering: false };
    });
    this.sizeSlots(slots);

    // Pintamos primero las páginas que quedarán visibles, aún fuera del DOM.
    const visible = this.pagesForAnchor(slots, anchor);
    await Promise.all(visible.map((s) => this.renderSlot(s)));
    if (token !== this.loadToken) {
      void task.destroy();
      return;
    }

    this.observer.disconnect();
    this.slots = slots;
    oldPagesEl.replaceWith(newPagesEl);
    this.pagesEl = newPagesEl;
    this.restoreAnchor(anchor);
    for (const s of slots) this.observer.observe(s.el);
    this.attachInverseSync();
    this.reportStatus();
    if (oldTask) void oldTask.destroy();
  }

  clear() {
    this.loadToken++;
    this.observer.disconnect();
    this.slots = [];
    void this.task?.destroy();
    this.task = null;
    this.doc = null;
    const el = this.makePagesEl();
    this.pagesEl.replaceWith(el);
    this.pagesEl = el;
  }

  private currentAnchor() {
    if (!this.slots.length) return { page: 0, offset: 0, left: 0 };
    const top = this.container.scrollTop;
    const slot = this.slots.find((s) => s.el.offsetTop + s.el.offsetHeight > top) ?? this.slots[0];
    return {
      page: this.slots.indexOf(slot),
      offset: (top - slot.el.offsetTop) / slot.el.offsetHeight,
      left: this.container.scrollLeft,
    };
  }

  private pagesForAnchor(slots: PageSlot[], anchor: { page: number }) {
    const first = Math.min(anchor.page, slots.length - 1);
    return slots.slice(Math.max(0, first - 1), first + 2);
  }

  private restoreAnchor(anchor: { page: number; offset: number; left: number }) {
    const slot = this.slots[Math.min(anchor.page, this.slots.length - 1)];
    if (!slot) return;
    this.container.scrollTop = slot.el.offsetTop + anchor.offset * slot.el.offsetHeight;
    this.container.scrollLeft = anchor.left;
  }

  private computeScale(page: PDFPageProxy) {
    if (typeof this.zoom === "number") return this.zoom;
    const vp = page.getViewport({ scale: 1 });
    const availW = this.container.clientWidth - 32;
    const byWidth = availW / vp.width;
    if (this.zoom === "fit-width") return Math.max(0.2, byWidth);
    const availH = this.container.clientHeight - 24;
    return Math.max(0.2, Math.min(byWidth, availH / vp.height));
  }

  private sizeSlots(slots: PageSlot[]) {
    for (const s of slots) {
      const vp = s.page.getViewport({ scale: this.scale });
      s.el.style.width = `${Math.floor(vp.width)}px`;
      s.el.style.height = `${Math.floor(vp.height)}px`;
    }
  }

  private async renderSlot(slot: PageSlot) {
    if (slot.rendering || slot.renderedScale === this.scale) return;
    slot.rendering = true;
    const scale = this.scale;
    try {
      const dpr = window.devicePixelRatio || 1;
      const vp = slot.page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.floor(vp.width * dpr);
      canvas.height = Math.floor(vp.height * dpr);
      canvas.style.width = `${Math.floor(vp.width)}px`;
      canvas.style.height = `${Math.floor(vp.height)}px`;
      await slot.page.render({
        canvas,
        viewport: vp,
        transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
      }).promise;
      // Cambio atómico del canvas: nunca se ve una página en blanco.
      if (slot.canvas) slot.canvas.replaceWith(canvas);
      else slot.el.prepend(canvas);
      slot.canvas = canvas;
      slot.renderedScale = scale;
    } catch (e) {
      if ((e as Error)?.name !== "RenderingCancelledException") console.warn("render", e);
    } finally {
      slot.rendering = false;
    }
    // Si el zoom cambió mientras pintábamos, repintar.
    if (slot.renderedScale !== this.scale && this.isNearViewport(slot)) void this.renderSlot(slot);
  }

  private isNearViewport(slot: PageSlot) {
    const top = this.container.scrollTop - 600;
    const bottom = this.container.scrollTop + this.container.clientHeight + 600;
    return slot.el.offsetTop < bottom && slot.el.offsetTop + slot.el.offsetHeight > top;
  }

  setZoom(z: ZoomMode) {
    if (typeof z === "number") z = Math.min(5, Math.max(0.25, z));
    this.zoom = z;
    this.applyZoom();
  }

  zoomBy(factor: number) {
    this.setZoom(this.scale * factor);
  }

  private applyZoom() {
    if (!this.slots.length) return;
    const anchor = this.currentAnchor();
    const newScale = this.computeScale(this.slots[0].page);
    if (Math.abs(newScale - this.scale) < 0.001) return;
    this.scale = newScale;
    this.sizeSlots(this.slots);
    // Estiramos los canvas existentes mientras se repintan a la nueva escala.
    for (const s of this.slots) {
      if (s.canvas) {
        s.canvas.style.width = s.el.style.width;
        s.canvas.style.height = s.el.style.height;
      }
    }
    this.restoreAnchor(anchor);
    for (const s of this.slots) if (this.isNearViewport(s)) void this.renderSlot(s);
    this.reportStatus();
  }

  private attachInverseSync() {
    this.pagesEl.addEventListener("dblclick", (e) => {
      const pageEl = (e.target as HTMLElement).closest<HTMLDivElement>(".pdf-page");
      if (!pageEl) return;
      const rect = pageEl.getBoundingClientRect();
      const x = (e.clientX - rect.left) / this.scale;
      const y = (e.clientY - rect.top) / this.scale;
      this.onInverseSync(Number(pageEl.dataset.page), x, y);
    });
  }

  /** Resalta una caja (en puntos PDF) y la centra en pantalla. */
  highlight(box: SyncBox) {
    const slot = this.slots[box.page - 1];
    if (!slot) return;
    const mark = document.createElement("div");
    mark.className = "sync-mark";
    mark.style.left = `${box.x * this.scale - 4}px`;
    mark.style.top = `${box.y * this.scale - 3}px`;
    mark.style.width = `${Math.max(box.w, 30) * this.scale + 8}px`;
    mark.style.height = `${box.h * this.scale + 6}px`;
    slot.el.appendChild(mark);
    setTimeout(() => mark.remove(), 1800);
    const target = slot.el.offsetTop + box.y * this.scale - this.container.clientHeight / 3;
    this.container.scrollTo({ top: target, behavior: "smooth" });
  }

  scrollToPage(n: number) {
    const slot = this.slots[n - 1];
    if (slot) this.container.scrollTo({ top: slot.el.offsetTop - 8 });
  }

  private reportStatus() {
    if (!this.slots.length) return;
    const mid = this.container.scrollTop + this.container.clientHeight / 2;
    const idx = this.slots.findIndex((s) => s.el.offsetTop + s.el.offsetHeight >= mid);
    this.onStatus((idx < 0 ? this.slots.length - 1 : idx) + 1, this.slots.length, Math.round(this.scale * 100));
  }
}
