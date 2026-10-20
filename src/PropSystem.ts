/**
 * Modelos 3D de Plaza de Mayo modelados en Blender (scripts/blender/props).
 *
 *   props.glb    biblioteca: un nodo por asset, en el origen
 *   layout.json  instancias (posición/yaw/escala en coordenadas del juego) y,
 *                por asset, primitivas de colisión y volúmenes de recorte
 *
 * Cada (asset, primitiva de material) se dibuja con un InstancedMesh: ~40
 * assets × pocos materiales = pocas llamadas de dibujo para ~110 objetos.
 *
 * Recorte del splat: un SplatEdit global con un SDF por volumen (caja,
 * cilindro o esfera) borra (opacidad 0) los splats donde ahora hay un modelo,
 * así el objeto borroso del splat no se superpone con el modelo nítido.
 *
 * Colisiones: las primitivas se convierten en triángulos que se suman a la
 * malla de colisión (CollisionSystem.addStaticGeometry).
 */

import * as THREE from "three";
import { SplatEdit, SplatEditRgbaBlendMode, SplatEditSdf, SplatEditSdfType } from "@sparkjsdev/spark";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { GameConfig } from "./config";

type Prim =
  | { type: "box"; c: [number, number, number]; s: [number, number, number]; ry: number }
  | { type: "cyl"; c: [number, number, number]; r: number; h: number }
  | { type: "sphere"; c: [number, number, number]; r: number };

interface AssetInfo {
  tris: number;
  collide: Prim[];
  carve: Prim[];
}

interface Instance {
  asset: string;
  x: number;
  y: number;
  z: number;
  yaw: number;
  scale: number;
}

interface Layout {
  version: number;
  assets: Record<string, AssetInfo>;
  instances: Instance[];
}

/**
 * Edificios cuyo splat es más realista que el modelo: por defecto el modelo
 * es invisible (sólo colisión) y el splat no se recorta (config.props.showBuildings).
 */
const BUILDINGS = new Set(["casa_rosada", "cabildo"]);

export class PropSystem {
  readonly group = new THREE.Group();
  status = "pendiente";
  instanceCount = 0;
  triangles = 0;
  private carveProps: SplatEdit | null = null;
  private carveBuildings: SplatEdit | null = null;
  /** Mallas de la Casa Rosada y el Cabildo (por defecto ocultas: se ve el splat). */
  private readonly buildingMeshes: THREE.InstancedMesh[] = [];

  constructor(private readonly config: GameConfig) {
    this.group.name = "props";
  }

  async load(scene: THREE.Scene, envMap: THREE.Texture | null): Promise<THREE.BufferGeometry | null> {
    const { propsUrl, propsLayoutUrl } = this.config.assets;
    if (!propsUrl || !propsLayoutUrl) return null;
    this.status = "cargando…";
    try {
      const [gltf, layout] = await Promise.all([
        new GLTFLoader().loadAsync(propsUrl),
        fetch(propsLayoutUrl).then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} al pedir ${propsLayoutUrl}`);
          return r.json() as Promise<Layout>;
        }),
      ]);
      this.buildInstances(gltf.scene, layout, envMap);
      scene.add(this.group);
      this.buildCarve(scene, layout);
      this.applySettings();
      this.status = `${this.instanceCount} objetos · ${(this.triangles / 1000).toFixed(0)} k tris`;
      return this.collisionGeometry(layout);
    } catch (err) {
      this.status = `ERROR: ${(err as Error).message}`;
      console.error("[Props]", err);
      return null;
    }
  }

  /** Visibilidad de los modelos y del recorte del splat según config.props. */
  applySettings(): void {
    const p = this.config.props;
    this.group.visible = p.visible;
    for (const m of this.buildingMeshes) m.visible = p.showBuildings;
    if (this.carveProps) this.carveProps.visible = p.visible && p.carveSplat;
    if (this.carveBuildings) this.carveBuildings.visible = p.visible && p.showBuildings && p.carveBuildings;
  }

  private static instanceMatrix(i: Instance, out: THREE.Matrix4): THREE.Matrix4 {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), THREE.MathUtils.degToRad(i.yaw));
    return out.compose(new THREE.Vector3(i.x, i.y, i.z), q, new THREE.Vector3(i.scale, i.scale, i.scale));
  }

  private buildInstances(root: THREE.Object3D, layout: Layout, envMap: THREE.Texture | null): void {
    root.updateMatrixWorld(true);
    const byAsset = new Map<string, Instance[]>();
    for (const inst of layout.instances) {
      if (!byAsset.has(inst.asset)) byAsset.set(inst.asset, []);
      byAsset.get(inst.asset)!.push(inst);
    }
    const tmp = new THREE.Matrix4();
    const rel = new THREE.Matrix4();
    for (const [asset, list] of byAsset) {
      const node = root.getObjectByName(asset);
      if (!node) {
        console.warn(`[Props] el GLB no tiene el asset "${asset}"`);
        continue;
      }
      const nodeInv = node.matrixWorld.clone().invert();
      node.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh) return;
        const material = mesh.material as THREE.MeshStandardMaterial;
        if (envMap && "envMap" in material) {
          material.envMapIntensity = 0.35;
        }
        const im = new THREE.InstancedMesh(mesh.geometry, material, list.length);
        im.name = `${asset}/${mesh.name}`;
        rel.multiplyMatrices(nodeInv, mesh.matrixWorld);
        list.forEach((inst, k) => {
          PropSystem.instanceMatrix(inst, tmp).multiply(rel);
          im.setMatrixAt(k, tmp);
        });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.frustumCulled = true;
        this.group.add(im);
        if (BUILDINGS.has(asset)) {
          this.buildingMeshes.push(im);
          return; // no cuentan en los triángulos dibujados mientras estén ocultos
        }
        const idx = mesh.geometry.index;
        this.triangles += ((idx ? idx.count : mesh.geometry.attributes.position.count) / 3) * list.length;
      });
      this.instanceCount += list.length;
    }
  }

  private static primMatrix(p: Prim, out: THREE.Matrix4): THREE.Matrix4 {
    const q = new THREE.Quaternion();
    const s = new THREE.Vector3(1, 1, 1);
    if (p.type === "box") {
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), p.ry);
      s.set(p.s[0], p.s[1], p.s[2]);
    } else if (p.type === "cyl") {
      s.set(p.r, p.h, p.r);
    } else {
      s.setScalar(p.r);
    }
    return out.compose(new THREE.Vector3(...p.c), q, s);
  }

  private collisionGeometry(layout: Layout): THREE.BufferGeometry | null {
    const unitBox = new THREE.BoxGeometry(1, 1, 1);
    const unitCyl = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
    const parts: THREE.BufferGeometry[] = [];
    const mi = new THREE.Matrix4();
    const mp = new THREE.Matrix4();
    for (const inst of layout.instances) {
      const info = layout.assets[inst.asset];
      if (!info) continue;
      PropSystem.instanceMatrix(inst, mi);
      for (const p of info.collide) {
        if (p.type === "sphere") continue;
        const g = (p.type === "box" ? unitBox : unitCyl).clone();
        g.deleteAttribute("normal");
        g.deleteAttribute("uv");
        g.applyMatrix4(mp.multiplyMatrices(mi, PropSystem.primMatrix(p, mp.clone())));
        parts.push(g);
      }
    }
    unitBox.dispose();
    unitCyl.dispose();
    if (parts.length === 0) return null;
    const merged = mergeGeometries(parts, false);
    for (const g of parts) g.dispose();
    return merged;
  }

  private buildCarve(scene: THREE.Scene, layout: Layout): void {
    const make = (name: string) =>
      new SplatEdit({ name, rgbaBlendMode: SplatEditRgbaBlendMode.MULTIPLY, softEdge: 0.15 });
    this.carveProps = make("props-carve");
    this.carveBuildings = make("buildings-carve");
    const mi = new THREE.Matrix4();
    const mp = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const propsSdfs: SplatEditSdf[] = [];
    const buildingsSdfs: SplatEditSdf[] = [];
    for (const inst of layout.instances) {
      const info = layout.assets[inst.asset];
      if (!info) continue;
      PropSystem.instanceMatrix(inst, mi);
      for (const p of info.carve) {
        const sdf = new SplatEditSdf({ opacity: 0, color: new THREE.Color(1, 1, 1) });
        mp.multiplyMatrices(mi, PropSystem.primMatrix(p, new THREE.Matrix4()));
        mp.decompose(pos, quat, scl);
        sdf.position.copy(pos);
        sdf.quaternion.copy(quat);
        if (p.type === "box") {
          sdf.type = SplatEditSdfType.BOX;
          // Spark: la escala de un SDF caja son los semiejes.
          sdf.scale.set(scl.x / 2, scl.y / 2, scl.z / 2);
        } else if (p.type === "cyl") {
          sdf.type = SplatEditSdfType.CYLINDER;
          sdf.radius = scl.x;
          sdf.scale.set(1, scl.y / 2, 1);
        } else {
          sdf.type = SplatEditSdfType.SPHERE;
          sdf.radius = scl.x;
          sdf.scale.set(1, 1, 1);
        }
        if (BUILDINGS.has(inst.asset)) {
          this.carveBuildings.add(sdf);
          buildingsSdfs.push(sdf);
        } else {
          this.carveProps.add(sdf);
          propsSdfs.push(sdf);
        }
      }
    }
    scene.add(this.carveProps, this.carveBuildings);
    this.carveProps.updateMatrixWorld(true);
    this.carveBuildings.updateMatrixWorld(true);
    // Pre-asignar la lista de SDFs evita que SplatMesh.update recorra los ~135 nodos cada frame.
    this.carveProps.sdfs = propsSdfs;
    this.carveBuildings.sdfs = buildingsSdfs;
  }
}
