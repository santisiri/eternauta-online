/**
 * Orquestador: crea los sistemas, carga los assets en paralelo y corre el
 * bucle principal (simulación a paso fijo + render interpolado).
 */

import * as THREE from "three";
import { Character, createShadowBlob } from "./Character";
import { AudioSystem } from "./Audio";
import { CollisionDebugView, CollisionSystem } from "./CollisionSystem";
import { Combat } from "./Combat";
import { CombatHud } from "./CombatHud";
import type { GameConfig, OneShotAction } from "./config";
import { DebugPanel } from "./DebugPanel";
import { Effects } from "./Effects";
import { EnemySystem } from "./EnemySystem";
import { GraphicsMenu } from "./GraphicsMenu";
import { Hud } from "./Hud";
import { InputManager } from "./InputManager";
import { PlayerController } from "./PlayerController";
import { PropSystem } from "./PropSystem";
import { SplatEnvironment } from "./SplatEnvironment";
import { ThirdPersonCamera } from "./ThirdPersonCamera";
import { TouchControls, isTouchPrimary } from "./TouchControls";
import { World } from "./World";

const MAX_TICKS_PER_FRAME = 12;

export class Game {
  readonly world: World;
  readonly input: InputManager;
  readonly collision: CollisionSystem;
  readonly player: PlayerController;
  readonly character: Character;
  readonly environment: SplatEnvironment;
  /** Modelos 3D de Blender (edificios, monumento, mobiliario) sobre el splat. */
  readonly props: PropSystem;
  readonly camera: ThirdPersonCamera;
  readonly hud: Hud;
  readonly graphics: GraphicsMenu;
  readonly debug: DebugPanel;
  readonly enemies: EnemySystem;
  readonly effects: Effects;
  readonly combat: Combat;
  readonly combatHud: CombatHud;
  readonly audio: AudioSystem;
  /** Distancia caminada desde la última pisada del Eternauta (m). */
  private stepDistance = 0;
  private wasGrounded = true;
  private readonly muzzle = new THREE.Vector3();
  private readonly collisionView: CollisionDebugView;
  readonly touch: TouchControls;
  /** Controles táctiles activos (celular/tablet, o primer toque en pantalla táctil). */
  private touchMode = isTouchPrimary();

  private running = false;
  private playing = false;
  private characterReady = false;
  private lastTime = 0;
  private lastRenderTime = 0;
  private accumulator = 0;
  private elapsed = 0;
  private pendingJump = false;
  private pendingAction: OneShotAction | null = null;
  private pointerLockErrorShown = false;
  private readonly renderPos = new THREE.Vector3();
  private frameCount = 0;
  private fpsTime = 0;
  private fps = 0;
  private frameMs = 0;
  private ticksLastFrame = 0;
  private statsTimer = 0;

  constructor(
    private readonly container: HTMLElement,
    readonly config: GameConfig,
  ) {
    this.world = new World(container, config);
    this.input = new InputManager(this.world.renderer.domElement);
    this.collision = new CollisionSystem(config);
    this.player = new PlayerController(config, this.collision);
    this.character = new Character(config);
    this.environment = new SplatEnvironment(config, this.world.scene);
    this.environment.activeSplats = () => this.world.spark.activeSplats;
    this.props = new PropSystem(config);
    this.camera = new ThirdPersonCamera(this.world.camera, config, this.collision);
    this.hud = new Hud(container);
    this.hud.applyEffects(config);
    this.collisionView = new CollisionDebugView(config);
    this.world.scene.add(this.collisionView.group, this.character.shadowBlob);
    this.collision.onMeshChange = (mesh) => this.collisionView.setCollisionMesh(mesh);

    this.player.height = config.character.targetHeight * config.character.scaleMultiplier;
    this.camera.snapBehind(this.player.position, this.player.yaw);

    // --- Combate: cascarudos, disparos y vida del traje ---------------------------
    const enemyShadow = createShadowBlob();
    this.enemies = new EnemySystem(config, this.collision, enemyShadow);
    this.enemies.envMap = this.world.scene.environment;
    this.effects = new Effects(config.effects.bloodColor);
    this.effects.decalLifetime = config.effects.decalLifetime;
    this.effects.particleDensity = config.effects.particleDensity;
    this.combatHud = new CombatHud(container);
    this.combat = new Combat(config, this.world.camera, this.collision, this.enemies, this.effects, this.combatHud);
    this.world.scene.add(this.enemies.group, this.effects.group);
    this.player.onMeleeHit = (action) => this.combat.melee(action, this.player.position, this.player.yaw);
    this.combat.onShot = () => {
      this.camera.kick(THREE.MathUtils.degToRad(config.effects.recoilDeg));
      this.audio.play("gunshot", { volume: 0.9, rateJitter: 0.03 });
    };
    this.combat.onPlayerHurt = (damage) => this.camera.shake(0.3 + damage / 50);
    // Pisadas de bestias de 3,6 m: nieve que se levanta y el suelo que tiembla cerca.
    this.enemies.onFootstep = (foot, enemy) => {
      const s = config.enemies.scale;
      this.effects.footstep(foot, s);
      // Un sonido por trípode (las tres patas apoyan juntas).
      this.audio.play("beastStep", { position: foot, volume: 0.6 }, `e${enemy.id}`, 0.08);
      const d = foot.distanceTo(this.player.position);
      this.camera.shake(config.effects.footstepShake * 0.05 * s * Math.max(0, 1 - d / (9 * s)));
    };
    this.enemies.onDrip = (point, groundY) => this.effects.drip(point, groundY, config.enemies.scale);

    // --- Sonido -------------------------------------------------------------------
    this.audio = new AudioSystem(config.audio, config.assets.audioSamples);
    // Voces de los cascarudos: salen de la cabeza (~2,5 m) y siguen al bicho.
    const voice = (e: { position: THREE.Vector3 }) => ({ follow: e.position, offsetY: 1.2 * config.enemies.scale });
    this.enemies.onAlert = (e) => this.audio.play("screech", { ...voice(e), volume: 1 }, `e${e.id}`, 2);
    this.enemies.onHurt = (e) => this.audio.play("shriek", { ...voice(e), volume: 0.85 }, `e${e.id}`, 0.7);
    this.enemies.onEnemyKilled = (e) => this.audio.play("deathScreech", { ...voice(e), offsetY: 0.8 * config.enemies.scale, volume: 1 });
    this.enemies.onWindup = (e) => this.audio.play("hiss", { ...voice(e), volume: 0.8 });
    this.enemies.onBite = (e) => this.audio.play("bite", { ...voice(e), volume: 1 });
    this.combat.onEnemyHit = (point) => this.audio.play("hitFlesh", { position: point, volume: 0.8 });
    this.combat.onWorldHit = (point) => this.audio.play("impact", { position: point, volume: 0.45 });
    // La cámara no se mete adentro de un cascarudo que esté detrás del jugador.
    this.camera.extraObstruction = (origin, dir, max) => this.enemies.raycast(origin, dir, max)?.distance ?? null;
    this.combat.onPlayerKilled = () => {
      this.player.kill();
      this.combatHud.setDead(true, this.touchMode ? "TOCÁ ↺ PARA VOLVER" : "APRETÁ R PARA VOLVER");
    };
    this.player.onReset = () => {
      this.camera.snapBehind(this.player.position, this.player.yaw);
      this.combat.revive();
      // Reaparecer sin cascarudos encima.
      if (this.playing) this.enemies.clearArea(this.player.position, this.config.enemies.spawnMinDistance * 0.6);
    };

    this.debug = new DebugPanel(config, {
      onCharacterChange: () => {
        this.character.applyCalibration();
        this.player.height = config.character.targetHeight * config.character.scaleMultiplier;
      },
      onEnvironmentChange: () => {
        this.environment.applyTransform();
        this.collision.updateEnvironmentTransform(this.environment.matrix);
      },
      onRenderChange: () => {
        this.applyGraphicsSettings();
      },
      onSpawnHere: () => {
        const p = this.player.position;
        config.world.spawn = { x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) };
        config.world.spawnYawDeg = Math.round(THREE.MathUtils.radToDeg(this.player.yaw));
      },
      onTeleportSpawn: () => this.player.reset(),
      onAddObstacleHere: () => {
        const p = this.player.position;
        const f = { x: Math.sin(this.player.yaw) * 1.5, z: Math.cos(this.player.yaw) * 1.5 };
        config.world.obstacles.push({
          name: `caja ${config.world.obstacles.length + 1}`,
          min: { x: p.x + f.x - 0.5, y: p.y, z: p.z + f.z - 0.5 },
          max: { x: p.x + f.x + 0.5, y: p.y + 1, z: p.z + f.z + 0.5 },
        });
      },
      setCollisionDebug: (v) => (this.collisionView.group.visible = v),
      setSplatVisible: (v) => this.environment.setVisible(v),
      onPropsChange: () => {
        this.props.applySettings();
        this.environment.syncEditable();
        this.world.spark.setDirty();
      },
      characterInfo: () => this.characterInfo(),
    });

    this.graphics = new GraphicsMenu(container, config, {
      onApply: () => this.applyGraphicsSettings(),
      onOpenChange: (open) => {
        if (open) {
          this.input.exitPointerLock();
          this.input.enabled = false;
          this.updateUi();
        } else if (this.playing) {
          this.input.enabled = true;
          if (!this.touchMode) this.input.requestPointerLock();
        }
      },
    });

    this.hud.onEnter = () => this.enter();
    this.hud.onOpenGraphics = () => this.graphics.toggle();
    window.addEventListener("keydown", this.handleEscapeKey);

    this.touch = new TouchControls(container, this.input, config);
    if (this.touchMode) this.hud.setTouchHelp();
    // Laptops con pantalla táctil: pasar a controles táctiles al primer toque.
    window.addEventListener("pointerdown", this.handleFirstTouch);

    // Aviso de captura del mouse: transitorio, nunca fijo en pantalla.
    this.input.onPointerLockChange = (locked) => {
      if (!this.playing) return;
      if (locked) this.hud.hideHint();
      else this.hud.showHint("CLICK PARA CAPTURAR EL MOUSE · O ARRASTRÁ PARA ROTAR");
    };
    this.input.onPointerLockError = () => {
      // Sólo una vez, y no si el jugador ya está arrastrando (encontró la alternativa).
      if (!this.playing || this.touchMode || this.pointerLockErrorShown || this.input.isDragging) return;
      this.pointerLockErrorShown = true;
      this.hud.showHint("SIN CAPTURA DE MOUSE · ARRASTRÁ PARA ROTAR LA CÁMARA", 3500);
    };
    this.input.onDragStart = () => this.hud.hideHint();
  }

  /** Carga personaje, escenario y (opcional) malla de colisiones en paralelo. */
  async load(): Promise<void> {
    this.hud.setLoad("fbx", 0, "0%");
    this.hud.setLoad("spz", 0, "0%");

    const characterTask = this.character
      .load((loaded, total) =>
        this.hud.setLoad("fbx", loaded / total, `${(loaded / 1e6).toFixed(0)} / ${(total / 1e6).toFixed(0)} MB`),
      )
      .then((report) => {
        this.world.scene.add(this.character.root);
        for (const action of ["punch", "kick", "dodge", "die"] as const) {
          this.player.setRootMotion(action, this.character.rootMotion.get(action) ?? null);
        }
        this.characterReady = true;
        this.debug.refreshInfo();
        this.hud.setLoad("fbx", 1, `listo · ${report.bones} huesos · ${report.clips.length} clip(s)`, "done");
        console.groupCollapsed("[Character] Reporte del FBX");
        console.info(report);
        for (const w of report.warnings) console.warn("[Character]", w);
        console.groupEnd();
      })
      .catch((err: Error) => {
        console.error("[Character] error de carga", err);
        this.hud.setLoad("fbx", 1, "error", "error");
        this.hud.showError(`No se pudo cargar el protagonista (FBX): ${err.message}`);
      });

    this.environment.onStatusChange = (env) => {
      const state = env.status === "listo" ? "done" : env.status === "error" ? "error" : "loading";
      this.hud.setLoad("spz", env.progress, env.statusLabel, state);
    };
    const splatTask = this.environment.load().catch((err: Error) => {
      this.hud.showError(`No se pudo cargar el escenario (SPZ): ${err.message}`);
    });

    const enemyTask = this.enemies
      .load()
      .then((r) => console.info(`[Enemigos] cascarudo listo · ${r.bones} huesos · ${r.triangles} tris`))
      .catch((err: Error) => {
        console.error("[Enemigos] error de carga", err);
        this.hud.showError(`No se pudieron cargar los cascarudos (GLB): ${err.message}`);
      });

    // El sonido se sintetiza en paralelo; si falla, el juego sigue mudo.
    this.audio.prepare().catch((err: Error) => console.error("[Audio] error al preparar los sonidos", err));

    const tasks: Promise<unknown>[] = [characterTask, splatTask, enemyTask];
    const meshUrl = this.config.assets.collisionMeshUrl;
    if (meshUrl) tasks.push(this.collision.loadMesh(meshUrl, this.environment.matrix));
    tasks.push(
      this.props.load(this.world.scene, this.world.scene.environment).then((geometry) => {
        if (geometry && this.config.props.collide) this.collision.addStaticGeometry(geometry, "modelos");
      }),
    );

    await Promise.all(tasks);
    // El suelo puede haber cambiado con la malla de colisiones.
    this.player.reset();

    if (!this.characterReady) {
      this.hud.setReady("NO SE PUDO CARGAR EL PROTAGONISTA", false);
    } else if (this.environment.status === "error") {
      this.hud.setReady("ENTRAR AL MUNDO (SIN ESCENARIO)", true);
    } else {
      this.hud.setReady("ENTRAR AL MUNDO", true);
    }
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    this.world.renderer.setAnimationLoop((t) => this.frame(t));
  }

  enter(): void {
    if (!this.characterReady || this.playing) return;
    this.playing = true;
    this.hud.hideStart();
    this.input.enabled = true;
    if (this.touchMode) {
      this.touch.show();
      this.enterFullscreen();
      if (this.world.isPortrait) this.hud.showHint("GIRÁ EL TELÉFONO PARA VER MÁS", 3500);
    } else {
      this.input.requestPointerLock();
    }
    this.player.reset();
    this.combatHud.show();
    // Gesto del usuario (clic en ENTRAR): recién ahora el navegador deja sonar.
    this.audio.unlock();
    this.enemies.populate(this.player.position);
  }

  /** Pantalla completa + horizontal en móviles (donde el navegador lo permite; iPhone no). */
  private enterFullscreen(): void {
    const root = document.documentElement;
    if (!root.requestFullscreen || document.fullscreenElement) return;
    root
      .requestFullscreen({ navigationUI: "hide" })
      .then(() => {
        const orientation = screen.orientation as ScreenOrientation & { lock?: (o: string) => Promise<void> };
        return orientation.lock?.("landscape");
      })
      .catch(() => undefined);
  }

  private readonly handleEscapeKey = (e: KeyboardEvent) => {
    if (e.code === "Escape" && this.graphics.isOpen) {
      e.preventDefault();
      this.graphics.close();
    }
  };

  /** Aplica en caliente todos los ajustes de render, resolución, splats y efectos. */
  applyGraphicsSettings(): void {
    this.world.applyRenderSettings();
    this.hud.applyEffects(this.config);
    this.props.applySettings();
    this.environment.syncEditable();
    this.effects.particleDensity = this.config.effects.particleDensity;
    this.effects.decalLifetime = this.config.effects.decalLifetime;
    this.debug.refreshDisplay();
    this.graphics.syncUI();
  }

  private readonly handleFirstTouch = (e: PointerEvent) => {
    if (e.pointerType !== "touch" || this.touchMode) return;
    this.touchMode = true;
    this.hud.setTouchHelp();
    this.input.exitPointerLock();
    if (this.playing) this.touch.show();
  };

  private frame(now: number): void {
    const maxFps = this.config.render.maxFps;
    if (maxFps > 0 && this.lastRenderTime > 0) {
      const minInterval = 1000 / maxFps;
      if (now - this.lastRenderTime < minInterval - 0.5) return;
    }
    this.lastRenderTime = now;

    const frameDt = Math.min((now - this.lastTime) / 1000, 0.25);
    this.lastTime = now;
    this.elapsed += frameDt;
    this.measureFps(frameDt);

    // --- Entrada -----------------------------------------------------------------
    if (this.input.consume("toggleDebug")) this.debug.toggle();
    if (this.input.consume("toggleGraphics")) this.graphics.toggle();
    if (this.playing && !this.graphics.isOpen) {
      const { dx, dy } = this.input.consumeMouseDelta();
      this.camera.handleInput(dx, dy, this.input.consumeWheel());
      if (this.input.consume("reset")) this.player.reset();
      if (this.input.consume("jump")) this.pendingJump = true;
      for (const action of ["punch", "kick", "dodge"] as const) if (this.input.consume(action)) this.pendingAction = action;
      if (this.input.consume("die")) this.player.kill();
      if (this.input.consume("toggleMute")) this.hud.showHint(this.audio.toggleMute() ? "SONIDO APAGADO · M" : "SONIDO ACTIVADO", 1500);
    } else {
      // Pantalla inicial: órbita lenta alrededor del protagonista.
      this.camera.yaw += frameDt * 0.12;
    }

    // --- Simulación a paso fijo ---------------------------------------------------
    const step = 1 / this.config.movement.tickRate;
    this.accumulator += frameDt;
    let ticks = 0;
    while (this.accumulator >= step && ticks < MAX_TICKS_PER_FRAME) {
      const axis = this.input.moveAxis();
      this.player.fixedUpdate(step, {
        moveX: axis.x,
        moveY: axis.y,
        run: this.input.running,
        jump: this.pendingJump,
        shoot: this.input.shooting,
        action: this.pendingAction,
        cameraYaw: this.camera.movementYaw,
      });
      this.pendingJump = false;
      this.pendingAction = null;
      this.accumulator -= step;
      ticks++;
    }
    if (ticks === MAX_TICKS_PER_FRAME) this.accumulator = 0; // evita la espiral de la muerte
    this.ticksLastFrame = ticks;
    const alpha = this.accumulator / step;

    // --- Render interpolado ----------------------------------------------------------
    const pos = this.player.interpolatedPosition(alpha, this.renderPos);
    if (this.characterReady) {
      this.character.setTransform(pos, this.player.interpolatedYaw(alpha));
      this.character.update(frameDt, this.player);
      const ground = this.collision.groundHeight(pos.x, pos.z, pos.y) ?? pos.y;
      this.character.updateShadow(pos, ground);
    }
    this.camera.aiming = this.playing && !this.player.dead && (this.input.aiming || this.player.shooting);
    this.camera.update(frameDt, pos);
    if (this.playing) {
      this.audio.update(this.world.camera);
      this.playerFootsteps(frameDt, pos);
      this.creatureChatter(frameDt);
    }
    if (this.playing) {
      this.enemies.update(frameDt, pos, !this.player.dead, this.world.camera);
      if (this.characterReady && this.player.shooting) {
        this.character.muzzleWorldPosition(this.muzzle);
      }
      this.combat.update(frameDt, {
        shooting: this.player.shooting,
        dead: this.player.dead,
        player: pos,
        muzzle: this.muzzle,
        speed: this.player.horizontalSpeed,
        touch: this.touchMode,
      });
    }
    this.world.followLight(pos);
    this.world.update(this.elapsed);
    this.collisionView.update(pos);
    this.world.render();

    // --- UI --------------------------------------------------------------------------
    this.statsTimer += frameDt;
    if (this.statsTimer > 0.2) {
      this.statsTimer = 0;
      this.updateUi();
    }
  }

  /** Pisadas del Eternauta en la nieve: una por zancada, y al caer de un salto. */
  private playerFootsteps(dt: number, feet: THREE.Vector3): void {
    const p = this.player;
    if (p.grounded && !this.wasGrounded) this.audio.play("playerStep", { position: feet, volume: 0.7 });
    this.wasGrounded = p.grounded;
    if (!p.grounded || p.dead || (p.state !== "walk" && p.state !== "run")) {
      this.stepDistance = 0.5; // la primera pisada al arrancar llega enseguida
      return;
    }
    const stride = p.state === "run" ? 1.05 : 0.72;
    this.stepDistance += p.horizontalSpeed * dt;
    if (this.stepDistance < stride) return;
    this.stepDistance -= stride;
    this.audio.play("playerStep", { position: feet, volume: p.state === "run" ? 0.5 : 0.32 });
  }

  /** Castañeteo ocasional de los cascarudos cercanos que no están mordiendo. */
  private creatureChatter(dt: number): void {
    for (const e of this.enemies.enemies) {
      if (!e.active || e.distance > 32 || (e.state !== "wander" && e.state !== "chase")) continue;
      if (Math.random() > dt / 5) continue;
      this.audio.play("chitter", { follow: e.position, offsetY: 1.2 * this.config.enemies.scale, volume: 0.7 }, `e${e.id}`, 3);
    }
  }

  private measureFps(dt: number): void {
    this.frameCount++;
    this.fpsTime += dt;
    if (this.fpsTime >= 0.5) {
      this.fps = this.frameCount / this.fpsTime;
      this.frameMs = (this.fpsTime / this.frameCount) * 1000;
      this.frameCount = 0;
      this.fpsTime = 0;
      this.world.updateDynamicResolution(this.fps);
    }
  }

  private updateUi(): void {
    const env = this.environment;
    const canvas = this.world.renderer.domElement;
    const drsTag =
      this.config.render.dynamicResolution && this.world.currentDynamicScale < 0.99
        ? ` · DRS ${Math.round(this.world.currentDynamicScale * 100)}%`
        : "";
    const resStr = `${canvas.width}×${canvas.height} (${this.config.render.qualityPreset.toUpperCase()}${drsTag})`;
    this.hud.update({
      fps: this.fps,
      frameMs: this.frameMs,
      resolution: resStr,
      position: this.player.position,
      animation: this.characterReady ? this.character.animationLabel : "—",
      splat: env.statusLabel,
      splatError: env.status === "error",
      collision: this.collision.status,
    });
    this.graphics.updateLiveMetrics({
      fps: this.fps,
      frameMs: this.frameMs,
      width: canvas.width,
      height: canvas.height,
      pixelRatio: this.world.pixelRatio,
      dynamicScale: this.world.currentDynamicScale,
      activeSplats: this.world.spark.activeSplats,
    });
    const info = this.world.renderer.info;
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    Object.assign(this.debug.stats, {
      fps: +this.fps.toFixed(1),
      frameMs: +this.frameMs.toFixed(2),
      drawCalls: info.render.calls,
      triangles: info.render.triangles,
      pixelRatio: +this.world.pixelRatio.toFixed(2),
      resolution: `${canvas.width}×${canvas.height}`,
      splats: `${(this.world.spark.activeSplats / 1e6).toFixed(2)} M activos / ${(env.numSplats / 1e6).toFixed(2)} M (LoD)`,
      props: this.props.status,
      ticks: this.ticksLastFrame,
      memory: mem ? `${(mem.usedJSHeapSize / 1e6).toFixed(0)} MB JS` : "n/d",
    });
    this.debug.updateStats();
  }

  private characterInfo(): Record<string, string | number> {
    const r = this.character.report;
    if (!r) return { estado: "sin cargar" };
    const s = r.originalSize;
    return {
      "tamaño original": `${s.x.toFixed(1)} × ${s.y.toFixed(1)} × ${s.z.toFixed(1)}`,
      "escala auto": +r.autoScale.toFixed(5),
      "frente auto (°)": +r.autoForwardDeg.toFixed(1),
      "método frente": r.forwardMethod,
      "offset suelo": +r.groundOffset.toFixed(4),
      "vel. clip walk (m/s)": +r.walkClipSpeed.toFixed(2),
      "vel. clip run (m/s)": r.missingStates.includes("run") ? "—" : +r.runClipSpeed.toFixed(2),
      "vel. clip shoot (m/s)": r.missingStates.includes("shoot") ? "—" : +r.shootClipSpeed.toFixed(2),
      "root motion (m)": Object.entries(r.rootMotion).map(([k, v]) => `${k} ${v!.toFixed(2)}`).join(", ") || "—",
      "pose neutra (s)": +r.neutralPoseTime.toFixed(3),
      huesos: r.bones,
      clips: r.clips.filter((c) => c.assignedTo).map((c) => `${c.name.split("|").pop()}→${c.assignedTo}`).join(", "),
      "clips estáticos": r.clips.filter((c) => c.static).length,
      "faltan clips": r.missingStates.join(", ") || "ninguno",
    };
  }

  dispose(): void {
    this.world.renderer.setAnimationLoop(null);
    this.running = false;
    this.input.exitPointerLock();
    this.input.dispose();
    this.graphics.dispose();
    this.debug.dispose();
    window.removeEventListener("keydown", this.handleEscapeKey);
    window.removeEventListener("pointerdown", this.handleFirstTouch);
    this.touch.dispose();
    this.enemies.dispose();
    this.effects.dispose();
    this.audio.dispose();
    this.combatHud.dispose();
    this.character.dispose();
    this.environment.dispose();
    this.collision.dispose();
    this.world.dispose();
    this.container.replaceChildren();
  }
}
