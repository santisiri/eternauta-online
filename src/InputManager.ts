/**
 * Entrada de teclado y mouse, desacoplada de la lógica de juego.
 *
 * - Estado continuo (ejes de movimiento, correr) consultado cada tick.
 * - Acciones de flanco (saltar, reiniciar) que se consumen una sola vez.
 * - Mouse: pointer lock para la cámara; si el puntero no está capturado,
 *   arrastrar con el botón izquierdo también rota la cámara. Con el mouse
 *   capturado, el botón izquierdo dispara (el derecho queda para apuntar).
 */

export type ActionName = "jump" | "reset" | "toggleDebug" | "toggleGraphics" | "toggleMute" | "punch" | "kick" | "dodge" | "die";

const KEY_BINDINGS: Record<string, ActionName> = {
  Space: "jump",
  KeyR: "reset",
  KeyF: "punch",
  KeyV: "kick",
  KeyC: "dodge",
  KeyK: "die",
  KeyM: "toggleMute",
  KeyG: "toggleGraphics",
  Backquote: "toggleDebug",
  F3: "toggleDebug",
  KeyP: "toggleDebug",
};

export class InputManager {
  private readonly keys = new Set<string>();
  private readonly pressed = new Set<ActionName>();
  private mouseDX = 0;
  private mouseDY = 0;
  private wheelDelta = 0;
  private dragging = false;
  private mouseShoot = false;
  private mouseAim = false;
  /** Entrada virtual (controles táctiles): eje de movimiento y carrera. */
  private virtualX = 0;
  private virtualY = 0;
  private virtualRun = false;
  private virtualShoot = false;
  /** Cuando es false se ignora la entrada de juego (p. ej. pantalla inicial). */
  enabled = false;

  /** Callbacks opcionales para la UI. */
  onPointerLockChange?: (locked: boolean) => void;
  /** El navegador rechazó el pointer lock (iframe/panel embebido, gesto inválido…). */
  onPointerLockError?: () => void;
  /** Empezó un arrastre con el botón izquierdo (rotación de cámara sin captura). */
  onDragStart?: () => void;

  constructor(private readonly element: HTMLElement) {
    window.addEventListener("keydown", this.handleKeyDown);
    window.addEventListener("keyup", this.handleKeyUp);
    window.addEventListener("blur", this.handleBlur);
    document.addEventListener("visibilitychange", this.handleVisibility);
    document.addEventListener("pointerlockchange", this.handlePointerLockChange);
    document.addEventListener("pointerlockerror", this.handlePointerLockError);
    document.addEventListener("mousemove", this.handleMouseMove);
    element.addEventListener("mousedown", this.handleMouseDown);
    window.addEventListener("mouseup", this.handleMouseUp);
    element.addEventListener("wheel", this.handleWheel, { passive: false });
    element.addEventListener("contextmenu", (e) => e.preventDefault());
  }

  get pointerLocked(): boolean {
    return document.pointerLockElement === this.element;
  }

  requestPointerLock(): void {
    if (this.pointerLocked) return;
    // En Chrome devuelve una promesa que rechaza si el gesto no es válido;
    // el fallo también llega como evento "pointerlockerror".
    try {
      const result = this.element.requestPointerLock() as unknown;
      if (result instanceof Promise) result.catch(() => undefined);
    } catch {
      this.handlePointerLockError();
    }
  }

  exitPointerLock(): void {
    if (this.pointerLocked) document.exitPointerLock();
  }

  isDown(code: string): boolean {
    return this.enabled && this.keys.has(code);
  }

  /** Eje de movimiento en el plano local de la cámara: x = derecha, y = adelante. */
  moveAxis(): { x: number; y: number } {
    if (!this.enabled) return { x: 0, y: 0 };
    let x = 0;
    let y = 0;
    if (this.keys.has("KeyW") || this.keys.has("ArrowUp")) y += 1;
    if (this.keys.has("KeyS") || this.keys.has("ArrowDown")) y -= 1;
    if (this.keys.has("KeyD") || this.keys.has("ArrowRight")) x += 1;
    if (this.keys.has("KeyA") || this.keys.has("ArrowLeft")) x -= 1;
    // El teclado manda; si no hay teclas, el joystick táctil (analógico).
    if (x === 0 && y === 0) return { x: this.virtualX, y: this.virtualY };
    const len = Math.hypot(x, y);
    return len > 1 ? { x: x / len, y: y / len } : { x, y };
  }

  get running(): boolean {
    return this.isDown("ShiftLeft") || this.isDown("ShiftRight") || (this.enabled && this.virtualRun);
  }

  /** Disparar: botón izquierdo con el mouse capturado, Q o el botón táctil. */
  get shooting(): boolean {
    return this.enabled && (this.mouseShoot || this.keys.has("KeyQ") || this.virtualShoot);
  }

  /** Apuntar: botón derecho con el mouse capturado (cámara sobre el hombro). */
  get aiming(): boolean {
    return this.enabled && this.mouseAim;
  }

  // --- Entrada virtual (TouchControls) -----------------------------------------

  setVirtualShoot(active: boolean): void {
    this.virtualShoot = active;
  }

  /** Joystick: x = derecha, y = adelante, magnitud ≤ 1. */
  setVirtualMove(x: number, y: number, run: boolean): void {
    this.virtualX = x;
    this.virtualY = y;
    this.virtualRun = run;
  }

  /** Delta de cámara en "píxeles de mouse" (se escala con camera.sensitivity). */
  addLookDelta(dx: number, dy: number): void {
    if (!this.enabled) return;
    this.mouseDX += dx;
    this.mouseDY += dy;
  }

  addWheel(delta: number): void {
    if (this.enabled) this.wheelDelta += delta;
  }

  /** Dispara una acción de flanco (botón táctil). */
  trigger(action: ActionName): void {
    if (this.enabled || action === "toggleDebug" || action === "toggleGraphics") this.pressed.add(action);
  }

  /** Devuelve true una sola vez por pulsación. */
  consume(action: ActionName): boolean {
    if (!this.pressed.has(action)) return false;
    this.pressed.delete(action);
    return true;
  }

  /** Delta acumulado del mouse desde la última lectura. */
  consumeMouseDelta(): { dx: number; dy: number } {
    const d = { dx: this.mouseDX, dy: this.mouseDY };
    this.mouseDX = 0;
    this.mouseDY = 0;
    return d;
  }

  consumeWheel(): number {
    const w = this.wheelDelta;
    this.wheelDelta = 0;
    return w;
  }

  private readonly handleKeyDown = (e: KeyboardEvent) => {
    // No secuestrar el teclado cuando se edita un campo del panel de debug.
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "SELECT" || target.isContentEditable)) return;
    // Atajos del sistema/navegador (Cmd/Ctrl + tecla): no son entrada de juego.
    // En macOS, mientras Cmd está apretado no llegan los keyup → teclas pegadas.
    if (e.metaKey || e.ctrlKey || e.code.startsWith("Meta") || e.code.startsWith("Control")) {
      this.keys.clear();
      return;
    }
    const action = KEY_BINDINGS[e.code];
    if (action === "toggleDebug" || action === "toggleGraphics") {
      // Los paneles de debug y gráficos funcionan incluso fuera del juego.
      if (!e.repeat) this.pressed.add(action);
      e.preventDefault();
      return;
    }
    if (!this.enabled) return;
    if (e.code === "Space" || e.code.startsWith("Arrow")) e.preventDefault();
    this.keys.add(e.code);
    if (action && !e.repeat) this.pressed.add(action);
  };

  private readonly handleKeyUp = (e: KeyboardEvent) => {
    this.keys.delete(e.code);
    if (e.code.startsWith("Meta")) this.keys.clear();
  };

  private readonly handleVisibility = () => {
    if (document.hidden) this.handleBlur();
  };

  private readonly handleBlur = () => {
    this.keys.clear();
    this.dragging = false;
    this.mouseShoot = false;
    this.mouseAim = false;
    this.virtualShoot = false;
    this.setVirtualMove(0, 0, false);
  };

  private readonly handlePointerLockChange = () => {
    if (!this.pointerLocked) this.mouseShoot = this.mouseAim = false;
    this.onPointerLockChange?.(this.pointerLocked);
  };

  private readonly handlePointerLockError = () => {
    this.onPointerLockError?.();
  };

  get isDragging(): boolean {
    return this.dragging;
  }

  private readonly handleMouseDown = (e: MouseEvent) => {
    if (!this.enabled) return;
    if (e.button === 0) {
      if (this.pointerLocked) {
        this.mouseShoot = true;
        return;
      }
      this.requestPointerLock();
      this.onDragStart?.();
      this.dragging = true;
    } else if (e.button === 2 && this.pointerLocked) {
      this.mouseAim = true;
    }
  };

  private readonly handleMouseUp = (e: MouseEvent) => {
    if (e.button === 0) {
      this.dragging = false;
      this.mouseShoot = false;
    } else if (e.button === 2) {
      this.mouseAim = false;
    }
  };

  private readonly handleMouseMove = (e: MouseEvent) => {
    if (!this.enabled) return;
    if (this.pointerLocked || this.dragging) {
      this.mouseDX += e.movementX;
      this.mouseDY += e.movementY;
    }
  };

  private readonly handleWheel = (e: WheelEvent) => {
    if (!this.enabled) return;
    e.preventDefault();
    // Normaliza modos de línea/página a píxeles aproximados.
    const scale = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    this.wheelDelta += e.deltaY * scale;
  };

  dispose(): void {
    window.removeEventListener("keydown", this.handleKeyDown);
    window.removeEventListener("keyup", this.handleKeyUp);
    window.removeEventListener("blur", this.handleBlur);
    document.removeEventListener("visibilitychange", this.handleVisibility);
    document.removeEventListener("pointerlockchange", this.handlePointerLockChange);
    document.removeEventListener("pointerlockerror", this.handlePointerLockError);
    document.removeEventListener("mousemove", this.handleMouseMove);
    this.element.removeEventListener("mousedown", this.handleMouseDown);
    window.removeEventListener("mouseup", this.handleMouseUp);
    this.element.removeEventListener("wheel", this.handleWheel);
  }
}
