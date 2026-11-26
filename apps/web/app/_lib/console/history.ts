/** Invoergeschiedenis voor de console (pijltje omhoog/omlaag), zoals in een shell. */
export class CommandHistory {
  private items: string[] = [];
  private index = 0; // == items.length: nieuwe regel
  private draft = "";

  constructor(
    initial: string[] = [],
    private readonly max = 100,
  ) {
    this.items = initial.slice(-max);
    this.index = this.items.length;
  }

  get all(): readonly string[] {
    return this.items;
  }

  push(cmd: string): void {
    const c = cmd.trim();
    if (c && this.items[this.items.length - 1] !== c) {
      this.items.push(c);
      if (this.items.length > this.max) this.items.shift();
    }
    this.index = this.items.length;
    this.draft = "";
  }

  /** Vorige opdracht; `current` is wat er nu in het invoerveld staat. */
  prev(current: string): string {
    if (this.index === this.items.length) this.draft = current;
    if (this.index > 0) this.index--;
    return this.items[this.index] ?? current;
  }

  next(): string {
    if (this.index < this.items.length) this.index++;
    return this.index === this.items.length ? this.draft : (this.items[this.index] ?? "");
  }
}
