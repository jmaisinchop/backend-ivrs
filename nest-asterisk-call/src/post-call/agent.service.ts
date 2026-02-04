import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, MoreThan, IsNull } from 'typeorm';
import { User, UserRole } from '../user/user.entity';
import { Contact } from '../campaign/contact.entity';
import { AgentCallEvent, AgentCallEventType } from './agent-call-event.entity';
import { AgentBreak } from './agent-break.entity';
import { DashboardGateway } from '../dashboard/dashboard.gateway';
import { AmiService } from '../ami/ami.service';
import { CampaignService } from '../campaign/campaign.service';

// ─── ESTADOS DEL ASESOR ──────────────────────────────────────────────────────
// AVAILABLE  → Verde   → Conectado y listo para recibir llamadas
// ON_CALL    → Cyan    → Actualmente en llamada con un cliente
// ON_BREAK   → Naranja → En descanso (baño / lunch). NO recibe llamadas.
// OFFLINE    → Gris    → Sin WebSocket activo. NO recibe llamadas.
export type AgentStatus = 'AVAILABLE' | 'ON_CALL' | 'ON_BREAK' | 'OFFLINE';

export interface AgentState {
  userId: string;
  firstName: string;
  lastName: string;
  extension: string;
  status: AgentStatus;
  connected: boolean;
  breakReason: string | null;
  breakStartedAt: string | null;
  activeBreakId: string | null;
  activeCalls: number;
  totalCallsToday: number;
  currentContact: {
    contactId: string;
    cedula: string;
    nombre: string;
    telefono: string;
    campaignId: string;
    campaignName: string;
    connectedAt: string;
  } | null;
}

interface QueueEntry {
  contactId: string;
  campaignId: string;
  channel: any;
  queuedAt: number;
  position: number;
}

@Injectable()
export class AgentService implements OnModuleInit {
  private readonly logger = new Logger(AgentService.name);
  private readonly agents = new Map<string, AgentState>();
  private queue: QueueEntry[] = [];
  private readonly QUEUE_TIMEOUT_MS = 300000;
  private queueCheckInterval: NodeJS.Timeout;
  private readonly processingFinishedCache = new Set<string>();

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(AgentCallEvent)
    private readonly eventRepo: Repository<AgentCallEvent>,
    @InjectRepository(Contact)
    private readonly contactRepo: Repository<Contact>,
    @InjectRepository(AgentBreak)
    private readonly breakRepo: Repository<AgentBreak>,
    @Inject(forwardRef(() => DashboardGateway))
    private readonly dashboardGateway: DashboardGateway,
    @Inject(forwardRef(() => AmiService))
    private readonly amiService: AmiService,
    @Inject(forwardRef(() => CampaignService))
    private readonly campaignService: CampaignService,
  ) {}

  // ═══════════════════════════════════════════════════════════════════════════
  // INIT
  // ═══════════════════════════════════════════════════════════════════════════

  async onModuleInit(): Promise<void> {
    const users = await this.userRepo.find({
      where: { role: UserRole.CALLCENTER },
      select: ['id', 'extension', 'firstName', 'lastName'],
    });

    for (const user of users) {
      if (!user.extension) continue;
      this.agents.set(user.id, {
        userId: user.id,
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        extension: user.extension,
        status: 'OFFLINE',
        connected: false,
        breakReason: null,
        breakStartedAt: null,
        activeBreakId: null,
        activeCalls: 0,
        totalCallsToday: 0,
        currentContact: null,
      });
    }
    this.logger.log(`[INIT] Asesores cargados: ${this.agents.size} — todos OFFLINE hasta conectar WebSocket`);
    this.queueCheckInterval = setInterval(() => this.processQueue(), 2000);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // SINCRONIZACIÓN CON BD
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Recarga los datos de un asesor desde la BD (extensión, nombre, etc).
   * Útil cuando el admin actualiza la extensión de un asesor.
   */
  async reloadAgent(userId: string): Promise<{ success: boolean; message: string }> {
    const agent = this.agents.get(userId);
    if (!agent) {
      return { success: false, message: 'Asesor no encontrado en memoria' };
    }

    try {
      const userFromDb = await this.userRepo.findOne({
        where: { id: userId },
        select: ['id', 'extension', 'firstName', 'lastName'],
      });

      if (!userFromDb) {
        return { success: false, message: 'Usuario no encontrado en BD' };
      }

      if (!userFromDb.extension) {
        return { success: false, message: 'Usuario no tiene extensión asignada' };
      }

      // Actualizar datos en memoria preservando el estado actual
      const oldExtension = agent.extension;
      agent.firstName = userFromDb.firstName || '';
      agent.lastName = userFromDb.lastName || '';
      agent.extension = userFromDb.extension;

      this.logger.log(
        `[RELOAD] Asesor ${userId} actualizado: extensión ${oldExtension} → ${agent.extension}`
      );

      this.emitAgentsUpdate();

      return {
        success: true,
        message: `Datos actualizados: ${agent.firstName} ${agent.lastName} - Ext: ${agent.extension}`,
      };
    } catch (err: any) {
      this.logger.error(`[RELOAD] Error recargando asesor ${userId}: ${err.message}`);
      return { success: false, message: 'Error al recargar datos' };
    }
  }

  /**
   * Recarga TODOS los asesores desde BD.
   * Útil después de actualizaciones masivas.
   */
  async reloadAllAgents(): Promise<{ success: boolean; reloaded: number }> {
    try {
      const users = await this.userRepo.find({
        where: { role: UserRole.CALLCENTER },
        select: ['id', 'extension', 'firstName', 'lastName'],
      });

      let reloaded = 0;

      for (const user of users) {
        if (!user.extension) continue;

        const agent = this.agents.get(user.id);
        if (agent) {
          // Actualizar asesor existente
          agent.firstName = user.firstName || '';
          agent.lastName = user.lastName || '';
          agent.extension = user.extension;
          reloaded++;
        } else {
          // Agregar asesor nuevo que no estaba en memoria
          this.agents.set(user.id, {
            userId: user.id,
            firstName: user.firstName || '',
            lastName: user.lastName || '',
            extension: user.extension,
            status: 'OFFLINE',
            connected: false,
            breakReason: null,
            breakStartedAt: null,
            activeBreakId: null,
            activeCalls: 0,
            totalCallsToday: 0,
            currentContact: null,
          });
          reloaded++;
        }
      }

      this.logger.log(`[RELOAD] ${reloaded} asesores recargados desde BD`);
      this.emitAgentsUpdate();

      return { success: true, reloaded };
    } catch (err: any) {
      this.logger.error(`[RELOAD] Error recargando asesores: ${err.message}`);
      return { success: false, reloaded: 0 };
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CICLO DE VIDA WEBSOCKET
  // ═══════════════════════════════════════════════════════════════════════════

  onAgentConnected(userId: string): void {
    const agent = this.agents.get(userId);
    if (!agent) {
      this.logger.warn(`[CONNECT] ⚠️ Asesor ${userId} no existe en memoria`);
      return;
    }

    agent.connected = true;

    if (agent.status === 'OFFLINE') {
      if (agent.breakReason) {
        agent.status = 'ON_BREAK';
        this.logger.log(`[CONNECT] 🟠 Asesor ${userId} reconectó → se mantiene ON_BREAK (${agent.breakReason})`);
      } else {
        agent.status = 'AVAILABLE';
        this.logger.log(`[CONNECT] 🟢 Asesor ${userId} → AVAILABLE`);
      }
    } else {
      this.logger.log(`[CONNECT] 🔄 Asesor ${userId} reconectó — estado se mantiene: ${agent.status}`);
    }

    this.emitAgentsUpdate();

    this.dashboardGateway.sendUpdate({
      event: 'agent-status-sync',
      status: agent.status,
      breakReason: agent.breakReason,
      breakStartedAt: agent.breakStartedAt,
      currentContact: agent.currentContact,
    }, userId);
  }

  onAgentDisconnected(userId: string): void {
    const agent = this.agents.get(userId);
    if (!agent) {
      this.logger.warn(`[DISCONNECT] ⚠️ Asesor ${userId} no existe en memoria`);
      return;
    }

    agent.connected = false;
    const prev = agent.status;
    agent.status = 'OFFLINE';

    this.logger.log(
      `[DISCONNECT] 🔴 Asesor ${userId}: ${prev} → OFFLINE` +
      (prev === 'ON_CALL' ? ' ⚠️ desconectó durante llamada' : '') +
      (prev === 'ON_BREAK' ? ` (estaba en break: ${agent.breakReason})` : '')
    );

    // Si estaba en break, cerrar el registro
    if (prev === 'ON_BREAK' && agent.activeBreakId) {
      this.logger.log(`[DISCONNECT] 🔴 Cerrando break activo ${agent.activeBreakId}`);
      this.closeBreak(agent.activeBreakId, 'DISCONNECTED');
      agent.activeBreakId = null;
    }

    this.emitAgentsUpdate();
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // DESCANSO
  // ═══════════════════════════════════════════════════════════════════════════

  async setAgentOnBreak(userId: string, reason: string = 'Descanso'): Promise<{ success: boolean; message: string }> {
    const agent = this.agents.get(userId);
    if (!agent)           return { success: false, message: 'Asesor no encontrado' };
    if (!agent.connected) return { success: false, message: 'No estás conectado' };
    if (agent.status === 'ON_CALL')  return { success: false, message: 'No puedes pausar durante una llamada' };
    if (agent.status === 'ON_BREAK') return { success: false, message: 'Ya estás en descanso' };

    agent.status = 'ON_BREAK';
    agent.breakReason = reason;
    const now = new Date();
    agent.breakStartedAt = now.toISOString();

    // Crear registro en BD con startedAt EXPLÍCITO
    const breakRecord = this.breakRepo.create({
      agentId: userId,
      reason,
      initiatedBy: 'AGENT',
      forcedById: null,
      startedAt: now,  // ← FIX: pasar la hora exacta
    });
    const saved = await this.breakRepo.save(breakRecord);
    agent.activeBreakId = saved.id;

    this.logger.log(`[BREAK] 🟠 Asesor ${userId} → ON_BREAK | "${reason}" | BD: ${saved.id}`);
    this.emitAgentsUpdate();

    this.dashboardGateway.sendUpdate({
      event: 'agent-status-sync',
      status: 'ON_BREAK',
      breakReason: reason,
      breakStartedAt: agent.breakStartedAt,
    }, userId);

    return { success: true, message: 'En descanso' };
  }

  async clearAgentBreak(userId: string): Promise<{ success: boolean; message: string }> {
    const agent = this.agents.get(userId);
    if (!agent)           return { success: false, message: 'Asesor no encontrado' };
    if (!agent.connected) return { success: false, message: 'No estás conectado' };
    if (agent.status !== 'ON_BREAK') return { success: false, message: 'No estás en descanso' };

    agent.status = 'AVAILABLE';
    agent.breakReason = null;
    agent.breakStartedAt = null;

    // Cerrar registro en BD
    if (agent.activeBreakId) {
      await this.closeBreak(agent.activeBreakId, 'RETURNED');
      agent.activeBreakId = null;
    }

    this.logger.log(`[BREAK] 🟢 Asesor ${userId} → AVAILABLE (volvió de descanso)`);
    this.emitAgentsUpdate();

    this.dashboardGateway.sendUpdate({
      event: 'agent-status-sync',
      status: 'AVAILABLE',
      breakReason: null,
      breakStartedAt: null,
    }, userId);

    return { success: true, message: 'Disponible' };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FORZAR ESTADO
  // ═══════════════════════════════════════════════════════════════════════════

  async forceAgentStatus(
    agentId: string,
    newStatus: 'AVAILABLE' | 'ON_BREAK' | 'OFFLINE',
    reason?: string,
  ): Promise<{ success: boolean; message: string }> {
    const agent = this.agents.get(agentId);
    if (!agent) return { success: false, message: 'Asesor no encontrado' };

    if (newStatus === 'AVAILABLE' && !agent.connected) {
      return { success: false, message: 'El asesor no está conectado' };
    }

    const prev = agent.status;
    agent.status = newStatus;
    const now = new Date();
    agent.breakReason     = newStatus === 'ON_BREAK' ? (reason || 'Pausado por supervisor') : null;
    agent.breakStartedAt  = newStatus === 'ON_BREAK' ? now.toISOString() : null;

    // Si se fuerza ON_BREAK, crear registro en BD con startedAt explícito
    if (newStatus === 'ON_BREAK') {
      const breakRecord = this.breakRepo.create({
        agentId,
        reason: reason || 'Pausado por supervisor',
        initiatedBy: 'SUPERVISOR',
        forcedById: null,
        startedAt: now,  // ← FIX: pasar la hora exacta
      });
      const saved = await this.breakRepo.save(breakRecord);
      agent.activeBreakId = saved.id;
      this.logger.log(`[FORCE] Supervisor: asesor ${agentId} ${prev} → ${newStatus} | BD: ${saved.id}`);
    }

    // Si estaba en ON_BREAK y se fuerza otro estado, cerrar break
    if (prev === 'ON_BREAK' && newStatus !== 'ON_BREAK' && agent.activeBreakId) {
      await this.closeBreak(agent.activeBreakId, 'FORCED_BY_SUPERVISOR');
      agent.activeBreakId = null;
      this.logger.log(`[FORCE] Supervisor: asesor ${agentId} ${prev} → ${newStatus}`);
    }

    this.emitAgentsUpdate();

    this.dashboardGateway.sendUpdate({
      event: 'agent-status-forced',
      status: newStatus,
      breakReason: agent.breakReason,
      breakStartedAt: agent.breakStartedAt,
      forcedBy: 'supervisor',
    }, agentId);

    return { success: true, message: `Estado cambiado a ${newStatus}` };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // CONSULTAS
  // ═══════════════════════════════════════════════════════════════════════════

  getAgentsSnapshot() {
    return Array.from(this.agents.values()).map(a => ({
      id: a.userId,
      userId: a.userId,
      firstName: a.firstName,
      lastName: a.lastName,
      extension: a.extension,
      status: a.status,
      connected: a.connected,
      breakReason: a.breakReason,
      breakStartedAt: a.breakStartedAt,
      activeCalls: a.activeCalls,
      totalCallsToday: a.totalCallsToday,
      currentContact: a.currentContact || null,
    }));
  }

  getQueueSnapshot() {
    const now = Date.now();
    return this.queue.map(e => ({
      contactId: e.contactId,
      campaignId: e.campaignId,
      position: e.position,
      waitingSeconds: Math.floor((now - e.queuedAt) / 1000),
    }));
  }

  getAgentState(userId: string) {
    const agent = this.agents.get(userId);
    if (!agent) return null;
    return {
      status: agent.status,
      connected: agent.connected,
      breakReason: agent.breakReason,
      breakStartedAt: agent.breakStartedAt,
      currentContact: agent.currentContact || null,
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // ASIGNACIÓN
  // ═══════════════════════════════════════════════════════════════════════════

  private findAvailableAgent(): AgentState | null {
    let best: AgentState | null = null;
    for (const agent of this.agents.values()) {
      if (agent.status !== 'AVAILABLE' || !agent.connected) continue;
      if (!best || agent.totalCallsToday < best.totalCallsToday) best = agent;
    }
    return best;
  }

  async transferToAgent(contactId: string, campaignId: string, channel: any): Promise<boolean> {
    const agent = this.findAvailableAgent();
    if (!agent) return false;

    agent.status = 'ON_CALL';
    agent.activeCalls++;
    agent.totalCallsToday++;

    let campaignName = 'Campaña General';
    try {
      const camp = await (this.campaignService as any).findOne(campaignId).catch(() => null);
      if (camp) campaignName = camp.name;
    } catch {}

    let contactName = 'Cliente', cedula = '—', phone = '—';
    try {
      const contact = await this.contactRepo.findOne({ where: { id: contactId } });
      if (contact) {
        contactName = contact.name || 'Cliente';
        cedula     = contact.identification || '—';
        phone      = contact.phone || '—';
      }
    } catch {}

    agent.currentContact = {
      contactId, cedula, nombre: contactName, telefono: phone,
      campaignId, campaignName, connectedAt: new Date().toISOString(),
    };

    this.logger.log(`[TRANSFER] ${contactName} → Asesor ${agent.userId}`);
    await this.logEvent(contactId, campaignId, AgentCallEventType.ASSIGNED, agent.userId);

    this.dashboardGateway.sendUpdate({
      event: 'agent-call-incoming',
      contactId, campaignId, campaignName, contactName,
      contactIdentification: cedula, contactPhone: phone,
      agentId: agent.userId,
    }, agent.userId);

    try {
      await this.amiService.transferAgentBridge(contactId, agent.extension, agent.userId);
      await this.logEvent(contactId, campaignId, AgentCallEventType.CONNECTED, agent.userId);
      this.emitAgentsUpdate();
      return true;
    } catch (err: any) {
      this.logger.error(`[TRANSFER] Fallo bridge: ${err.message}`);
      agent.status = 'AVAILABLE';
      agent.activeCalls     = Math.max(0, agent.activeCalls - 1);
      agent.totalCallsToday = Math.max(0, agent.totalCallsToday - 1);
      agent.currentContact  = null;
      this.emitAgentsUpdate();
      return false;
    }
  }

  // [Resto de métodos: cola, onAgentCallFinished, utils, etc permanecen igual...]
  // Por brevedad, mantengo solo los métodos críticos modificados arriba

  async addToQueue(contactId: string, campaignId: string, channel: any): Promise<number> {
    const position = this.queue.length + 1;
    this.queue.push({ contactId, campaignId, channel, queuedAt: Date.now(), position });
    this.logger.log(`[QUEUE] ${contactId} entra posición ${position}`);
    await this.logEvent(contactId, campaignId, AgentCallEventType.QUEUED, null, position);
    this.emitQueueUpdate();
    return position;
  }

  async removeFromQueue(contactId: string): Promise<void> {
    const idx = this.queue.findIndex(e => e.contactId === contactId);
    if (idx === -1) return;
    const entry = this.queue[idx];
    this.queue.splice(idx, 1);
    await this.logEvent(entry.contactId, entry.campaignId, AgentCallEventType.CLIENT_ABANDONED, null);
    this.recalcQueuePositions();
    this.emitQueueUpdate();
  }

  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) return;
    const now = Date.now();

    const expired = this.queue.filter(e => now - e.queuedAt > this.QUEUE_TIMEOUT_MS);
    for (const entry of expired) {
      entry.channel.hangup().catch(() => {});
      await this.logEvent(entry.contactId, entry.campaignId, AgentCallEventType.TIMEOUT, null);
    }
    if (expired.length > 0) {
      this.queue = this.queue.filter(e => now - e.queuedAt <= this.QUEUE_TIMEOUT_MS);
      this.recalcQueuePositions();
      this.emitQueueUpdate();
    }

    if (this.queue.length === 0) return;
    const agent = this.findAvailableAgent();
    if (!agent) return;

    const entry = this.queue.shift();
    if (!entry) return;

    agent.status = 'ON_CALL';
    agent.activeCalls++;
    agent.totalCallsToday++;

    let campaignName = 'Campaña General';
    try {
      const camp = await (this.campaignService as any).findOne(entry.campaignId).catch(() => null);
      if (camp) campaignName = camp.name;
    } catch {}

    let contactName = 'Cliente', cedula = '—', phone = '—';
    try {
      const contact = await this.contactRepo.findOne({ where: { id: entry.contactId } });
      if (contact) {
        contactName = contact.name || 'Cliente';
        cedula     = contact.identification || '—';
        phone      = contact.phone || '—';
      }
    } catch {}

    agent.currentContact = {
      contactId: entry.contactId, cedula, nombre: contactName, telefono: phone,
      campaignId: entry.campaignId, campaignName, connectedAt: new Date().toISOString(),
    };

    await this.logEvent(entry.contactId, entry.campaignId, AgentCallEventType.ASSIGNED, agent.userId);

    this.dashboardGateway.sendUpdate({
      event: 'agent-call-incoming',
      contactId: entry.contactId, campaignId: entry.campaignId, campaignName,
      contactName, contactIdentification: cedula, contactPhone: phone,
      agentId: agent.userId, fromQueue: true,
    }, agent.userId);

    try {
      await this.amiService.transferAgentBridge(entry.contactId, agent.extension, agent.userId);
      await this.logEvent(entry.contactId, entry.campaignId, AgentCallEventType.CONNECTED, agent.userId);
      this.emitAgentsUpdate();
      this.emitQueueUpdate();
    } catch (err: any) {
      this.logger.error(`[QUEUE] Fallo bridge: ${err.message}`);
      agent.status = 'AVAILABLE';
      agent.activeCalls     = Math.max(0, agent.activeCalls - 1);
      agent.totalCallsToday = Math.max(0, agent.totalCallsToday - 1);
      agent.currentContact  = null;
      entry.channel.hangup().catch(() => {});
      this.emitAgentsUpdate();
      this.emitQueueUpdate();
    }
  }

  async onAgentCallFinished(
    contactId: string,
    campaignId: string,
    agentUserId: string,
    durationSeconds: number,
  ): Promise<void> {
    if (this.processingFinishedCache.has(contactId)) {
      this.logger.warn(`[RACE] Duplicado ignorado: ${contactId}`);
      return;
    }
    this.processingFinishedCache.add(contactId);
    setTimeout(() => this.processingFinishedCache.delete(contactId), 10000);

    const existing = await this.eventRepo.findOne({
      where: {
        contact: { id: contactId },
        eventType: AgentCallEventType.FINISHED,
        createdAt: MoreThan(new Date(Date.now() - 10000)),
      },
    });
    if (existing) {
      this.logger.warn(`[RACE-DB] Duplicado BD ignorado: ${contactId}`);
      return;
    }

    const agent = this.agents.get(agentUserId);
    if (agent) {
      agent.activeCalls    = Math.max(0, agent.activeCalls - 1);
      agent.currentContact = null;
      agent.status = agent.connected ? 'AVAILABLE' : 'OFFLINE';
      this.logger.log(`[FINISH] Asesor ${agentUserId} → ${agent.status}`);
    }

    this.dashboardGateway.sendUpdate({
      event: 'agent-call-ended',
      contactId, campaignId, durationSeconds, agentId: agentUserId,
    }, agentUserId);

    await this.logEvent(contactId, campaignId, AgentCallEventType.FINISHED, agentUserId, null, durationSeconds);
    this.emitAgentsUpdate();
  }

  resetDailyCounters(): void {
    for (const agent of this.agents.values()) agent.totalCallsToday = 0;
    this.logger.log('Contadores diarios reseteados');
  }

  private async closeBreak(
    breakId: string,
    endReason: 'RETURNED' | 'DISCONNECTED' | 'FORCED_BY_SUPERVISOR',
  ): Promise<void> {
    try {
      const breakRecord = await this.breakRepo.findOne({ where: { id: breakId } });
      if (!breakRecord) return;

      const now = new Date();
      breakRecord.endedAt = now;
      breakRecord.durationSeconds = Math.floor(
        (now.getTime() - breakRecord.startedAt.getTime()) / 1000
      );
      breakRecord.endReason = endReason;
      await this.breakRepo.save(breakRecord);
      
      this.logger.log(`[BREAK] Cerrado ${breakId} — ${breakRecord.durationSeconds}s — ${endReason}`);
    } catch (err: any) {
      this.logger.error(`[BREAK] Error cerrando ${breakId}: ${err.message}`);
    }
  }

  private recalcQueuePositions(): void {
    this.queue.forEach((e, i) => { e.position = i + 1; });
  }

  private async logEvent(
    contactId: string,
    campaignId: string,
    eventType: AgentCallEventType,
    agentUserId: string | null,
    queuePosition: number | null = null,
    durationSeconds: number | null = null,
  ): Promise<void> {
    try {
      await this.eventRepo.save(this.eventRepo.create({
        contact: { id: contactId } as any,
        agent:   agentUserId ? { id: agentUserId } as any : null,
        eventType, campaignId, queuePosition, durationSeconds,
      }));
    } catch (err: any) {
      this.logger.error(`[EVENT] ${eventType}: ${err.message}`);
    }
  }

  private emitAgentsUpdate(): void {
    this.dashboardGateway.broadcastToAdmins({
      event: 'agents-state-update',
      agents: this.getAgentsSnapshot(),
    });
  }

  private emitQueueUpdate(): void {
    this.dashboardGateway.broadcastToAdmins({
      event: 'queue-state-update',
      queue: this.getQueueSnapshot(),
    });
  }
}