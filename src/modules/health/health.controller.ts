import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/auth/auth.decorators';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

@Public()
@ApiTags('health')
@Controller('health')
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /** Liveness: process + framework + config loaded. No dependencies checked. */
  @Get()
  @ApiOkResponse({ description: 'Process is alive' })
  live(): { status: 'ok'; uptimeSeconds: number } {
    return { status: 'ok', uptimeSeconds: Math.round(process.uptime()) };
  }

  /** Readiness: dependencies (database) reachable. */
  @Get('ready')
  @ApiOkResponse({ description: 'Service can serve traffic' })
  async ready(): Promise<{ status: 'ok'; database: 'up' }> {
    if (!(await this.prisma.ping())) {
      throw new ServiceUnavailableException('Database unavailable');
    }
    return { status: 'ok', database: 'up' };
  }
}
