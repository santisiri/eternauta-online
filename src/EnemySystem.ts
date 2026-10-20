/**
 * Cascarudos: la invasión que recorre Buenos Aires.
 *
 * - Carga el GLB una sola vez y clona malla + esqueleto por individuo
 *   (SkeletonUtils), con material propio (color y reflejo del caparazón).
 * - IA a paso fijo (`enemies.tickRate`, 30 Hz) e interpolada en el render,
 *   igual que el jugador: sólo usa la malla de colisiones (nunca el splat),
 *   así que podría correr en un servidor autoritativo.
 *     deambular → alerta (se para en dos patas y chilla, `alertTime`)
 *     → perseguir (o directo al recibir un tiro) → morder (se yergue y
 *     golpea con las mandíbulas) → morir (panza arriba, patas encogidas)
 *     → hundirse en la nieve y reaparecer lejos del jugador.
 * - Aparecen por todo el mapa: puntos al azar dentro de los límites con
 *   suelo caminable a la altura de la plaza (no techos ni interiores).
 */

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import * as SkeletonUtils from "three/examples/jsm/utils/SkeletonUtils.js";
import { CascarudoRig, type CascarudoPose } from "./CascarudoRig";
import type { CollisionSystem } from "./CollisionSystem";
import type { GameConfig } from "./config";

type EnemyState = "wander" | "alert" | "chase" | "attack" | "dead";

/**
 * Cuerpo físico contra el escenario (escala 1, m). Bastante más chico que el
 * visual: las patas abiertas rozan paredes y bancos, como un insecto real; con
 * el radio visual una bestia de 3,6 m no pasaría entre los canteros. Se
 * consulta con los pies elevados `BODY_LIFT`: las esferas de
 * `resolveHorizontal` no deben tocar el piso, o lo confunden con una pared y
 * empujan en cualquier pendiente leve.
 */
const BODY_RADIUS = 0.45;
const BODY_HEIGHT = 1.0;
const BODY_LIFT = 0.35;
/** Radio visual: separación entre cascarudos y con el jugador. */
const VISUAL_RADIUS = 0.9;
/** Esfera de impacto (centro sobre los pies y radio, escala 1). */
const HIT_CENTER_Y = 0.85;
const HIT_RADIUS = 0.95;
/** Altura del caparazón dado vuelta, para apoyarlo sobre el suelo. */
const FLIPPED_HEIGHT = 1.45;
/** Escalón máximo que sube caminando y pendiente máxima (m, grados). */
const MAX_STEP = 0.45;
const MAX_SLOPE_DEG = 35;
const TURN_SPEED = 2.6;
/** Vuelco al morir (s a escala 1; los grandes caen más lento: × √escala). */
const FLIP_TIME = 0.55;
/** Erguirse antes de morder (s): anticipa el golpe. */
const WINDUP = 0.5;
/** Distancia máxima al jugador para emitir polvo de pisadas (m). */
const FOOTSTEP_RANGE = 45;
/**
 * Reflejo del entorno sobre el caparazón. El mapa del modelo es casi cromo:
 * con el RoomEnvironment de la escena (blanco, pensado para el traje del
 * protagonista) los cascarudos se veían plateados y translúcidos.
 */
const ENV_INTENSITY = 0.08;
const SINK_TIME = 1.6;

export interface Enemy {
  readonly id: number;
  readonly root: THREE.Group;
  readonly rig: CascarudoRig;
  readonly material: THREE.MeshStandardMaterial;
  readonly position: THREE.Vector3;
  readonly previousPosition: THREE.Vector3;
  yaw: number;
  previousYaw: number;
  speed: number;
  state: EnemyState;
  health: number;
  stateTime: number;
  wanderYaw: number;
  wanderTimer: number;
  /** Rodeo tras chocar: desvío (rad) y tiempo restante. */
  detour: number;
  detourTimer: number;
  attackTimer: number;
  pose: CascarudoPose;
  active: boolean;
  /** Distancia horizontal al jugador en el último tick. */
  distance: number;
  /** Altura suavizada del render (subir un escalón no es un salto brusco). */
  renderY: number;
  /** Fase de marcha del frame anterior (detección de pisadas). */
  renderGait: number;
  dripTimer: number;
  /** Rumbo elegido por la navegación local al perseguir, y cuándo recalcularlo. */
  steerYaw: number;
  steerTimer: number;
  /** Control de progreso al perseguir: distancia de referencia y tiempo. */
  progressDist: number;
  progressTimer: number;
}

export interface EnemyHit {
  enemy: Enemy;
  distance: number;
  point: THREE.Vector3;
  normal: THREE.Vector3;
}

export class EnemySystem {
  readonly group = new THREE.Group();
  readonly enemies: Enemy[] = [];
  /** Cascarudos abatidos en esta partida (contador del HUD). */
  kills = 0;
  ready = false;
  /** Mordida al jugador: daño y origen (para el indicador de dirección). */
  onPlayerBitten?: (damage: number, from: THREE.Vector3) => void;
  onEnemyKilled?: (enemy: Enemy) => void;
  /** Una pata apoyó en el suelo (polvo de nieve, temblor de cámara). */
  onFootstep?: (point: THREE.Vector3, enemy: Enemy) => void;
  /** Detectó al jugador: se para en dos patas y chilla. */
  onAlert?: (enemy: Enemy) => void;
  /** Recibió daño sin morir. */
  onHurt?: (enemy: Enemy) => void;
  /** Empieza a erguirse para morder (siseo). */
  onWindup?: (enemy: Enemy) => void;
  /** Cierra las mandíbulas (conecte o no). */
  onBite?: (enemy: Enemy) => void;
  /** Un herido chorrea hemolinfa desde `point`; el suelo está en `groundY`. */
  onDrip?: (point: THREE.Vector3, groundY: number) => void;
  /** Mapa de entorno propio (el de la escena, atenuado con ENV_INTENSITY). */
  envMap: THREE.Texture | null = null;

  private template: THREE.Object3D | null = null;
  private sourceMaterial: THREE.MeshStandardMaterial | null = null;
  private readonly shadowGeometry: THREE.BufferGeometry;
  private readonly shadowMaterial: THREE.MeshBasicMaterial;
  private accumulator = 0;
  private time = 0;
  private nextId = 1;
  private respawnQueue: number[] = [];
  private readonly player = new THREE.Vector3();
  private playerAlive = true;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly ray = new THREE.Ray();
  private readonly feet = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  private readonly frustum = new THREE.Frustum();
  private readonly projScreenMatrix = new THREE.Matrix4();
  private readonly cullSphere = new THREE.Sphere();
  private renderFrame = 0;
  private readonly disposables: { dispose(): void }[] = [];

  constructor(
    private readonly config: GameConfig,
    private readonly collision: CollisionSystem,
    /** Sombra de contacto de referencia (createShadowBlob): se comparte entre todos. */
    shadow: THREE.Mesh,
  ) {
    this.group.name = "cascarudos";
    this.shadowGeometry = shadow.geometry;
    this.shadowMaterial = shadow.material as THREE.MeshBasicMaterial;
    this.disposables.push(this.shadowGeometry, this.shadowMaterial);
    if (this.shadowMaterial.map) this.disposables.push(this.shadowMaterial.map);
  }

  async load(onProgress?: (loaded: number, total: number) => void): Promise<{ bones: number; triangles: number }> {
    const gltf = await new GLTFLoader().loadAsync(this.config.assets.enemyUrl, (e) => {
      if (e.total) onProgress?.(e.loaded, e.total);
    });
    this.template = gltf.scene;
    let bones = 0;
    let triangles = 0;
    gltf.scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) bones++;
      const mesh = o as THREE.SkinnedMesh;
      if (!mesh.isMesh) return;
      mesh.frustumCulled = false; // los huesos se mueven fuera del bounding box de reposo
      triangles += (mesh.geometry.index?.count ?? mesh.geometry.attributes.position.count) / 3;
      this.sourceMaterial = mesh.material as THREE.MeshStandardMaterial;
      this.disposables.push(mesh.geometry);
    });
    if (!this.sourceMaterial) throw new Error("El GLB del cascarudo no tiene malla");
    const m = this.sourceMaterial;
    for (const t of [m.map, m.normalMap, m.roughnessMap, m.metalnessMap]) if (t) this.disposables.push(t);
    this.disposables.push(m);
    // Validar el rig una vez (lanza si faltan huesos).
    new CascarudoRig(gltf.scene);
    this.ready = true;
    return { bones, triangles };
  }

  /** Puebla el mapa (al entrar al juego o al reiniciar la partida). */
  populate(player: THREE.Vector3): void {
    if (!this.ready || !this.config.enemies.enabled) return;
    this.player.copy(player);
    for (const e of this.enemies) this.despawn(e);
    this.enemies.length = 0;
    this.respawnQueue = [];
    this.kills = 0;
    for (let i = 0; i < this.config.enemies.count; i++) this.spawn();
  }

  /**
   * Al reaparecer el jugador: los cascarudos vivos cerca del punto de
   * reaparición se trasladan a otro lugar del mapa (y todos se calman).
   */
  clearArea(center: THREE.Vector3, radius: number): void {
    this.player.copy(center);
    for (const e of this.enemies) {
      if (!e.active || e.state === "dead") continue;
      this.setState(e, "wander");
      if (e.position.distanceTo(center) >= radius) continue;
      this.despawn(e);
      this.spawn();
    }
  }

  get aliveCount(): number {
    let n = 0;
    for (let i = 0; i < this.enemies.length; i++) {
      const e = this.enemies[i];
      if (e.active && e.state !== "dead") n++;
    }
    return n;
  }

  private createEnemy(): Enemy {
    const root = new THREE.Group();
    const model = SkeletonUtils.clone(this.template!) as THREE.Object3D;
    const material = this.sourceMaterial!.clone();
    // Quitina oscura: el color base del modelo, un poco más sombrío.
    material.color.setScalar(0.72);
    material.envMap = this.envMap;
    material.envMapIntensity = ENV_INTENSITY;
    model.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh) {
        mesh.material = material;
        mesh.frustumCulled = false;
      }
    });
    root.add(model);
    root.rotation.order = "YZX"; // yaw, luego vuelco sobre el eje frontal
    const shadow = new THREE.Mesh(this.shadowGeometry, this.shadowMaterial);
    shadow.renderOrder = 10;
    shadow.name = "cascarudo-shadow";
    root.userData.shadow = shadow;
    this.group.add(root, shadow);
    const rig = new CascarudoRig(model);
    return {
      id: this.nextId++,
      root,
      rig,
      material,
      position: new THREE.Vector3(),
      previousPosition: new THREE.Vector3(),
      yaw: 0,
      previousYaw: 0,
      speed: 0,
      state: "wander",
      health: 0,
      stateTime: 0,
      wanderYaw: 0,
      wanderTimer: 0,
      detour: 0,
      detourTimer: 0,
      attackTimer: 0,
      pose: { gait: 0, stride: 0, turnRate: 0, attack: 0, hurt: 0, rear: 0, death: 0, deathTime: 0, time: 0, seed: Math.random() * 100 },
      active: false,
      distance: Infinity,
      renderY: NaN,
      renderGait: 0,
      dripTimer: 0,
      steerYaw: 0,
      steerTimer: 0,
      progressDist: Infinity,
      progressTimer: 0,
    };
  }

  private spawn(): Enemy | null {
    const point = this.findSpawnPoint();
    if (!point) return null;
    // Reutilizar un cadáver ya hundido antes de clonar otro esqueleto.
    let e = this.enemies.find((x) => !x.active);
    if (!e) {
      e = this.createEnemy();
      this.enemies.push(e);
    }
    const c = this.config.enemies;
    e.position.copy(point);
    e.previousPosition.copy(point);
    e.yaw = e.previousYaw = e.wanderYaw = Math.random() * Math.PI * 2;
    e.speed = 0;
    e.state = "wander";
    e.health = c.health;
    e.stateTime = 0;
    e.wanderTimer = 2 + Math.random() * 4;
    e.detourTimer = 0;
    e.attackTimer = 0;
    e.active = true;
    Object.assign(e.pose, { stride: 0, attack: 0, hurt: 0, rear: 0, death: 0, deathTime: 0 });
    e.renderY = NaN;
    e.renderGait = e.pose.gait;
    e.root.visible = true;
    e.root.scale.setScalar(c.scale);
    (e.root.userData.shadow as THREE.Mesh).visible = true;
    return e;
  }

  private despawn(e: Enemy): void {
    e.active = false;
    e.root.visible = false;
    (e.root.userData.shadow as THREE.Mesh).visible = false;
  }

  /**
   * Punto al azar con suelo caminable a la altura de la plaza, lejos del
   * jugador y sin solaparse con obstáculos ni con otros cascarudos.
   */
  private findSpawnPoint(): THREE.Vector3 | null {
    const c = this.config.enemies;
    const b = this.config.world.bounds;
    const s = c.scale;
    const minNormalY = Math.cos(THREE.MathUtils.degToRad(MAX_SLOPE_DEG));
    // Referencia de altura: el suelo bajo el spawn del jugador.
    const spawn = this.config.world.spawn;
    const plazaY = this.collision.groundHeight(spawn.x, spawn.z, spawn.y + 2) ?? spawn.y;
    for (let attempt = 0; attempt < 60; attempt++) {
      const x = THREE.MathUtils.lerp(b.minX + 3, b.maxX - 3, Math.random());
      const z = THREE.MathUtils.lerp(b.minZ + 3, b.maxZ - 3, Math.random());
      const dist = Math.hypot(x - this.player.x, z - this.player.z);
      // Con pocos intentos restantes se relaja la distancia mínima.
      if (dist < c.spawnMinDistance * (attempt < 40 ? 1 : 0.6)) continue;
      const g = this.collision.groundSample(x, z, plazaY + 1.5);
      // Al nivel del piso de la plaza: ni techos ni canteros (los arbustos del splat lo taparían).
      if (!g || g.normalY < minNormalY || Math.abs(g.height - plazaY) > 0.6) continue;
      const p = new THREE.Vector3(x, g.height, z);
      // Lugar despejado: el empuje de las colisiones no debe moverlo.
      this.tmp.copy(p);
      this.resolveBody(this.tmp);
      if (this.tmp.distanceToSquared(p) > 0.01) continue;
      if (this.enemies.some((o) => o.active && o.position.distanceToSquared(p) < (3 * s) ** 2)) continue;
      return p;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // Simulación
  // ---------------------------------------------------------------------------

  /** Avanza la IA a paso fijo y actualiza las poses (llamar una vez por frame). */
  update(frameDt: number, player: THREE.Vector3, playerAlive: boolean, camera?: THREE.Camera): void {
    if (!this.ready) return;
    this.player.copy(player);
    this.playerAlive = playerAlive;
    const step = 1 / this.config.enemies.tickRate;
    this.accumulator += frameDt;
    let ticks = 0;
    while (this.accumulator >= step && ticks < 4) {
      this.fixedUpdate(step);
      this.accumulator -= step;
      ticks++;
    }
    if (ticks === 4) this.accumulator = 0;
    this.render(frameDt, this.accumulator / step, camera);
  }

  private fixedUpdate(dt: number): void {
    this.time += dt;
    for (const e of this.enemies) if (e.active) this.think(e, dt);
    this.separate();

    // Reemplazos de los muertos.
    for (let i = this.respawnQueue.length - 1; i >= 0; i--) {
      if (this.time < this.respawnQueue[i]) continue;
      if (this.spawn()) this.respawnQueue.splice(i, 1);
      else this.respawnQueue[i] = this.time + 1; // sin lugar: reintentar
    }
  }

  private think(e: Enemy, dt: number): void {
    const c = this.config.enemies;
    const s = c.scale;
    e.previousPosition.copy(e.position);
    e.previousYaw = e.yaw;
    e.stateTime += dt;
    e.pose.hurt = Math.max(0, e.pose.hurt - dt * 3);

    if (e.state === "dead") {
      e.speed = 0;
      e.pose.deathTime = e.stateTime;
      if (e.stateTime > c.corpseTime + SINK_TIME) this.despawn(e);
      return;
    }

    const dx = this.player.x - e.position.x;
    const dz = this.player.z - e.position.z;
    e.distance = Math.hypot(dx, dz);
    const toPlayerYaw = Math.atan2(dx, dz);
    const reach = c.attackRange * s;

    // --- Transiciones -----------------------------------------------------------
    if (!this.playerAlive) {
      if (e.state !== "wander") this.setState(e, "wander");
    } else if (e.state === "wander" && e.distance < c.aggroRange) {
      this.setState(e, c.alertTime > 0 ? "alert" : "chase");
    } else if (e.state === "alert" && e.stateTime > c.alertTime) {
      this.setState(e, "chase");
    } else if (e.state === "chase") {
      if (e.distance < reach) this.setState(e, "attack");
      else if (e.distance > c.aggroRange * 1.6) this.setState(e, "wander");
    } else if (e.state === "attack" && e.distance > reach * 1.25) {
      this.setState(e, "chase");
    }

    // --- Rumbo y velocidad deseados ---------------------------------------------
    let targetYaw = e.yaw;
    let targetSpeed = 0;
    let rear = 0;
    if (e.state === "alert") {
      // Gira hacia el jugador y se para en dos patas, mandíbulas abiertas.
      targetYaw = toPlayerYaw;
      const facing = Math.cos(toPlayerYaw - e.yaw);
      rear = facing > 0.7 ? 1 : 0.3;
    } else if (e.state === "wander") {
      e.wanderTimer -= dt;
      if (e.wanderTimer <= 0) {
        e.wanderYaw += (Math.random() - 0.5) * 2.4;
        e.wanderTimer = 2.5 + Math.random() * 5;
      }
      targetYaw = e.wanderYaw;
      // Pausas cortas para olfatear.
      targetSpeed = e.wanderTimer % 4 < 0.8 ? 0 : c.wanderSpeed;
    } else if (e.state === "chase") {
      // Sin acercarse en 2 s: está encerrado; probar un rodeo amplio un rato.
      e.progressTimer += dt;
      if (e.progressTimer > 2) {
        if (e.distance > e.progressDist - 1 && e.detourTimer <= 0) {
          e.detour = (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 2 + Math.random() * Math.PI / 3);
          e.detourTimer = 1.5 + Math.random();
        }
        e.progressDist = e.distance;
        e.progressTimer = 0;
      }
      if (e.detourTimer > 0) e.detourTimer -= dt;
      e.steerTimer -= dt;
      if (e.steerTimer <= 0) {
        e.steerTimer = 0.35;
        e.steerYaw = this.steer(e, toPlayerYaw + (e.detourTimer > 0 ? e.detour : 0));
      }
      targetYaw = e.steerYaw;
      targetSpeed = c.chaseSpeed;
    } else if (e.state === "attack") {
      targetYaw = toPlayerYaw;
      e.attackTimer -= dt;
      // Se yergue antes del golpe y cae con todo el peso sobre la mordida.
      rear = THREE.MathUtils.clamp((WINDUP - e.attackTimer) / WINDUP, 0, 1);
      if (e.attackTimer <= WINDUP && e.attackTimer + dt > WINDUP) this.onWindup?.(e);
      if (e.attackTimer <= 0) {
        rear = 0;
        this.onBite?.(e);
        e.attackTimer = c.attackInterval;
        // La mordida conecta a mitad de la embestida.
        e.pose.attack = 1;
        if (this.playerAlive && e.distance < reach * 1.15) {
          this.tmp.copy(e.position);
          this.onPlayerBitten?.(c.attackDamage, this.tmp);
        }
      }
    }
    if (e.detourTimer > 0 && e.state !== "chase") {
      e.detourTimer -= dt;
      targetYaw += e.detour;
    }

    // --- Giro y aceleración --------------------------------------------------------
    const diff = Math.atan2(Math.sin(targetYaw - e.yaw), Math.cos(targetYaw - e.yaw));
    const maxTurn = TURN_SPEED * dt;
    const turn = THREE.MathUtils.clamp(diff, -maxTurn, maxTurn);
    e.yaw += turn;
    e.pose.turnRate = turn / dt;
    // Frenar para girar en el lugar si el rumbo está muy desviado.
    if (Math.abs(diff) > 1.2) targetSpeed *= 0.3;
    const accel = targetSpeed > e.speed ? 4 : 8;
    e.speed += THREE.MathUtils.clamp(targetSpeed - e.speed, -accel * dt, accel * dt);
    e.pose.attack = Math.max(0, e.pose.attack - dt * 2.2);
    // Subir es lento (amenaza); bajar, un golpe.
    const rearRate = rear > e.pose.rear ? 5 : 18;
    e.pose.rear += (rear - e.pose.rear) * (1 - Math.exp(-rearRate * dt));

    // Los heridos chorrean y dejan rastro en la nieve.
    if (e.health < c.health) {
      e.dripTimer -= dt;
      if (e.dripTimer <= 0) {
        e.dripTimer = (0.12 + Math.random() * 0.35) * (0.4 + e.health / c.health);
        const a = Math.random() * Math.PI * 2;
        const r = Math.random() * 0.55 * s;
        this.tmp2.set(e.position.x + Math.cos(a) * r, e.position.y + (0.75 + Math.random() * 0.25) * s, e.position.z + Math.sin(a) * r);
        this.onDrip?.(this.tmp2, e.position.y);
      }
    }

    // --- Movimiento con colisiones -------------------------------------------------
    if (e.speed > 0.01) {
      const fx = Math.sin(e.yaw);
      const fz = Math.cos(e.yaw);
      const next = this.tmp.set(e.position.x + fx * e.speed * dt, e.position.y, e.position.z + fz * e.speed * dt);
      this.resolveBody(next);
      // Escalón fijo aunque sea enorme: si se sube a los canteros queda metido en
      // los arbustos del splat, que lo tapan y lo hacen ver translúcido.
      const maxStep = MAX_STEP;
      const g = this.collision.groundSample(next.x, next.z, e.position.y + maxStep);
      const minNormalY = Math.cos(THREE.MathUtils.degToRad(MAX_SLOPE_DEG));
      const blocked =
        !g ||
        g.height - e.position.y > maxStep ||
        (g.normalY < minNormalY && g.height > e.position.y + 0.02) ||
        g.height < e.position.y - 2;
      if (blocked) {
        this.onBlocked(e);
      } else {
        const moved = Math.hypot(next.x - e.position.x, next.z - e.position.z);
        // Si las colisiones lo frenan casi del todo, está trabado contra algo.
        if (moved < e.speed * dt * 0.25) this.onBlocked(e);
        e.position.set(next.x, g.height, next.z);
        e.pose.gait += moved / (e.rig.strideLength * s * Math.max(0.3, e.pose.stride));
      }
    }
    e.pose.stride = THREE.MathUtils.clamp(e.speed / 0.7, 0, 1);
  }

  /**
   * Navegación local: prueba rumbos alrededor de `desired` (0°, ±30°, ±60°…)
   * y devuelve el primero con suelo caminable y sin obstáculos a ~1 cuerpo y
   * medio de distancia. Alcanza para rodear canteros, bancos y el colectivo.
   */
  private steer(e: Enemy, desired: number): number {
    const s = this.config.enemies.scale;
    const ahead = 2.6 * s;
    const minNormalY = Math.cos(THREE.MathUtils.degToRad(MAX_SLOPE_DEG));
    // Preferir el lado hacia el que ya venía girando (evita titubeos).
    const bias = Math.sign(Math.sin(e.steerYaw - desired)) || 1;
    for (const k of [0, 1, -1, 2, -2, 3, -3, 4, -4]) {
      const yaw = desired + k * bias * (Math.PI / 6);
      let ok = true;
      for (const d of [ahead * 0.5, ahead]) {
        const p = this.tmp2.set(e.position.x + Math.sin(yaw) * d, e.position.y, e.position.z + Math.cos(yaw) * d);
        const g = this.collision.groundSample(p.x, p.z, e.position.y + MAX_STEP);
        if (!g || Math.abs(g.height - e.position.y) > MAX_STEP + 0.1 * d || (g.normalY < minNormalY && g.height > e.position.y + 0.02)) {
          ok = false;
          break;
        }
        const x = p.x;
        const z = p.z;
        p.y = g.height;
        this.resolveBody(p);
        if (Math.hypot(p.x - x, p.z - z) > 0.25 * s) {
          ok = false;
          break;
        }
      }
      if (ok) return yaw;
    }
    // Encerrado: dar media vuelta para salir.
    return desired + Math.PI;
  }

  /** Empuja el cuerpo fuera de paredes y obstáculos (sólo en XZ). */
  private resolveBody(p: THREE.Vector3): void {
    const s = this.config.enemies.scale;
    const y = p.y;
    p.y += BODY_LIFT * s;
    this.collision.resolveHorizontal(p, BODY_RADIUS * s, BODY_HEIGHT * s);
    p.y = y;
  }

  private onBlocked(e: Enemy): void {
    if (e.detourTimer > 0) return;
    if (e.state === "wander") {
      e.wanderYaw = e.yaw + Math.PI * (0.6 + Math.random() * 0.8) * (Math.random() < 0.5 ? -1 : 1);
      e.wanderTimer = 3 + Math.random() * 3;
    } else {
      // Rodear el obstáculo hacia un costado durante un rato.
      e.detour = (Math.random() < 0.5 ? -1 : 1) * (Math.PI / 2);
      e.detourTimer = 0.8 + Math.random() * 0.8;
    }
  }

  private setState(e: Enemy, state: EnemyState): void {
    if (e.state === state) return;
    e.state = state;
    e.stateTime = 0;
    if (state === "attack") e.attackTimer = WINDUP + 0.15;
    if (state === "alert") this.onAlert?.(e);
    if (state === "wander") e.wanderYaw = e.yaw;
    if (state === "chase") {
      e.steerTimer = 0;
      e.progressDist = Infinity;
      e.progressTimer = 0;
    }
  }

  /** Empuja a los cascarudos entre sí y fuera del jugador. */
  private separate(): void {
    const s = this.config.enemies.scale;
    const min = VISUAL_RADIUS * 2 * s;
    const keep = (VISUAL_RADIUS + 0.5) * s;
    const n = this.enemies.length;
    for (let i = 0; i < n; i++) {
      const a = this.enemies[i];
      if (!a.active || a.state === "dead") continue;
      for (let j = i + 1; j < n; j++) {
        const b = this.enemies[j];
        if (!b.active || b.state === "dead") continue;
        const dx = b.position.x - a.position.x;
        const dz = b.position.z - a.position.z;
        const d = Math.hypot(dx, dz);
        if (d >= min || d < 1e-4) continue;
        const push = (min - d) / 2;
        a.position.x -= (dx / d) * push;
        a.position.z -= (dz / d) * push;
        b.position.x += (dx / d) * push;
        b.position.z += (dz / d) * push;
      }
      // Nunca encima del jugador.
      const px = a.position.x - this.player.x;
      const pz = a.position.z - this.player.z;
      const pd = Math.hypot(px, pz);
      if (pd < keep && pd > 1e-4) {
        a.position.x = this.player.x + (px / pd) * keep;
        a.position.z = this.player.z + (pz / pd) * keep;
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Disparos
  // ---------------------------------------------------------------------------

  /**
   * Primer cascarudo vivo atravesado por el rayo (esfera de impacto por
   * individuo, agrandada `assist` m con controles táctiles).
   */
  raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number, assist = 0): EnemyHit | null {
    const s = this.config.enemies.scale;
    const radius = HIT_RADIUS * s;
    let best: EnemyHit | null = null;
    this.ray.set(origin, dir);
    for (const e of this.enemies) {
      if (!e.active || e.state === "dead") continue;
      const center = this.tmp.copy(e.position);
      center.y += HIT_CENTER_Y * s;
      // Primero con el radio real; si no, con la ayuda de apuntado.
      let hit = this.ray.intersectSphere(this.sphere(center, radius), this.tmp2);
      if (!hit && assist > 0) {
        if (this.ray.distanceSqToPoint(center) > (radius + assist) ** 2) continue;
        // Con ayuda: el impacto va al punto de la esfera más cercano al rayo.
        this.ray.closestPointToPoint(center, this.tmp2);
        this.tmp2.sub(center).setLength(radius * 0.9).add(center);
        hit = this.tmp2;
      }
      if (!hit) continue;
      const distance = hit.distanceTo(origin);
      if (distance > maxDist || (best && distance >= best.distance)) continue;
      best = { enemy: e, distance, point: hit.clone(), normal: hit.clone().sub(center).normalize() };
    }
    return best;
  }

  private readonly sphereTmp = new THREE.Sphere();
  private sphere(center: THREE.Vector3, radius: number): THREE.Sphere {
    this.sphereTmp.center.copy(center);
    this.sphereTmp.radius = radius;
    return this.sphereTmp;
  }

  /** Aplica un balazo. Devuelve true si lo mató. */
  damage(e: Enemy, amount: number, from: THREE.Vector3): boolean {
    if (!e.active || e.state === "dead") return false;
    e.health -= amount;
    e.pose.hurt = 1;
    // Retroceso leve y furia: deja lo que estaba haciendo y va por el jugador.
    const away = this.tmp.copy(e.position).sub(from).setY(0).normalize().multiplyScalar(0.12 * this.config.enemies.scale);
    e.position.add(away);
    if (e.state === "wander") this.setState(e, "chase");
    if (e.health > 0) {
      this.onHurt?.(e);
      return false;
    }
    this.setState(e, "dead");
    e.pose.attack = 0;
    this.kills++;
    this.respawnQueue.push(this.time + this.config.enemies.respawnDelay);
    this.onEnemyKilled?.(e);
    return true;
  }

  /** Centro de la esfera de impacto (para efectos al morir). */
  bodyCenter(e: Enemy, target: THREE.Vector3): THREE.Vector3 {
    return target.copy(e.position).setY(e.position.y + HIT_CENTER_Y * this.config.enemies.scale);
  }

  // ---------------------------------------------------------------------------
  // Render
  // ---------------------------------------------------------------------------

  private render(dt: number, alpha: number, camera?: THREE.Camera): void {
    this.renderFrame++;
    const s = this.config.enemies.scale;
    const castShadows = this.config.character.castShadowBlob;
    if (camera) {
      this.projScreenMatrix.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
      this.frustum.setFromProjectionMatrix(this.projScreenMatrix);
    }
    const sphereRadius = 2.6 * s;

    for (const e of this.enemies) {
      if (!e.active) continue;
      const root = e.root;
      root.position.lerpVectors(e.previousPosition, e.position, alpha);
      // Altura suavizada: al subir un cantero el cuerpo se eleva en ~0,2 s.
      if (Number.isNaN(e.renderY)) e.renderY = root.position.y;
      e.renderY += (root.position.y - e.renderY) * (1 - Math.exp(-12 * dt));
      root.position.y = e.renderY;
      const dy = Math.atan2(Math.sin(e.yaw - e.previousYaw), Math.cos(e.yaw - e.previousYaw));
      const yaw = e.previousYaw + dy * alpha;

      let roll = 0;
      let lift = 0;
      if (e.state === "dead") {
        // Salta, se da vuelta y queda panza arriba; al final se hunde.
        const flipTime = FLIP_TIME * Math.sqrt(s);
        const t = Math.min(1, e.stateTime / flipTime);
        const eased = t * t * (3 - 2 * t);
        roll = Math.PI * eased;
        // Pesado: apenas se despega del suelo al darse vuelta.
        lift = Math.sin(Math.PI * t) * 0.3 * s + eased * FLIPPED_HEIGHT * s;
        const sink = Math.max(0, e.stateTime - this.config.enemies.corpseTime) / SINK_TIME;
        lift -= sink * (FLIPPED_HEIGHT + 0.3) * s;
        e.pose.death = Math.min(1, e.stateTime / (flipTime * 0.8));
      }
      root.position.y += lift;
      root.rotation.set(0, yaw, roll);

      e.pose.time += dt;

      // Frustum culling manual con esfera envolvente holgada (mesh.frustumCulled
      // está desactivado porque las patas se salen del bounding box de reposo).
      let inFrustum = true;
      if (camera) {
        this.cullSphere.center.set(root.position.x, root.position.y + 0.9 * s, root.position.z);
        this.cullSphere.radius = sphereRadius;
        inFrustum = this.frustum.intersectsSphere(this.cullSphere);
      }
      root.visible = inFrustum;

      // Pisadas: cada trípode que apoya levanta nieve (sólo cerca del jugador).
      const landed = CascarudoRig.landings(e.renderGait, e.pose.gait);
      e.renderGait = e.pose.gait;

      if (inFrustum) {
        // A distancia (> 26 m), actualizar los 57 huesos en frames alternados.
        const shouldApplyRig =
          e.distance <= 26 ||
          e.state === "dead" ||
          Boolean(landed && e.distance < FOOTSTEP_RANGE) ||
          ((this.renderFrame + e.id) & 1) === 0;
        if (shouldApplyRig) {
          e.rig.apply(e.pose);
        }
      }

      if (landed && e.state !== "dead" && e.distance < FOOTSTEP_RANGE && this.onFootstep) {
        if (!inFrustum) e.rig.apply(e.pose);
        for (let tripod = 0; tripod < 2; tripod++) {
          if (!(landed & (1 << tripod))) continue;
          e.rig.tripodTips(tripod, this.feet);
          for (const foot of this.feet) {
            foot.y = e.position.y;
            this.onFootstep(foot, e);
          }
        }
      }

      const shadow = root.userData.shadow as THREE.Mesh;
      shadow.position.set(root.position.x, e.position.y + 0.03, root.position.z);
      shadow.scale.setScalar(2.4 * s * (e.state === "dead" ? 0.75 : 1));
      shadow.visible = inFrustum && castShadows && e.stateTime < this.config.enemies.corpseTime + SINK_TIME * 0.5;
    }
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const e of this.enemies) e.material.dispose();
    for (const d of this.disposables) d.dispose();
  }
}
