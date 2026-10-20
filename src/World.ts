/**
 * Escena, renderer, luces y atmósfera.
 *
 * El renderer se crea con antialias: false como recomienda Spark (el MSAA no
 * mejora los splats y cuesta mucho). La resolución interna se controla con
 * `render.maxPixelRatio` y `render.renderScale`.
 */

import * as THREE from "three";
import { SparkRenderer } from "@sparkjsdev/spark";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { RESOLUTION_HEIGHT_MAP, type GameConfig } from "./config";
import { Snowfall } from "./Snowfall";

export class World {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly spark: SparkRenderer;
  readonly snow: Snowfall;
  private readonly envTexture: THREE.Texture;
  private readonly hemi: THREE.HemisphereLight;
  private readonly sun: THREE.DirectionalLight;
  private resizeObserver: ResizeObserver;
  /** Multiplicador dinámico de resolución (1 = sin reducción). */
  private dynamicScale = 1;
  private appliedPixelRatio = 0;

  constructor(
    private readonly container: HTMLElement,
    private readonly config: GameConfig,
  ) {
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      powerPreference: "high-performance",
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.domElement.id = "game-canvas";
    container.appendChild(this.renderer.domElement);

    const c = config.camera;
    this.camera = new THREE.PerspectiveCamera(c.fov, 1, c.near, c.far);
    this.scene.background = new THREE.Color(config.render.background);

    // Spark: un único SparkRenderer en la escena compone todos los splats.
    // lodRaycast: 0 evita que Spark corra un segundo traverseLodTrees en worker
    // cada 500 ms para raycasting sobre splats (las colisiones usan collider.glb).
    const env = config.environment;
    this.spark = new SparkRenderer({
      renderer: this.renderer,
      lodRaycast: 0,
      lodSplatScale: env.lodSplatScale,
      lodRenderScale: env.lodRenderScale,
      maxStdDev: env.maxStdDev,
      minAlpha: env.minAlpha,
      minSortIntervalMs: env.minSortIntervalMs,
    });
    this.spark.name = "spark-renderer";
    this.scene.add(this.spark);

    // Luz de día nublado y nevado: fría, difusa, de arriba.
    this.hemi = new THREE.HemisphereLight(0xd4dde6, 0x4b4744, 1.6);
    this.sun = new THREE.DirectionalLight(0xe8eef5, 1.4);
    this.sun.position.set(-6, 12, 4);
    this.scene.add(this.hemi, this.sun, this.sun.target);

    // Reflejos suaves para el material PBR del personaje.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();
    this.scene.environment = this.envTexture;
    this.scene.environmentIntensity = 0.45;

    this.snow = new Snowfall(config);
    this.scene.add(this.snow.points);

    this.applyRenderSettings();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  /**
   * Pixel ratio efectivo = min(devicePixelRatio, maxPixelRatio) × renderScale × dynamicScale,
   * acotado además por `maxResolutionHeight` si se eligió un límite (1080p, 900p, 720p, etc.).
   */
  get pixelRatio(): number {
    const r = this.config.render;
    const dpr = Math.min(window.devicePixelRatio || 1, r.maxPixelRatio);
    const scale = r.renderScale * (r.dynamicResolution ? this.dynamicScale : 1);
    let pr = dpr * scale;
    const maxH = r.maxResolutionHeight;
    if (maxH > 0) {
      const h = this.container.clientHeight || window.innerHeight || 1;
      pr = Math.min(pr, maxH / h);
    }
    return Math.max(0.25, pr);
  }

  get currentDynamicScale(): number {
    return this.config.render.dynamicResolution ? this.dynamicScale : 1;
  }

  /**
   * Ajusta gradualmente la escala de resolución interna para mantener `render.targetFps`.
   * Sólo redimensiona el framebuffer cuando el cambio supera el umbral de histéresis.
   */
  updateDynamicResolution(fps: number): void {
    const r = this.config.render;
    if (!r.dynamicResolution || fps <= 5) return;
    const target = Math.max(24, r.targetFps || 60);
    const minScale = THREE.MathUtils.clamp(r.minRenderScale || 0.55, 0.35, 1);
    const ratio = fps / target;
    let next = this.dynamicScale;
    if (ratio < 0.9) {
      // Caída de FPS: bajar resolución rápido para recuperar fluidez.
      next = Math.max(minScale, this.dynamicScale * Math.max(0.84, ratio));
    } else if (ratio > 1.08 && this.dynamicScale < 1) {
      // Margen sobrante: recuperar nitidez de a poco.
      next = Math.min(1, this.dynamicScale + 0.03);
    }
    if (Math.abs(next - this.dynamicScale) >= 0.025) {
      this.dynamicScale = next;
      const pr = this.pixelRatio;
      if (Math.abs(pr - this.appliedPixelRatio) >= 0.02) {
        this.resize();
      }
    }
  }

  applyRenderSettings(): void {
    const r = this.config.render;
    if (r.resolutionPreset in RESOLUTION_HEIGHT_MAP) {
      r.maxResolutionHeight = RESOLUTION_HEIGHT_MAP[r.resolutionPreset];
    }
    if (!r.dynamicResolution) this.dynamicScale = 1;
    this.renderer.toneMappingExposure = r.exposure;
    (this.scene.background as THREE.Color).set(r.background);
    const isSubNative = r.renderScale < 1 || r.maxResolutionHeight > 0 || r.dynamicResolution;
    this.renderer.domElement.classList.toggle("pixelated", r.pixelated && isSubNative);
    this.renderer.domElement.classList.toggle("color-grading", r.colorGrading);
    this.camera.fov = this.config.camera.fov;
    this.camera.near = this.config.camera.near;
    this.camera.far = this.config.camera.far;
    const env = this.config.environment;
    this.spark.lodSplatScale = env.lodSplatScale;
    this.spark.lodRenderScale = env.lodRenderScale;
    this.spark.maxStdDev = env.maxStdDev;
    this.spark.minAlpha = env.minAlpha;
    this.spark.minSortIntervalMs = env.minSortIntervalMs;
    this.spark.setDirty();
    this.resize();
  }

  resize(): void {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    const pr = this.pixelRatio;
    this.appliedPixelRatio = pr;
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, true);
    const aspect = w / h;
    this.camera.aspect = aspect;
    // Vertical (celular parado): abrir el FOV para conservar campo horizontal.
    const base = this.config.camera.fov;
    this.camera.fov = aspect < 1 ? Math.min(Math.max(base, this.config.camera.portraitMaxFov), base / Math.sqrt(aspect)) : base;
    this.camera.updateProjectionMatrix();
    this.spark.setDirty();
  }

  get isPortrait(): boolean {
    return this.camera.aspect < 1;
  }

  /** Mantiene la luz direccional centrada en el jugador. */
  followLight(target: THREE.Vector3): void {
    this.sun.target.position.copy(target);
    this.sun.position.set(target.x - 6, target.y + 12, target.z + 4);
  }

  update(time: number): void {
    this.snow.update(time, this.camera, this.renderer.domElement.height);
  }

  render(): void {
    // Evita ejecutar pasadas MRT de SplatAccumulator.generate() (2,5M splats) en frames
    // donde un ordenamiento asíncrono ya está en vuelo o aún no venció minSortIntervalMs.
    // Spark igualmente reproyecta `spark.display` a la matriz exacta de la cámara actual
    // en `onBeforeRender` mediante `accumToCamera`.
    const now = performance.now();
    this.spark.autoUpdate =
      !this.spark.sorting &&
      (this.spark.activeSplats === 0 ||
        this.spark.dirty ||
        now - this.spark.lastSortTime >= this.spark.minSortIntervalMs);
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.snow.dispose();
    this.envTexture.dispose();
    this.scene.remove(this.spark);
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }
}
