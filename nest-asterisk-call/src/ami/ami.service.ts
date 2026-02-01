import {
  Injectable,
  OnModuleInit,
  Logger,
  Inject,
  forwardRef,
} from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { lastValueFrom } from 'rxjs';
import FormData from 'form-data';
import { v4 as uuidv4 } from 'uuid';
import AriClient from 'ari-client';
import { CampaignService } from '../campaign/campaign.service';
import { ConfigService } from '@nestjs/config';
import { DashboardGateway } from 'src/dashboard/dashboard.gateway';
import { PostCallService } from '../post-call/post-call.service';
import { AgentService } from '../post-call/agent.service';
import { EventEmitter } from 'events';

const WS_RETRY_MS = 3000;
const ORIGINATE_TIMEOUT_MS = 70000;
const MAX_EVENT_LISTENERS = 100;

const CAUSES: Record<number | string, string> = {
  1: 'Número no asignado',
  16: 'Finalización normal',
  17: 'Ocupado',
  18: 'Sin respuesta',
  19: 'No contestó',
  21: 'Rechazado',
  28: 'Número inválido',
  31: 'Fallo general',
  34: 'Canal no disponible',
};

interface CallFlags { 
  contactId: string; 
  campaignId: string;   // ← AGREGADO: se guarda al originar la llamada
  rang: boolean; 
  up: boolean; 
  createdAt: number;
}

interface CallResult {
  success: boolean;
  causeNum: string;
  causeMsg: string;
  startedAt: Date | null;
  answeredAt: Date | null;
  finishedAt: Date | null;
}

@Injectable()
export class AmiService implements OnModuleInit {
  private readonly logger = new Logger('AmiService');
  private ari: any;
  private readonly trunks = ['gsmDinstar', 'gsmDinstar2', 'gsmDinstar3', 'gsmDinstar5'];
  private flags = new Map<string, CallFlags>();
  private readonly ariEvents = new EventEmitter();
  private reconnecting = false;
  private callQueue = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly http: HttpService,
    @Inject(forwardRef(() => CampaignService))
    private readonly campaigns: CampaignService,
    private readonly configService: ConfigService,
    private readonly dashboardGateway: DashboardGateway,
    @Inject(forwardRef(() => PostCallService))
    private readonly postCallService: PostCallService,
    @Inject(forwardRef(() => AgentService))
    private readonly agentService: AgentService,
  ) {
    this.ariEvents.setMaxListeners(MAX_EVENT_LISTENERS);
  }

  async onModuleInit(): Promise<void> { 
    await this.connectAri(); 
    this.startFlagCleanupTimer();
  }

  private startFlagCleanupTimer(): void {
    setInterval(() => {
      const now = Date.now();
      const STALE_THRESHOLD = 300000; // 5 minutos
      
      for (const [channelId, flag] of this.flags.entries()) {
        if (now - flag.createdAt > STALE_THRESHOLD) {
          this.logger.warn(`Flag estancado detectado para canal ${channelId}. Limpiando...`);
          this.flags.delete(channelId);
          
          if (!flag.up) {
            this.campaigns.updateContactStatusById(
              flag.contactId,
              'FAILED',
              'TIMEOUT',
              'Timeout de sistema - flag estancado',
              null,
              null,
              new Date(),
              true
            ).catch(err => {
              this.logger.error(`Error actualizando contacto estancado ${flag.contactId}: ${err.message}`);
            });
          }
        }
      }
    }, 60000); // Ejecutar cada minuto
  }

  private async connectAri(): Promise<void> {
    if (this.reconnecting) {
      return;
    }

    this.reconnecting = true;

    try {
      this.ari = await AriClient.connect(
        this.configService.get<string>('ARI_URL'),
        this.configService.get<string>('ARI_USERNAME'),
        this.configService.get<string>('ARI_PASSWORD'),
      );
      
      this.ari.on('WebSocketClose', () => {
        this.logger.error('WebSocket ARI cerrado, reintentando...');
        this.reconnecting = false;
        setTimeout(() => this.connectAri(), WS_RETRY_MS);
      });

      this.ari.on('StasisStart', (event: any, channel: any) => {
        this.handleStasisStart(event, channel);
      });

      this.ari.on('StasisEnd', (event: any, channel: any) => {
        this.handleStasisEnd(event, channel);
      });

      await this.ari.start('stasis-app');
      this.logger.log('Conectado a ARI exitosamente');
      this.reconnecting = false;
    } catch (err: any) {
      this.logger.error(`Error conectando a ARI: ${err.message}`);
      this.reconnecting = false;
      setTimeout(() => this.connectAri(), WS_RETRY_MS);
    }
  }

  private async handleStasisEnd(event: any, channel: any) {
    const f = this.flags.get(channel.id);
    if (f) {
      this.logger.log(`[StasisEnd] Canal ${channel.id} terminó. Contacto: ${f.contactId}`);
      
      if (f.up) {
        await this.campaigns.updateContactStatusById(
          f.contactId, 
          'SUCCESS', 
          '16', 
          'Finalización normal', 
          null,
          null,
          new Date(),
          true
        ).catch(err => {
          this.logger.error(`Error actualizando contacto ${f.contactId} en StasisEnd: ${err.message}`);
        });
      }
      
      this.flags.delete(channel.id);
      
      if (this.callQueue.has(channel.id)) {
        clearTimeout(this.callQueue.get(channel.id)!);
        this.callQueue.delete(channel.id);
      }
    }
  }

  private async handleStasisStart(event: any, channel: any) {
    this.logger.log(`[StasisStart] Canal ${channel.id} entró en la aplicación.`);
    
    const varResult = await channel.getChannelVar({ variable: 'SPY_LEG' }).catch(() => ({value: null}));
    const isSpyLeg = varResult.value === 'true';

    // Verificar si es una llamada al asesor (transferencia post-call)
    const agentLegResult = await channel.getChannelVar({ variable: 'AGENT_LEG' }).catch(() => ({value: null}));
    const isAgentLeg = agentLegResult.value === 'true';
    
    if (isAgentLeg) {
      // Es la llamada originada al asesor para el bridge
      this.logger.log(`[StasisStart] Canal ${channel.id} es llamada a asesor. Contestando...`);
      try {
        await channel.answer();

        const masterIdResult = await channel.getChannelVar({ variable: 'AGENT_MASTER_ID' });
        const contactId = masterIdResult.value;

        if (contactId) {
          this.logger.log(`[StasisStart] Emitting 'agent_answered' para contacto ${contactId}`);
          this.ariEvents.emit(`agent_answered_${contactId}`, { agentChannel: channel });
        }
      } catch (err: any) {
        this.logger.error(`[StasisStart] Error asesor ${channel.id}: ${err.message}`);
        const m = await channel.getChannelVar({ variable: 'AGENT_MASTER_ID' }).catch(() => ({value: null}));
        if (m.value) {
          this.ariEvents.emit(`agent_failed_${m.value}`, new Error('Fallo al contestar asesor.'));
        }
      }
    } else if (isSpyLeg) {
      this.logger.log(`[StasisStart] El canal ${channel.id} es una llamada para el supervisor. Contestando...`);
      try {
        await channel.answer();
        const masterIdResult = await channel.getChannelVar({ variable: 'SPY_MASTER_ID' });
        const spyMasterId = masterIdResult.value;

        if (spyMasterId) {
          this.logger.log(`[StasisStart] Emitting 'supervisor_answered' para ${spyMasterId}`);
          this.ariEvents.emit(`supervisor_answered_${spyMasterId}`, { supervisorChannel: channel });
        }
      } catch (err: any) {
        this.logger.error(`[StasisStart] Error supervisor ${channel.id}: ${err.message}`);
        const m = await channel.getChannelVar({ variable: 'SPY_MASTER_ID' }).catch(() => ({value: null}));
        if(m.value) {
          this.ariEvents.emit(`supervisor_failed_${m.value}`, new Error('Fallo al contestar supervisor.'));
        }
      }
    } else if (channel.name.startsWith('SIP/')) { 
      const f = this.flags.get(channel.id);
      if (f && f.up) {
        const contact = await this.campaigns.findContactById(f.contactId);
        if(contact && contact.message) {
          const audio = await this.generateTts(contact.message).catch(() => null);
          if (audio) {
            this.logger.log(`[StasisStart] Reproduciendo audio ${audio} en canal ${channel.id}`);
            channel.play({ media: `sound:campanas/${audio}` }, (err: any, playback: any) => {
              if (err) {
                this.logger.error(`[StasisStart-Playback] Error: ${err.message}`);
                channel.hangup().catch(() => {});
                return;
              }
              playback.once('PlaybackFinished', () => {
                // ─── Delegar a PostCallService pasando campaignId desde flags ──
                this.logger.log(`[StasisStart-Playback] TTS finalizado. Delegando a PostCallService.`);
                this.postCallService.handlePostCall(channel, f.contactId, f.campaignId).catch((err2: any) => {
                  this.logger.error(`[StasisStart-Playback] Error en handlePostCall: ${err2.message}`);
                  channel.hangup().catch(() => {});
                });
              });
            });
          } else {
            this.logger.error(`[StasisStart] No se pudo obtener audio para contacto ${f.contactId}. Colgando.`);
            channel.hangup().catch(() => {});
          }
        }
      }
    }
  }

  // ─── BRIDGE CLIENTE → ASESOR (transferencia post-call) ───────────────

  public async transferAgentBridge(contactId: string, agentExtension: string): Promise<void> {
    const connectAt = Date.now();
    this.logger.log(`[AGENT-BRIDGE] Iniciando bridge contacto ${contactId} → asesor ${agentExtension}`);

    // Buscar el canal activo del contacto
    const contact = await this.campaigns.findContactById(contactId);
    if (!contact || !contact.activeChannelId) {
      throw new Error('Canal del contacto no activo.');
    }
    const clientChannelId = contact.activeChannelId;

    return new Promise<void>(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        // Si timeout, notificar al AgentService que falló
        this.logger.warn(`[AGENT-BRIDGE] Timeout esperando asesor para contacto ${contactId}`);
        reject(new Error('Timeout esperando que el asesor conteste'));
      }, 30000);

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.ariEvents.removeAllListeners(`agent_answered_${contactId}`);
        this.ariEvents.removeAllListeners(`agent_failed_${contactId}`);
      };

      this.ariEvents.once(`agent_answered_${contactId}`, async ({ agentChannel }) => {
        cleanup();
        try {
          // Crear bridge de mixing entre cliente y asesor
          const bridge = this.ari.Bridge();
          await bridge.create({ type: 'mixing' });

          // Obtener referencia al canal del cliente
          const clientChannel = await this.ari.channels.get({ channelId: clientChannelId });
          await bridge.addChannel({ channel: [clientChannel.id, agentChannel.id] });

          this.logger.log(`[AGENT-BRIDGE] Bridge activo. Contacto ${contactId} ↔ Asesor ${agentExtension}`);

          // Emitir al asesor que ya está conectado con datos del contacto
          const campaignId = contact.campaign?.id || null;
          this.dashboardGateway.sendUpdate(
            {
              event: 'agent-call-connected',
              contactId,
              campaignId,
              contactName: contact.name,
              contactPhone: contact.phone,
              contactIdentification: contact.identification,
            },
            // El userId del asesor lo buscamos por extensión — se pasa desde AgentService
          );

          const durationStart = Date.now();

          // Cuando cualquiera cuelga, destruir bridge y notificar
          const onEnd = async () => {
            const durationSeconds = Math.floor((Date.now() - durationStart) / 1000);
            this.logger.log(`[AGENT-BRIDGE] Finalizado. Duración: ${durationSeconds}s`);
            agentChannel.hangup().catch(() => {});
            clientChannel.hangup().catch(() => {});
            bridge.destroy().catch(() => {});

            // Notificar a AgentService que la llamada terminó
            // El agentUserId lo resolvemos buscando por extensión en AgentService
            const agents = this.agentService.getAgentsSnapshot();
            const agent = agents.find(a => a.extension === agentExtension);
            if (agent) {
              await this.agentService.onAgentCallFinished(contactId, campaignId, agent.userId, durationSeconds);
            }
          };

          agentChannel.once('StasisEnd', onEnd);
          clientChannel.once('StasisEnd', onEnd);

          resolve();
        } catch (err: any) {
          this.logger.error(`[AGENT-BRIDGE] Error bridge: ${err.message}`);
          agentChannel.hangup().catch(() => {});
          reject(new Error('Error al conectar bridge cliente-asesor.'));
        }
      });

      this.ariEvents.once(`agent_failed_${contactId}`, (err: Error) => {
        cleanup();
        reject(err);
      });

      // Originar llamada al asesor via extensión interna
      try {
        await this.ari.channels.originate({
          endpoint: `Local/${agentExtension}@from-internal`,
          callerId: `Cliente-${contactId}`,
          app: 'stasis-app',
          variables: { 'AGENT_LEG': 'true', 'AGENT_MASTER_ID': contactId },
        });
      } catch (err: any) {
        this.ariEvents.emit(`agent_failed_${contactId}`, err);
      }
    });
  }
  
  public async spyCall(contactId: string, supervisorExtension: string): Promise<{ message: string }> {
    const callId = uuidv4();
    this.logger.log(`[SPY:${callId}] Solicitud de espionaje para contacto ${contactId} por ${supervisorExtension}`);

    const contact = await this.campaigns.findContactById(contactId);
    if (!contact || !contact.activeChannelId) {
      throw new Error('La llamada del contacto no está activa o no se encontró.');
    }
    const channelToSpyId = contact.activeChannelId;

    return new Promise(async (resolve, reject) => {
      const timeoutId = setTimeout(() => {
        cleanup();
        reject(new Error('Timeout esperando conexión del supervisor'));
      }, 30000);

      const cleanup = () => {
        clearTimeout(timeoutId);
        this.ariEvents.removeAllListeners(`supervisor_answered_${callId}`);
        this.ariEvents.removeAllListeners(`supervisor_failed_${callId}`);
      };

      this.ariEvents.once(`supervisor_answered_${callId}`, async ({ supervisorChannel }) => {
        cleanup();
        try {
          const snoopChannel = await this.ari.channels.snoopChannel({
            channelId: channelToSpyId, 
            app: 'stasis-app', 
            spy: 'both',
          });
          
          const bridge = this.ari.Bridge();
          await bridge.create({ type: 'mixing' });
          await bridge.addChannel({ channel: [supervisorChannel.id, snoopChannel.id] });
          
          this.logger.log(`[SPY:${callId}] Espionaje activo.`);

          supervisorChannel.once('StasisEnd', () => {
            this.logger.log(`[SPY:${callId}] Supervisor colgó.`);
            snoopChannel.hangup().catch(() => {});
            bridge.destroy().catch(() => {});
          });

          const monitorOriginalChannel = async () => {
            try {
              const channelInfo = await this.ari.channels.get({ channelId: channelToSpyId });
              if (!channelInfo || channelInfo.state === 'Down') {
                this.logger.log(`[SPY:${callId}] Canal original terminó. Cerrando espionaje.`);
                supervisorChannel.hangup().catch(() => {});
                snoopChannel.hangup().catch(() => {});
                bridge.destroy().catch(() => {});
              }
            } catch (err) {
              this.logger.log(`[SPY:${callId}] Canal original no disponible. Cerrando espionaje.`);
              supervisorChannel.hangup().catch(() => {});
              snoopChannel.hangup().catch(() => {});
              bridge.destroy().catch(() => {});
            }
          };

          const monitorInterval = setInterval(monitorOriginalChannel, 2000);
          supervisorChannel.once('StasisEnd', () => clearInterval(monitorInterval));
          
          resolve({ message: 'Conectado a la llamada.' });
        } catch (err: any) {
          this.logger.error(`[SPY:${callId}] Error bridge: ${err.message}`);
          supervisorChannel.hangup().catch(() => {});
          reject(new Error('Error al conectar espionaje.'));
        }
      });

      this.ariEvents.once(`supervisor_failed_${callId}`, (err: Error) => {
        cleanup();
        reject(err);
      });

      try {
        await this.ari.channels.originate({
          endpoint: `Local/${supervisorExtension}@from-internal`,
          callerId: 'Supervisor',
          app: 'stasis-app',
          variables: { 'SPY_LEG': 'true', 'SPY_MASTER_ID': callId },
        });
      } catch (err: any) {
        this.ariEvents.emit(`supervisor_failed_${callId}`, err);
      }
    });
  }

  public async callWithTTS(text: string, phone: string, contactId: string): Promise<void> {
    const initialCallAttemptStartedAt = new Date();

    // ─── AGREGADO: buscar campaignId del contacto antes de originar ───
    const contact = await this.campaigns.findContactById(contactId);
    const campaignId = contact?.campaign?.id || '';
    
    const audio = await this.generateTts(text).catch((err) => {
      this.logger.error(`Error generando TTS para contacto ${contactId}: ${err.message}`);
      return null;
    });
    
    if (!audio) {
      await this.persist(contactId, 'FAILED', 'TTS_ERROR', 'Error generando audio TTS', initialCallAttemptStartedAt, null, new Date());
      return;
    }

    await this.persist(contactId, 'CALLING', '', 'Generando llamada', initialCallAttemptStartedAt, null, null).catch(() => { });

    let final: CallResult = {
      success: false, 
      causeNum: '', 
      causeMsg: 'No trunks attempted',
      startedAt: initialCallAttemptStartedAt, 
      answeredAt: null, 
      finishedAt: new Date()
    };

    for (const trunk of this.trunks) {
      let attemptSpecificStartedAt = new Date();
      try {
        // ─── AGREGADO: pasar campaignId a tryCallRaw ───
        final = await this.tryCallRaw(contactId, campaignId, trunk, phone, audio, attemptSpecificStartedAt);
      } catch (e: any) {
        this.logger.error(`[${contactId}] Error tryCallRaw ${trunk}: ${e.message}`);
        final = {
          success: false, 
          causeNum: 'ERROR_INTERNO', 
          causeMsg: 'Error originando',
          startedAt: attemptSpecificStartedAt, 
          answeredAt: null, 
          finishedAt: new Date()
        };
      }
      
      if (final.success || final.causeNum === '16' || final.causeNum === '17') {
        break;
      }
    }

    if (final.success) {
      this.logger.log(`[${contactId}] Contestada. Manteniendo estado CALLING hasta fin de llamada.`);
      await this.campaigns.updateContactStatusById(
        contactId, 
        'CALLING',
        final.causeNum, 
        final.causeMsg, 
        final.startedAt, 
        final.answeredAt, 
        null
      ).catch(err => {
        this.logger.error(`Error actualizando contacto contestado ${contactId}: ${err.message}`);
      });
    } else {
      await this.persist(
        contactId, 
        'FAILED', 
        final.causeNum, 
        final.causeMsg,
        initialCallAttemptStartedAt, 
        final.answeredAt, 
        final.finishedAt,
      ).catch(() => { });
    }
  }

  private async tryCallRaw(
    contactId: string,
    campaignId: string,   // ─── AGREGADO ───
    trunk: string, 
    phone: string, 
    audio: string,
    attemptStartedAt: Date
  ): Promise<CallResult> {
    const callId = uuidv4();
    
    // ─── AGREGADO: guardar campaignId en flags ───
    this.flags.set(callId, { 
      contactId, 
      campaignId,
      rang: false, 
      up: false,
      createdAt: Date.now()
    });
    
    if (contactId) {
      await this.campaigns.updateContactChannelId(contactId, callId);
    }
    
    return new Promise<CallResult>((resolve) => {
      let resolved = false;
      let channelRef: any = null;

      const finish = (res: Omit<CallResult, 'startedAt' | 'answeredAt' | 'finishedAt'> & { answeredAt?: Date | null }) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          
          if (this.callQueue.has(callId)) {
            clearTimeout(this.callQueue.get(callId)!);
            this.callQueue.delete(callId);
          }

          const currentFlags = this.flags.get(callId);
          if (!currentFlags?.up) {
            this.flags.delete(callId);
          }
          
          if (channelRef) {
            try {
              channelRef.removeAllListeners('ChannelDestroyed');
              channelRef.removeAllListeners('ChannelStateChange');
            } catch (err) {
              // Ignorar errores al limpiar listeners
            }
          }
          
          resolve({
            ...res,
            startedAt: attemptStartedAt,
            answeredAt: res.answeredAt || null,
            finishedAt: new Date()
          });
        }
      };

      const timer = setTimeout(() => {
        this.logger.warn(`[${callId}] Timeout originate.`);
        const currentFlags = this.flags.get(callId);
        finish(this.interpret(-1, currentFlags?.up || false, true));
      }, ORIGINATE_TIMEOUT_MS);

      this.ari.channels.originate({
        endpoint: `SIP/${trunk}/${phone}`,
        app: 'stasis-app',
        callerId: `IVR-${callId}`,
        timeout: 45,
        channelId: callId,
      })
        .then((ch: any) => {
          channelRef = ch;

          ch.on('ChannelDestroyed', (ev: any) => {
            const cause = ev.cause_code ?? ev.cause ?? -1;
            const currentFlags = this.flags.get(callId);
            finish(this.interpret(cause, currentFlags?.up || false));
          });

          ch.on('ChannelStateChange', (_ev: any, st: { state: string }) => {
            const f = this.flags.get(callId);
            if (f) {
              if (st.state === 'Ringing') {
                f.rang = true;
              }
              if (st.state === 'Up') {
                if (f.up) return;
                f.up = true;
                this.logger.log(`[${callId}] Llamada contestada (UP).`);
                finish({ 
                  success: true, 
                  causeNum: '16', 
                  causeMsg: 'Contestada', 
                  answeredAt: new Date() 
                });
              }
            }
          });
        })
        .catch((err: any) => {
          this.logger.error(`[${callId}] Error originate catch: ${err.message}`);
          finish({ 
            success: false, 
            causeNum: 'ORIGINATE_FAIL', 
            causeMsg: err.message 
          });
        });
    });
  }

  private interpret(cause: number, up: boolean, isTimeout: boolean = false) {
    if (up) {
      return { success: true, causeNum: '16', causeMsg: 'Contestada' };
    }
    if (isTimeout) {
      return { success: false, causeNum: '19', causeMsg: CAUSES[19] || 'Timeout' };
    }
    const msg = CAUSES[cause] ?? `Fallo desconocido (${cause})`;
    return { success: false, causeNum: String(cause), causeMsg: msg };
  }

  private async generateTts(text: string): Promise<string | null> {
    const form = new FormData(); 
    form.append('text', text);
    
    try {
      const { data } = await lastValueFrom(
        this.http.post<{ filename: string }>(
          this.configService.get<string>('TTS_URL'),
          form,
          { 
            headers: form.getHeaders(),
            timeout: 10000
          },
        ),
      );
      return data.filename?.replace(/\.gsm$/, '') || null;
    } catch (e: any) {
      this.logger.error(`TTS error: ${e.message}`);
      return null;
    }
  }

  private async persist(
    id: string,
    status: 'CALLING' | 'SUCCESS' | 'FAILED',
    num: string,
    msg: string,
    startedAt?: Date | null,
    answeredAt?: Date | null,
    finishedAt?: Date | null,
  ) {
    if (!id) return;
    try {
      const shouldClearChannelId = status === 'SUCCESS' || status === 'FAILED';
      await this.campaigns.updateContactStatusById(
        id, 
        status, 
        num, 
        msg, 
        startedAt, 
        answeredAt, 
        finishedAt, 
        shouldClearChannelId
      );
    } catch (e: any) { 
      this.logger.error(`Persist fail for contact ${id}: ${e.message}`); 
    }
  }

  async updateContactStatusById(
    id: string, 
    s: string, 
    n?: string, 
    m?: string, 
    start?: Date, 
    ans?: Date, 
    fin?: Date
  ) {
    return this.campaigns.updateContactStatusById(id, s, n, m, start, ans, fin);
  }
}