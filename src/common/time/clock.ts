import { Global, Injectable, Module } from '@nestjs/common';

/** Injectable time source so expiry/deadline logic is deterministic in tests. */
@Injectable()
export class Clock {
  now(): Date {
    return new Date();
  }
}

@Global()
@Module({ providers: [Clock], exports: [Clock] })
export class ClockModule {}
