import { Injectable, Logger, OnModuleInit, Inject, forwardRef } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User, UserRole } from '../user/user.entity';
import { AgentCallEvent, AgentCallEventType } from './agent-call-event.entity';
import { DashboardGateway } from '../dashboard/dashboard.gateway';
import { AmiService } from '../ami/ami.service';

// Estado en memoria de cada asesor
export interface AgentState {
  userId: string;
  firstName: string;
  lastName: string;
  extension: string;
  activeCalls: number;       // Llamadas activas ahora mismo
  totalCallsToday: number;   // Contador diario (se usa para Least Calls)
  busy: boolean;             // Ocupado en llamada en este momento
  currentContact?: {         // Contacto actual si está en llamada
    contactId: string;
    cedula: string;
    nombre: string;
    telefono: string;
    campaignId: string;
    campaignName: string;
    connectedAt: string;
  } | null;
}

// Entrada en la cola virtual de espera
interface QueueEntry {
  contactId: string;
  campaignId: string;
  channel: any;              // Referencia al canal ARI del cliente (para bridge y hangup)
  queuedAt: number;          // Timestamp cuando entró a cola
  position: number;          // Posición actual en la cola
}

@Injectable()
export class AgentService implements OnModuleInit {
  private readonly logger = new Logger(AgentService.name);

  // Estado en memoria de todos los asesores registrados
  private readonly agents = new Map<string, AgentState>();

  // Cola virtual de clientes esperando
  private queue: QueueEntry[] = [];

  // Timeout máximo que un cliente puede esperar en cola (5 minutos)
  private readonly QUEUE_TIMEOUT_MS = 300000;

  // Intervalo para revisar si hay asesores libres y avanzar la cola
  private queueCheckInterval: NodeJS.Timeout;

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    @InjectRepository(AgentCallEvent)
    private readonly eventRepo: Repository<AgentCallEvent>,
    private readonly dashboardGateway: DashboardGateway,
    @Inject(forwardRef(() => AmiService))
    private readonly amiService: AmiService,
  ) {}

  async onModuleInit(): Promise<void> {
    // Cargar solo usuarios con rol CALLCENTER que tienen extensión configurada
    const callcenterUsers = await this.userRepo.find({
      where: { role: UserRole.CALLCENTER },
      select: ['id', 'extension', 'firstName', 'lastName', 'role'],
    });

    for (const user of callcenterUsers) {
      if (user.extension) {
        this.agents.set(user.id, {
          userId: user.id,
          firstName: user.firstName || '',
          lastName: user.lastName || '',
          extension: user.extension,
          activeCalls: 0,
          totalCallsToday: 0,
          busy: false,
          currentContact: null,
        });
      }
    }

    this.logger.log(`Asesores cargados en memoria: ${this.agents.size}`);

    // Revisar cola cada 2 segundos
    this.queueCheckInterval = setInterval(() => this.processQueue(), 2000);
  }

  // ─── CONSULTAS DE ESTADO ─────────────────────────────────────────────

  // Retorna todos los asesores con su estado actual (para mesa de control)
  getAgentsSnapshot() {
    return Array.from(this.agents.values()).map(agent => ({
      id: agent.userId,
      userId: agent.userId,
      firstName: agent.firstName,
      lastName: agent.lastName,
      extension: agent.extension,
      status: agent.busy ? 'ON_CALL' : 'AVAILABLE' as const,
      activeCalls: agent.activeCalls,
      totalCallsToday: agent.totalCallsToday,
      currentContact: agent.currentContact || null,
    }));
  }

  // Retorna la cola actual (para mesa de control)
  getQueueSnapshot(): { contactId: string; campaignId: string; position: number; waitingSeconds: number }[] {
    const now = Date.now();
    return this.queue.map((entry) => ({
      contactId: entry.contactId,
      campaignId: entry.campaignId,
      position: entry.position,
      waitingSeconds: Math.floor((now - entry.queuedAt) / 1000),
    }));
  }

  // ─── ALGORITMO LEAST CALLS ───────────────────────────────────────────

  // Encuentra el asesor libre con menos llamadas atendidas hoy
  private findAvailableAgent(): AgentState | null {
    let bestAgent: AgentState | null = null;

    for (const agent of this.agents.values()) {
      if (agent.busy) continue;

      if (!bestAgent || agent.totalCallsToday < bestAgent.totalCallsToday) {
        bestAgent = agent;
      }
    }

    return bestAgent;
  }

  // ─── TRANSFERENCIA DIRECTA (asesor libre disponible) ─────────────────

  // Intenta transferir directamente. Retorna true si se asignó, false si fue a cola.
  async transferToAgent(
    contactId: string,
    campaignId: string,
    channel: any,
  ): Promise<boolean> {
    const agent = this.findAvailableAgent();

    if (agent) {
      // Marcar asesor como ocupado inmediatamente para evitar asignación doble
      agent.busy = true;
      agent.activeCalls++;
      agent.totalCallsToday++;

      this.logger.log(`[TRANSFER] Contacto ${contactId} → Asesor ${agent.userId} (extensión ${agent.extension})`);

      // Registrar evento ASSIGNED
      await this.logEvent(contactId, campaignId, AgentCallEventType.ASSIGNED, agent.userId);

      // Emitir por WebSocket al asesor: "te entra una llamada"
      this.dashboardGateway.sendUpdate(
        {
          event: 'agent-call-incoming',
          contactId,
          campaignId,
          agentId: agent.userId,
        },
        agent.userId,
      );

      // Ejecutar el bridge vía AmiService
      try {
        await this.amiService.transferAgentBridge(contactId, agent.extension);

        // Registrar evento CONNECTED
        await this.logEvent(contactId, campaignId, AgentCallEventType.CONNECTED, agent.userId);

        // Emitir estado actualizado a mesa de control
        this.emitAgentsUpdate();

        return true;
      } catch (err: any) {
        // Si falla el bridge, liberar al asesor
        this.logger.error(`[TRANSFER] Fallo al conectar asesor ${agent.userId}: ${err.message}`);
        agent.busy = false;
        agent.activeCalls = Math.max(0, agent.activeCalls - 1);
        agent.totalCallsToday = Math.max(0, agent.totalCallsToday - 1);
        this.emitAgentsUpdate();
        return false;
      }
    }

    // No hay asesor libre → meter a cola
    return false;
  }

  // ─── COLA VIRTUAL ────────────────────────────────────────────────────

  // Agrega un cliente a la cola de espera
  async addToQueue(contactId: string, campaignId: string, channel: any): Promise<number> {
    const position = this.queue.length + 1;

    this.queue.push({
      contactId,
      campaignId,
      channel,
      queuedAt: Date.now(),
      position,
    });

    this.logger.log(`[QUEUE] Contacto ${contactId} entra a cola posición ${position}`);

    // Registrar evento QUEUED
    await this.logEvent(contactId, campaignId, AgentCallEventType.QUEUED, null, position);

    // Emitir estado de cola a mesa de control
    this.emitQueueUpdate();

    return position;
  }

  // Cuando el cliente cuelga mientras está en cola
  async removeFromQueue(contactId: string): Promise<void> {
    const index = this.queue.findIndex((e) => e.contactId === contactId);
    if (index === -1) return;

    const entry = this.queue[index];
    this.queue.splice(index, 1);

    this.logger.log(`[QUEUE] Contacto ${contactId} abandonó la cola`);

    // Registrar evento CLIENT_ABANDONED
    await this.logEvent(entry.contactId, entry.campaignId, AgentCallEventType.CLIENT_ABANDONED, null);

    // Recalcular posiciones
    this.recalcQueuePositions();
    this.emitQueueUpdate();
  }

  // Procesa la cola: si hay asesor libre, conecta al siguiente cliente via bridge
  private async processQueue(): Promise<void> {
    if (this.queue.length === 0) return;

    const now = Date.now();

    // Eliminar entradas expiradas por timeout
    const expired = this.queue.filter((e) => now - e.queuedAt > this.QUEUE_TIMEOUT_MS);
    for (const entry of expired) {
      this.logger.warn(`[QUEUE] Timeout contacto ${entry.contactId} en cola`);
      entry.channel.hangup().catch(() => {});
      await this.logEvent(entry.contactId, entry.campaignId, AgentCallEventType.TIMEOUT, null);
    }
    if (expired.length > 0) {
      this.queue = this.queue.filter((e) => now - e.queuedAt <= this.QUEUE_TIMEOUT_MS);
      this.recalcQueuePositions();
      this.emitQueueUpdate();
    }

    // Intentar conectar al primero de la cola con un asesor libre
    if (this.queue.length === 0) return;

    const agent = this.findAvailableAgent();
    if (!agent) return;

    const entry = this.queue.shift();
    if (!entry) return;

    // Marcar asesor ocupado
    agent.busy = true;
    agent.activeCalls++;
    agent.totalCallsToday++;

    this.logger.log(`[QUEUE] Conectando contacto ${entry.contactId} (cola) → Asesor ${agent.userId}`);

    await this.logEvent(entry.contactId, entry.campaignId, AgentCallEventType.ASSIGNED, agent.userId);

    // Emitir al asesor
    this.dashboardGateway.sendUpdate(
      {
        event: 'agent-call-incoming',
        contactId: entry.contactId,
        campaignId: entry.campaignId,
        agentId: agent.userId,
        fromQueue: true,
      },
      agent.userId,
    );

    // Ejecutar el bridge directamente vía AmiService
    try {
      await this.amiService.transferAgentBridge(entry.contactId, agent.extension);

      await this.logEvent(entry.contactId, entry.campaignId, AgentCallEventType.CONNECTED, agent.userId);
      this.emitAgentsUpdate();
      this.emitQueueUpdate();
    } catch (err: any) {
      this.logger.error(`[QUEUE] Fallo bridge desde cola para contacto ${entry.contactId}: ${err.message}`);
      agent.busy = false;
      agent.activeCalls = Math.max(0, agent.activeCalls - 1);
      agent.totalCallsToday = Math.max(0, agent.totalCallsToday - 1);
      entry.channel.hangup().catch(() => {});
      this.emitAgentsUpdate();
      this.emitQueueUpdate();
    }
  }

  // ─── CUANDO TERMINA UNA LLAMADA CON ASESOR ───────────────────────────

  // Se llama cuando el bridge entre cliente y asesor termina
  async onAgentCallFinished(contactId: string, campaignId: string, agentUserId: string, durationSeconds: number): Promise<void> {
    const agent = this.agents.get(agentUserId);
    if (agent) {
      agent.busy = false;
      agent.activeCalls = Math.max(0, agent.activeCalls - 1);
      this.logger.log(`[FINISH] Asesor ${agentUserId} libre. Activas: ${agent.activeCalls}`);
    }

    await this.logEvent(contactId, campaignId, AgentCallEventType.FINISHED, agentUserId, null, durationSeconds);

    this.emitAgentsUpdate();
  }

  // ─── REINICIAR CONTADOR DIARIO ───────────────────────────────────────
  // Se debe llamar cada día (via cron desde el módulo)
  resetDailyCounters(): void {
    for (const agent of this.agents.values()) {
      agent.totalCallsToday = 0;
    }
    this.logger.log('Contadores diarios de asesores reseteados.');
  }

  // ─── HELPERS PRIVADOS ────────────────────────────────────────────────

  private recalcQueuePositions(): void {
    this.queue.forEach((entry, index) => {
      entry.position = index + 1;
    });
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
      const event = this.eventRepo.create({
        contact: { id: contactId } as any,
        agent: agentUserId ? ({ id: agentUserId } as any) : null,
        eventType,
        campaignId,
        queuePosition,
        durationSeconds,
      });
      await this.eventRepo.save(event);
    } catch (err: any) {
      this.logger.error(`[EVENT] Error guardando evento ${eventType} para contacto ${contactId}: ${err.message}`);
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