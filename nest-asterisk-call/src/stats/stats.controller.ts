import {
  Controller, Get, Query, Req, Param,
  UseGuards
} from '@nestjs/common';
import { StatsService } from './stats.service';
import { AuthGuard } from '@nestjs/passport';
import { RolesGuard } from '../auth/roles.guard';
import { Roles } from '../auth/roles.decorator';
import { Res } from '@nestjs/common';
import { Response } from 'express';
@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('stats')
export class StatsController {
  constructor(private readonly stats: StatsService) { }

  /* ---------- OVERVIEW ---------- */
  @Get('overview')
  overview(@Req() req) {
    return req.user.role === 'CALLCENTER'
      ? this.stats.getOverview(req.user.id)
      : this.stats.getOverview();
  }

  /* ---------- SERIES ---------- */
  @Get('calls/daily')
  callsDaily(@Query('days') d = '30', @Req() req) {
    return this.stats.getCallsPerDay(+d, req.user.role === 'CALLCENTER' ? req.user.id : undefined);
  }

  @Get('calls/monthly')
  callsMonthly(@Query('months') m = '12', @Req() req) {
    return this.stats.getCallsPerMonth(+m, req.user.role === 'CALLCENTER' ? req.user.id : undefined);
  }

  @Get('calls/hourly')
  callsHourly(@Query('days') d = '7', @Req() req) {
    return this.stats.getCallsPerHour(+d, req.user.role === 'CALLCENTER' ? req.user.id : undefined);
  }

  @Get('calls/success-trend')
  successTrend(@Query('days') d = '30', @Req() req) {
    return this.stats.getSuccessTrend(+d, req.user.role === 'CALLCENTER' ? req.user.id : undefined);
  }

  /* ---------- EXTRAS ---------- */
  @Get('calls/status-distribution')
  statusDist(@Query('days') d = '30', @Req() req) {
    return this.stats.getCallStatusDistribution(+d, this._uid(req));
  }

  @Get('calls/attempts-efficiency')
  attemptsEff(@Query('days') d = '30', @Req() req) {
    return this.stats.getAttemptsEfficiency(+d, this._uid(req));
  }

  @Get('calls/hangup-causes')
  hangup(@Query('limit') l = '5', @Query('days') d = '30', @Req() req) {
    return this.stats.getTopHangupCauses(+l, +d, this._uid(req));
  }

  @Get('calls/retry-rate')
  retryRate(@Query('days') d = '30', @Req() req) {
    return this.stats.getRetryRate(+d, this._uid(req));
  }

  /* ---------- AGENTES & CAMPAÑAS ---------- */
  @Get('agents/performance')
  agentPerf(@Query('days') d = '30', @Req() req) {
    return this.stats.getAgentPerformance(+d, this._uid(req));
  }

  @Get('campaigns/leaderboard')
  leaderboard(@Query('limit') l = '5', @Req() req) {
    return this.stats.getCampaignLeaderboard(+l, this._uid(req));
  }

  /* ---------- CANALES ---------- */
  @Roles('ADMIN', 'SUPERVISOR')
  @Get('channels/usage')
  channelsAll() {
    return this.stats.getChannelUsageSnapshot();
  }

  @Roles('ADMIN', 'SUPERVISOR')
  @Get('channels/usage/:userId')
  async channelsByUser(@Param('userId') id: string) {
    const all = await this.stats.getChannelUsageSnapshot();
    return all.find((u) => u.userId === id) ?? { userId: id, message: 'Sin datos' };
  }

  /* ---------- NUEVAS MÉTRICAS ---------- */
  @Get('calls/failure-trend')
  failureTrend(@Query('days') d = '30', @Req() req) {
    return this.stats.getFailureTrend(+d, this._uid(req));
  }

  @Get('calls/success-rate-hour')
  byHour(@Query('days') d = '30', @Req() req) {
    return this.stats.getSuccessRateByHour(+d, this._uid(req));
  }

  @Get('calls/busy-hours')
  busyHours(@Query('limit') l = '5', @Query('days') d = '30', @Req() req) {
    return this.stats.getTopBusyHours(+l, +d, this._uid(req));
  }

  @Get('calls/avg-per-campaign')
  avgPerCampaign(@Query('days') d = '30', @Req() req) {
    return this.stats.getAvgCallsPerCampaign(+d, this._uid(req));
  }

  @Get('campaigns/active-durations')
  activeDur(@Req() req) {
    return this.stats.getActiveCampaignDurations(this._uid(req));
  }

  @Get('channels/pressure')
  channelPressure(@Req() req) {
    return this.stats.getChannelPressure(this._uid(req));
  }

  /* ---------- helper ---------- */
  private _uid(req) {
    return req.user.role === 'CALLCENTER' ? req.user.id : undefined;
  }
  @Get('campaigns/summary')
  summary(
    @Query('start') start: string,
    @Query('end') end: string,
    @Req() req,
  ) {
    return this.stats.getCampaignSummary(
      start,
      end,
      req.user.role === 'CALLCENTER' ? req.user.id : undefined,
    );
  }

  /* ────────────────────────────────────────────────
     Excel – descarga
  ──────────────────────────────────────────────── */
  @Get('campaigns/report')
  async report(
    @Query('start') start: string,
    @Query('end') end: string,
    @Req() req,
    @Res() res: Response,
  ) {
    const buffer = await this.stats.generateCampaignReport(
      start,
      end,
      req.user.role === 'CALLCENTER' ? req.user.id : undefined,
    );

    res.setHeader(
      'Content-Type',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="campañas_${start}_a_${end}.xlsx"`,
    );

    res.end(buffer);   // se envía el binario y se cierra la respuesta
  }
}
