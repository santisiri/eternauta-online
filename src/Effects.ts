/**
 * Efectos de combate: fogonazo, humo, vainas, trazadoras, hemolinfa de los
 * cascarudos, manchas en la nieve y polvo de las pisadas.
 *
 * Todo sale de pools fijos (cero asignaciones por disparo) con un draw call
 * por sistema:
 *  - `ParticleSystem`: quads instanciados que miran a la cámara y se ESTIRAN en
 *    la dirección de su velocidad en pantalla (desenfoque de movimiento), así
 *    las gotas en vuelo se ven como chorros y las chispas como rayas. Uno con
 *    mezcla normal (sangre, humo, nieve, vainas, esquirlas) y otro aditivo
 *    (chispas, trazadoras).
 *  - `DecalSystem`: manchas planas sobre el suelo (gotas que caen, charcos que
 *    se expanden bajo los cadáveres, impactos de bala) que se desvanecen.
 *  - Fogonazo: estrella frontal + llama lateral orientada al cañón + luz.
 *
 * Las texturas se dibujan proceduralmente en canvas al iniciar (sin assets).
 * Las partículas no colisionan con la malla: cada ráfaga recibe la altura del
 * suelo bajo el impacto y la usa como plano (rebote o mancha al caer).
 */

import * as THREE from "three";

// Celdas del atlas de partículas (2×2).
const TEX_SMOKE = 0;
const TEX_DROP = 1;
const TEX_CHUNK = 2;
const TEX_SPARK = 3;
// Celdas del atlas de manchas (2×2).
const DECAL_SPLAT = [0, 1];
const DECAL_POOL = 2;
const DECAL_HOLE = 3;

const FLAG_BOUNCE = 1;
const FLAG_DECAL = 2;
/** Recién creada: se dibuja al menos un frame antes de envejecer. */
const FLAG_FRESH = 4;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
/** Tamaño de gota: muchas finas y pocas gruesas (distribución sesgada, como un spray real). */
const dropSize = (min: number, max: number) => min + (max - min) * Math.pow(Math.random(), 2.6);

// =============================================================================
// Partículas
// =============================================================================

const PARTICLE_VERTEX = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iVel;
  attribute vec4 iColor;
  // x = tamaño, y = exposición (s de desenfoque), z = celda del atlas, w = rotación
  attribute vec4 iMisc;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
    vec2 vel = (modelViewMatrix * vec4(iVel, 0.0)).xy;
    float speed = length(vel);
    float size = iMisc.x;
    // Sin velocidad visible: orientación propia (rotación de humo / esquirlas).
    vec2 axis = speed > 1e-3 && iMisc.y > 0.0 ? vel / speed : vec2(cos(iMisc.w), sin(iMisc.w));
    // (perp, axis) debe ser una rotación (det = +1): si fuera un reflejo, el
    // quad quedaría de espaldas.
    vec2 perp = vec2(axis.y, -axis.x);
    float len = 1.0 + iMisc.y * speed / max(size, 1e-4);
    vec2 c = position.xy;
    mv.xy += (perp * c.x + axis * c.y * len) * size;
    gl_Position = projectionMatrix * mv;
    float cell = iMisc.z;
    vUv = (uv + vec2(mod(cell, 2.0), 1.0 - floor(cell / 2.0))) * 0.5;
    vColor = iColor;
  }
`;

const PARTICLE_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  uniform float additive;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vec4 tex = texture2D(map, vUv);
    float a = vColor.a * tex.a;
    if (a < 0.004) discard;
    vec3 rgb = vColor.rgb * tex.rgb;
    gl_FragColor = additive > 0.5 ? vec4(rgb * a, 1.0) : vec4(rgb, a);
    #include <colorspace_fragment>
  }
`;

export interface ParticleSpec {
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  size: number;
  /** Tamaño final (crece o se achica linealmente). */
  endSize?: number;
  color: THREE.Color;
  alpha: number;
  tex: number;
  /** Segundos de desenfoque de movimiento (0 = sin estirar). */
  stretch?: number;
  gravity?: number;
  /** Frenado del aire (1/s). */
  drag?: number;
  /** Altura del suelo (plano) para rebotar o dejar mancha. */
  groundY?: number;
  bounce?: boolean;
  /** Al tocar el suelo deja una mancha de este tamaño (m) y color. */
  decal?: { size: number; color: THREE.Color; tex?: number };
  rotation?: number;
  spin?: number;
  /** Exponente del desvanecido: 1 = lineal, alto = opaco hasta el final. */
  fade?: number;
  /** Fracción de vida en la que aparece (humo/niebla). */
  fadeIn?: number;
}

class ParticleSystem {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aVel: THREE.InstancedBufferAttribute;
  private readonly aColor: THREE.InstancedBufferAttribute;
  private readonly aMisc: THREE.InstancedBufferAttribute;
  // Estado de simulación (SoA).
  private readonly pos: Float32Array;
  private readonly vel: Float32Array;
  private readonly color: Float32Array;
  private readonly misc: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  private readonly size0: Float32Array;
  private readonly size1: Float32Array;
  private readonly alpha0: Float32Array;
  private readonly gravity: Float32Array;
  private readonly drag: Float32Array;
  private readonly ground: Float32Array;
  private readonly spin: Float32Array;
  private readonly fade: Float32Array;
  private readonly fadeIn: Float32Array;
  private readonly flags: Uint8Array;
  private readonly decalSize: Float32Array;
  private readonly decalColor: Float32Array;
  private readonly decalTex: Float32Array;
  private next = 0;
  private alive = 0;
  private activeBound = 0;

  constructor(
    private readonly capacity: number,
    map: THREE.Texture,
    additive: boolean,
    private readonly onLand?: (x: number, y: number, z: number, size: number, r: number, g: number, b: number, tex: number) => void,
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute("position", quad.attributes.position);
    this.geometry.setAttribute("uv", quad.attributes.uv);
    this.geometry.instanceCount = 0;
    const attr = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = attr(3);
    this.aVel = attr(3);
    this.aColor = attr(4);
    this.aMisc = attr(4);
    this.geometry.setAttribute("iPos", this.aPos);
    this.geometry.setAttribute("iVel", this.aVel);
    this.geometry.setAttribute("iColor", this.aColor);
    this.geometry.setAttribute("iMisc", this.aMisc);
    this.pos = this.aPos.array as Float32Array;
    this.vel = this.aVel.array as Float32Array;
    this.color = this.aColor.array as Float32Array;
    this.misc = this.aMisc.array as Float32Array;
    const f = () => new Float32Array(capacity);
    this.life = f();
    this.maxLife = f();
    this.size0 = f();
    this.size1 = f();
    this.alpha0 = f();
    this.gravity = f();
    this.drag = f();
    this.ground = f();
    this.spin = f();
    this.fade = f();
    this.fadeIn = f();
    this.decalSize = f();
    this.decalTex = f();
    this.decalColor = new Float32Array(capacity * 3);
    this.flags = new Uint8Array(capacity);

    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: map }, additive: { value: additive ? 1 : 0 } },
      vertexShader: PARTICLE_VERTEX,
      fragmentShader: PARTICLE_FRAGMENT,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    this.mesh.renderOrder = additive ? 13 : 11;
    quad.dispose();
  }

  spawn(p: ParticleSpec): void {
    const i = this.next;
    this.next = (i + 1) % this.capacity;
    const wasAlive = this.life[i] > 0;
    const o3 = i * 3;
    const o4 = i * 4;
    this.pos[o3] = p.x;
    this.pos[o3 + 1] = p.y;
    this.pos[o3 + 2] = p.z;
    this.vel[o3] = p.vx;
    this.vel[o3 + 1] = p.vy;
    this.vel[o3 + 2] = p.vz;
    this.color[o4] = p.color.r;
    this.color[o4 + 1] = p.color.g;
    this.color[o4 + 2] = p.color.b;
    this.color[o4 + 3] = (p.fadeIn ?? 0) > 0 ? 0 : p.alpha;
    this.misc[o4] = p.size;
    this.misc[o4 + 1] = p.stretch ?? 0;
    this.misc[o4 + 2] = p.tex;
    this.misc[o4 + 3] = p.rotation ?? Math.random() * Math.PI * 2;
    this.life[i] = this.maxLife[i] = p.life;
    this.size0[i] = p.size;
    this.size1[i] = p.endSize ?? p.size;
    this.alpha0[i] = p.alpha;
    this.gravity[i] = p.gravity ?? 0;
    this.drag[i] = p.drag ?? 0;
    this.ground[i] = p.groundY ?? -1e9;
    this.spin[i] = p.spin ?? 0;
    this.fade[i] = p.fade ?? 1;
    this.fadeIn[i] = p.fadeIn ?? 0;
    let flags = FLAG_FRESH;
    if (p.bounce) flags |= FLAG_BOUNCE;
    if (p.decal) {
      flags |= FLAG_DECAL;
      this.decalSize[i] = p.decal.size;
      this.decalColor[o3] = p.decal.color.r;
      this.decalColor[o3 + 1] = p.decal.color.g;
      this.decalColor[o3 + 2] = p.decal.color.b;
      this.decalTex[i] = p.decal.tex ?? -1;
    }
    this.flags[i] = flags;
    if (!wasAlive) this.alive++;
    if (i + 1 > this.activeBound) this.activeBound = i + 1;
    this.geometry.instanceCount = this.activeBound;
    this.mesh.visible = true;
  }

  private kill(i: number): void {
    this.life[i] = 0;
    this.misc[i * 4] = 0; // tamaño 0: quad degenerado
    this.color[i * 4 + 3] = 0;
    this.alive = Math.max(0, this.alive - 1);
  }

  update(dt: number): void {
    if (this.alive === 0) {
      this.mesh.visible = false;
      this.geometry.instanceCount = 0;
      return;
    }
    const limit = this.activeBound;
    let maxActive = 0;
    let aliveCount = 0;
    for (let i = 0; i < limit; i++) {
      if (this.life[i] <= 0) continue;
      if (this.flags[i] & FLAG_FRESH) {
        this.flags[i] &= ~FLAG_FRESH;
        maxActive = i + 1;
        aliveCount++;
        continue;
      }
      const life = (this.life[i] -= dt);
      if (life <= 0) {
        this.kill(i);
        continue;
      }
      const o3 = i * 3;
      const o4 = i * 4;
      const k = Math.exp(-this.drag[i] * dt);
      this.vel[o3] *= k;
      this.vel[o3 + 1] = this.vel[o3 + 1] * k - this.gravity[i] * dt;
      this.vel[o3 + 2] *= k;
      this.pos[o3] += this.vel[o3] * dt;
      this.pos[o3 + 1] += this.vel[o3 + 1] * dt;
      this.pos[o3 + 2] += this.vel[o3 + 2] * dt;

      const g = this.ground[i];
      if (this.pos[o3 + 1] < g && this.vel[o3 + 1] < 0) {
        const flags = this.flags[i];
        if (flags & FLAG_DECAL) {
          const c = this.decalColor;
          this.onLand?.(this.pos[o3], g, this.pos[o3 + 2], this.decalSize[i], c[o3], c[o3 + 1], c[o3 + 2], this.decalTex[i]);
          this.kill(i);
          continue;
        }
        if (flags & FLAG_BOUNCE) {
          this.pos[o3 + 1] = g;
          this.vel[o3 + 1] *= -0.3;
          this.vel[o3] *= 0.45;
          this.vel[o3 + 2] *= 0.45;
          this.spin[i] *= 0.5;
          // Quieta en el piso: deja de estirarse.
          if (Math.abs(this.vel[o3 + 1]) < 0.3) this.vel[o3 + 1] = 0;
          this.ground[i] = g;
        } else {
          this.kill(i);
          continue;
        }
      }

      const t = 1 - life / this.maxLife[i]; // 0 → 1
      this.misc[o4] = this.size0[i] + (this.size1[i] - this.size0[i]) * t;
      this.misc[o4 + 3] += this.spin[i] * dt;
      const fi = this.fadeIn[i];
      const appear = fi > 0 ? Math.min(1, t / fi) : 1;
      this.color[o4 + 3] = this.alpha0[i] * appear * (1 - Math.pow(t, this.fade[i]));
      maxActive = i + 1;
      aliveCount++;
    }
    this.alive = aliveCount;
    this.activeBound = maxActive;
    this.geometry.instanceCount = maxActive;
    this.mesh.visible = aliveCount > 0;
    this.aPos.needsUpdate = true;
    this.aVel.needsUpdate = true;
    this.aColor.needsUpdate = true;
    this.aMisc.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// =============================================================================
// Manchas en el suelo
// =============================================================================

const DECAL_VERTEX = /* glsl */ `
  attribute vec3 iPos;
  // x = rotación, y = tamaño, z = opacidad, w = celda del atlas
  attribute vec4 iData;
  attribute vec3 iTint;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    float s = sin(iData.x), c = cos(iData.x);
    vec2 p = position.xy * iData.y;
    vec3 world = iPos + vec3(c * p.x - s * p.y, 0.0, s * p.x + c * p.y);
    gl_Position = projectionMatrix * viewMatrix * vec4(world, 1.0);
    float cell = iData.w;
    vUv = (uv + vec2(mod(cell, 2.0), 1.0 - floor(cell / 2.0))) * 0.5;
    vColor = vec4(iTint, iData.z);
  }
`;

const DECAL_FRAGMENT = /* glsl */ `
  uniform sampler2D map;
  varying vec2 vUv;
  varying vec4 vColor;
  void main() {
    vec4 tex = texture2D(map, vUv);
    float a = vColor.a * tex.a;
    if (a < 0.01) discard;
    gl_FragColor = vec4(vColor.rgb * tex.rgb, a);
    #include <colorspace_fragment>
  }
`;

class DecalSystem {
  readonly mesh: THREE.Mesh;
  private readonly geometry: THREE.InstancedBufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly aPos: THREE.InstancedBufferAttribute;
  private readonly aData: THREE.InstancedBufferAttribute;
  private readonly aTint: THREE.InstancedBufferAttribute;
  private readonly age: Float32Array;
  private readonly delay: Float32Array;
  private readonly targetSize: Float32Array;
  private readonly growTime: Float32Array;
  private readonly opacity: Float32Array;
  private next = 0;
  private alive = 0;
  private activeBound = 0;
  lifetime = 45;

  constructor(
    private readonly capacity: number,
    map: THREE.Texture,
  ) {
    const quad = new THREE.PlaneGeometry(1, 1);
    this.geometry = new THREE.InstancedBufferGeometry();
    this.geometry.index = quad.index;
    this.geometry.setAttribute("position", quad.attributes.position);
    this.geometry.setAttribute("uv", quad.attributes.uv);
    this.geometry.instanceCount = 0;
    const attr = (n: number) => new THREE.InstancedBufferAttribute(new Float32Array(capacity * n), n).setUsage(THREE.DynamicDrawUsage);
    this.aPos = attr(3);
    this.aData = attr(4);
    this.aTint = attr(3);
    this.geometry.setAttribute("iPos", this.aPos);
    this.geometry.setAttribute("iData", this.aData);
    this.geometry.setAttribute("iTint", this.aTint);
    this.age = new Float32Array(capacity).fill(Infinity);
    this.delay = new Float32Array(capacity);
    this.targetSize = new Float32Array(capacity);
    this.growTime = new Float32Array(capacity);
    this.opacity = new Float32Array(capacity);
    this.material = new THREE.ShaderMaterial({
      uniforms: { map: { value: map } },
      vertexShader: DECAL_VERTEX,
      fragmentShader: DECAL_FRAGMENT,
      transparent: true,
      depthWrite: false,
      // El quad se proyecta sobre XZ: según el lado, queda mirando hacia abajo.
      side: THREE.DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });
    this.mesh = new THREE.Mesh(this.geometry, this.material);
    this.mesh.frustumCulled = false;
    this.mesh.visible = false;
    // Después de los splats (como las sombras de contacto) para que el suelo no las tape.
    this.mesh.renderOrder = 9;
    quad.dispose();
  }

  add(
    x: number,
    y: number,
    z: number,
    size: number,
    tint: THREE.Color | [number, number, number],
    tex: number,
    opts: { opacity?: number; grow?: number; delay?: number } = {},
  ): void {
    const i = this.next;
    this.next = (i + 1) % this.capacity;
    const wasAlive = this.age[i] !== Infinity;
    const p = this.aPos.array as Float32Array;
    // Un poco por encima del suelo; los charcos más grandes, más arriba (z-fighting).
    p[i * 3] = x;
    p[i * 3 + 1] = y + 0.02 + Math.min(0.03, size * 0.01) + Math.random() * 0.004;
    p[i * 3 + 2] = z;
    const d = this.aData.array as Float32Array;
    d[i * 4] = Math.random() * Math.PI * 2;
    d[i * 4 + 1] = opts.grow ? size * 0.1 : size;
    d[i * 4 + 2] = 0;
    d[i * 4 + 3] = tex;
    const t = this.aTint.array as Float32Array;
    if (Array.isArray(tint)) t.set(tint, i * 3);
    else t.set([tint.r, tint.g, tint.b], i * 3);
    this.age[i] = 0;
    this.delay[i] = opts.delay ?? 0;
    this.targetSize[i] = size;
    this.growTime[i] = opts.grow ?? 0;
    this.opacity[i] = opts.opacity ?? 1;
    if (!wasAlive) this.alive++;
    if (i + 1 > this.activeBound) this.activeBound = i + 1;
    this.geometry.instanceCount = this.activeBound;
    this.mesh.visible = true;
    this.aPos.needsUpdate = true;
    this.aTint.needsUpdate = true;
    this.aData.needsUpdate = true;
  }

  update(dt: number): void {
    if (this.alive === 0) {
      this.mesh.visible = false;
      this.geometry.instanceCount = 0;
      return;
    }
    const d = this.aData.array as Float32Array;
    const limit = this.activeBound;
    let maxActive = 0;
    let aliveCount = 0;
    let dataChanged = false;
    for (let i = 0; i < limit; i++) {
      if (this.age[i] === Infinity) continue;
      if (this.delay[i] > 0) {
        this.delay[i] -= dt;
        maxActive = i + 1;
        aliveCount++;
        continue;
      }
      const age = (this.age[i] += dt);
      if (age > this.lifetime) {
        this.age[i] = Infinity;
        d[i * 4 + 2] = 0;
        d[i * 4 + 1] = 0;
        dataChanged = true;
        continue;
      }
      maxActive = i + 1;
      aliveCount++;
      const grow = this.growTime[i];
      if (grow > 0 && age <= grow + dt) {
        // Charco: se expande rápido al principio y frena (la hemolinfa es espesa).
        const k = Math.min(1, age / grow);
        d[i * 4 + 1] = this.targetSize[i] * (0.1 + 0.9 * (1 - Math.pow(1 - k, 3)));
        dataChanged = true;
      }
      // Aparece en 0,1 s; los últimos 4 s se desvanece.
      const fadeOut = Math.min(1, (this.lifetime - age) / 4);
      const nextAlpha = this.opacity[i] * Math.min(1, age * 10) * fadeOut;
      if (Math.abs(d[i * 4 + 2] - nextAlpha) > 1e-4) {
        d[i * 4 + 2] = nextAlpha;
        dataChanged = true;
      }
    }
    this.alive = aliveCount;
    this.activeBound = maxActive;
    this.geometry.instanceCount = maxActive;
    this.mesh.visible = aliveCount > 0;
    if (dataChanged) this.aData.needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }
}

// =============================================================================
// Efectos de combate
// =============================================================================

export class Effects {
  readonly group = new THREE.Group();
  private readonly particles: ParticleSystem;
  private readonly glow: ParticleSystem;
  private readonly decals: DecalSystem;

  // Fogonazo
  private readonly flashLight: THREE.PointLight;
  private readonly flashFront: THREE.Mesh;
  private readonly flashSide: THREE.Mesh;
  private readonly flashSideGeometry: THREE.BufferGeometry;
  private readonly flashDir = new THREE.Vector3();
  private flashFrames = 0;
  private flashLife = 0;

  // Paleta (colores lineales)
  private readonly blood = new THREE.Color();
  private readonly bloodDark = new THREE.Color();
  private readonly bloodMist = new THREE.Color();
  private readonly bloodDecal = new THREE.Color();
  private readonly chitin = new THREE.Color(0x1a1613);
  private readonly smoke = new THREE.Color(0x8d8a86);
  private readonly snow = new THREE.Color(0xeef2f5);
  private readonly snowShade = new THREE.Color(0xc9d1d8);
  private readonly brass = new THREE.Color(0xc8973d);
  private readonly spark = new THREE.Color(0xffc673);
  private readonly tracerColor = new THREE.Color(0xffe2a8);
  private readonly scorch = new THREE.Color(0x2b2a29);
  private readonly tmpColor = new THREE.Color();

  private readonly v = new THREE.Vector3();
  private readonly side = new THREE.Vector3();
  private readonly toCam = new THREE.Vector3();
  private readonly disposables: { dispose(): void }[] = [];

  constructor(bloodColor = "#7d8f1e") {
    this.group.name = "combat-effects";
    const particleAtlas = createParticleAtlas();
    const decalAtlas = createDecalAtlas();
    this.decals = new DecalSystem(320, decalAtlas);
    const land = (x: number, y: number, z: number, size: number, r: number, g: number, b: number, tex: number) => {
      this.decals.add(x, y, z, size * rand(0.8, 1.25), [r, g, b], tex >= 0 ? tex : DECAL_SPLAT[(Math.random() * 2) | 0], { opacity: rand(0.75, 0.95) });
    };
    this.particles = new ParticleSystem(2600, particleAtlas, false, land);
    this.glow = new ParticleSystem(400, particleAtlas, true);
    this.setBloodColor(bloodColor);

    // --- Fogonazo ---------------------------------------------------------------
    // Luz cálida y muy breve: ilumina al Eternauta, la nieve y los cascarudos cercanos.
    this.flashLight = new THREE.PointLight(0xffa850, 0, 10, 2);
    const frontTexture = createFlashFrontTexture();
    const sideTexture = createFlashSideTexture();
    const flashMaterial = (map: THREE.Texture) =>
      new THREE.MeshBasicMaterial({
        map,
        transparent: true,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
        side: THREE.DoubleSide,
        toneMapped: false,
      });
    const frontMaterial = flashMaterial(frontTexture);
    const sideMaterial = flashMaterial(sideTexture);
    this.flashFront = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), frontMaterial);
    // La llama lateral: quad reconstruido cada frame alineado al cañón y de frente a la cámara.
    this.flashSideGeometry = new THREE.BufferGeometry();
    this.flashSideGeometry.setAttribute("position", new THREE.BufferAttribute(new Float32Array(12), 3));
    this.flashSideGeometry.setAttribute("uv", new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    this.flashSideGeometry.setIndex([0, 1, 2, 0, 2, 3]);
    this.flashSide = new THREE.Mesh(this.flashSideGeometry, sideMaterial);
    for (const m of [this.flashFront, this.flashSide]) {
      m.visible = false;
      m.frustumCulled = false;
      m.renderOrder = 14;
    }

    this.group.add(this.decals.mesh, this.particles.mesh, this.glow.mesh, this.flashLight, this.flashFront, this.flashSide);
    this.disposables.push(
      this.particles,
      this.glow,
      this.decals,
      particleAtlas,
      decalAtlas,
      frontTexture,
      sideTexture,
      frontMaterial,
      sideMaterial,
      this.flashFront.geometry,
      this.flashSideGeometry,
    );
  }

  setBloodColor(hex: string): void {
    this.blood.set(hex);
    this.bloodDark.copy(this.blood).multiplyScalar(0.45);
    // Las partículas no reciben luz: el día nublado apaga el tono saturado.
    this.blood.multiplyScalar(0.75);
    // La niebla pulverizada es más pálida y grisácea que el líquido.
    this.bloodMist.copy(this.blood).lerp(new THREE.Color(0x8a8c78), 0.5).multiplyScalar(0.8);
    // Sobre la nieve la hemolinfa se ve más oscura, empapada y menos saturada.
    this.bloodDecal.copy(this.blood).lerp(new THREE.Color(0x3a3420), 0.35).multiplyScalar(0.5);
  }

  set decalLifetime(seconds: number) {
    this.decals.lifetime = seconds;
  }

  /** Multiplicador de cantidad de partículas por ráfaga (0.15 a 1). */
  particleDensity = 1;

  private count(base: number): number {
    return Math.max(1, Math.round(base * THREE.MathUtils.clamp(this.particleDensity, 0.15, 1)));
  }

  private shade(base: THREE.Color, min: number, max: number): THREE.Color {
    return this.tmpColor.copy(base).multiplyScalar(rand(min, max));
  }

  // ---------------------------------------------------------------------------
  // Disparo
  // ---------------------------------------------------------------------------

  /**
   * Fogonazo, humo, vaina y trazadora de un disparo.
   * @param dir dirección del cañón hacia el blanco (normalizada)
   * @param feetY altura del suelo bajo el tirador (para la vaina)
   */
  shot(muzzle: THREE.Vector3, dir: THREE.Vector3, target: THREE.Vector3, feetY: number): void {
    // --- Fogonazo: dura 1-2 frames, forma y tamaño distintos en cada tiro.
    this.flashDir.copy(dir);
    this.flashFront.position.copy(muzzle).addScaledVector(dir, 0.04);
    this.flashFront.userData.scale = rand(0.22, 0.36);
    this.flashFront.userData.rot = Math.random() * Math.PI * 2;
    this.flashSide.userData.length = rand(0.38, 0.62);
    this.flashSide.userData.width = rand(0.13, 0.2);
    this.flashSide.position.copy(muzzle);
    this.flashFrames = 2;
    this.flashLife = 0.05;
    this.flashLight.position.copy(muzzle).addScaledVector(dir, 0.3);

    // Chispas de pólvora: rayas rápidas en un cono hacia adelante.
    const sparks = this.count(7);
    for (let n = 0; n < sparks; n++) {
      const speed = rand(10, 26);
      this.v.copy(dir).multiplyScalar(speed);
      this.v.x += rand(-1, 1) * speed * 0.22;
      this.v.y += rand(-1, 1) * speed * 0.22;
      this.v.z += rand(-1, 1) * speed * 0.22;
      this.glow.spawn({
        x: muzzle.x + dir.x * 0.1,
        y: muzzle.y + dir.y * 0.1,
        z: muzzle.z + dir.z * 0.1,
        vx: this.v.x,
        vy: this.v.y,
        vz: this.v.z,
        life: rand(0.04, 0.11),
        size: rand(0.008, 0.016),
        color: this.spark,
        alpha: 1,
        tex: TEX_SPARK,
        stretch: 1 / 60,
        drag: 6,
        fade: 2,
      });
    }

    // Humo: gases que salen del cañón, se expanden, suben y se los lleva el aire.
    const smokes = this.count(3);
    for (let n = 0; n < smokes; n++) {
      const speed = rand(0.6, 2.2) * (n + 1) * 0.6;
      this.particles.spawn({
        x: muzzle.x + dir.x * 0.15 * n,
        y: muzzle.y + dir.y * 0.15 * n,
        z: muzzle.z + dir.z * 0.15 * n,
        vx: dir.x * speed + rand(-0.2, 0.2),
        vy: dir.y * speed + rand(0.15, 0.45),
        vz: dir.z * speed + rand(-0.2, 0.2),
        life: rand(0.9, 1.6),
        size: rand(0.08, 0.14),
        endSize: rand(0.5, 0.9),
        color: this.shade(this.smoke, 0.85, 1.1),
        alpha: rand(0.12, 0.2),
        tex: TEX_SMOKE,
        drag: 2.5,
        gravity: -0.25,
        fadeIn: 0.08,
        spin: rand(-0.8, 0.8),
      });
    }

    // Vaina: sale por la ventana de expulsión (~0,6 m detrás de la boca), a la
    // derecha, gira y rebota en el piso.
    this.side.crossVectors(dir, THREE.Object3D.DEFAULT_UP).normalize();
    this.particles.spawn({
      x: muzzle.x - dir.x * 0.6,
      y: muzzle.y + 0.05,
      z: muzzle.z - dir.z * 0.6,
      vx: this.side.x * rand(1.8, 2.8) - dir.x * 0.4,
      vy: rand(1.8, 2.8),
      vz: this.side.z * rand(1.8, 2.8) - dir.z * 0.4,
      life: rand(1.6, 2.2),
      size: 0.022,
      color: this.shade(this.brass, 0.85, 1.15),
      alpha: 1,
      tex: TEX_CHUNK,
      gravity: 9.8,
      groundY: feetY + 0.01,
      bounce: true,
      spin: rand(15, 30),
      fade: 6,
    });

    // Trazadora: raya de ~4 m que viaja a 350 m/s (se ve 1-2 frames, como en la realidad).
    const dist = muzzle.distanceTo(target);
    const speed = 350;
    const streak = Math.min(4, dist * 0.6);
    if (dist > 1.5) {
      this.glow.spawn({
        x: muzzle.x + dir.x * (0.6 + streak / 2),
        y: muzzle.y + dir.y * (0.6 + streak / 2),
        z: muzzle.z + dir.z * (0.6 + streak / 2),
        vx: dir.x * speed,
        vy: dir.y * speed,
        vz: dir.z * speed,
        life: Math.max(0.001, (dist - 0.6 - streak) / speed),
        size: 0.018,
        color: this.tracerColor,
        alpha: 0.55,
        tex: TEX_SPARK,
        stretch: streak / speed,
        fade: 1,
      });
    }
  }

  // ---------------------------------------------------------------------------
  // Hemolinfa
  // ---------------------------------------------------------------------------

  /**
   * Balazo en un cascarudo: chorro de gotas que sale de la herida (más fuerte
   * hacia afuera y en el sentido de la bala), niebla fina y esquirlas del
   * caparazón. Las gotas que llegan al piso dejan manchas en la nieve.
   * @param scale tamaño del cascarudo (las gotas y la presión escalan)
   */
  bloodHit(point: THREE.Vector3, normal: THREE.Vector3, bulletDir: THREE.Vector3, groundY: number, scale = 1, intensity = 1): void {
    // Presión ~ √escala; volumen de la herida ~ escala.
    const s = Math.sqrt(scale);
    const effIntensity = intensity * THREE.MathUtils.clamp(this.particleDensity, 0.15, 1);
    const drops = Math.max(2, Math.round(40 * effIntensity));
    for (let n = 0; n < drops; n++) {
      // Cono alrededor de la normal, empujado por la bala (salpica hacia atrás y a los costados).
      this.v.set(rand(-1, 1), rand(-0.6, 1), rand(-1, 1)).multiplyScalar(0.55);
      this.v.addScaledVector(normal, 1).addScaledVector(bulletDir, rand(-0.2, 0.6)).normalize();
      const speed = rand(1.2, 5.5) * s * (n < drops * 0.2 ? 1.5 : 1);
      const size = dropSize(0.008, 0.05) * scale;
      this.particles.spawn({
        x: point.x,
        y: point.y,
        z: point.z,
        vx: this.v.x * speed,
        vy: this.v.y * speed + rand(0, 1.5),
        vz: this.v.z * speed,
        life: 2.5,
        size,
        color: this.shade(this.blood, 0.45, 1.05),
        alpha: 0.96,
        tex: TEX_DROP,
        stretch: 1 / 22,
        gravity: 9.8,
        drag: 0.4,
        groundY,
        fade: 8,
        decal: Math.random() < 0.55 ? { size: size * rand(4, 7), color: this.shade(this.bloodDecal, 0.8, 1.1) } : undefined,
      });
    }
    // Chorro: un hilo denso que sale de la herida en línea (la hemolinfa a presión).
    this.v.copy(normal).addScaledVector(bulletDir, -0.3).normalize();
    for (let n = 0; n < Math.max(1, Math.round(10 * effIntensity)); n++) {
      const speed = (2.5 + n * 0.35) * s;
      this.particles.spawn({
        x: point.x,
        y: point.y,
        z: point.z,
        vx: this.v.x * speed + rand(-0.15, 0.15),
        vy: this.v.y * speed + rand(0, 0.4),
        vz: this.v.z * speed + rand(-0.15, 0.15),
        life: 2.5,
        size: rand(0.025, 0.05) * scale,
        color: this.shade(this.blood, 0.6, 0.95),
        alpha: 0.97,
        tex: TEX_DROP,
        stretch: 1 / 18,
        gravity: 9.8,
        drag: 0.3,
        groundY,
        fade: 8,
        decal: n % 2 === 0 ? { size: 0.25 * scale * rand(0.8, 1.3), color: this.shade(this.bloodDecal, 0.8, 1) } : undefined,
      });
    }
    // Niebla de hemolinfa pulverizada: se abre en una nube y cae despacio.
    for (let n = 0; n < Math.max(1, Math.round(6 * effIntensity)); n++) {
      this.v.copy(normal).multiplyScalar(rand(0.6, 1.8) * s);
      this.particles.spawn({
        x: point.x,
        y: point.y,
        z: point.z,
        vx: this.v.x + rand(-0.4, 0.4),
        vy: this.v.y + rand(-0.1, 0.5),
        vz: this.v.z + rand(-0.4, 0.4),
        life: rand(0.5, 0.9),
        size: rand(0.12, 0.2) * scale,
        endSize: rand(0.5, 0.9) * scale,
        color: this.shade(this.bloodMist, 0.75, 1),
        alpha: rand(0.18, 0.3),
        tex: TEX_SMOKE,
        drag: 4,
        gravity: 0.6,
        fadeIn: 0.05,
        spin: rand(-1, 1),
      });
    }
    // Esquirlas de caparazón.
    for (let n = 0; n < Math.max(1, Math.round(3 * effIntensity)); n++) {
      this.v.copy(normal).multiplyScalar(rand(2, 5)).add(this.side.set(rand(-2, 2), rand(0.5, 3), rand(-2, 2)));
      this.particles.spawn({
        x: point.x,
        y: point.y,
        z: point.z,
        vx: this.v.x,
        vy: this.v.y,
        vz: this.v.z,
        life: rand(1.2, 2.2),
        size: rand(0.03, 0.08) * s,
        color: this.shade(this.chitin, 0.8, 1.4),
        alpha: 1,
        tex: TEX_CHUNK,
        gravity: 9.8,
        drag: 0.3,
        groundY,
        bounce: true,
        spin: rand(-14, 14),
        fade: 6,
      });
    }
  }

  /**
   * Muerte: borbotón de hemolinfa que sube y cae alrededor, esquirlas y un
   * charco que se expande lentamente bajo el cadáver.
   */
  deathGush(center: THREE.Vector3, groundY: number, scale = 1): void {
    const s = Math.sqrt(scale);
    const gushDrops = this.count(90);
    for (let n = 0; n < gushDrops; n++) {
      const a = Math.random() * Math.PI * 2;
      const out = rand(0.5, 3.2) * s;
      const size = dropSize(0.01, 0.08) * scale;
      this.particles.spawn({
        x: center.x + Math.cos(a) * 0.3 * scale,
        y: center.y,
        z: center.z + Math.sin(a) * 0.3 * scale,
        vx: Math.cos(a) * out,
        vy: rand(1.5, 6) * s,
        vz: Math.sin(a) * out,
        life: 3,
        size,
        color: this.shade(this.blood, 0.45, 1.05),
        alpha: 0.96,
        tex: TEX_DROP,
        stretch: 1 / 22,
        gravity: 9.8,
        drag: 0.3,
        groundY,
        fade: 8,
        decal: Math.random() < 0.6 ? { size: size * rand(4, 7), color: this.shade(this.bloodDecal, 0.75, 1.05) } : undefined,
      });
    }
    const mistCount = this.count(10);
    for (let n = 0; n < mistCount; n++) {
      this.particles.spawn({
        x: center.x,
        y: center.y,
        z: center.z,
        vx: rand(-1.5, 1.5) * s,
        vy: rand(0.2, 1.5) * s,
        vz: rand(-1.5, 1.5) * s,
        life: rand(0.7, 1.2),
        size: 0.3 * s,
        endSize: rand(1.2, 1.8) * s,
        color: this.shade(this.bloodMist, 0.75, 1),
        alpha: 0.22,
        tex: TEX_SMOKE,
        drag: 3,
        gravity: 0.5,
        fadeIn: 0.05,
        spin: rand(-0.6, 0.6),
      });
    }
    const chunkCount = this.count(14);
    for (let n = 0; n < chunkCount; n++) {
      this.particles.spawn({
        x: center.x,
        y: center.y,
        z: center.z,
        vx: rand(-4, 4) * s,
        vy: rand(2, 6) * s,
        vz: rand(-4, 4) * s,
        life: rand(2, 3),
        size: rand(0.05, 0.14) * s,
        color: this.shade(this.chitin, 0.8, 1.4),
        alpha: 1,
        tex: TEX_CHUNK,
        gravity: 9.8,
        groundY,
        bounce: true,
        spin: rand(-12, 12),
        fade: 6,
      });
    }
    // Charco: aparece cuando el cuerpo ya cayó y se extiende unos segundos.
    // El cadáver mide ~2,2 m × escala de ancho: el charco tiene que asomar alrededor.
    this.decals.add(center.x, groundY, center.z, 3.4 * scale, this.bloodDecal, DECAL_POOL, { grow: 7, delay: 0.5, opacity: 0.92 });
  }

  /** Gota que chorrea de un cascarudo herido (deja rastro en la nieve). */
  drip(point: THREE.Vector3, groundY: number, scale = 1): void {
    const size = rand(0.015, 0.035) * scale;
    this.particles.spawn({
      x: point.x,
      y: point.y,
      z: point.z,
      vx: rand(-0.2, 0.2),
      vy: rand(-0.5, 0),
      vz: rand(-0.2, 0.2),
      life: 3,
      size,
      color: this.shade(this.blood, 0.5, 0.9),
      alpha: 0.95,
      tex: TEX_DROP,
      stretch: 1 / 22,
      gravity: 9.8,
      groundY,
      fade: 8,
      decal: { size: size * rand(5, 8), color: this.shade(this.bloodDecal, 0.8, 1) },
    });
  }

  // ---------------------------------------------------------------------------
  // Escenario
  // ---------------------------------------------------------------------------

  /**
   * Bala que pega en el escenario. En el suelo: nieve pulverizada, terrones y un
   * agujero; en paredes: polvo de revoque y chispas.
   */
  impact(point: THREE.Vector3, normal: THREE.Vector3, groundY: number, onGround: boolean): void {
    const puffs = this.count(4);
    for (let n = 0; n < puffs; n++) {
      this.v.copy(normal).multiplyScalar(rand(0.4, 1.4));
      this.particles.spawn({
        x: point.x,
        y: point.y,
        z: point.z,
        vx: this.v.x + rand(-0.3, 0.3),
        vy: this.v.y + rand(0, 0.4),
        vz: this.v.z + rand(-0.3, 0.3),
        life: rand(0.6, 1.1),
        size: rand(0.06, 0.1),
        endSize: rand(0.35, 0.6),
        color: this.shade(onGround ? this.snow : this.snowShade, 0.85, 1),
        alpha: rand(0.35, 0.55),
        tex: TEX_SMOKE,
        drag: 3.5,
        gravity: 0.8,
        fadeIn: 0.05,
        spin: rand(-1, 1),
      });
    }
    const debris = this.count(9);
    for (let n = 0; n < debris; n++) {
      this.v.copy(normal).multiplyScalar(rand(1.5, 4)).add(this.side.set(rand(-1.5, 1.5), rand(0, 2), rand(-1.5, 1.5)));
      this.particles.spawn({
        x: point.x,
        y: point.y,
        z: point.z,
        vx: this.v.x,
        vy: this.v.y,
        vz: this.v.z,
        life: rand(0.6, 1.2),
        size: rand(0.012, 0.03),
        color: this.shade(onGround ? this.snow : this.snowShade, 0.7, 1),
        alpha: 1,
        tex: onGround ? TEX_DROP : TEX_CHUNK,
        stretch: 1 / 60,
        gravity: 9.8,
        drag: 0.6,
        groundY,
        bounce: !onGround,
        fade: 4,
      });
    }
    if (!onGround) {
      for (let n = 0; n < 4; n++) {
        this.v.copy(normal).multiplyScalar(rand(4, 9)).add(this.side.set(rand(-3, 3), rand(-1, 3), rand(-3, 3)));
        this.glow.spawn({
          x: point.x,
          y: point.y,
          z: point.z,
          vx: this.v.x,
          vy: this.v.y,
          vz: this.v.z,
          life: rand(0.08, 0.2),
          size: rand(0.006, 0.012),
          color: this.spark,
          alpha: 1,
          tex: TEX_SPARK,
          stretch: 1 / 50,
          gravity: 9.8,
          fade: 2,
        });
      }
    } else {
      this.decals.add(point.x, groundY, point.z, rand(0.12, 0.2), this.scorch, DECAL_HOLE, { opacity: 0.85 });
    }
  }

  /** Pisada de un cascarudo: nube de nieve que se levanta y terrones. */
  footstep(point: THREE.Vector3, scale = 1): void {
    const puffs = this.count(3);
    for (let n = 0; n < puffs; n++) {
      const a = Math.random() * Math.PI * 2;
      const out = rand(0.3, 0.8) * scale * 0.5;
      this.particles.spawn({
        x: point.x,
        y: point.y + 0.05,
        z: point.z,
        vx: Math.cos(a) * out,
        vy: rand(0.15, 0.5) * scale * 0.4,
        vz: Math.sin(a) * out,
        life: rand(1, 1.6),
        size: 0.15 * scale,
        endSize: rand(0.55, 0.85) * scale,
        color: this.shade(this.snow, 0.9, 1),
        alpha: rand(0.4, 0.55),
        tex: TEX_SMOKE,
        drag: 3,
        gravity: 0.3,
        fadeIn: 0.08,
        spin: rand(-0.6, 0.6),
      });
    }
    const clumps = this.count(7);
    for (let n = 0; n < clumps; n++) {
      this.particles.spawn({
        x: point.x,
        y: point.y + 0.05,
        z: point.z,
        vx: rand(-1, 1) * scale * 0.6,
        vy: rand(1, 2.4) * Math.sqrt(scale),
        vz: rand(-1, 1) * scale * 0.6,
        life: 1,
        size: rand(0.015, 0.035) * scale,
        color: this.shade(this.snow, 0.85, 1),
        alpha: 1,
        tex: TEX_DROP,
        stretch: 1 / 60,
        gravity: 9.8,
        groundY: point.y,
        fade: 4,
      });
    }
  }

  // ---------------------------------------------------------------------------

  update(dt: number, camera: THREE.Camera): void {
    this.particles.update(dt);
    this.glow.update(dt);
    this.decals.update(dt);

    // Fogonazo: visible al menos un frame aunque el frame dure más de 50 ms.
    this.flashLife -= dt;
    const on = this.flashFrames > 0 || this.flashLife > 0;
    this.flashFrames = Math.max(0, this.flashFrames - 1);
    this.flashFront.visible = this.flashSide.visible = on;
    this.flashLight.intensity = on ? rand(2.5, 4) : 0;
    if (!on) return;

    // Estrella frontal: de frente a la cámara, girada al azar.
    const sc = this.flashFront.userData.scale as number;
    this.flashFront.quaternion.copy(camera.quaternion);
    this.flashFront.rotateZ(this.flashFront.userData.rot as number);
    this.flashFront.scale.setScalar(sc);

    // Llama lateral: a lo largo del cañón, ensanchada hacia la cámara.
    const len = this.flashSide.userData.length as number;
    const w = (this.flashSide.userData.width as number) / 2;
    const origin = this.flashSide.position;
    this.toCam.copy(camera.position).sub(origin).normalize();
    this.side.crossVectors(this.flashDir, this.toCam);
    if (this.side.lengthSq() < 1e-6) this.side.set(0, 1, 0);
    this.side.normalize();
    const p = this.flashSideGeometry.attributes.position.array as Float32Array;
    const d = this.flashDir;
    const set = (i: number, along: number, across: number) => {
      p[i * 3] = d.x * along + this.side.x * across;
      p[i * 3 + 1] = d.y * along + this.side.y * across;
      p[i * 3 + 2] = d.z * along + this.side.z * across;
    };
    set(0, 0, -w);
    set(1, len, -w);
    set(2, len, w);
    set(3, 0, w);
    this.flashSideGeometry.attributes.position.needsUpdate = true;
  }

  dispose(): void {
    this.group.removeFromParent();
    for (const d of this.disposables) d.dispose();
  }
}

// =============================================================================
// Texturas procedurales
// =============================================================================

function canvas(w: number, h = w): [HTMLCanvasElement, CanvasRenderingContext2D] {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  return [c, c.getContext("2d")!];
}

function texture(c: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

/** Atlas 2×2: humo, gota, esquirla, chispa (blancos: el color va por partícula). */
function createParticleAtlas(): THREE.CanvasTexture {
  const S = 128;
  const [c, ctx] = canvas(S * 2);

  // 0 · Humo: suma de manchas suaves con borde irregular.
  ctx.save();
  for (let i = 0; i < 26; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * S * 0.22;
    const x = S / 2 + Math.cos(a) * r;
    const y = S / 2 + Math.sin(a) * r;
    const rad = S * (0.14 + Math.random() * 0.16);
    const g = ctx.createRadialGradient(x, y, 0, x, y, rad);
    g.addColorStop(0, "rgba(255,255,255,0.22)");
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, S, S);
  }
  ctx.restore();

  // 1 · Gota: líquido denso, más oscuro hacia el borde (espesor), con un
  // reflejo especular chico desplazado (luz del cielo) y borde nítido.
  ctx.save();
  ctx.translate(S, 0);
  let g = ctx.createRadialGradient(S * 0.46, S * 0.46, 0, S / 2, S / 2, S * 0.4);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.55, "rgba(205,205,205,1)");
  g.addColorStop(0.88, "rgba(120,120,120,1)");
  g.addColorStop(1, "rgba(90,90,90,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  // Reflejo (hemolinfa húmeda).
  g = ctx.createRadialGradient(S * 0.38, S * 0.36, 0, S * 0.38, S * 0.36, S * 0.09);
  g.addColorStop(0, "rgba(255,255,255,0.9)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.globalCompositeOperation = "lighter";
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();

  // 2 · Esquirla: polígono irregular con una arista clara.
  ctx.save();
  ctx.translate(0, S);
  ctx.beginPath();
  const pts = 7;
  for (let i = 0; i < pts; i++) {
    const a = (i / pts) * Math.PI * 2;
    const r = S * (0.22 + Math.random() * 0.2);
    ctx.lineTo(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r * 0.75);
  }
  ctx.closePath();
  ctx.fillStyle = "rgb(210,210,210)";
  ctx.fill();
  ctx.strokeStyle = "rgba(255,255,255,0.9)";
  ctx.lineWidth = 3;
  ctx.stroke();
  ctx.restore();

  // 3 · Chispa: núcleo gaussiano muy brillante.
  ctx.save();
  ctx.translate(S, S);
  g = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S / 2);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.25, "rgba(255,255,255,0.8)");
  g.addColorStop(0.6, "rgba(255,255,255,0.15)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();

  return texture(c);
}

/** Atlas 2×2 de manchas: dos salpicaduras, charco, agujero de bala. */
function createDecalAtlas(): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S * 2);

  const blob = (x: number, y: number, r: number, alpha: number) => {
    const g = ctx.createRadialGradient(x, y, 0, x, y, r);
    g.addColorStop(0, `rgba(255,255,255,${alpha})`);
    g.addColorStop(0.7, `rgba(255,255,255,${alpha})`);
    g.addColorStop(1, "rgba(255,255,255,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };

  // 0 y 1 · Salpicaduras: mancha central irregular, gotas satélite y regueros.
  for (let v = 0; v < 2; v++) {
    ctx.save();
    ctx.translate(v * S, 0);
    const cx = S / 2;
    const cy = S / 2;
    for (let i = 0; i < 14; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * S * 0.1;
      blob(cx + Math.cos(a) * r, cy + Math.sin(a) * r, S * (0.07 + Math.random() * 0.1), 0.95);
    }
    for (let i = 0; i < 26; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = S * (0.18 + Math.random() * 0.26);
      blob(cx + Math.cos(a) * r, cy + Math.sin(a) * r, S * (0.006 + Math.random() * 0.025), 0.9);
    }
    // Regueros: la gota llegó en ángulo y se arrastró.
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineCap = "round";
    for (let i = 0; i < 5; i++) {
      const a = Math.random() * Math.PI * 2;
      const r0 = S * 0.12;
      const r1 = S * (0.25 + Math.random() * 0.2);
      ctx.lineWidth = S * (0.01 + Math.random() * 0.02);
      ctx.beginPath();
      ctx.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0);
      ctx.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1);
      ctx.stroke();
    }
    ctx.restore();
  }

  // 2 · Charco: borde orgánico, centro más oscuro y espeso, brillo húmedo.
  ctx.save();
  ctx.translate(0, S);
  for (let i = 0; i < 22; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = Math.random() * S * 0.2;
    blob(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r * 0.9, S * (0.12 + Math.random() * 0.12), 0.97);
  }
  // Centro más oscuro (la textura multiplica el color: gris = más oscuro).
  ctx.globalCompositeOperation = "source-atop";
  const dark = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.3);
  dark.addColorStop(0, "rgba(90,90,90,0.75)");
  dark.addColorStop(1, "rgba(90,90,90,0)");
  ctx.fillStyle = dark;
  ctx.fillRect(0, 0, S, S);
  const shine = ctx.createRadialGradient(S * 0.42, S * 0.4, 0, S * 0.42, S * 0.4, S * 0.18);
  shine.addColorStop(0, "rgba(255,255,255,0.5)");
  shine.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = shine;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();

  // 3 · Agujero de bala en la nieve: cráter oscuro con borde de nieve removida.
  ctx.save();
  ctx.translate(S, S);
  for (let i = 0; i < 10; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = S * (0.06 + Math.random() * 0.12);
    blob(S / 2 + Math.cos(a) * r, S / 2 + Math.sin(a) * r, S * (0.03 + Math.random() * 0.05), 0.4);
  }
  blob(S / 2, S / 2, S * 0.13, 0.9);
  const hole = ctx.createRadialGradient(S / 2, S / 2, 0, S / 2, S / 2, S * 0.08);
  hole.addColorStop(0, "rgba(20,20,20,1)");
  hole.addColorStop(1, "rgba(20,20,20,0)");
  ctx.globalCompositeOperation = "source-atop";
  ctx.fillStyle = hole;
  ctx.fillRect(0, 0, S, S);
  ctx.restore();

  return texture(c);
}

/** Fogonazo frontal: núcleo blanco, halo naranja y 4-5 púas irregulares. */
function createFlashFrontTexture(): THREE.CanvasTexture {
  const S = 256;
  const [c, ctx] = canvas(S);
  const cx = S / 2;
  ctx.globalCompositeOperation = "lighter";
  const prongs = 5;
  for (let i = 0; i < prongs; i++) {
    const a = (i / prongs) * Math.PI * 2 + (Math.random() - 0.5) * 0.5;
    const len = S * (0.32 + Math.random() * 0.16);
    const width = S * (0.05 + Math.random() * 0.03);
    ctx.save();
    ctx.translate(cx, cx);
    ctx.rotate(a);
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, "rgba(255,240,200,0.95)");
    g.addColorStop(0.4, "rgba(255,170,60,0.6)");
    g.addColorStop(1, "rgba(255,90,10,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, -width);
    ctx.quadraticCurveTo(len * 0.5, -width * 0.4, len, 0);
    ctx.quadraticCurveTo(len * 0.5, width * 0.4, 0, width);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  }
  let g = ctx.createRadialGradient(cx, cx, 0, cx, cx, S * 0.3);
  g.addColorStop(0, "rgba(255,250,235,1)");
  g.addColorStop(0.25, "rgba(255,215,140,0.9)");
  g.addColorStop(0.6, "rgba(255,130,40,0.3)");
  g.addColorStop(1, "rgba(255,80,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  g = ctx.createRadialGradient(cx, cx, 0, cx, cx, S * 0.08);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);
  return texture(c);
}

/** Llama lateral: del cañón (u = 0) a la punta (u = 1), con lenguas de fuego. */
function createFlashSideTexture(): THREE.CanvasTexture {
  const W = 256;
  const H = 96;
  const [c, ctx] = canvas(W, H);
  ctx.globalCompositeOperation = "lighter";
  for (let i = 0; i < 9; i++) {
    const y = H / 2 + (Math.random() - 0.5) * H * 0.35;
    const len = W * (0.45 + Math.random() * 0.55);
    const h = H * (0.08 + Math.random() * 0.14);
    const g = ctx.createLinearGradient(0, 0, len, 0);
    g.addColorStop(0, "rgba(255,245,215,0.9)");
    g.addColorStop(0.3, "rgba(255,185,80,0.65)");
    g.addColorStop(0.75, "rgba(255,110,25,0.25)");
    g.addColorStop(1, "rgba(255,70,0,0)");
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.moveTo(0, H / 2 - h);
    ctx.quadraticCurveTo(len * 0.55, y - h * 0.6, len, y);
    ctx.quadraticCurveTo(len * 0.55, y + h * 0.6, 0, H / 2 + h);
    ctx.closePath();
    ctx.fill();
  }
  const g = ctx.createRadialGradient(0, H / 2, 0, 0, H / 2, H * 0.5);
  g.addColorStop(0, "rgba(255,255,245,1)");
  g.addColorStop(1, "rgba(255,255,245,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, W, H);
  return texture(c);
}
