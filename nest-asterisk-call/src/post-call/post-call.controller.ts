import { Controller, Get, Post, Body, Param, UseGuards } from '@nestjs/common';
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
  constructor(
    private readonly postCallService: PostCallService,
    private readonly agentService: AgentService,
    @InjectRepository(Commitment)
    private readonly commitmentRepo: Repository<Commitment>,
  ) {}

  // ─── MENÚ POR CAMPAÑA ────────────────────────────────────────────────

  // Obtener configuración del menú de una campaña
  @Get('menu/:campaignId')
  async getMenu(@Param('campaignId') campaignId: string) {
    const menu = await this.postCallService.getMenuByCampaignId(campaignId);
    return menu || { active: false, greeting: null, options: [] };
  }

  // Crear o actualizar menú de una campaña
  @Post('menu/:campaignId')
  @Roles('ADMIN', 'SUPERVISOR')
  async saveMenu(
    @Param('campaignId') campaignId: string,
    @Body() body: {
      active: boolean;
      greeting?: string | null;
      options?: PostCallMenuOption[];
    },
  ) {
    return this.postCallService.saveMenu(campaignId, body);
  }

  // ─── COMPROMISOS ─────────────────────────────────────────────────────

  // Obtener compromisos de un contacto específico
  @Get('commitments/contact/:contactId')
  async getCommitmentsByContact(@Param('contactId') contactId: string) {
    return this.commitmentRepo.find({
      where: { contact: { id: contactId } },
      relations: ['contact', 'attendedBy'],
      order: { createdAt: 'DESC' },
    });
  }

  // Obtener compromisos de una campaña
  @Get('commitments/campaign/:campaignId')
  @Roles('ADMIN', 'SUPERVISOR')
  async getCommitmentsByCampaign(@Param('campaignId') campaignId: string) {
    return this.commitmentRepo.find({
      where: { campaignId },
      relations: ['contact', 'attendedBy'],
      order: { createdAt: 'DESC' },
    });
  }

  // Crear compromiso manual (desde panel del asesor)
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
    const commitment = this.commitmentRepo.create({
      contact: { id: body.contactId } as any,
      campaignId: body.campaignId,
      commitmentDate: new Date(body.commitmentDate),
      source: 'MANUAL' as any,
      attendedBy: { id: body.agentId } as any,
      note: body.note || null,
    });
    return this.commitmentRepo.save(commitment);
  }

  // ─── ESTADO ASESORES Y COLA (Mesa de Control) ───────────────────────

  // Snapshot actual de asesores
  @Get('agents')
  @Roles('ADMIN', 'SUPERVISOR')
  getAgents() {
    return this.agentService.getAgentsSnapshot();
  }

  // Snapshot actual de la cola
  @Get('queue')
  @Roles('ADMIN', 'SUPERVISOR')
  getQueue() {
    return this.agentService.getQueueSnapshot();
  }
}