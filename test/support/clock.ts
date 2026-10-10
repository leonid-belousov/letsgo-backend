import { Clock } from '../../src/common/time/clock';

/** Mutable clock for deadline/expiry tests. */
export class FakeClock extends Clock {
  private current = new Date();

  override now(): Date {
    return new Date(this.current);
  }

  set(d: Date): void {
    this.current = d;
  }

  advanceMinutes(min: number): void {
    this.current = new Date(this.current.getTime() + min * 60_000);
  }

  advanceHours(h: number): void {
    this.advanceMinutes(h * 60);
  }
}
