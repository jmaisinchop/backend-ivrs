import {
  Controller, Get, Post, Body, Param,
  UseGuards, Req, Query, Logger,
} from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { PostCallService } from './post-call.service';
import { PostCallMenuOption } from './post-call-menu.entity';
import { Roles } from '../auth/roles.decorator';
import { RolesGuard } from '../auth/roles.guard';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Commitment } from './commitment.entity';
import { AgentService } from './agent.service';

@UseGuards(AuthGuard('jwt'), RolesGuard)
@Controller('post-call')
export class PostCallController {
  private readonly logger = new Logger(PostCallController.name);

  constructor(
    private readonly postCallService: PostCallService,
    private readonly agentService: AgentService,
    @InjectRepository(Commitment)
    private readonly commitmentRepo: Repository<Commitment>,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // MENÚ POR CAMPAÑA
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('menu/:campaignId')
  async getMenu(@Param('campaignId') campaignId: string) {
    const menu = await this.postCallService.getMenuByCampaignId(campaignId);
    return menu || {
      active: false,
      greeting: null,
      options: [],
      queueMessage: null,
      confirmationMessage: null,
      errorMessage: null,
    };
  }

  @Post('menu/:campaignId')
  @Roles('ADMIN', 'SUPERVISOR', 'CALLCENTER')
  async saveMenu(
    @Param('campaignId') campaignId: string,
    @Body() body: {
      active: boolean;
      greeting?: string | null;
      options?: PostCallMenuOption[];
      queueMessage?: string | null;
      confirmationMessage?: string | null;
      errorMessage?: string | null;
    },
  ) {
    this.logger.log(`[MENU] Campaña ${campaignId} | active=${body.active}`);
    return this.postCallService.saveMenu(campaignId, body);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // COMPROMISOS
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('commitments/contact/:contactId')
  async getCommitmentsByContact(@Param('contactId') contactId: string) {
    return this.commitmentRepo.find({
      where: { contact: { id: contactId } },
      relations: ['contact', 'attendedBy'],
      order: { createdAt: 'DESC' },
    });
  }

  @Get('commitments/campaign/:campaignId')
  @Roles('ADMIN', 'SUPERVISOR')
  async getCommitmentsByCampaign(@Param('campaignId') campaignId: string) {
    return this.commitmentRepo.find({
      where: { campaignId },
      relations: ['contact', 'attendedBy'],
      order: { createdAt: 'DESC' },
    });
  }

  @Post('commitments/manual')
  async createManualCommitment(
    @Body() body: {
      contactId: string;
      campaignId: string;
      commitmentDate: string;
      agentId: string;
      note?: string;
    },
  ) {
    return this.postCallService.createManualCommitment({
      contactId: body.contactId,
      campaignId: body.campaignId,
      promisedDate: body.commitmentDate,
      agentId: body.agentId,
      notes: body.note,
    });
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // MESA DE CONTROL — snapshot de asesores y cola
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('agents')
  @Roles('ADMIN', 'SUPERVISOR')
  getAgents() {
    return this.agentService.getAgentsSnapshot();
  }

  @Get('queue')
  @Roles('ADMIN', 'SUPERVISOR')
  getQueue() {
    return this.agentService.getQueueSnapshot();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PANEL DEL ASESOR — estado personal y descanso
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * El asesor recupera su estado al hacer F5 / recargar página.
   * GET /post-call/my-state
   */
  @Get('my-state')
  getMyState(@Req() req: any) {
    return this.agentService.getAgentState(req.user.id);
  }

  /**
   * El asesor solicita ir a descanso.
   * POST /post-call/agents/break
   * Body: { reason?: string }   ej: "Baño", "Lunch", "Otro"
   */
  @Post('agents/break')
  @Roles('CALLCENTER')
  setBreak(@Req() req: any, @Body() body: { reason?: string }) {
    this.logger.log(`[BREAK] Asesor ${req.user.id} solicita descanso: "${body.reason || 'sin motivo'}"`);
    return this.agentService.setAgentOnBreak(req.user.id, body.reason || 'Descanso');
  }

  /**
   * El asesor vuelve del descanso.
   * POST /post-call/agents/break/clear
   */
  @Post('agents/break/clear')
  @Roles('CALLCENTER')
  clearBreak(@Req() req: any) {
    this.logger.log(`[BREAK] Asesor ${req.user.id} vuelve de descanso`);
    return this.agentService.clearAgentBreak(req.user.id);
  }

  /**
   * El supervisor fuerza el estado de un asesor desde Mesa de Control.
   * POST /post-call/agents/:agentId/force-status
   * Body: { status: 'AVAILABLE' | 'ON_BREAK' | 'OFFLINE', reason?: string }
   */
  @Post('agents/:agentId/force-status')
  @Roles('ADMIN', 'SUPERVISOR')
  forceAgentStatus(
    @Param('agentId') agentId: string,
    @Body() body: { status: 'AVAILABLE' | 'ON_BREAK' | 'OFFLINE'; reason?: string },
  ) {
    this.logger.log(`[FORCE] Supervisor fuerza asesor ${agentId} → ${body.status}`);
    return this.agentService.forceAgentStatus(agentId, body.status, body.reason);
  }

  /**
   * Recargar los datos de un asesor específico desde la BD.
   * Útil cuando se actualiza la extensión u otros datos del usuario.
   * POST /post-call/agents/:agentId/reload
   */
  @Post('agents/:agentId/reload')
  @Roles('ADMIN', 'SUPERVISOR')
  async reloadAgent(@Param('agentId') agentId: string) {
    this.logger.log(`[RELOAD] Admin solicita recargar asesor ${agentId}`);
    return this.agentService.reloadAgent(agentId);
  }

  /**
   * Recargar TODOS los asesores desde la BD.
   * Útil después de actualizaciones masivas de extensiones.
   * POST /post-call/agents/reload-all
   */
  @Post('agents/reload-all')
  @Roles('ADMIN', 'SUPERVISOR')
  async reloadAllAgents() {
    this.logger.log(`[RELOAD] Admin solicita recargar TODOS los asesores`);
    return this.agentService.reloadAllAgents();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // HISTORIAL DEL ASESOR
  // ═══════════════════════════════════════════════════════════════════════════

  @Get('history/me')
  async getMyHistory(
    @Req() req: any,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ) {
    return this.postCallService.getAgentHistory(req.user.id, { startDate, endDate });
  }
}