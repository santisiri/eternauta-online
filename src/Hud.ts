/**
 * Interfaz minimalista: título, métricas en la esquina, pantalla inicial
 * con progreso de carga y errores, y overlays (grano / viñeta).
 */

import type { GameConfig } from "./config";

export interface HudMetrics {
  fps: number;
  frameMs: number;
  resolution: string;
  position: { x: number; y: number; z: number };
  animation: string;
  splat: string;
  splatError: boolean;
  collision: string;
}

type LoadItem = { label: HTMLElement; bar: HTMLElement; value: HTMLElement };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class Hud {
  readonly root: HTMLElement;
  private readonly metrics: Record<"fps" | "res" | "pos" | "anim" | "splat" | "coll", HTMLElement>;
  private readonly start: HTMLElement;
  private readonly enterButton: HTMLButtonElement;
  private readonly gfxStartButton: HTMLButtonElement;
  private readonly gfxHudButton: HTMLButtonElement;
  private readonly errors: HTMLElement;
  private readonly note: HTMLElement;
  private readonly help: HTMLElement;
  private readonly keys: HTMLElement;
  private readonly hint: HTMLElement;
  private hintTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly items = new Map<string, LoadItem>();
  private readonly grain: HTMLElement;
  private readonly vignette: HTMLElement;
  onEnter?: () => void;
  onOpenGraphics?: () => void;

  constructor(container: HTMLElement) {
    this.root = el("div", "hud");
    this.grain = el("div", "fx-grain");
    this.vignette = el("div", "fx-vignette");

    // Título
    const title = el("header", "hud-title");
    title.append(el("h1", "", "EL ETERNAUTA ONLINE"), el("p", "", "PLAZA DE MAYO — PROTOTIPO"));

    // Métricas
    const panel = el("dl", "hud-metrics");
    const row = (name: string) => {
      const v = el("dd");
      panel.append(el("dt", "", name), v);
      return v;
    };
    this.metrics = {
      fps: row("FPS"),
      res: row("RES"),
      pos: row("XYZ"),
      anim: row("ANIM"),
      splat: row("SPZ"),
      coll: row("COL"),
    };

    this.gfxHudButton = el("button", "hud-gfx-btn", "⚙ GRÁFICOS · G");
    this.gfxHudButton.type = "button";
    this.gfxHudButton.title = "Configuración gráfica y resolución (G)";
    this.gfxHudButton.addEventListener("click", (e) => {
      e.stopPropagation();
      this.onOpenGraphics?.();
    });

    const help = el("div", "hud-help");
    this.help = help;
    help.innerHTML =
      "<b>WASD</b> mover · <b>Shift</b> correr · <b>Espacio</b> saltar · <b>Clic izq./Q</b> disparar · <b>Clic der.</b> apuntar · " +
      "<b>F</b> piña · <b>V</b> patada · <b>C</b> esquivar · <b>K</b> morir · <b>R</b> reiniciar · <b>M</b> sonido · " +
      "<b>G</b> gráficos · <b>P</b> debug";

    this.hint = el("div", "hud-hint");

    // Pantalla inicial
    this.start = el("section", "start");
    const card = el("div", "start-card");
    const kicker = el("p", "start-kicker", "BUENOS AIRES · AÑO CERO DE LA NEVADA");
    const h = el("h1", "start-title", "EL ETERNAUTA ONLINE");
    const sub = el("p", "start-sub", "PLAZA DE MAYO — PROTOTIPO");
    const quote = el("p", "start-quote", "Afuera nieva. Cada copo mata. Sólo el traje te separa de la nevada.");
    const loading = el("div", "start-loading");
    for (const [key, label] of [
      ["fbx", "PROTAGONISTA · FBX"],
      ["spz", "PLAZA DE MAYO · SPZ"],
    ]) {
      const item = el("div", "load-item");
      const name = el("span", "load-label", label);
      const value = el("span", "load-value", "—");
      const track = el("div", "load-track");
      const bar = el("div", "load-bar");
      track.append(bar);
      item.append(name, value, track);
      loading.append(item);
      this.items.set(key, { label: name, bar, value });
    }
    this.errors = el("div", "start-errors");
    this.note = el("p", "start-note");
    this.note.hidden = true;
    this.enterButton = el("button", "start-enter", "CARGANDO…");
    this.enterButton.disabled = true;
    this.enterButton.addEventListener("click", () => this.onEnter?.());
    this.gfxStartButton = el("button", "start-gfx", "⚙ GRÁFICOS Y RESOLUCIÓN");
    this.gfxStartButton.type = "button";
    this.gfxStartButton.addEventListener("click", () => this.onOpenGraphics?.());
    const actions = el("div", "start-actions");
    actions.append(this.enterButton, this.gfxStartButton);
    const keys = el("p", "start-keys");
    this.keys = keys;
    keys.innerHTML = help.innerHTML;
    card.append(kicker, h, sub, quote, this.note, loading, this.errors, actions, keys);
    this.start.append(card);

    this.root.append(title, panel, this.gfxHudButton, help, this.hint);
    container.append(this.vignette, this.grain, this.root, this.start);
  }

  setLoad(key: "fbx" | "spz", fraction: number, text: string, state: "loading" | "done" | "error" = "loading"): void {
    const item = this.items.get(key);
    if (!item) return;
    item.bar.style.transform = `scaleX(${Math.max(0, Math.min(1, fraction))})`;
    item.value.textContent = text;
    item.bar.parentElement!.parentElement!.dataset.state = state;
  }

  showError(message: string): void {
    const p = el("p", "", message);
    this.errors.append(p);
  }

  /** Reemplaza la ayuda de teclado por la de controles táctiles. */
  setTouchHelp(): void {
    const html =
      "<b>Joystick izquierdo</b> mover (al tope: correr) · <b>Arrastrar</b> cámara · " +
      "<b>Pellizcar</b> zoom · <b>SALTAR</b> · <b>FUEGO</b> (mantener) · <b>PIÑA</b> · <b>PATADA</b> · " +
      "<b>ESQUIVAR</b> · <b>↺</b> reiniciar";
    this.keys.innerHTML = html;
    this.help.innerHTML = html;
    document.body.classList.add("touch");
  }

  /**
   * Muestra un aviso antes de empezar la descarga y espera a que el jugador
   * acepte (p. ej. en celulares: el juego pide teclado y mouse y pesa ~90 MB).
   */
  gate(message: string, buttonLabel: string): Promise<void> {
    this.note.textContent = message;
    this.note.hidden = false;
    this.enterButton.textContent = buttonLabel;
    this.enterButton.disabled = false;
    return new Promise((resolve) => {
      const previous = this.onEnter;
      this.onEnter = () => {
        this.onEnter = previous;
        this.note.hidden = true;
        this.setReady("CARGANDO…", false);
        resolve();
      };
    });
  }

  setReady(label: string, enabled: boolean): void {
    this.enterButton.textContent = label;
    this.enterButton.disabled = !enabled;
    if (enabled) this.enterButton.focus({ preventScroll: true });
  }

  hideStart(): void {
    this.start.classList.add("hidden");
    this.root.classList.add("playing");
  }

  applyEffects(config: GameConfig): void {
    this.grain.hidden = !config.render.filmGrain;
    this.vignette.hidden = !config.render.vignette;
  }

  update(m: HudMetrics): void {
    this.metrics.fps.textContent = `${m.fps.toFixed(0)}  (${m.frameMs.toFixed(1)} ms)`;
    this.metrics.res.textContent = m.resolution;
    this.metrics.pos.textContent = `${m.position.x.toFixed(2)}  ${m.position.y.toFixed(2)}  ${m.position.z.toFixed(2)}`;
    this.metrics.anim.textContent = m.animation;
    this.metrics.splat.textContent = m.splat;
    this.metrics.splat.classList.toggle("error", m.splatError);
    this.metrics.coll.textContent = m.collision;
  }

  /** Aviso transitorio centrado abajo; desaparece solo tras `durationMs`. */
  showHint(text: string, durationMs = 3000): void {
    this.hint.textContent = text;
    this.hint.classList.add("visible");
    clearTimeout(this.hintTimer);
    this.hintTimer = setTimeout(() => this.hideHint(), durationMs);
  }

  hideHint(): void {
    clearTimeout(this.hintTimer);
    this.hint.classList.remove("visible");
  }
}
