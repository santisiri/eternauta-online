/**
 * Capa de combate del HUD: mira, marcador de impacto, vida, bajas, flash de
 * daño con indicador de dirección y cartel de muerte.
 *
 * Separada de `Hud` para que el combate se pueda apagar sin tocar la UI base.
 */

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  e.className = className;
  if (text !== undefined) e.textContent = text;
  return e;
}

export class CombatHud {
  readonly root: HTMLElement;
  private readonly crosshair: HTMLElement;
  private readonly hitMarker: HTMLElement;
  private readonly healthBar: HTMLElement;
  private readonly healthValue: HTMLElement;
  private readonly kills: HTMLElement;
  private readonly alive: HTMLElement;
  private readonly damage: HTMLElement;
  private readonly arrow: HTMLElement;
  private readonly death: HTMLElement;
  private hitTimer: ReturnType<typeof setTimeout> | undefined;
  private lastHealthFrac = -1;
  private lastHealthInt = -1;
  private lastLow = false;
  private lastKills = -1;
  private lastAlive = -1;

  constructor(container: HTMLElement) {
    this.root = el("div", "hud-combat");
    this.root.hidden = true;

    this.crosshair = el("div", "hud-combat-crosshair");
    this.hitMarker = el("div", "hud-combat-hit");
    this.damage = el("div", "hud-combat-damage");
    this.arrow = el("div", "hud-combat-arrow");

    const status = el("div", "hud-combat-status");
    const track = el("div", "hud-combat-health");
    this.healthBar = el("div", "hud-combat-health-bar");
    track.append(this.healthBar);
    this.healthValue = el("span", "hud-combat-health-value", "100");
    const counters = el("div", "hud-combat-counters");
    this.kills = el("span", "", "0");
    this.alive = el("span", "", "0");
    counters.append("CASCARUDOS ABATIDOS ", this.kills, " · A LA VISTA ", this.alive);
    status.append(el("span", "hud-combat-label", "TRAJE"), track, this.healthValue, counters);

    this.death = el("div", "hud-combat-death");
    this.death.append(el("p", "hud-combat-death-title", "TE ATRAPARON LOS CASCARUDOS"), el("p", "hud-combat-death-sub", ""));

    this.root.append(this.damage, this.arrow, this.crosshair, this.hitMarker, status, this.death);
    container.append(this.root);
  }

  show(): void {
    this.root.hidden = false;
  }

  setHealth(value: number, max: number): void {
    const f = Math.max(0, Math.min(1, value / max));
    if (Math.abs(f - this.lastHealthFrac) > 1e-3) {
      this.lastHealthFrac = f;
      this.healthBar.style.transform = `scaleX(${f.toFixed(3)})`;
    }
    const ceilVal = Math.ceil(value);
    if (ceilVal !== this.lastHealthInt) {
      this.lastHealthInt = ceilVal;
      this.healthValue.textContent = String(ceilVal);
    }
    const low = f < 0.3;
    if (low !== this.lastLow) {
      this.lastLow = low;
      this.root.classList.toggle("low", low);
    }
  }

  setCounts(kills: number, alive: number): void {
    if (kills !== this.lastKills) {
      this.lastKills = kills;
      this.kills.textContent = String(kills);
    }
    if (alive !== this.lastAlive) {
      this.lastAlive = alive;
      this.alive.textContent = String(alive);
    }
  }

  /** Marcador en la mira: blanco al pegar, rojo al matar. */
  hit(killed: boolean): void {
    this.hitMarker.classList.remove("visible", "kill");
    void this.hitMarker.offsetWidth; // reiniciar la animación CSS
    this.hitMarker.classList.add("visible");
    if (killed) this.hitMarker.classList.add("kill");
    clearTimeout(this.hitTimer);
    this.hitTimer = setTimeout(() => this.hitMarker.classList.remove("visible", "kill"), killed ? 380 : 160);
  }

  /**
   * Flash rojo y flecha hacia el atacante.
   * @param angle dirección del atacante relativa a la cámara (rad, 0 = adelante, + = derecha)
   */
  hurt(angle: number): void {
    for (const e of [this.damage, this.arrow]) {
      e.classList.remove("visible");
      void e.offsetWidth;
      e.classList.add("visible");
    }
    this.arrow.style.setProperty("--angle", `${angle}rad`);
  }

  setDead(dead: boolean, hint = ""): void {
    this.death.classList.toggle("visible", dead);
    this.crosshair.hidden = dead;
    (this.death.lastElementChild as HTMLElement).textContent = hint;
  }

  dispose(): void {
    clearTimeout(this.hitTimer);
    this.root.remove();
  }
}
