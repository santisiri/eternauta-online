/**
 * Protagonista: importación FBX, normalización y animación.
 *
 * Al cargar, inspecciona el FBX y genera un `CharacterReport` con su
 * estructura (mallas, esqueleto, clips, escala y orientación originales).
 * Luego normaliza el modelo:
 *   - escala para que mida `targetHeight` metros,
 *   - lo apoya sobre el suelo (pies en y = 0 del grupo raíz),
 *   - lo orienta para que su frente mire hacia +Z local,
 *   - elimina la deriva horizontal del hueso raíz (sin root motion duplicado),
 *   - convierte los materiales Phong a PBR.
 *
 * Jerarquía:  root (posición/yaw del jugador)
 *               └─ pivot (orientación frontal, escala, offset vertical)
 *                    └─ modelo FBX
 */

import * as THREE from "three";
import { FBXLoader } from "three/examples/jsm/loaders/FBXLoader.js";
import type { AnimationStateName, GameConfig, OneShotAction } from "./config";
import type { LocomotionState, RootMotionCurve } from "./PlayerController";

/** Lo que la animación necesita saber del controlador en cada frame. */
export interface AnimationDriver {
  state: LocomotionState;
  horizontalSpeed: number;
  velocity: { y: number };
  shooting: boolean;
  /** Tiempo del clip de la acción en curso (lo avanza el controlador a paso fijo). */
  actionClipTime: number;
}

const ONE_SHOTS: OneShotAction[] = ["punch", "kick", "dodge", "die"];
const isOneShot = (s: string): s is OneShotAction => (ONE_SHOTS as string[]).includes(s);
/** Muestras por segundo de las curvas de root motion. */
const ROOT_MOTION_RATE = 60;

export interface CharacterReport {
  url: string;
  meshes: { name: string; skinned: boolean; vertices: number; materials: string[]; hidden: boolean }[];
  bones: number;
  rootBone: string | null;
  clips: { name: string; duration: number; tracks: number; assignedTo: string | null; source: string; static: boolean }[];
  originalSize: THREE.Vector3;
  originalScale: THREE.Vector3;
  originalRotationDeg: THREE.Vector3;
  autoScale: number;
  autoForwardDeg: number;
  forwardMethod: string;
  groundOffset: number;
  walkClipSpeed: number;
  runClipSpeed: number;
  shootClipSpeed: number;
  neutralPoseTime: number;
  /** Desplazamiento neto del hueso raíz por acción (m), que aplica el controlador. */
  rootMotion: Partial<Record<OneShotAction, number>>;
  rootMotionRemoved: string[];
  missingStates: AnimationStateName[];
  warnings: string[];
}

type ActionSlot = {
  action: THREE.AnimationAction;
  weight: number;
  target: number;
  /** Etiqueta mostrada en el HUD. */
  label: string;
};

const STATE_PATTERNS: [AnimationStateName, RegExp][] = [
  ["idle", /idle|breath|stand/i],
  ["run", /run|sprint|jog/i],
  ["walk", /walk/i],
  ["jump", /jump/i],
  ["fall", /fall/i],
];

export class Character {
  readonly root = new THREE.Group();
  readonly pivot = new THREE.Group();
  readonly shadowBlob: THREE.Mesh;
  model!: THREE.Group;
  mixer!: THREE.AnimationMixer;
  report!: CharacterReport;
  /** Estado de animación legible para el HUD. */
  animationLabel = "sin cargar";

  private readonly clips = new Map<AnimationStateName, THREE.AnimationClip>();
  private walk: ActionSlot | null = null;
  private idle: ActionSlot | null = null;
  private run: ActionSlot | null = null;
  private jump: ActionSlot | null = null;
  private fall: ActionSlot | null = null;
  /** Correr disparando (cuerpo entero). */
  private shoot: ActionSlot | null = null;
  /** Disparar quieto: piernas del idle + torso del clip de disparo. */
  private aim: ActionSlot | null = null;
  private readonly oneShots = new Map<OneShotAction, ActionSlot>();
  /** Root motion extraído de las acciones (lo consume PlayerController). */
  readonly rootMotion = new Map<OneShotAction, RootMotionCurve>();
  private autoScale = 1;
  private autoForward = 0;
  private groundOffset = 0;
  private walkClipSpeed = 1.4;
  private runClipSpeed = 4;
  private shootClipSpeed = 2.3;
  private rightHand: THREE.Object3D | null = null;
  private activeSlots: ActionSlot[] = [];
  private readonly disposables: { dispose(): void }[] = [];

  constructor(private readonly config: GameConfig) {
    this.root.name = "player";
    this.pivot.name = "player-pivot";
    this.root.add(this.pivot);
    this.shadowBlob = createShadowBlob();
    this.disposables.push(this.shadowBlob.geometry, this.shadowBlob.material as THREE.Material);
  }

  async load(onProgress?: (loaded: number, total: number) => void): Promise<CharacterReport> {
    const { assets } = this.config;
    const loader = new FBXLoader();
    // Los clips extra se descargan en paralelo con el personaje.
    const extrasTask = loadExtraClips(loader, assets.extraAnimations);
    const model = await loader.loadAsync(assets.characterUrl, (e) => {
      if (e.total) onProgress?.(e.loaded, e.total);
    });
    this.model = model;
    model.name = "fbx-character";
    const warnings: string[] = [];

    // ---- Inspección --------------------------------------------------------
    const meshes: THREE.Mesh[] = [];
    const bones: THREE.Bone[] = [];
    model.traverse((o) => {
      if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh);
      if ((o as THREE.Bone).isBone) bones.push(o as THREE.Bone);
    });
    const skinned = meshes.filter((m) => (m as THREE.SkinnedMesh).isSkinnedMesh) as THREE.SkinnedMesh[];
    if (skinned.length === 0) warnings.push("El FBX no tiene SkinnedMesh: la animación esquelética no se verá.");

    // Mallas estáticas sueltas que no forman parte del personaje (Meshy exporta
    // una "Icosphere" de 2 m de diámetro centrada en el modelo).
    const hidden = new Set<THREE.Mesh>();
    if (this.config.character.hideAuxiliaryMeshes && skinned.length > 0) {
      for (const m of meshes) {
        if (!(m as THREE.SkinnedMesh).isSkinnedMesh && !isUnderBone(m)) {
          m.visible = false;
          hidden.add(m);
          warnings.push(`Malla auxiliar oculta: "${m.name}" (estática, sin skin, no es parte del personaje).`);
        }
      }
    }

    const rootBone = bones.find((b) => !(b.parent as THREE.Bone | null)?.isBone) ?? null;
    const originalScale = model.scale.clone();
    const originalRotationDeg = new THREE.Vector3(
      THREE.MathUtils.radToDeg(model.rotation.x),
      THREE.MathUtils.radToDeg(model.rotation.y),
      THREE.MathUtils.radToDeg(model.rotation.z),
    );

    // ---- Materiales PBR ------------------------------------------------------
    await this.convertMaterials(skinned.length ? skinned : meshes, warnings);
    for (const m of meshes) {
      m.castShadow = false;
      m.receiveShadow = false;
      // El bounding sphere de bind pose no acompaña la animación.
      m.frustumCulled = false;
    }

    // ---- Clips ----------------------------------------------------------------
    const clipReport: CharacterReport["clips"] = [];
    const baseName = assets.characterUrl.split("/").pop() ?? assets.characterUrl;
    for (const clip of model.animations) {
      const frozen = isStaticClip(clip);
      const state = frozen ? null : classifyClip(clip.name);
      if (state && !this.clips.has(state)) this.clips.set(state, clip);
      if (frozen) warnings.push(`Clip "${shortClipName(clip.name)}" de ${baseName} no tiene keyframes animados (pose estática): se ignora.`);
      clipReport.push({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length, assignedTo: state, source: baseName, static: frozen });
    }
    // Si sólo hay un clip válido y no se reconoció, asumimos que es la caminata.
    if (!this.clips.has("walk") && model.animations.length === 1 && !clipReport[0].static) {
      this.clips.set("walk", model.animations[0]);
      clipReport[0].assignedTo = "walk";
    }
    // Clips extra declarados en config (mismo rig Mixamo): pisan a los del FBX base.
    for (const extra of await extrasTask) {
      if (extra.error) {
        warnings.push(extra.error);
        continue;
      }
      const clip = extra.clip!;
      this.clips.set(extra.state, clip);
      clipReport.push({ name: clip.name, duration: clip.duration, tracks: clip.tracks.length, assignedTo: extra.state, source: extra.source, static: false });
    }
    // Pistas de huesos que el rig base no tiene: se descartan para no generar avisos de binding.
    const boneNames = new Set<string>();
    model.traverse((o) => boneNames.add(o.name));
    for (const clip of this.clips.values()) {
      clip.tracks = clip.tracks.filter((t) => boneNames.has(splitTrackName(t.name)[0]));
    }

    // Root motion: en los ciclos (walk/run/shoot) se quita la deriva neta; el
    // salto lo maneja la física (se fija la cadera); las acciones se procesan
    // más abajo, cuando ya está la escala en metros.
    const rootMotionRemoved: string[] = [];
    for (const [state, clip] of this.clips) {
      if (isOneShot(state)) continue;
      if (state === "jump") rootMotionRemoved.push(...flattenRootTranslation(clip, model, rootBone, true));
      else if (this.config.character.stripRootMotion) rootMotionRemoved.push(...stripRootMotion(clip, model, rootBone));
    }

    // ---- Normalización: escala, orientación, apoyo en el suelo --------------
    this.pivot.add(model);
    this.mixer = new THREE.AnimationMixer(model);
    const visibleSkinned = skinned.filter((m) => !hidden.has(m));
    const measureTargets: THREE.Object3D[] = visibleSkinned.length ? visibleSkinned : meshes.filter((m) => !hidden.has(m));

    model.updateMatrixWorld(true);
    const bindBox = boxOf(measureTargets, model);
    const originalSize = bindBox.getSize(new THREE.Vector3());
    const height = originalSize.y;
    if (height <= 0) throw new Error("El FBX no tiene geometría medible");
    this.autoScale = this.config.character.targetHeight / height;

    const forward = detectForward(model, bones);
    this.autoForward = -Math.atan2(forward.dir.x, forward.dir.z);

    // Medimos el apoyo y la velocidad natural del clip con la escala automática
    // y sin ajustes manuales (yOffset / scaleMultiplier se aplican después).
    this.pivot.scale.setScalar(this.autoScale);
    this.pivot.rotation.set(0, this.autoForward, 0);
    this.pivot.position.set(0, 0, 0);
    const walkClip = this.clips.get("walk");
    let neutralTime = 0;
    if (walkClip) {
      const analysis = analyseWalkClip(this, walkClip, measureTargets, bones);
      this.groundOffset = analysis.groundOffset;
      this.walkClipSpeed = analysis.speed;
      neutralTime = analysis.neutralTime;
    } else {
      this.root.updateMatrixWorld(true);
      this.groundOffset = -boxOf(measureTargets, this.root).min.y;
    }
    const runClip = this.clips.get("run");
    if (runClip) {
      const analysis = analyseWalkClip(this, runClip, measureTargets, bones);
      if (analysis.speedMeasured) this.runClipSpeed = analysis.speed;
      else warnings.push("No se pudo estimar la velocidad natural del clip de carrera: usando 4 m/s (ajustable en el panel).");
    }
    const shootClip = this.clips.get("shoot");
    if (shootClip) {
      const analysis = analyseWalkClip(this, shootClip, measureTargets, bones);
      if (analysis.speedMeasured) this.shootClipSpeed = analysis.speed;
    }
    // Acciones: el desplazamiento del hueso raíz se mide en metros (espacio del
    // personaje) y se quita del clip; el controlador lo aplica con colisiones.
    const rootMotionDistance: CharacterReport["rootMotion"] = {};
    for (const action of ONE_SHOTS) {
      const clip = this.clips.get(action);
      if (!clip || !rootBone) continue;
      const curve = sampleRootMotion(this, clip, rootBone);
      this.rootMotion.set(action, curve);
      const n = curve.x.length - 1;
      rootMotionDistance[action] = Math.hypot(curve.x[n], curve.z[n]);
      rootMotionRemoved.push(...flattenRootTranslation(clip, model, rootBone, false));
    }
    this.applyCalibration();

    // ---- Acciones ----------------------------------------------------------------
    this.rightHand = model.getObjectByName("mixamorigRightHand") ?? null;
    this.setupActions(neutralTime);

    const missing = (["idle", "walk", "run", "jump", "shoot", ...ONE_SHOTS] as AnimationStateName[]).filter((s) => !this.clips.has(s));
    if (missing.includes("idle"))
      warnings.push("No hay clip idle: el reposo usa una pose congelada del clip de caminata. Incorporar un idle (Mixamo) en config.assets.extraAnimations.");
    if (missing.includes("run")) warnings.push("No hay clip de carrera: se acelera la caminata.");
    if (missing.includes("jump")) warnings.push("No hay clip de salto: en el aire se congela la pose actual.");

    this.report = {
      url: this.config.assets.characterUrl,
      meshes: meshes.map((m) => ({
        name: m.name,
        skinned: !!(m as THREE.SkinnedMesh).isSkinnedMesh,
        vertices: m.geometry.attributes.position.count,
        materials: (Array.isArray(m.material) ? m.material : [m.material]).map((x) => `${x.name} (${x.type})`),
        hidden: hidden.has(m),
      })),
      bones: bones.length,
      rootBone: rootBone?.name ?? null,
      clips: clipReport,
      originalSize,
      originalScale,
      originalRotationDeg,
      autoScale: this.autoScale,
      autoForwardDeg: THREE.MathUtils.radToDeg(this.autoForward),
      forwardMethod: forward.method,
      groundOffset: this.groundOffset,
      walkClipSpeed: this.walkClipSpeed,
      runClipSpeed: this.runClipSpeed,
      shootClipSpeed: this.shootClipSpeed,
      neutralPoseTime: neutralTime,
      rootMotion: rootMotionDistance,
      rootMotionRemoved,
      missingStates: missing,
      warnings,
    };
    return this.report;
  }

  /** Reaplica escala / orientación / offset desde la config (panel de debug). */
  applyCalibration(): void {
    const c = this.config.character;
    const s = this.autoScale * c.scaleMultiplier;
    this.pivot.scale.setScalar(s);
    this.pivot.rotation.set(0, this.autoForward + THREE.MathUtils.degToRad(c.forwardOffsetDeg), 0);
    // groundOffset se mide con scaleMultiplier = 1; escala proporcionalmente.
    this.pivot.position.set(0, this.groundOffset * c.scaleMultiplier + c.yOffset, 0);
  }

  get effectiveWalkClipSpeed(): number {
    return this.config.character.walkClipSpeed > 0 ? this.config.character.walkClipSpeed : this.walkClipSpeed * this.config.character.scaleMultiplier;
  }

  get effectiveRunClipSpeed(): number {
    return this.config.character.runClipSpeed > 0 ? this.config.character.runClipSpeed : this.runClipSpeed * this.config.character.scaleMultiplier;
  }

  get effectiveShootClipSpeed(): number {
    return this.config.character.shootClipSpeed > 0 ? this.config.character.shootClipSpeed : this.shootClipSpeed * this.config.character.scaleMultiplier;
  }

  private setupActions(neutralTime: number): void {
    const make = (clip: THREE.AnimationClip, label: string, weight = 0): ActionSlot => {
      const action = this.mixer.clipAction(clip);
      action.setLoop(THREE.LoopRepeat, Infinity);
      action.enabled = true;
      action.setEffectiveWeight(weight);
      action.play();
      return { action, weight, target: weight, label };
    };
    const walkClip = this.clips.get("walk");
    if (walkClip) this.walk = make(walkClip, "walk");

    const idleClip = this.clips.get("idle");
    if (idleClip) {
      this.idle = make(idleClip, "idle", 1);
    } else if (walkClip) {
      // Pose de reposo provisoria: el clip de caminata congelado en el
      // instante con los pies más juntos. Clon con otro uuid → acción propia.
      const frozen = walkClip.clone();
      frozen.name = "idle-pose (walk congelado)";
      this.idle = make(frozen, "idle (pose congelada · falta clip idle)", 1);
      this.idle.action.time = neutralTime;
      this.idle.action.timeScale = 0;
    }
    const runClip = this.clips.get("run");
    if (runClip) this.run = make(runClip, "run");
    // Clips cuyo tiempo no corre solo: lo fija update() desde el controlador.
    const scrubbed = (clip: THREE.AnimationClip, label: string): ActionSlot => {
      const slot = make(clip, label);
      slot.action.timeScale = 0;
      return slot;
    };
    const jumpClip = this.clips.get("jump");
    if (jumpClip) this.jump = scrubbed(jumpClip, "jump");
    const fallClip = this.clips.get("fall");
    if (fallClip) this.fall = make(fallClip, "fall");

    const shootClip = this.clips.get("shoot");
    if (shootClip) {
      this.shoot = make(shootClip, "shoot");
      const base = idleClip ?? walkClip;
      if (base) {
        const aimClip = buildAimClip(base, shootClip, this.model);
        if (aimClip) this.aim = make(aimClip, "aim");
      }
    }
    for (const action of ONE_SHOTS) {
      const clip = this.clips.get(action);
      if (clip) this.oneShots.set(action, scrubbed(clip, action));
    }
    this.activeSlots = [this.idle, this.walk, this.run, this.jump, this.fall, this.shoot, this.aim, ...this.oneShots.values()].filter(Boolean) as ActionSlot[];
  }

  /** Avanza la animación según el estado del controlador. */
  update(dt: number, driver: AnimationDriver): void {
    if (!this.mixer) return;
    const { state, horizontalSpeed: speed } = driver;
    const slots = this.activeSlots;
    for (let i = 0; i < slots.length; i++) slots[i].target = 0;

    const clipSpeed = this.effectiveWalkClipSpeed;
    let label = "";
    const airborne = state === "jump" || state === "fall";
    const oneShot = isOneShot(state) ? this.oneShots.get(state) : undefined;

    if (oneShot) {
      // La acción avanza a paso fijo en el controlador: se muestra ese instante.
      const duration = oneShot.action.getClip().duration;
      oneShot.action.time = THREE.MathUtils.clamp(driver.actionClipTime, 0, duration - 1e-4);
      oneShot.target = 1;
      label = `${state} ${driver.actionClipTime.toFixed(2)} s`;
    } else if (isOneShot(state)) {
      if (this.idle) this.idle.target = 1;
      label = `${state} (falta clip)`;
    } else if (airborne) {
      if (state === "fall" && this.fall) {
        this.fall.target = 1;
        label = this.fall.label;
      } else if (this.jump) {
        // El clip sigue a la física: despegue (vy = +impulso) → 0, apogeo → ½,
        // aterrizaje a la misma altura → 1. Una caída sin salto arranca en el
        // apogeo; en caídas largas se frena antes de la pose de aterrizaje.
        const j = Math.max(0.1, this.config.movement.jumpSpeed);
        const progress = THREE.MathUtils.clamp((j - driver.velocity.y) / (2 * j), 0, 0.88);
        this.jump.action.time = progress * this.jump.action.getClip().duration;
        this.jump.target = 1;
        label = `${state} ${(progress * 100).toFixed(0)}%`;
      } else {
        // Sin clip aéreo: mantener la pose actual congelada.
        for (let i = 0; i < slots.length; i++) slots[i].target = slots[i].weight;
        if (this.walk) this.walk.action.timeScale = 0;
        label = `${state} (pose congelada · falta clip)`;
      }
    } else if (driver.shooting && (this.shoot || this.aim)) {
      if (state !== "idle" && speed > 0.3 && this.shoot) {
        const rate = THREE.MathUtils.clamp(speed / this.effectiveShootClipSpeed, 0.5, 1.8);
        this.shoot.action.timeScale = rate;
        this.shoot.target = 1;
        label = `shoot · corriendo ×${rate.toFixed(2)}`;
      } else {
        const slot = this.aim ?? this.shoot!;
        slot.target = 1;
        label = "shoot · apuntando";
      }
    } else if (state === "idle") {
      if (this.idle) this.idle.target = 1;
      label = this.idle?.label ?? "idle (sin pose)";
    } else if (state === "walk" || (state === "run" && !this.run)) {
      // Ajusta la cadencia a la velocidad real para que los pies no patinen
      // (con tope: por encima, la caminata acelerada deja de verse natural).
      const rate = THREE.MathUtils.clamp(speed / clipSpeed, 0.4, 2.6);
      if (this.walk) {
        this.walk.target = 1;
        this.walk.action.timeScale = rate;
      }
      label = state === "run" ? `run (walk ×${rate.toFixed(2)} · falta clip run)` : `walk ×${rate.toFixed(2)}`;
    } else if (state === "run" && this.run) {
      this.run.target = 1;
      const rate = THREE.MathUtils.clamp(speed / this.effectiveRunClipSpeed, 0.5, 1.8);
      this.run.action.timeScale = rate;
      label = `run ×${rate.toFixed(2)}`;
    }

    const fade = Math.max(0.01, this.config.character.crossFade);
    const k = 1 - Math.exp(-dt / (fade / 3));
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i];
      const target = s.target;
      s.weight += (target - s.weight) * k;
      if (Math.abs(target - s.weight) < 1e-3) s.weight = target;
      s.action.setEffectiveWeight(s.weight);
    }
    if (!airborne && this.walk && state !== "walk" && state !== "run") this.walk.action.timeScale = 1;

    this.mixer.update(dt);
    this.animationLabel = label;
  }

  /**
   * Punto aproximado de la boca del arma (el personaje no tiene arma modelada):
   * la mano derecha adelantada 25 cm hacia donde mira el personaje.
   */
  muzzleWorldPosition(target: THREE.Vector3): THREE.Vector3 {
    const hand = this.rightHand;
    if (!hand) return target.copy(this.root.position).setY(this.root.position.y + 1.4);
    hand.getWorldPosition(target);
    const yaw = this.root.rotation.y;
    target.x += Math.sin(yaw) * 0.25;
    target.z += Math.cos(yaw) * 0.25;
    return target;
  }

  setTransform(position: THREE.Vector3, yaw: number): void {
    this.root.position.copy(position);
    this.root.rotation.set(0, yaw, 0);
  }

  /** Sombra de contacto: sigue al jugador sobre el suelo y se achica al saltar. */
  updateShadow(feet: THREE.Vector3, groundY: number): void {
    const visible = this.config.character.castShadowBlob;
    this.shadowBlob.visible = visible;
    if (!visible) return;
    const height = Math.max(0, feet.y - groundY);
    const s = THREE.MathUtils.clamp(1 - height / 3, 0.35, 1);
    this.shadowBlob.position.set(feet.x, groundY + 0.02, feet.z);
    this.shadowBlob.scale.setScalar(s * this.config.character.targetHeight * 0.55);
    (this.shadowBlob.material as THREE.MeshBasicMaterial).opacity = 0.55 * s;
  }

  private async convertMaterials(meshes: THREE.Mesh[], warnings: string[]): Promise<void> {
    const { characterRoughnessUrl, characterMetalnessUrl } = this.config.assets;
    const texLoader = new THREE.TextureLoader();
    const loadOptional = async (url: string | null) => {
      if (!url) return null;
      try {
        const t = await texLoader.loadAsync(url);
        t.colorSpace = THREE.NoColorSpace;
        t.flipY = true;
        this.disposables.push(t);
        return t;
      } catch {
        warnings.push(`No se pudo cargar la textura ${url}; se usa un valor constante.`);
        return null;
      }
    };
    const [roughnessMap, metalnessMap] = await Promise.all([
      loadOptional(characterRoughnessUrl),
      loadOptional(characterMetalnessUrl),
    ]);

    for (const mesh of meshes) {
      const convert = (old: THREE.Material): THREE.Material => {
        const src = old as THREE.MeshPhongMaterial;
        const mat = new THREE.MeshStandardMaterial({
          name: `${src.name}-pbr`,
          map: src.map ?? null,
          normalMap: src.normalMap ?? null,
          normalScale: src.normalScale?.clone() ?? new THREE.Vector2(1, 1),
          roughnessMap,
          metalnessMap,
          roughness: roughnessMap ? 1 : 0.8,
          metalness: metalnessMap ? 1 : 0,
          color: 0xffffff,
          envMapIntensity: 0.6,
        });
        if (mat.map) mat.map.colorSpace = THREE.SRGBColorSpace;
        if (!src.map) warnings.push(`El material "${src.name}" no trae textura base.`);
        old.dispose();
        this.disposables.push(mat);
        if (mat.map) this.disposables.push(mat.map);
        if (mat.normalMap) this.disposables.push(mat.normalMap);
        return mat;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(convert) : convert(mesh.material);
    }
  }

  dispose(): void {
    this.mixer?.stopAllAction();
    if (this.model) this.mixer?.uncacheRoot(this.model);
    this.model?.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
    for (const d of this.disposables) d.dispose();
    this.root.removeFromParent();
    this.shadowBlob.removeFromParent();
  }
}

// ---------------------------------------------------------------------------
// Utilidades de análisis
// ---------------------------------------------------------------------------

function classifyClip(name: string): AnimationStateName | null {
  // El nombre de Meshy es "target_character|...|Walking": usamos el último segmento.
  const last = name.split("|").pop() ?? name;
  for (const [state, re] of STATE_PATTERNS) if (re.test(last)) return state;
  return null;
}

function shortClipName(name: string): string {
  return name.split("|").pop() ?? name;
}

/**
 * Un clip es "estático" si ningún hueso cambia de rotación ni de posición.
 * Pasa con exports de Meshy "Merged Animations" donde sólo se hornea una
 * animación y el resto queda como pose fija de 2 keys.
 */
export function isStaticClip(clip: THREE.AnimationClip): boolean {
  const q0 = new THREE.Quaternion();
  const q1 = new THREE.Quaternion();
  for (const t of clip.tracks) {
    const v = t.values;
    if (t.name.endsWith(".quaternion")) {
      q0.fromArray(v, 0);
      for (let i = 4; i < v.length; i += 4) if (q0.angleTo(q1.fromArray(v, i)) > 0.01) return false;
    } else if (t.name.endsWith(".position")) {
      for (let i = 3; i < v.length; i++) if (Math.abs(v[i] - v[i % 3]) > 1e-3) return false;
    }
  }
  return true;
}

type ExtraClipResult = { state: AnimationStateName; clip?: THREE.AnimationClip; source: string; error?: string };

/**
 * Descarga las animaciones extra (una vez por URL), extrae el clip pedido y
 * libera el resto. Acepta FBX o JSON de `THREE.AnimationClip.toJSON()`
 * (generado con `npm run extract:clip`, mucho más liviano).
 */
async function loadExtraClips(loader: FBXLoader, extras: GameConfig["assets"]["extraAnimations"]): Promise<ExtraClipResult[]> {
  const files = new Map<string, Promise<THREE.AnimationClip[]>>();
  const fetchJson = async (url: string) => {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as unknown;
    const list = Array.isArray(data) ? data : [data];
    return list.map((json) => THREE.AnimationClip.parse(json as Parameters<typeof THREE.AnimationClip.parse>[0]));
  };
  const fetchClips = (url: string) => {
    if (!files.has(url)) {
      files.set(
        url,
        /\.json(\?|$)/i.test(url) ? fetchJson(url) : loader.loadAsync(url).then((fbx) => {
          const clips = fbx.animations;
          // Sólo nos interesan las animaciones: liberar geometría, materiales y texturas.
          fbx.traverse((o) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.geometry.dispose();
            for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
              for (const value of Object.values(m)) if (value instanceof THREE.Texture) value.dispose();
              m.dispose();
            }
          });
          return clips;
        }),
      );
    }
    return files.get(url)!;
  };
  return Promise.all(
    extras.map(async (extra): Promise<ExtraClipResult> => {
      const source = `${extra.url.split("/").pop()}${extra.clip ? ` › ${extra.clip}` : ""}`;
      try {
        const clips = await fetchClips(extra.url);
        const clip = extra.clip ? clips.find((c) => shortClipName(c.name) === extra.clip || c.name === extra.clip) : clips[0];
        if (!clip) return { state: extra.state, source, error: `No existe el clip "${extra.clip}" en ${extra.url} (hay: ${clips.map((c) => shortClipName(c.name)).join(", ")})` };
        if (isStaticClip(clip)) return { state: extra.state, source, error: `El clip "${shortClipName(clip.name)}" de ${extra.url} es una pose estática (sin keyframes animados): no se usa para "${extra.state}".` };
        // Clon: el mismo clip podría usarse en más de un estado.
        return { state: extra.state, clip: clip.clone(), source };
      } catch (err) {
        return { state: extra.state, source, error: `No se pudo cargar la animación extra ${extra.url}: ${(err as Error).message}` };
      }
    }),
  );
}

function isUnderBone(o: THREE.Object3D): boolean {
  for (let p = o.parent; p; p = p.parent) if ((p as THREE.Bone).isBone) return true;
  return false;
}

/** Bounding box (precisa, con skinning) de varios objetos expresada en el espacio de `space`. */
function boxOf(objects: THREE.Object3D[], space: THREE.Object3D): THREE.Box3 {
  space.updateMatrixWorld(true);
  const inv = space.matrixWorld.clone().invert();
  const box = new THREE.Box3();
  const tmp = new THREE.Box3();
  for (const o of objects) {
    const mesh = o as THREE.SkinnedMesh;
    if (mesh.isSkinnedMesh) {
      mesh.computeBoundingBox();
      tmp.copy(mesh.boundingBox!).applyMatrix4(mesh.matrixWorld).applyMatrix4(inv);
    } else {
      tmp.setFromObject(o, true).applyMatrix4(inv);
    }
    box.union(tmp);
  }
  return box;
}

/** Detecta hacia dónde mira el modelo en su propio espacio. */
function detectForward(model: THREE.Object3D, bones: THREE.Bone[]): { dir: THREE.Vector3; method: string } {
  model.updateMatrixWorld(true);
  const inv = model.matrixWorld.clone().invert();
  const local = (b: THREE.Object3D) => b.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv);
  const find = (re: RegExp) => bones.find((b) => re.test(b.name));
  const dir = new THREE.Vector3();
  let method = "";

  // Puntas de los pies: los dedos apuntan hacia adelante.
  const pairs: [RegExp, RegExp][] = [
    [/LeftFoot$/i, /LeftToeBase$/i],
    [/RightFoot$/i, /RightToeBase$/i],
  ];
  for (const [a, b] of pairs) {
    const foot = find(a);
    const toe = find(b);
    if (foot && toe) dir.add(local(toe).sub(local(foot)));
  }
  if (dir.lengthSq() > 1e-6) method = "dedos de los pies (Foot → ToeBase)";

  if (!method) {
    const head = find(/Head$/i);
    const front = find(/headfront$/i);
    if (head && front) {
      dir.copy(local(front).sub(local(head)));
      method = "hueso headfront";
    }
  }
  dir.y = 0;
  if (dir.lengthSq() < 1e-8) {
    dir.set(0, 0, 1);
    method = "por defecto (+Z)";
  }
  return { dir: dir.normalize(), method };
}

/**
 * Elimina la traslación horizontal neta del hueso raíz a lo largo del clip
 * (root motion), conservando el balanceo y el rebote vertical.
 */
function stripRootMotion(clip: THREE.AnimationClip, model: THREE.Object3D, rootBone: THREE.Bone | null): string[] {
  const removed: string[] = [];
  const candidates = new Set<string>();
  if (rootBone) candidates.add(rootBone.name);
  for (const c of model.children) if (!(c as THREE.Mesh).isMesh) candidates.add(c.name);

  model.updateMatrixWorld(true);
  for (const track of clip.tracks) {
    const [nodeName, prop] = splitTrackName(track.name);
    if (prop !== "position" || !candidates.has(nodeName)) continue;
    const node = model.getObjectByName(nodeName);
    if (!node) continue;
    // Eje "arriba" del mundo expresado en el espacio del padre del nodo.
    const parentQuat = new THREE.Quaternion();
    node.parent?.getWorldQuaternion(parentQuat);
    const up = new THREE.Vector3(0, 1, 0).applyQuaternion(parentQuat.invert()).normalize();

    const v = track.values;
    const n = v.length / 3;
    if (n < 2) continue;
    const first = new THREE.Vector3(v[0], v[1], v[2]);
    const last = new THREE.Vector3(v[(n - 1) * 3], v[(n - 1) * 3 + 1], v[(n - 1) * 3 + 2]);
    const drift = last.sub(first);
    drift.addScaledVector(up, -drift.dot(up)); // sólo componente horizontal
    if (drift.length() < 1e-4) continue;
    const t0 = track.times[0];
    const span = track.times[n - 1] - t0 || 1;
    for (let i = 0; i < n; i++) {
      const f = (track.times[i] - t0) / span;
      v[i * 3] -= drift.x * f;
      v[i * 3 + 1] -= drift.y * f;
      v[i * 3 + 2] -= drift.z * f;
    }
    removed.push(`${clip.name}: ${track.name} (deriva ${drift.length().toFixed(3)})`);
  }
  return removed;
}

/**
 * Fija la traslación del hueso raíz al valor del primer frame: sólo en el plano
 * horizontal (acciones: el controlador aplica ese desplazamiento) o también en
 * vertical (salto: la altura la pone la física).
 */
function flattenRootTranslation(clip: THREE.AnimationClip, model: THREE.Object3D, rootBone: THREE.Bone | null, vertical: boolean): string[] {
  if (!rootBone) return [];
  const track = clip.tracks.find((t) => t.name === `${rootBone.name}.position`);
  if (!track || track.values.length < 6) return [];
  model.updateMatrixWorld(true);
  const parentQuat = new THREE.Quaternion();
  rootBone.parent?.getWorldQuaternion(parentQuat);
  const up = new THREE.Vector3(0, 1, 0).applyQuaternion(parentQuat.invert()).normalize();
  const v = track.values;
  const d = new THREE.Vector3();
  let max = 0;
  for (let i = 3; i < v.length; i += 3) {
    d.set(v[i] - v[0], v[i + 1] - v[1], v[i + 2] - v[2]);
    if (!vertical) d.addScaledVector(up, -d.dot(up));
    max = Math.max(max, d.length());
    v[i] -= d.x;
    v[i + 1] -= d.y;
    v[i + 2] -= d.z;
  }
  return max > 1e-4 ? [`${clip.name}: ${track.name} fijado${vertical ? "" : " en horizontal"} (máx. ${max.toFixed(1)} u)`] : [];
}

/** Trayectoria horizontal del hueso raíz en el espacio del personaje (m, +Z adelante). */
function sampleRootMotion(character: Character, clip: THREE.AnimationClip, rootBone: THREE.Bone): RootMotionCurve {
  const { root, mixer } = character;
  const action = mixer.clipAction(clip);
  action.play();
  const n = Math.max(2, Math.ceil(clip.duration * ROOT_MOTION_RATE) + 1);
  const x = new Float32Array(n);
  const z = new Float32Array(n);
  const inv = new THREE.Matrix4();
  const p = new THREE.Vector3();
  let x0 = 0;
  let z0 = 0;
  for (let i = 0; i < n; i++) {
    mixer.setTime(Math.min(i / ROOT_MOTION_RATE, clip.duration - 1e-4));
    root.updateMatrixWorld(true);
    inv.copy(root.matrixWorld).invert();
    rootBone.getWorldPosition(p).applyMatrix4(inv);
    if (i === 0) {
      x0 = p.x;
      z0 = p.z;
    }
    x[i] = p.x - x0;
    z[i] = p.z - z0;
  }
  action.stop();
  mixer.setTime(0);
  return { rate: ROOT_MOTION_RATE, x, z };
}

/**
 * Pose de disparo quieto: piernas y cadera de `base` (idle) + torso, brazos y
 * cabeza del primer frame de `shoot`. La rotación de la columna se corrige por
 * la diferencia de cadera entre ambos clips para que el torso quede orientado
 * igual que en el clip de disparo (y no inclinado por la cadera del idle).
 */
function buildAimClip(base: THREE.AnimationClip, shoot: THREE.AnimationClip, model: THREE.Object3D): THREE.AnimationClip | null {
  const spine = model.getObjectByName("mixamorigSpine");
  const hips = spine?.parent;
  if (!spine || !hips) return null;
  const upper = new Set<string>();
  spine.traverse((o) => upper.add(o.name));

  // createInterpolant existe en KeyframeTrack pero no está en los tipos.
  const evaluate = (track: THREE.KeyframeTrack, t: number): number[] =>
    Array.from((track as unknown as { createInterpolant(): THREE.Interpolant }).createInterpolant().evaluate(t) as ArrayLike<number>);
  const valueAt = (clip: THREE.AnimationClip, name: string, t: number): number[] | null => {
    const track = clip.tracks.find((tr) => tr.name === name);
    return track ? evaluate(track, t) : null;
  };
  const tracks = base.tracks.filter((t) => !upper.has(splitTrackName(t.name)[0])).map((t) => t.clone());
  const hipsBase = valueAt(base, `${hips.name}.quaternion`, 0);
  const hipsShoot = valueAt(shoot, `${hips.name}.quaternion`, 0);
  for (const t of shoot.tracks) {
    if (!upper.has(splitTrackName(t.name)[0])) continue;
    const value = evaluate(t, 0);
    if (t.name === `${spine.name}.quaternion` && hipsBase && hipsShoot) {
      const q = new THREE.Quaternion().fromArray(hipsBase).invert();
      q.multiply(new THREE.Quaternion().fromArray(hipsShoot)).multiply(new THREE.Quaternion().fromArray(value));
      q.toArray(value);
    }
    const Track = t.constructor as new (name: string, times: number[], values: number[]) => THREE.KeyframeTrack;
    tracks.push(new Track(t.name, [0], value));
  }
  return new THREE.AnimationClip(`aim (${shortClipName(base.name)} + ${shortClipName(shoot.name)})`, base.duration, tracks);
}

function splitTrackName(name: string): [string, string] {
  const i = name.lastIndexOf(".");
  return [name.slice(0, i), name.slice(i + 1)];
}

/**
 * Muestrea el clip de caminata para obtener:
 *  - groundOffset: cuánto subir el modelo para que el pie apoyado toque y = 0,
 *  - speed: velocidad (m/s) a la que el pie apoyado no patina,
 *  - neutralTime: instante con los pies más juntos (pose de reposo provisoria).
 */
function analyseWalkClip(
  character: Character,
  clip: THREE.AnimationClip,
  measureTargets: THREE.Object3D[],
  bones: THREE.Bone[],
): { groundOffset: number; speed: number; speedMeasured: boolean; neutralTime: number } {
  const root = character.root;
  const mixer = character.mixer;
  const action = mixer.clipAction(clip);
  action.play();
  const footL = bones.find((b) => /LeftFoot$/i.test(b.name));
  const footR = bones.find((b) => /RightFoot$/i.test(b.name));
  const inv = new THREE.Matrix4();
  const samples = 48;
  const mins: number[] = [];
  const feet: { l: THREE.Vector3; r: THREE.Vector3; t: number }[] = [];

  for (let i = 0; i < samples; i++) {
    const t = (clip.duration * i) / samples;
    mixer.setTime(t);
    root.updateMatrixWorld(true);
    mins.push(boxOf(measureTargets, root).min.y);
    if (footL && footR) {
      inv.copy(root.matrixWorld).invert();
      feet.push({
        l: footL.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv),
        r: footR.getWorldPosition(new THREE.Vector3()).applyMatrix4(inv),
        t,
      });
    }
  }
  action.stop();
  mixer.setTime(0);

  const sorted = [...mins].sort((a, b) => a - b);
  const groundOffset = -sorted[Math.floor(sorted.length / 2)];

  let speed = 1.4;
  let speedMeasured = false;
  let neutralTime = 0;
  if (feet.length) {
    // Velocidad: el pie apoyado (el más bajo) retrocede respecto del cuerpo
    // a la velocidad con la que el cuerpo avanza. Adelante = +Z local.
    const dt = clip.duration / samples;
    const vels: number[] = [];
    for (const key of ["l", "r"] as const) {
      const minY = Math.min(...feet.map((f) => f[key].y));
      for (let i = 0; i < feet.length; i++) {
        const a = feet[i][key];
        const b = feet[(i + 1) % feet.length][key];
        if (a.y < minY + 0.03 && b.y < minY + 0.03) vels.push(-(b.z - a.z) / dt);
      }
    }
    vels.sort((a, b) => a - b);
    const median = vels.length ? vels[Math.floor(vels.length / 2)] : 0;
    if (median > 0.3 && median < 9) {
      speed = median;
      speedMeasured = true;
    }

    // Pose neutra: pies juntos y a la misma altura.
    let best = Infinity;
    for (const f of feet) {
      const score = Math.hypot(f.l.x - f.r.x, f.l.z - f.r.z) * 0.6 + Math.abs(f.l.z - f.r.z) + 2 * Math.abs(f.l.y - f.r.y);
      if (score < best) {
        best = score;
        neutralTime = f.t;
      }
    }
  }
  return { groundOffset, speed, speedMeasured, neutralTime };
}

export function createShadowBlob(): THREE.Mesh {
  const size = 128;
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext("2d")!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, "rgba(0,0,0,0.85)");
  g.addColorStop(0.45, "rgba(0,0,0,0.45)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, depthWrite: false, opacity: 0.55 }),
  );
  mesh.name = "player-shadow";
  // Dibujar después de los splats para que el suelo no lo tape.
  mesh.renderOrder = 10;
  return mesh;
}
