/**
 * Menú de configuración gráfica y ajustes de resolución.
 *
 * Accesible desde la pantalla inicial, el botón del HUD o la tecla G.
 * Modifica `GameConfig` en vivo, aplica los cambios sin recargar la página y
 * guarda las preferencias en `localStorage`.
 */

import {
  RESOLUTION_HEIGHT_MAP,
  applyQualityPreset,
  defaultConfig,
  saveConfig,
  type GameConfig,
  type QualityPreset,
  type ResolutionPreset,
} from "./config";

export interface GraphicsMenuHooks {
  onApply(): void;
  onOpenChange?(open: boolean): void;
}

export interface GraphicsLiveMetrics {
  fps: number;
  frameMs: number;
  width: number;
  height: number;
  pixelRatio: number;
  dynamicScale: number;
  activeSplats: number;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

const QUALITY_OPTIONS: { value: QualityPreset; label: string }[] = [
  { value: "bajo", label: "BAJO" },
  { value: "medio", label: "MEDIO" },
  { value: "alto", label: "ALTO" },
  { value: "ultra", label: "ULTRA" },
  { value: "personalizado", label: "PERSONAL" },
];

const RESOLUTION_OPTIONS: { value: ResolutionPreset; label: string }[] = [
  { value: "nativa", label: "NATIVA" },
  { value: "1080p", label: "1080p" },
  { value: "900p", label: "900p" },
  { value: "720p", label: "720p" },
  { value: "540p", label: "540p" },
  { value: "480p", label: "480p" },
];

const FPS_CAP_OPTIONS: { value: number; label: string }[] = [
  { value: 0, label: "SIN LÍMITE" },
  { value: 30, label: "30 FPS" },
  { value: 60, label: "60 FPS" },
  { value: 90, label: "90 FPS" },
  { value: 120, label: "120 FPS" },
];

const TARGET_FPS_OPTIONS: { value: number; label: string }[] = [
  { value: 30, label: "30 FPS" },
  { value: 60, label: "60 FPS" },
  { value: 90, label: "90 FPS" },
  { value: 120, label: "120 FPS" },
];

const DPR_OPTIONS: { value: number; label: string }[] = [
  { value: 1, label: "1.0×" },
  { value: 1.25, label: "1.25×" },
  { value: 1.5, label: "1.5×" },
  { value: 2, label: "2.0×" },
];

export class GraphicsMenu {
  readonly root: HTMLElement;
  private readonly liveFps: HTMLElement;
  private readonly liveRes: HTMLElement;
  private readonly liveSplats: HTMLElement;
  private readonly syncFns: (() => void)[] = [];

  constructor(
    container: HTMLElement,
    private readonly config: GameConfig,
    private readonly hooks: GraphicsMenuHooks,
  ) {
    this.root = el("div", "gfx-overlay");
    this.root.hidden = true;
    this.root.addEventListener("pointerdown", (e) => {
      if (e.target === this.root) this.close();
    });

    const modal = el("section", "gfx-modal");
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-label", "Configuración gráfica y resolución");

    // --- Encabezado ----------------------------------------------------------
    const header = el("header", "gfx-header");
    const titleWrap = el("div", "gfx-title-wrap");
    titleWrap.append(
      el("p", "gfx-kicker", "RENDIMIENTO Y RESOLUCIÓN"),
      el("h2", "gfx-title", "CONFIGURACIÓN GRÁFICA"),
    );
    const closeBtn = el("button", "gfx-close", "✕");
    closeBtn.title = "Cerrar (G / Esc)";
    closeBtn.addEventListener("click", () => this.close());
    header.append(titleWrap, closeBtn);

    // --- Barra de telemetría en vivo -----------------------------------------
    const status = el("div", "gfx-live");
    this.liveFps = el("span", "gfx-live-item", "— FPS");
    this.liveRes = el("span", "gfx-live-item", "— × — px");
    this.liveSplats = el("span", "gfx-live-item", "— M splats");
    status.append(this.liveFps, this.liveRes, this.liveSplats);

    // --- Cuerpo con secciones ------------------------------------------------
    const body = el("div", "gfx-body");

    // 1. Perfil global de calidad
    const presetSec = this.section("PERFIL DE CALIDAD");
    presetSec.append(
      this.segmented(
        QUALITY_OPTIONS,
        () => this.config.render.qualityPreset,
        (val) => {
          if (val !== "personalizado") {
            applyQualityPreset(this.config, val);
            this.applyAndSave(false);
          }
        },
      ),
    );
    body.append(presetSec);

    // 2. Resolución y pantalla
    const resSec = this.section("RESOLUCIÓN Y PANTALLA");
    resSec.append(
      this.labeledRow(
        "Resolución máxima",
        "Acota la altura del framebuffer (720p/900p aumentan mucho los FPS en pantallas 1080p/4K)",
        this.segmented(
          RESOLUTION_OPTIONS,
          () => this.config.render.resolutionPreset,
          (val) => {
            this.config.render.resolutionPreset = val;
            this.config.render.maxResolutionHeight = RESOLUTION_HEIGHT_MAP[val];
            this.applyAndSave(true);
          },
        ),
      ),
      this.sliderRow({
        label: "Escala de resolución interna",
        hint: "Porcentaje sobre la resolución activa (50% + Pixelado = estética PS2)",
        min: 0.25,
        max: 1,
        step: 0.05,
        get: () => this.config.render.renderScale,
        set: (v) => {
          this.config.render.renderScale = v;
          this.applyAndSave(true);
        },
        format: (v) => `${Math.round(v * 100)}%`,
      }),
      this.labeledRow(
        "Límite de densidad de píxeles (DPR)",
        "Tope del multiplicador en pantallas Retina / HiDPI",
        this.segmented(
          DPR_OPTIONS,
          () => this.config.render.maxPixelRatio,
          (val) => {
            this.config.render.maxPixelRatio = val;
            this.applyAndSave(true);
          },
        ),
      ),
      this.toggleRow({
        label: "Resolución dinámica automática (Auto-DRS)",
        hint: "Ajusta la escala interna en tiempo real si caen los FPS",
        get: () => this.config.render.dynamicResolution,
        set: (v) => {
          this.config.render.dynamicResolution = v;
          this.applyAndSave(true);
        },
      }),
      this.labeledRow(
        "FPS objetivo (Auto-DRS)",
        "Meta de fluidez que sostiene la resolución dinámica",
        this.segmented(
          TARGET_FPS_OPTIONS,
          () => this.config.render.targetFps,
          (val) => {
            this.config.render.targetFps = val;
            this.applyAndSave(true);
          },
        ),
      ),
      this.labeledRow(
        "Límite máximo de FPS",
        "Evita sobrecalentar la GPU cuando sobran cuadros por segundo",
        this.segmented(
          FPS_CAP_OPTIONS,
          () => this.config.render.maxFps,
          (val) => {
            this.config.render.maxFps = val;
            this.applyAndSave(false);
          },
        ),
      ),
      this.toggleRow({
        label: "Escalado pixelado (look PS2)",
        hint: "Sin filtrado bilineal al bajar la escala o la resolución",
        get: () => this.config.render.pixelated,
        set: (v) => {
          this.config.render.pixelated = v;
          this.applyAndSave(false);
        },
      }),
    );
    body.append(resSec);

    // 3. Gaussian Splatting (Spark)
    const splatSec = this.section("ESCENARIO GAUSSIAN SPLATTING (SPARK)");
    splatSec.append(
      this.sliderRow({
        label: "Presupuesto de splats (LoD)",
        hint: "Cantidad de splats activos en pantalla (menor = mucho más rápido)",
        min: 0.25,
        max: 2.0,
        step: 0.05,
        get: () => this.config.environment.lodSplatScale,
        set: (v) => {
          this.config.environment.lodSplatScale = v;
          this.applyAndSave(true);
        },
        format: (v) => `${Math.round(v * 100)}%`,
      }),
      this.sliderRow({
        label: "Umbral de detalle lejano (LoD px)",
        hint: "Tamaño mínimo en píxeles para fusionar splats distantes",
        min: 1.0,
        max: 3.0,
        step: 0.1,
        get: () => this.config.environment.lodRenderScale,
        set: (v) => {
          this.config.environment.lodRenderScale = v;
          this.applyAndSave(true);
        },
        format: (v) => `${v.toFixed(1)} px`,
      }),
      this.sliderRow({
        label: "Radio gaussiano (Overdraw GPU)",
        hint: "Recorta el borde transparente de cada splat para ahorrar fillrate",
        min: 1.8,
        max: 2.85,
        step: 0.05,
        get: () => this.config.environment.maxStdDev,
        set: (v) => {
          this.config.environment.maxStdDev = v;
          this.applyAndSave(true);
        },
        format: (v) => `${v.toFixed(2)} σ`,
      }),
      this.sliderRow({
        label: "Intervalo de ordenamiento (Sort)",
        hint: "Milisegundos mínimos entre pasadas de ordenamiento de profundidad",
        min: 8,
        max: 48,
        step: 4,
        get: () => this.config.environment.minSortIntervalMs,
        set: (v) => {
          this.config.environment.minSortIntervalMs = v;
          this.applyAndSave(true);
        },
        format: (v) => `${v.toFixed(0)} ms`,
      }),
      this.toggleRow({
        label: "Recorte SDF del splat en objetos 3D",
        hint: "Oculta el splat dentro de bancos/árboles (desactivar ahorra GPU en el generador)",
        get: () => this.config.props.carveSplat,
        set: (v) => {
          this.config.props.carveSplat = v;
          this.applyAndSave(true);
        },
      }),
    );
    body.append(splatSec);

    // 4. Efectos y post-procesado
    const fxSec = this.section("EFECTOS Y ATMÓSFERA");
    fxSec.append(
      this.sliderRow({
        label: "Copos de la nevada mortal",
        hint: "Cantidad de partículas de nieve alrededor de la cámara (0 = sin nieve)",
        min: 0,
        max: 10000,
        step: 500,
        get: () => (this.config.atmosphere.snow ? this.config.atmosphere.snowCount : 0),
        set: (v) => {
          this.config.atmosphere.snow = v > 0;
          if (v > 0) this.config.atmosphere.snowCount = v;
          this.applyAndSave(true);
        },
        format: (v) => (v === 0 ? "APAGADA" : `${v}`),
      }),
      this.sliderRow({
        label: "Densidad de partículas de combate",
        hint: "Hemolinfa, chispas, humo y nieve levantada por los cascarudos",
        min: 0.2,
        max: 1.0,
        step: 0.05,
        get: () => this.config.effects.particleDensity,
        set: (v) => {
          this.config.effects.particleDensity = v;
          this.applyAndSave(true);
        },
        format: (v) => `${Math.round(v * 100)}%`,
      }),
      this.toggleRow({
        label: "Sombras de contacto",
        hint: "Sombras suaves bajo el Eternauta y los cascarudos",
        get: () => this.config.character.castShadowBlob,
        set: (v) => {
          this.config.character.castShadowBlob = v;
          this.applyAndSave(true);
        },
      }),
      this.toggleRow({
        label: "Grano fílmico",
        hint: "Textura analógica superpuesta en pantalla",
        get: () => this.config.render.filmGrain,
        set: (v) => {
          this.config.render.filmGrain = v;
          this.applyAndSave(true);
        },
      }),
      this.toggleRow({
        label: "Viñeta",
        hint: "Oscurecimiento suave en los bordes de la pantalla",
        get: () => this.config.render.vignette,
        set: (v) => {
          this.config.render.vignette = v;
          this.applyAndSave(true);
        },
      }),
      this.toggleRow({
        label: "Gradación de color fría (CSS)",
        hint: "Filtro de saturación/contraste (desactivar ahorra composición en GPU)",
        get: () => this.config.render.colorGrading,
        set: (v) => {
          this.config.render.colorGrading = v;
          this.applyAndSave(true);
        },
      }),
    );
    body.append(fxSec);

    // --- Pie -----------------------------------------------------------------
    const footer = el("footer", "gfx-footer");
    const resetBtn = el("button", "gfx-btn gfx-btn-secondary", "RESTAURAR VALORES POR DEFECTO");
    resetBtn.addEventListener("click", () => {
      Object.assign(this.config.render, structuredClone(defaultConfig.render));
      Object.assign(this.config.environment, structuredClone(defaultConfig.environment));
      Object.assign(this.config.atmosphere, structuredClone(defaultConfig.atmosphere));
      Object.assign(this.config.effects, structuredClone(defaultConfig.effects));
      this.config.props.carveSplat = defaultConfig.props.carveSplat;
      this.config.character.castShadowBlob = defaultConfig.character.castShadowBlob;
      this.applyAndSave(false);
    });
    const doneBtn = el("button", "gfx-btn gfx-btn-primary", "LISTO · GUARDADO");
    doneBtn.addEventListener("click", () => this.close());
    footer.append(resetBtn, doneBtn);

    modal.append(header, status, body, footer);
    this.root.append(modal);
    container.append(this.root);
  }

  get isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    if (this.isOpen) return;
    this.syncUI();
    this.root.hidden = false;
    this.hooks.onOpenChange?.(true);
  }

  close(): void {
    if (!this.isOpen) return;
    this.root.hidden = true;
    this.hooks.onOpenChange?.(false);
  }

  toggle(): void {
    if (this.isOpen) this.close();
    else this.open();
  }

  syncUI(): void {
    for (const fn of this.syncFns) fn();
  }

  updateLiveMetrics(m: GraphicsLiveMetrics): void {
    if (!this.isOpen) return;
    this.liveFps.textContent = `${m.fps.toFixed(0)} FPS · ${m.frameMs.toFixed(1)} ms`;
    const drs = this.config.render.dynamicResolution ? ` · DRS ${Math.round(m.dynamicScale * 100)}%` : "";
    this.liveRes.textContent = `${m.width}×${m.height} px (DPR ${m.pixelRatio.toFixed(2)}${drs})`;
    this.liveSplats.textContent = `${(m.activeSplats / 1e6).toFixed(2)} M splats`;
  }

  private applyAndSave(markCustom: boolean): void {
    if (markCustom) {
      this.config.render.qualityPreset = "personalizado";
    }
    this.syncUI();
    this.hooks.onApply();
    saveConfig(this.config);
  }

  private section(title: string): HTMLElement {
    const sec = el("div", "gfx-section");
    sec.append(el("h3", "gfx-section-title", title));
    return sec;
  }

  private labeledRow(label: string, hint: string, control: HTMLElement): HTMLElement {
    const row = el("div", "gfx-row gfx-row-stack");
    const info = el("div", "gfx-row-info");
    info.append(el("span", "gfx-row-label", label), el("span", "gfx-row-hint", hint));
    row.append(info, control);
    return row;
  }

  private segmented<T extends string | number>(
    options: { value: T; label: string }[],
    get: () => T,
    set: (v: T) => void,
  ): HTMLElement {
    const group = el("div", "gfx-segmented");
    const buttons: { btn: HTMLButtonElement; value: T }[] = [];
    for (const opt of options) {
      const btn = el("button", "gfx-seg-btn", opt.label);
      btn.type = "button";
      btn.addEventListener("click", () => set(opt.value));
      group.append(btn);
      buttons.push({ btn, value: opt.value });
    }
    this.syncFns.push(() => {
      const cur = get();
      for (const b of buttons) {
        b.btn.classList.toggle("active", b.value === cur);
      }
    });
    return group;
  }

  private sliderRow(opts: {
    label: string;
    hint: string;
    min: number;
    max: number;
    step: number;
    get: () => number;
    set: (v: number) => void;
    format: (v: number) => string;
  }): HTMLElement {
    const row = el("div", "gfx-row");
    const info = el("div", "gfx-row-info");
    info.append(el("span", "gfx-row-label", opts.label), el("span", "gfx-row-hint", opts.hint));

    const ctrl = el("div", "gfx-slider-wrap");
    const input = el("input", "gfx-slider");
    input.type = "range";
    input.min = String(opts.min);
    input.max = String(opts.max);
    input.step = String(opts.step);
    const valEl = el("span", "gfx-slider-val", "");

    input.addEventListener("input", () => {
      const v = Number(input.value);
      valEl.textContent = opts.format(v);
      opts.set(v);
    });

    ctrl.append(input, valEl);
    row.append(info, ctrl);

    this.syncFns.push(() => {
      const v = opts.get();
      input.value = String(v);
      valEl.textContent = opts.format(v);
    });
    return row;
  }

  private toggleRow(opts: {
    label: string;
    hint: string;
    get: () => boolean;
    set: (v: boolean) => void;
  }): HTMLElement {
    const row = el("div", "gfx-row");
    const info = el("div", "gfx-row-info");
    info.append(el("span", "gfx-row-label", opts.label), el("span", "gfx-row-hint", opts.hint));

    const btn = el("button", "gfx-toggle");
    btn.type = "button";
    btn.addEventListener("click", () => opts.set(!opts.get()));

    row.append(info, btn);
    this.syncFns.push(() => {
      const on = opts.get();
      btn.classList.toggle("active", on);
      btn.textContent = on ? "SÍ" : "NO";
    });
    return row;
  }

  dispose(): void {
    this.root.remove();
  }
}
