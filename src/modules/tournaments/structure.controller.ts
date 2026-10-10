import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  DefaultValuePipe,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiCreatedResponse,
  ApiHeader,
  ApiOkResponse,
  ApiTags,
} from '@nestjs/swagger';
import type { Request } from 'express';
import { CurrentUser, OptionalUser, Public } from '../../common/auth/auth.decorators';
import type { AuthUser } from '../../common/auth/auth.types';
import { IdempotencyKey } from '../../common/idempotency/idempotency-key.decorator';
import {
  ApplyScheduleDto,
  BracketsDto,
  CorrectResultDto,
  CreateFixtureDto,
  CreateStageDto,
  DrawDto,
  FixtureDto,
  FixtureListDto,
  FixtureListQuery,
  FixtureStatusDto,
  GenerateResultDto,
  ImpactDto,
  MoveFixtureDto,
  RecordResultDto,
  ScheduleApplyResultDto,
  ScheduleParamsDto,
  SchedulePreviewDto,
  ScheduleReportDto,
  StageDto,
  StageProblemDto,
  StandingsDto,
  TieResolutionDto,
  UpdateStageDto,
} from './dto/structure.dto';
import { ResultsService } from './results.service';
import { ScheduleService } from './schedule.service';
import { StructureService } from './structure.service';

const idem = { name: 'Idempotency-Key', required: false, description: 'Safe retries' };

@ApiTags('tournaments')
@ApiBearerAuth()
@Controller('tournaments/:id')
export class StructureController {
  constructor(
    private readonly structure: StructureService,
    private readonly results: ResultsService,
    private readonly schedule: ScheduleService,
  ) {}

  // ── stages ──

  @Public()
  @Get('stages')
  @ApiOkResponse({ type: [StageDto] })
  stages(@OptionalUser() v: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.structure.listStages(v?.userId ?? null, id);
  }

  @Get('structure/check')
  @ApiOkResponse({
    type: [StageProblemDto],
    description: 'Cup feeding conflicts, missing positions, stale draws',
  })
  check(@CurrentUser() u: AuthUser, @Param('id', ParseUUIDPipe) id: string) {
    return this.structure.check(u.userId, id);
  }

  @Post('stages')
  @ApiHeader(idem)
  @ApiCreatedResponse({ type: StageDto })
  createStage(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateStageDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.structure.createStage(u.userId, id, dto, key, String(req.id));
  }

  @Patch('stages/:stageId')
  @ApiHeader(idem)
  @ApiOkResponse({ type: StageDto })
  updateStage(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: UpdateStageDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.structure.updateStage(u.userId, id, stageId, dto, key, String(req.id));
  }

  @Delete('stages/:stageId')
  @ApiOkResponse({ description: '{deleted:true}' })
  deleteStage(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Req() req: Request,
  ) {
    return this.structure.deleteStage(u.userId, id, stageId, String(req.id));
  }

  @Post('stages/:stageId/draw')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: StageDto,
    description: 'Manual assignment or seeded-random group draw (seed and author recorded)',
  })
  draw(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: DrawDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.structure.draw(u.userId, id, stageId, dto, key, String(req.id));
  }

  @Post('stages/:stageId/generate')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: GenerateResultDto,
    description:
      'Round-robin for groups/leagues; bracket with byes for knockouts. Refused once results exist.',
  })
  generate(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.structure.generate(u.userId, id, stageId, key, String(req.id));
  }

  @Post('stages/:stageId/fixtures')
  @ApiHeader(idem)
  @ApiCreatedResponse({ type: FixtureDto, description: 'Custom stages only' })
  addFixture(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: CreateFixtureDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.structure.addFixture(u.userId, id, stageId, dto, key);
  }

  @Post('stages/:stageId/tie-resolution')
  @HttpCode(200)
  @ApiOkResponse({
    description:
      '{resolved:number} - chief organiser orders clubs left tied by the configured criteria',
  })
  tie(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('stageId', ParseUUIDPipe) stageId: string,
    @Body() dto: TieResolutionDto,
    @Req() req: Request,
  ) {
    return this.results.resolveTie(u.userId, id, stageId, dto, String(req.id));
  }

  // ── public reads ──

  @Public()
  @Get('fixtures')
  @ApiOkResponse({
    type: FixtureListDto,
    description: 'Times/pitches of unpublished (draft) slots are visible to schedule managers only',
  })
  fixtures(
    @OptionalUser() v: AuthUser | null,
    @Param('id', ParseUUIDPipe) id: string,
    @Query() q: FixtureListQuery,
  ) {
    return this.structure.fixtures(v?.userId ?? null, id, q);
  }

  @Public()
  @Get('standings')
  @ApiOkResponse({ type: StandingsDto })
  standings(@OptionalUser() v: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.structure.standings(v?.userId ?? null, id);
  }

  @Public()
  @Get('brackets')
  @ApiOkResponse({ type: BracketsDto })
  brackets(@OptionalUser() v: AuthUser | null, @Param('id', ParseUUIDPipe) id: string) {
    return this.structure.brackets(v?.userId ?? null, id);
  }

  // ── results ──

  @Post('fixtures/:fixtureId/result')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: FixtureDto,
    description:
      'tournament.protocols. FINISHED + standings recomputed in one transaction; knockout ties need a shoot-out winner',
  })
  record(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fixtureId', ParseUUIDPipe) fid: string,
    @Body() dto: RecordResultDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.results.record(u.userId, id, fid, dto, key, String(req.id));
  }

  @Post('fixtures/:fixtureId/impact')
  @HttpCode(200)
  @ApiOkResponse({
    type: ImpactDto,
    description: 'Lists dependent fixtures a corrected score would change; saves nothing',
  })
  impact(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fixtureId', ParseUUIDPipe) fid: string,
    @Body() dto: RecordResultDto,
  ) {
    return this.results.impact(u.userId, id, fid, dto);
  }

  @Post('fixtures/:fixtureId/correction')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: FixtureDto,
    description:
      'Chief organiser only; needs a reason and, when dependents change, an explicit decision. Played matches are never rebuilt.',
  })
  correct(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fixtureId', ParseUUIDPipe) fid: string,
    @Body() dto: CorrectResultDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.results.correct(u.userId, id, fid, dto, key, String(req.id));
  }

  @Post('fixtures/:fixtureId/status')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ type: FixtureDto })
  status(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fixtureId', ParseUUIDPipe) fid: string,
    @Body() dto: FixtureStatusDto,
    @IdempotencyKey() key: string | undefined,
  ) {
    return this.results.setStatus(u.userId, id, fid, dto, key);
  }

  // ── schedule ──

  @Post('schedule/preview')
  @HttpCode(200)
  @ApiOkResponse({
    type: SchedulePreviewDto,
    description: 'Conflicts, per-club rest and unscheduled fixtures; nothing is saved',
  })
  preview(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ScheduleParamsDto,
  ) {
    return this.schedule.preview(u.userId, id, dto);
  }

  @Post('schedule/apply')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({
    type: ScheduleApplyResultDto,
    description:
      'Refused (409) with the full problem list if anything is unscheduled or conflicts; published changes get a new schedule version and notify clubs',
  })
  apply(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: ApplyScheduleDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.schedule.apply(u.userId, id, dto, key, String(req.id));
  }

  @Post('schedule/publish')
  @HttpCode(200)
  @ApiHeader(idem)
  @ApiOkResponse({ description: '{scheduleVersion, published}' })
  publishSchedule(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.schedule.publish(u.userId, id, key, String(req.id));
  }

  @Get('schedule/report')
  @ApiOkResponse({ type: ScheduleReportDto })
  report(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('minRestMinutes', new DefaultValuePipe(0), ParseIntPipe) minRest: number,
  ) {
    return this.schedule.report(u.userId, id, minRest);
  }

  @Patch('fixtures/:fixtureId/slot')
  @ApiHeader(idem)
  @ApiOkResponse({
    type: FixtureDto,
    description:
      'Move one match: overlaps refused (BOOKING_CONFLICT); short rest needs allowShortRest',
  })
  move(
    @CurrentUser() u: AuthUser,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('fixtureId', ParseUUIDPipe) fid: string,
    @Body() dto: MoveFixtureDto,
    @IdempotencyKey() key: string | undefined,
    @Req() req: Request,
  ) {
    return this.schedule.move(u.userId, id, fid, dto, key, String(req.id));
  }
}
