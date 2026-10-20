/**
 * Panel de calibración y métricas (lil-gui). Tecla P / º / F3.
 *
 * Edita en vivo el objeto de configuración y notifica a cada sistema.
 * "Guardar" persiste en localStorage; "Exportar JSON" copia la config para
 * pegarla en src/config.ts y dejarla fija en el repo.
 */

import GUI from "lil-gui";
import type { Controller } from "lil-gui";
import { applyQualityPreset, clearSavedConfig, defaultConfig, saveConfig } from "./config";
import type { GameConfig, QualityPreset } from "./config";

export interface DebugHooks {
  onCharacterChange(): void;
  onEnvironmentChange(): void;
  onRenderChange(): void;
  onSpawnHere(): void;
  onTeleportSpawn(): void;
  onAddObstacleHere(): void;
  setCollisionDebug(visible: boolean): void;
  setSplatVisible(visible: boolean): void;
  onPropsChange(): void;
  characterInfo(): Record<string, string | number>;
}

export interface DebugStats {
  fps: number;
  frameMs: number;
  drawCalls: number;
  triangles: number;
  pixelRatio: number;
  resolution: string;
  splats: string;
  props: string;
  ticks: number;
  memory: string;
}

export class DebugPanel {
  readonly gui: GUI;
  readonly stats: DebugStats = {
    fps: 0,
    frameMs: 0,
    drawCalls: 0,
    triangles: 0,
    pixelRatio: 1,
    resolution: "",
    splats: "",
    props: "",
    ticks: 0,
    memory: "",
  };
  private readonly statControllers: Controller[] = [];
  private readonly infoControllers: Controller[] = [];
  private readonly info: Record<string, string | number> = {};
  private readonly view = { collisionDebug: false, splatVisible: true };

  constructor(
    private readonly config: GameConfig,
    private readonly hooks: DebugHooks,
  ) {
    this.gui = new GUI({ title: "Calibración · El Eternauta", width: 320 });
    this.gui.domElement.classList.add("debug-panel");
    this.gui.hide();
    this.build();
  }

  get visible(): boolean {
    return !this.gui._hidden;
  }

  toggle(): void {
    if (this.visible) this.gui.hide();
    else {
      this.refreshInfo();
      this.gui.show();
    }
  }

  private build(): void {
    const c = this.config;
    const h = this.hooks;
    const gui = this.gui;

    // --- Métricas -----------------------------------------------------------
    const m = gui.addFolder("Métricas");
    for (const key of Object.keys(this.stats) as (keyof DebugStats)[]) {
      const ctrl = m.add(this.stats, key).disable();
      this.statControllers.push(ctrl);
    }

    // --- Personaje ----------------------------------------------------------
    const ch = gui.addFolder("Personaje (FBX)");
    ch.add(c.character, "targetHeight", 1.2, 2.4, 0.01).name("altura objetivo (m)").onChange(h.onCharacterChange);
    ch.add(c.character, "scaleMultiplier", 0.25, 4, 0.01).name("escala × auto").onChange(h.onCharacterChange);
    ch.add(c.character, "forwardOffsetDeg", -180, 180, 1).name("orientación frontal (°)").onChange(h.onCharacterChange);
    ch.add(c.character, "yOffset", -0.5, 0.5, 0.005).name("offset vertical (m)").onChange(h.onCharacterChange);
    ch.add(c.character, "walkClipSpeed", 0, 4, 0.01).name("vel. clip walk (0=auto)");
    ch.add(c.character, "runClipSpeed", 0, 9, 0.01).name("vel. clip run (0=auto)");
    ch.add(c.character, "shootClipSpeed", 0, 9, 0.01).name("vel. clip shoot (0=auto)");
    ch.add(c.character, "crossFade", 0.01, 1, 0.01).name("cross-fade (s)");
    ch.add(c.character, "castShadowBlob").name("sombra de contacto");
    const info = ch.addFolder("Info del FBX").close();
    this.infoFolder = info;

    // --- Acciones -----------------------------------------------------------
    const ac = gui.addFolder("Acciones (ventana del clip)").close();
    for (const [key, label] of [
      ["punch", "piña"],
      ["kick", "patada"],
      ["dodge", "esquive"],
      ["die", "muerte"],
    ] as const) {
      const f = ac.addFolder(label).close();
      f.add(c.actions[key], "start", 0, 4, 0.01).name("inicio (s)");
      f.add(c.actions[key], "end", 0, 4, 0.01).name("fin (s)");
      f.add(c.actions[key], "speed", 0.25, 3, 0.05).name("velocidad ×");
    }

    // --- Escenario ----------------------------------------------------------
    const env = gui.addFolder("Escenario (SPZ)").close();
    const ep = env.addFolder("posición");
    ep.add(c.environment.position, "x", -50, 50, 0.01).onChange(h.onEnvironmentChange);
    ep.add(c.environment.position, "y", -20, 20, 0.01).onChange(h.onEnvironmentChange);
    ep.add(c.environment.position, "z", -50, 50, 0.01).onChange(h.onEnvironmentChange);
    const er = env.addFolder("rotación (°)");
    er.add(c.environment.rotationDeg, "x", -180, 180, 0.5).onChange(h.onEnvironmentChange);
    er.add(c.environment.rotationDeg, "y", -180, 180, 0.5).onChange(h.onEnvironmentChange);
    er.add(c.environment.rotationDeg, "z", -180, 180, 0.5).onChange(h.onEnvironmentChange);
    env.add(c.environment, "scale", 0.1, 5, 0.01).name("escala").onChange(h.onEnvironmentChange);
    env.add(c.environment, "lodSplatScale", 0.25, 3, 0.05).name("presupuesto LoD ×").onChange(h.onRenderChange);
    env.add(c.environment, "lodRenderScale", 1, 4, 0.1).name("umbral LoD (px)").onChange(h.onRenderChange);
    env.add(c.environment, "maxStdDev", 1.5, 3, 0.05).name("radio gauss (σ)").onChange(h.onRenderChange);
    env.add(c.environment, "minAlpha", 0.001, 0.05, 0.001).name("alfa mín.").onChange(h.onRenderChange);
    env.add(c.environment, "minSortIntervalMs", 0, 60, 2).name("intervalo sort (ms)").onChange(h.onRenderChange);
    env.add(this.view, "splatVisible").name("mostrar splat").onChange((v: boolean) => h.setSplatVisible(v));
    env.add(c.environment, "lod").name("LoD (recargar)");
    env.add(c.environment, "extSplats").name("float32 (recargar)");

    // --- Modelos 3D (Blender) ----------------------------------------------
    const pr = gui.addFolder("Modelos 3D").close();
    pr.add(c.props, "visible").name("mostrar modelos").onChange(h.onPropsChange);
    pr.add(c.props, "carveSplat").name("recortar splat (objetos)").onChange(h.onPropsChange);
    pr.add(c.props, "showBuildings").name("ver Casa Rosada / Cabildo").onChange(h.onPropsChange);
    pr.add(c.props, "carveBuildings").name("recortar splat (fachadas)").onChange(h.onPropsChange);

    // --- Mundo / colisiones -------------------------------------------------
    const w = gui.addFolder("Suelo y límites").close();
    w.add(this.view, "collisionDebug").name("mostrar colisiones").onChange((v: boolean) => h.setCollisionDebug(v));
    w.add(c.world, "groundHeight", -5, 5, 0.01).name("altura suelo (m)");
    w.add(c.world, "groundSlopeX", -0.1, 0.1, 0.001).name("pendiente X");
    w.add(c.world, "groundSlopeZ", -0.1, 0.1, 0.001).name("pendiente Z");
    const b = w.addFolder("límites XZ").close();
    b.add(c.world.bounds, "minX", -300, 0, 0.5);
    b.add(c.world.bounds, "maxX", 0, 300, 0.5);
    b.add(c.world.bounds, "minZ", -300, 0, 0.5);
    b.add(c.world.bounds, "maxZ", 0, 300, 0.5);
    w.add(c.world, "killY", -200, 0, 1).name("altura de reinicio");
    const sp = w.addFolder("spawn").close();
    sp.add(c.world.spawn, "x", -100, 100, 0.1).listen();
    sp.add(c.world.spawn, "y", -10, 10, 0.1).listen();
    sp.add(c.world.spawn, "z", -100, 100, 0.1).listen();
    sp.add(c.world, "spawnYawDeg", -180, 180, 1).name("yaw (°)").listen();
    sp.add({ here: h.onSpawnHere }, "here").name("usar posición actual");
    sp.add({ go: h.onTeleportSpawn }, "go").name("ir al spawn (R)");
    w.add({ add: h.onAddObstacleHere }, "add").name("+ obstáculo 1×1 m aquí");
    w.add({ clear: () => (c.world.obstacles.length = 0) }, "clear").name("borrar obstáculos");

    // --- Movimiento ---------------------------------------------------------
    const mv = gui.addFolder("Movimiento").close();
    mv.add(c.movement, "walkSpeed", 0.5, 4, 0.05).name("caminar (m/s)");
    mv.add(c.movement, "runSpeed", 1, 10, 0.05).name("correr (m/s)");
    mv.add(c.movement, "acceleration", 1, 40, 0.5).name("aceleración");
    mv.add(c.movement, "deceleration", 1, 40, 0.5).name("desaceleración");
    mv.add(c.movement, "airControl", 0, 1, 0.01).name("control aéreo");
    mv.add(c.movement, "gravity", 1, 60, 0.5).name("gravedad");
    mv.add(c.movement, "jumpSpeed", 0, 15, 0.1).name("impulso salto");
    mv.add(c.movement, "shootMoveSpeed", 0.5, 6, 0.05).name("vel. disparando (m/s)");
    mv.add(c.movement, "turnSpeed", 1, 30, 0.5).name("giro");
    mv.add(c.movement, "radius", 0.1, 1, 0.01).name("radio colisión");
    mv.add(c.movement, "maxSlopeDeg", 10, 80, 1).name("pendiente máx. (°)");

    // --- Cámara -------------------------------------------------------------
    const cam = gui.addFolder("Cámara").close();
    cam.add(c.camera, "fov", 30, 100, 1).onChange(h.onRenderChange);
    cam.add(c.camera, "distance", 1, 15, 0.1).name("distancia inicial");
    cam.add(c.camera, "minDistance", 0.5, 5, 0.1).name("distancia mín.");
    cam.add(c.camera, "maxDistance", 2, 40, 0.5).name("distancia máx.");
    cam.add(c.camera, "pivotHeight", 0.5, 2.5, 0.01).name("altura pivote");
    cam.add(c.camera, "lookAheadHeight", -1, 2, 0.01).name("mirar sobre pivote");
    cam.add(c.camera, "shoulderOffset", -1.5, 1.5, 0.01).name("hombro");
    cam.add(c.camera, "sensitivity", 0.0005, 0.006, 0.0001).name("sensibilidad");
    cam.add(c.camera, "invertY").name("invertir Y");
    cam.add(c.camera, "followStiffness", 1, 40, 0.5).name("rigidez seguimiento");
    cam.add(c.camera, "rotationStiffness", 1, 60, 0.5).name("rigidez rotación");
    cam.add(c.camera, "minGroundClearance", 0, 2, 0.01).name("margen suelo");

    // --- Render -------------------------------------------------------------
    const r = gui.addFolder("Render").close();
    r.add(c.render, "qualityPreset", ["bajo", "medio", "alto", "ultra", "personalizado"])
      .name("perfil calidad")
      .onChange((v: QualityPreset) => {
        if (v !== "personalizado") applyQualityPreset(c, v);
        this.refreshDisplay();
        h.onRenderChange();
        h.onPropsChange();
      });
    r.add(c.render, "resolutionPreset", ["nativa", "1080p", "900p", "720p", "540p", "480p"])
      .name("resolución máx.")
      .onChange(h.onRenderChange);
    r.add(c.render, "maxPixelRatio", 0.5, 3, 0.25).name("pixel ratio máx.").onChange(h.onRenderChange);
    r.add(c.render, "renderScale", 0.25, 1, 0.05).name("escala resolución").onChange(h.onRenderChange);
    r.add(c.render, "dynamicResolution").name("resolución dinámica").onChange(h.onRenderChange);
    r.add(c.render, "targetFps", [30, 60, 90, 120]).name("FPS objetivo DRS");
    r.add(c.render, "maxFps", [0, 30, 60, 90, 120]).name("límite FPS (0=sin)");
    r.add(c.render, "pixelated").name("pixelado PS2").onChange(h.onRenderChange);
    r.addColor(c.render, "background").name("fondo").onChange(h.onRenderChange);
    r.add(c.render, "filmGrain").name("grano").onChange(h.onRenderChange);
    r.add(c.render, "vignette").name("viñeta").onChange(h.onRenderChange);
    r.add(c.render, "colorGrading").name("gradación color").onChange(h.onRenderChange);
    r.add(c.effects, "particleDensity", 0.2, 1, 0.05).name("densidad partículas").onChange(h.onRenderChange);

    // --- Atmósfera ----------------------------------------------------------
    const a = gui.addFolder("Nevada").close();
    a.add(c.atmosphere, "snow").name("activa");
    a.add(c.atmosphere, "snowCount", 0, 30000, 500).name("copos");
    a.add(c.atmosphere, "snowArea", 10, 100, 1).name("volumen (m)");
    a.add(c.atmosphere, "snowFallSpeed", 0, 5, 0.05).name("caída (m/s)");
    a.add(c.atmosphere.snowWind, "x", -3, 3, 0.05).name("viento X");
    a.add(c.atmosphere.snowWind, "z", -3, 3, 0.05).name("viento Z");
    a.add(c.atmosphere, "snowSize", 0.01, 0.2, 0.005).name("tamaño");

    // --- Persistencia -------------------------------------------------------
    const p = gui.addFolder("Guardar / exportar");
    p.add({ save: () => saveConfig(c) }, "save").name("guardar (localStorage)");
    p.add({ exp: () => this.exportJson() }, "exp").name("exportar JSON (portapapeles)");
    p.add(
      {
        reset: () => {
          clearSavedConfig();
          location.reload();
        },
      },
      "reset",
    ).name("restaurar defaults y recargar");
    p.add({ reload: () => location.reload() }, "reload").name("recargar página");
  }

  private infoFolder: GUI | null = null;

  refreshInfo(): void {
    if (!this.infoFolder) return;
    Object.assign(this.info, this.hooks.characterInfo());
    for (const key of Object.keys(this.info)) {
      if (!this.infoControllers.some((c) => c.property === key)) {
        this.infoControllers.push(this.infoFolder.add(this.info, key).disable());
      }
    }
    for (const c of this.infoControllers) c.updateDisplay();
  }

  /** Refresca las métricas visibles (llamar ~4 veces por segundo). */
  updateStats(): void {
    if (!this.visible) return;
    for (const c of this.statControllers) c.updateDisplay();
  }

  /** Sincroniza todos los controles de lil-gui con los valores actuales de `config`. */
  refreshDisplay(): void {
    for (const c of this.gui.controllersRecursive()) {
      if (!this.statControllers.includes(c)) c.updateDisplay();
    }
  }

  private exportJson(): void {
    // Sólo las diferencias respecto de los defaults: más fácil de revisar.
    const diff = diffConfig(defaultConfig, this.config);
    const json = JSON.stringify(diff, null, 2);
    console.info("[Debug] Config modificada (pegar en src/config.ts):\n" + json);
    navigator.clipboard?.writeText(json).catch(() => undefined);
  }

  dispose(): void {
    this.gui.destroy();
  }
}

function diffConfig(base: unknown, current: unknown): unknown {
  if (typeof base !== "object" || base === null || typeof current !== "object" || current === null || Array.isArray(base)) {
    return JSON.stringify(base) === JSON.stringify(current) ? undefined : current;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(current as object)) {
    const d = diffConfig((base as Record<string, unknown>)[key], (current as Record<string, unknown>)[key]);
    if (d !== undefined) out[key] = d;
  }
  return Object.keys(out).length ? out : undefined;
}
