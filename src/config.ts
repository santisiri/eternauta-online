/**
 * Configuración central del prototipo.
 *
 * Todo lo que depende de los assets (escala, orientación, suelo, límites)
 * vive acá para poder calibrarlo sin tocar la lógica. El panel de debug
 * (tecla º / F3) edita este mismo objeto en caliente y permite exportar
 * los valores como JSON para pegarlos de vuelta en este archivo.
 *
 * Unidades del mundo: metros. Eje Y hacia arriba (convención de Three.js).
 */

import type { SoundName } from "./Audio";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

/** Caja alineada a ejes usada como obstáculo provisional. */
export interface BoxObstacle {
  name: string;
  min: Vec3Like;
  max: Vec3Like;
}

export type QualityPreset = "bajo" | "medio" | "alto" | "ultra" | "personalizado";

export type ResolutionPreset = "nativa" | "1080p" | "900p" | "720p" | "540p" | "480p";

export const RESOLUTION_HEIGHT_MAP: Record<ResolutionPreset, number> = {
  nativa: 0,
  "1080p": 1080,
  "900p": 900,
  "720p": 720,
  "540p": 540,
  "480p": 480,
};

export interface GameConfig {
  assets: {
    characterUrl: string;
    /** Mapas PBR externos (el FBX los referencia pero FBXLoader no los soporta en Phong). */
    characterRoughnessUrl: string | null;
    characterMetalnessUrl: string | null;
    /**
     * Clips extra (FBX con el mismo rig Mixamo) para estados de animación.
     * `clip` elige por nombre dentro del FBX (si se omite, el primero).
     * Ej.: { state: "idle", url: "/assets/player/idle.fbx" }.
     */
    extraAnimations: { state: AnimationStateName; url: string; clip?: string }[];
    splatUrl: string;
    /** Malla de colisiones exportada desde Marble (GLB). null = colisiones provisionales. */
    collisionMeshUrl: string | null;
    /** Cascarudo: GLB con malla + rig (sin clips; la marcha es procedural). */
    enemyUrl: string;
    /** Modelos 3D de la plaza (Blender): biblioteca GLB + layout. null = sin modelos. */
    propsUrl: string | null;
    propsLayoutUrl: string | null;
    /**
     * Grabaciones que reemplazan a los sonidos sintetizados, por nombre
     * (variantes al azar). Ej.: { gunshot: [asset("assets/audio/fal-1.ogg")] }.
     */
    audioSamples: Partial<Record<SoundName, string[]>>;
  };
  /**
   * Acciones de un solo disparo (piña, patada, esquive, muerte). Los clips de
   * Meshy traen preparación y recuperación largas: `start`/`end` recortan la
   * ventana útil (s de clip) y `speed` la acelera. El desplazamiento del hueso
   * raíz dentro de la ventana lo aplica el controlador (root motion con colisiones).
   */
  actions: Record<OneShotAction, { start: number; end: number; speed: number; /** Instante del impacto (s de clip) para golpes. */ hit?: number }>;
  character: {
    /** Altura objetivo del protagonista en metros. */
    targetHeight: number;
    /** Multiplicador manual sobre la escala calculada automáticamente. */
    scaleMultiplier: number;
    /** Corrección de la orientación frontal del modelo (grados, eje Y). */
    forwardOffsetDeg: number;
    /** Desplazamiento vertical fino del modelo respecto del suelo (m). */
    yOffset: number;
    /** Oculta mallas estáticas sueltas (p. ej. la "Icosphere" que exporta Meshy). */
    hideAuxiliaryMeshes: boolean;
    /** Elimina la deriva horizontal del hueso raíz (evita root motion duplicado). */
    stripRootMotion: boolean;
    /** Velocidad (m/s) a la que el clip de caminata no patina. 0 = estimar del clip. */
    walkClipSpeed: number;
    /** Ídem para el clip de carrera. 0 = estimar del clip. */
    runClipSpeed: number;
    /** Ídem para el clip de correr disparando. 0 = estimar del clip. */
    shootClipSpeed: number;
    /** Tiempo de cruce entre estados de animación (s). */
    crossFade: number;
    castShadowBlob: boolean;
  };
  environment: {
    position: Vec3Like;
    /** Rotación del splat en grados (XYZ). */
    rotationDeg: Vec3Like;
    scale: number;
    /** Construye el LoD de Spark en un worker al cargar (recomendado para >1M splats). */
    lod: boolean;
    /** Centros en float32 (mejor precisión lejos del origen, algo más costoso). */
    extSplats: boolean;
    /** Multiplicador del presupuesto de splats del LoD (1 = default de plataforma). */
    lodSplatScale: number;
    /** Tamaño mínimo en píxeles de los splats del LoD (mayor = menos splats diminutos lejanos). */
    lodRenderScale: number;
    /** Radio máximo de las gaussianas en desvíos estándar (menor = menos overdraw en GPU). */
    maxStdDev: number;
    /** Opacidad mínima para descartar bordes transparentes de splats. */
    minAlpha: number;
    /** Intervalo mínimo entre ordenamientos de profundidad en ms. */
    minSortIntervalMs: number;
  };
  world: {
    /** Altura del suelo invisible en el origen (m). */
    groundHeight: number;
    /** Pendiente del suelo invisible (m de altura por m en X / Z). */
    groundSlopeX: number;
    groundSlopeZ: number;
    /** Límites jugables (rectángulo XZ). */
    bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
    /** Por debajo de esta altura se reinicia al jugador (anti caída infinita). */
    killY: number;
    spawn: Vec3Like;
    /** Orientación inicial del jugador (grados, 0 = mirando hacia +Z). */
    spawnYawDeg: number;
    obstacles: BoxObstacle[];
  };
  movement: {
    walkSpeed: number;
    runSpeed: number;
    acceleration: number;
    deceleration: number;
    /** Fracción del control horizontal disponible en el aire. */
    airControl: number;
    gravity: number;
    jumpSpeed: number;
    /** Velocidad máxima mientras se dispara (m/s). */
    shootMoveSpeed: number;
    /** Velocidad de giro del personaje hacia la dirección de marcha (rad/s aprox.). */
    turnSpeed: number;
    radius: number;
    /** Pendiente máxima que se puede subir caminando (grados). */
    maxSlopeDeg: number;
    /** Paso de simulación fijo (Hz). */
    tickRate: number;
    maxFallSpeed: number;
  };
  camera: {
    fov: number;
    distance: number;
    minDistance: number;
    maxDistance: number;
    /** Altura del pivote de órbita sobre los pies del jugador (m). */
    pivotHeight: number;
    /** Punto al que mira la cámara por encima del pivote: baja al personaje en pantalla. */
    lookAheadHeight: number;
    /** Desplazamiento lateral (hombro). 0 = centrado. */
    shoulderOffset: number;
    /** Apuntando (clic derecho / disparando): cámara sobre el hombro y más cerca. */
    aimShoulderOffset: number;
    aimDistance: number;
    initialPitchDeg: number;
    minPitchDeg: number;
    maxPitchDeg: number;
    sensitivity: number;
    /** Rotación por px de arrastre táctil (rad/px). */
    touchSensitivity: number;
    /** En pantallas verticales se abre el FOV para no ver "por un tubo" (grados máx.). */
    portraitMaxFov: number;
    invertY: boolean;
    /** Rigidez del seguimiento de posición (1/s). */
    followStiffness: number;
    /** Rigidez de la rotación (1/s). */
    rotationStiffness: number;
    zoomStiffness: number;
    zoomStep: number;
    /** Distancia mínima de la cámara sobre el suelo (m). */
    minGroundClearance: number;
    near: number;
    far: number;
  };
  enemies: {
    enabled: boolean;
    /** Cascarudos vivos a la vez. */
    count: number;
    /** Escala del modelo (1 = 1,7 m de alto, 2,2 m de ancho). */
    scale: number;
    /** Segundos que se para en dos patas y chilla antes de cargar. */
    alertTime: number;
    health: number;
    wanderSpeed: number;
    chaseSpeed: number;
    /** Distancia a la que detectan al jugador (m). */
    aggroRange: number;
    /** Distancia de mordida, medida desde el centro del cascarudo (m). */
    attackRange: number;
    attackDamage: number;
    /** Segundos entre mordidas. */
    attackInterval: number;
    /** Distancia mínima al jugador para aparecer (m). */
    spawnMinDistance: number;
    /** Segundos hasta que aparece un reemplazo tras una muerte. */
    respawnDelay: number;
    /** Segundos que el cadáver queda panza arriba antes de hundirse. */
    corpseTime: number;
    /** Paso fijo de la IA (Hz); el render interpola. */
    tickRate: number;
  };
  props: {
    /** Mostrar los modelos 3D (edificios, monumento, mobiliario, vegetación). */
    visible: boolean;
    /** Borrar el splat donde hay un modelo (evita ver el objeto doble). */
    carveSplat: boolean;
    /**
     * Mostrar los modelos de la Casa Rosada y el Cabildo. Apagado: el splat de
     * esas fachadas es mucho más realista; los modelos quedan sólo como colisión.
     */
    showBuildings: boolean;
    /** Borrar el splat de las fachadas (sólo tiene sentido con showBuildings). */
    carveBuildings: boolean;
    /** Sumar las colisiones de los modelos a la malla de Marble. */
    collide: boolean;
  };
  audio: {
    enabled: boolean;
    masterVolume: number;
    /** Efectos (disparos, chillidos, pisadas). */
    sfxVolume: number;
    /** Viento de la nevada. */
    ambienceVolume: number;
    /** Envío a la reverb de la plaza (eco entre fachadas). */
    reverb: number;
    /**
     * Banda sonora: mismas pistas en distintos formatos, en orden de
     * preferencia (se usa la primera que el navegador pueda reproducir).
     */
    musicUrls: string[];
    musicVolume: number;
    /** Silencio (s, sólo viento) entre una repetición de la pista y la siguiente. */
    musicPause: number;
  };
  effects: {
    /** Hemolinfa de los cascarudos (gotas y manchas en la nieve). */
    bloodColor: string;
    /** Segundos que duran las manchas de sangre y los impactos en el suelo. */
    decalLifetime: number;
    /** Multiplicador de densidad de partículas de combate y pisadas (0.25 a 1). */
    particleDensity: number;
    /** Sacudón de cámara por las pisadas de los cascarudos cercanos (0 = sin). */
    footstepShake: number;
    /** Retroceso del arma: cabeceo de la cámara por disparo (grados). */
    recoilDeg: number;
  };
  weapon: {
    /** Disparos por segundo manteniendo el botón. */
    fireRate: number;
    damage: number;
    range: number;
    /** Dispersión en grados (cadera / apuntando). */
    spreadDeg: number;
    aimSpreadDeg: number;
    /** Radio extra de los blancos con controles táctiles (ayuda de apuntado, m). */
    touchAimAssist: number;
  };
  player: {
    maxHealth: number;
    /** Vida por segundo tras `regenDelay` s sin recibir daño. */
    regenRate: number;
    regenDelay: number;
  };
  render: {
    /** Perfil general de calidad gráfica. */
    qualityPreset: QualityPreset;
    /** Resolución objetivo de salida (limita la altura máxima del framebuffer). */
    resolutionPreset: ResolutionPreset;
    /** Altura máxima del framebuffer en píxeles (0 = sin límite / nativa). */
    maxResolutionHeight: number;
    /** Límite superior del devicePixelRatio. */
    maxPixelRatio: number;
    /** Escala de resolución interna (0.5 = mitad, look PS2). */
    renderScale: number;
    /** Ajusta automáticamente la resolución interna para sostener `targetFps`. */
    dynamicResolution: boolean;
    /** FPS objetivo cuando `dynamicResolution` está activo. */
    targetFps: number;
    /** Escala mínima permitida por la resolución dinámica. */
    minRenderScale: number;
    /** Límite máximo de cuadros por segundo (0 = sin límite). */
    maxFps: number;
    /** Escalado sin filtrado (pixelado) cuando renderScale < 1. */
    pixelated: boolean;
    exposure: number;
    background: string;
    filmGrain: boolean;
    vignette: boolean;
    /** Corrección de color CSS en el canvas (desactivar ahorra una pasada de composición). */
    colorGrading: boolean;
  };
  atmosphere: {
    snow: boolean;
    snowCount: number;
    /** Lado del volumen de nieve que acompaña a la cámara (m). */
    snowArea: number;
    snowFallSpeed: number;
    snowWind: Vec3Like;
    snowSize: number;
  };
}

/** Acciones con principio y fin que interrumpen la locomoción. */
export type OneShotAction = "punch" | "kick" | "dodge" | "die";

export type AnimationStateName = "idle" | "walk" | "run" | "jump" | "fall" | "shoot" | OneShotAction;

/**
 * URL de un archivo de public/ relativa a la base del sitio, para que el
 * juego funcione tanto en la raíz como en una subcarpeta (GitHub Pages,
 * itch.io…). Con `base: "./"` en vite.config, BASE_URL es relativa.
 */
export function asset(path: string): string {
  return `${import.meta.env.BASE_URL}${path}`;
}

export const defaultConfig: GameConfig = {
  assets: {
    characterUrl: asset("assets/player/Meshy_AI_Blue_Wasteland_Sentin_biped_Animation_Walking_withSkin.fbx"),
    // Versiones 1024 px de los mapas 4096 originales (ver scripts/optimize-assets.sh).
    characterRoughnessUrl: asset("assets/player/texture_0_roughness_1k.png"),
    characterMetalnessUrl: asset("assets/player/texture_0_metallic_1k.png"),
    extraAnimations: [
      // Del FBX "Merged Animations" de Meshy sólo "Running" trae keyframes
      // reales (los otros 15 clips son una pose estática, ver README). Se
      // extrajo a JSON con `npm run extract:clip` para no descargar 17 MB.
      { state: "run", url: asset("assets/player/animations/running.json") },
      // Un FBX por animación (Meshy, mismo rig), extraídos a JSON con
      // `npm run optimize:assets` desde assets-src/animations.
      { state: "idle", url: asset("assets/player/animations/idle.json") },
      { state: "jump", url: asset("assets/player/animations/jump.json") },
      { state: "shoot", url: asset("assets/player/animations/run-shoot.json") },
      { state: "punch", url: asset("assets/player/animations/punch.json") },
      { state: "kick", url: asset("assets/player/animations/kick.json") },
      { state: "dodge", url: asset("assets/player/animations/step-back.json") },
      { state: "die", url: asset("assets/player/animations/die.json") },
    ],
    splatUrl: asset("assets/scene.spz"),
    // Collider mesh exportado desde Marble (mismo sistema de referencia que el
    // splat; la transformación viene en el nodo raíz del GLB). Optimizado con
    // `npm run prepare:collider`. null = suelo provisional.
    collisionMeshUrl: asset("assets/collider.glb"),
    // Texturas 4096 → 1024 px (`npm run prepare:enemy`): 31 MB → 2,8 MB.
    enemyUrl: asset("assets/enemies/cascarudo.glb"),
    // Modelados en Blender (`npm run props:build`, scripts/blender/props).
    propsUrl: asset("assets/props/props.glb"),
    propsLayoutUrl: asset("assets/props/layout.json"),
    // Vacío: todos los sonidos se sintetizan (src/Audio.ts).
    audioSamples: {},
  },
  actions: {
    // Boxing_Guard_Prep_Straight_Punch (3,97 s): retroceso del brazo desde
    // 1,25 s, impacto a 1,88 s, guardia recuperada a 2,7 s.
    punch: { start: 1.25, end: 2.7, speed: 1.4, hit: 1.88 },
    // Boxing_Guard_Step_Knee_Strike (2,5 s): paso adelante, rodilla arriba a
    // 0,92 s y vuelta al lugar.
    kick: { start: 0.15, end: 2.3, speed: 1.3, hit: 0.92 },
    // Crouch_and_Step_Back (2,67 s): se agacha y retrocede ~1,9 m.
    dodge: { start: 0.25, end: 2.2, speed: 1.25 },
    // dying_backwards (2,17 s): cae de espaldas y queda en el piso hasta reiniciar.
    die: { start: 0, end: 2.167, speed: 1 },
  },
  character: {
    targetHeight: 1.8,
    scaleMultiplier: 1,
    forwardOffsetDeg: 0,
    yOffset: 0,
    hideAuxiliaryMeshes: true,
    stripRootMotion: true,
    walkClipSpeed: 0,
    runClipSpeed: 0,
    shootClipSpeed: 0,
    crossFade: 0.2,
    castShadowBlob: true,
  },
  environment: {
    position: { x: 0, y: 0, z: 0 },
    rotationDeg: { x: 0, y: 0, z: 0 },
    scale: 1,
    lod: true,
    extSplats: false,
    lodSplatScale: 1,
    lodRenderScale: 1.25,
    maxStdDev: 2.45,
    minAlpha: 0.004,
    minSortIntervalMs: 16,
  },
  world: {
    // Plano ajustado por mínimos cuadrados a la densidad de splats del suelo
    // (sólo para calibrar; en runtime no se consulta el splat). Residuo
    // mediano 0.15 m; hay una hondonada de ~0.4 m hacia x≈30, z≈10.
    groundHeight: -0.2,
    groundSlopeX: -0.003,
    groundSlopeZ: -0.0006,
    // Red de seguridad: con el collider de Marble, los límites reales son los
    // edificios. Este rectángulo envuelve el área alcanzable desde el spawn
    // (x[-46.5, 57] z[-78.5, 40.5], medida con un flood fill sobre la malla).
    bounds: { minX: -48, maxX: 59, minZ: -80, maxZ: 42 },
    killY: -30,
    spawn: { x: 0, y: 0, z: 0 },
    spawnYawDeg: 0,
    obstacles: [],
  },
  movement: {
    walkSpeed: 1.7,
    runSpeed: 4.6,
    acceleration: 12,
    deceleration: 14,
    airControl: 0.35,
    gravity: 22,
    jumpSpeed: 6.2,
    shootMoveSpeed: 2.2,
    turnSpeed: 10,
    radius: 0.35,
    maxSlopeDeg: 40,
    tickRate: 120,
    maxFallSpeed: 40,
  },
  camera: {
    fov: 55,
    distance: 4.2,
    minDistance: 1.6,
    maxDistance: 12,
    pivotHeight: 1.55,
    lookAheadHeight: 0.35,
    shoulderOffset: 0,
    aimShoulderOffset: 0.6,
    aimDistance: 2.6,
    initialPitchDeg: 12,
    minPitchDeg: -35,
    maxPitchDeg: 70,
    sensitivity: 0.0022,
    touchSensitivity: 0.0085,
    portraitMaxFov: 85,
    invertY: false,
    followStiffness: 12,
    rotationStiffness: 22,
    zoomStiffness: 10,
    zoomStep: 0.6,
    minGroundClearance: 0.3,
    near: 0.05,
    far: 4000,
  },
  enemies: {
    enabled: true,
    count: 10,
    // 3,6 m de alto: el doble que el Eternauta (1,8 m).
    scale: 2.1,
    alertTime: 0.9,
    health: 9,
    wanderSpeed: 0.9,
    chaseSpeed: 3.2,
    aggroRange: 28,
    // × scale: muerde a ~3,3 m de su centro (las mandíbulas sobresalen ~2,3 m).
    attackRange: 1.55,
    attackDamage: 20,
    attackInterval: 1.4,
    spawnMinDistance: 22,
    respawnDelay: 4,
    corpseTime: 8,
    tickRate: 30,
  },
  props: {
    visible: true,
    carveSplat: true,
    showBuildings: false,
    carveBuildings: false,
    collide: true,
  },
  audio: {
    enabled: true,
    masterVolume: 0.8,
    sfxVolume: 1,
    ambienceVolume: 0.22,
    reverb: 0.5,
    // "Bandoneón Lejos" (banda sonora original). WebM/Opus = la grabación sin
    // recomprimir; AAC de respaldo para Safari sin Opus.
    musicUrls: [asset("assets/audio/bandoneon-lejos.webm"), asset("assets/audio/bandoneon-lejos.m4a")],
    musicVolume: 0.45,
    musicPause: 12,
  },
  effects: {
    // Hemolinfa de insecto: verde amarillento; sobre la nieve se oscurece.
    bloodColor: "#7d8f1e",
    decalLifetime: 45,
    particleDensity: 1,
    footstepShake: 1,
    recoilDeg: 0.35,
  },
  weapon: {
    fireRate: 6,
    damage: 1,
    range: 120,
    spreadDeg: 1.6,
    aimSpreadDeg: 0.4,
    touchAimAssist: 0.6,
  },
  player: {
    maxHealth: 100,
    regenRate: 6,
    regenDelay: 5,
  },
  render: {
    qualityPreset: "alto",
    resolutionPreset: "nativa",
    maxResolutionHeight: 0,
    maxPixelRatio: 1.5,
    renderScale: 1,
    dynamicResolution: false,
    targetFps: 60,
    minRenderScale: 0.55,
    maxFps: 0,
    pixelated: false,
    exposure: 1,
    background: "#b9c0c6",
    filmGrain: true,
    vignette: true,
    colorGrading: true,
  },
  atmosphere: {
    snow: true,
    snowCount: 5000,
    snowArea: 36,
    snowFallSpeed: 1.1,
    snowWind: { x: 0.35, y: 0, z: 0.15 },
    snowSize: 0.045,
  },
};

/**
 * Aplica un perfil de calidad gráfica predefinido sobre `config`.
 */
export function applyQualityPreset(config: GameConfig, preset: Exclude<QualityPreset, "personalizado">): void {
  config.render.qualityPreset = preset;
  switch (preset) {
    case "bajo":
      config.render.resolutionPreset = "720p";
      config.render.maxResolutionHeight = 720;
      config.render.maxPixelRatio = 1.0;
      config.render.renderScale = 0.75;
      config.render.filmGrain = false;
      config.render.vignette = false;
      config.render.colorGrading = false;
      config.environment.lodSplatScale = 0.45;
      config.environment.lodRenderScale = 2.2;
      config.environment.maxStdDev = 2.0;
      config.environment.minAlpha = 0.01;
      config.environment.minSortIntervalMs = 32;
      config.props.carveSplat = false;
      config.props.carveBuildings = false;
      config.atmosphere.snow = true;
      config.atmosphere.snowCount = 1500;
      config.effects.particleDensity = 0.4;
      config.effects.decalLifetime = 15;
      config.character.castShadowBlob = false;
      break;
    case "medio":
      config.render.resolutionPreset = "900p";
      config.render.maxResolutionHeight = 900;
      config.render.maxPixelRatio = 1.25;
      config.render.renderScale = 0.85;
      config.render.filmGrain = false;
      config.render.vignette = true;
      config.render.colorGrading = false;
      config.environment.lodSplatScale = 0.7;
      config.environment.lodRenderScale = 1.6;
      config.environment.maxStdDev = 2.25;
      config.environment.minAlpha = 0.006;
      config.environment.minSortIntervalMs = 24;
      config.props.carveSplat = true;
      config.props.carveBuildings = false;
      config.atmosphere.snow = true;
      config.atmosphere.snowCount = 3000;
      config.effects.particleDensity = 0.7;
      config.effects.decalLifetime = 30;
      config.character.castShadowBlob = true;
      break;
    case "alto":
      config.render.resolutionPreset = "nativa";
      config.render.maxResolutionHeight = 0;
      config.render.maxPixelRatio = 1.5;
      config.render.renderScale = 1.0;
      config.render.filmGrain = true;
      config.render.vignette = true;
      config.render.colorGrading = true;
      config.environment.lodSplatScale = 1.0;
      config.environment.lodRenderScale = 1.25;
      config.environment.maxStdDev = 2.45;
      config.environment.minAlpha = 0.004;
      config.environment.minSortIntervalMs = 16;
      config.props.carveSplat = true;
      config.props.carveBuildings = false;
      config.atmosphere.snow = true;
      config.atmosphere.snowCount = 5000;
      config.effects.particleDensity = 1.0;
      config.effects.decalLifetime = 45;
      config.character.castShadowBlob = true;
      break;
    case "ultra":
      config.render.resolutionPreset = "nativa";
      config.render.maxResolutionHeight = 0;
      config.render.maxPixelRatio = 2.0;
      config.render.renderScale = 1.0;
      config.render.filmGrain = true;
      config.render.vignette = true;
      config.render.colorGrading = true;
      config.environment.lodSplatScale = 1.5;
      config.environment.lodRenderScale = 1.0;
      config.environment.maxStdDev = 2.828;
      config.environment.minAlpha = 0.002;
      config.environment.minSortIntervalMs = 12;
      config.props.carveSplat = true;
      config.props.carveBuildings = false;
      config.atmosphere.snow = true;
      config.atmosphere.snowCount = 8000;
      config.effects.particleDensity = 1.0;
      config.effects.decalLifetime = 60;
      config.character.castShadowBlob = true;
      break;
  }
}

/**
 * Ajustes para celulares y tablets: menos píxeles, menos partículas y sin
 * efectos de composición CSS (grano/filtros), que en GPUs móviles cuestan.
 * Spark ya reduce por su cuenta el presupuesto de splats del LoD en móviles.
 */
export function applyMobileProfile(config: GameConfig): void {
  config.render.maxPixelRatio = Math.min(config.render.maxPixelRatio, 1.25);
  config.render.maxResolutionHeight = config.render.maxResolutionHeight ? Math.min(config.render.maxResolutionHeight, 900) : 900;
  config.render.resolutionPreset = "900p";
  config.render.filmGrain = false;
  config.render.colorGrading = false;
  config.environment.lodRenderScale = Math.max(config.environment.lodRenderScale, 1.6);
  config.environment.maxStdDev = Math.min(config.environment.maxStdDev, 2.25);
  config.atmosphere.snowCount = Math.min(config.atmosphere.snowCount, 2500);
  config.effects.particleDensity = Math.min(config.effects.particleDensity, 0.65);
  config.camera.distance = Math.max(config.camera.distance, 4.6);
}

const STORAGE_KEY = "eternauta.config.v1";

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Mezcla profunda: sólo copia claves que existen en `target` y con el mismo tipo. */
export function mergeInto<T>(target: T, source: unknown): T {
  if (!isPlainObject(source) || !isPlainObject(target)) return target;
  const t = target as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (!(key in t)) continue;
    const current = t[key];
    if (isPlainObject(current)) mergeInto(current, value);
    else if (Array.isArray(current) && Array.isArray(value)) t[key] = structuredClone(value);
    else if (current === null || typeof current === typeof value) t[key] = value;
  }
  return target;
}

/** Carga la config por defecto + overrides guardados por el panel de debug. */
export function loadConfig(): GameConfig {
  const config = structuredClone(defaultConfig);
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      // Las rutas de assets las define el código, no la calibración guardada.
      const { assets: _ignored, ...rest } = JSON.parse(saved) as Record<string, unknown>;
      mergeInto(config, rest);
    }
  } catch {
    // localStorage puede no estar disponible (modo privado): seguimos con defaults.
  }
  // Overrides rápidos por URL: ?quality=bajo&resolution=720p&renderScale=0.5&drs=1&maxFps=60
  const params = new URLSearchParams(location.search);
  const quality = params.get("quality");
  if (quality === "bajo" || quality === "medio" || quality === "alto" || quality === "ultra") {
    applyQualityPreset(config, quality);
  }
  const resolution = params.get("resolution") as ResolutionPreset | null;
  if (resolution && resolution in RESOLUTION_HEIGHT_MAP) {
    config.render.resolutionPreset = resolution;
    config.render.maxResolutionHeight = RESOLUTION_HEIGHT_MAP[resolution];
  }
  const num = (k: string) => (params.has(k) ? Number(params.get(k)) : undefined);
  const renderScale = num("renderScale");
  if (renderScale && renderScale > 0) config.render.renderScale = renderScale;
  const maxFps = num("maxFps");
  if (maxFps !== undefined && maxFps >= 0) config.render.maxFps = maxFps;
  if (params.get("drs") === "1") config.render.dynamicResolution = true;
  if (params.get("drs") === "0") config.render.dynamicResolution = false;
  const envScale = num("envScale");
  if (envScale && envScale > 0) config.environment.scale = envScale;
  if (params.get("lod") === "0") config.environment.lod = false;
  return config;
}

export function saveConfig(config: GameConfig): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(config));
  } catch {
    /* sin persistencia disponible */
  }
}

export function clearSavedConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
