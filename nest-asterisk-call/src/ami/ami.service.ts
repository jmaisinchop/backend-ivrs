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
import { EventEmitter } from 'events';

const WS_RETRY_MS = 3000;
const ORIGINATE_TIMEOUT_MS = 70000;

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

interface CallFlags { contactId: string; rang: boolean; up: boolean; }
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
  
  // Mapea ChannelID -> Datos de la llamada en curso
  private flags = new Map<string, CallFlags>();
  private readonly ariEvents = new EventEmitter();

  constructor(
    private readonly http: HttpService,
    @Inject(forwardRef(() => CampaignService))
    private readonly campaigns: CampaignService,
    private readonly configService: ConfigService,
    private readonly dashboardGateway: DashboardGateway,
  ) { }

  async onModuleInit(): Promise<void> { await this.connectAri(); }

  private async connectAri(): Promise<void> {
    try {
      this.ari = await AriClient.connect(
        this.configService.get<string>('ARI_URL'),
        this.configService.get<string>('ARI_USERNAME'),
        this.configService.get<string>('ARI_PASSWORD'),
      );
      
      this.ari.on('WebSocketClose', () => {
        this.logger.error('WebSocket ARI cerrado, reintentando...');
        setTimeout(() => this.connectAri(), WS_RETRY_MS);
      });

      // Manejo de inicio de llamada (StasisStart)
      this.ari.on('StasisStart', (event: any, channel: any) => {
        this.handleStasisStart(event, channel);
      });

      // CRÍTICO: Manejo de fin de llamada (StasisEnd)
      // Esto libera el slot de concurrencia realmente cuando cuelgan.
      this.ari.on('StasisEnd', (event: any, channel: any) => {
        this.handleStasisEnd(event, channel);
      });

      await this.ari.start('stasis-app');
      this.logger.log('Conectado a ARI');
    } catch (err: any) {
      this.logger.error(`Error conectando a ARI: ${err.message}`);
      setTimeout(() => this.connectAri(), WS_RETRY_MS);
    }
  }

  // Lógica para detectar cuando la llamada termina realmente
  private async handleStasisEnd(event: any, channel: any) {
    const f = this.flags.get(channel.id);
    if (f) {
        this.logger.log(`[StasisEnd] Canal ${channel.id} terminó. Contacto: ${f.contactId}`);
        
        // Si la llamada fue contestada (UP), ahora sí la marcamos como SUCCESS (finalizada exitosamente)
        if (f.up) {
            await this.campaigns.updateContactStatusById(
                f.contactId, 
                'SUCCESS', 
                '16', 
                'Finalización normal', 
                null, // startedAt (no cambia)
                null, // answeredAt (no cambia)
                new Date(), // finishedAt (Ahora mismo)
                true // Limpiar channelId para que no sea zombi
            );
        }
        // Si NO fue UP (no contestaron), el método tryCallRaw ya se encargó de marcarla como FAILED.
        
        this.flags.delete(channel.id);
    }
  }

  private async handleStasisStart(event: any, channel: any) {
    this.logger.log(`[StasisStart] Canal ${channel.id} entró en la aplicación.`);
    
    // Lógica de Espionaje (Supervisor)
    const varResult = await channel.getChannelVar({ variable: 'SPY_LEG' }).catch(() => ({value: null}));
    const isSpyLeg = varResult.value === 'true';
    
    if (isSpyLeg) {
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
        if(m.value) this.ariEvents.emit(`supervisor_failed_${m.value}`, new Error('Fallo al contestar supervisor.'));
      }
    }
    // Lógica para llamadas de campaña (reproducción de audio)
    else if (channel.name.startsWith('SIP/')) { 
        const f = this.flags.get(channel.id);
        if (f && f.up) {
            const contact = await this.campaigns.findContactById(f.contactId);
            if(contact && contact.message) {
                // El audio ya debería estar generado, pero por seguridad lo regeneramos/buscamos
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
                            this.logger.log(`[StasisStart-Playback] Finalizado. Colgando.`);
                            channel.hangup().catch(() => {});
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
  
  public async spyCall(contactId: string, supervisorExtension: string): Promise<{ message: string }> {
    const callId = uuidv4();
    this.logger.log(`[SPY:${callId}] Solicitud de espionaje para contacto ${contactId} por ${supervisorExtension}`);

    const contact = await this.campaigns.findContactById(contactId);
    if (!contact || !contact.activeChannelId) {
      throw new Error('La llamada del contacto no está activa o no se encontró.');
    }
    const channelToSpyId = contact.activeChannelId;

    return new Promise(async (resolve, reject) => {
        const cleanup = () => {
            this.ariEvents.removeAllListeners(`supervisor_answered_${callId}`);
            this.ariEvents.removeAllListeners(`supervisor_failed_${callId}`);
        };

        this.ariEvents.once(`supervisor_answered_${callId}`, async ({ supervisorChannel }) => {
            cleanup();
            try {
                // spy: 'both' escucha ambas direcciones
                const snoopChannel = await this.ari.channels.snoopChannel({
                    channelId: channelToSpyId, app: 'stasis-app', spy: 'both',
                });
                
                const bridge = this.ari.Bridge();
                await bridge.create({ type: 'mixing' });
                await bridge.addChannel({ channel: [supervisorChannel.id, snoopChannel.id] });
                
                this.logger.log(`[SPY:${callId}] Espionaje activo.`);

                // Limpieza si el supervisor cuelga
                supervisorChannel.once('StasisEnd', () => {
                    this.logger.log(`[SPY:${callId}] Supervisor colgó.`);
                    snoopChannel.hangup().catch(() => {});
                    bridge.destroy().catch(() => {});
                });

                // NUEVO: Limpieza si el cliente cuelga (StasisEnd del canal original)
                // (Esto se maneja indirectamente porque snoopChannel morirá si el canal original muere, 
                // pero es buena práctica estar atentos a errores en el snoop).
                
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
    this.dashboardGateway.sendUpdate({ event: 'call-initiated' });
    
    // Generamos el audio ANTES de iniciar la llamada para asegurar que existe
    const audio = await this.generateTts(text).catch(() => null);
    if (!audio) {
      await this.persist(contactId, 'FAILED', '', 'TTS ERROR', initialCallAttemptStartedAt, null, new Date());
      return;
    }

    // Iniciamos persistencia básica
    await this.persist(contactId, 'CALLING', '', 'Calling', initialCallAttemptStartedAt, null, null).catch(() => { });

    let final: CallResult = {
      success: false, causeNum: '', causeMsg: 'No trunks attempted',
      startedAt: initialCallAttemptStartedAt, answeredAt: null, finishedAt: new Date()
    };

    // Intentar por cada troncal
    for (const trunk of this.trunks) {
      let attemptSpecificStartedAt = new Date();
      try {
        final = await this.tryCallRaw(contactId, trunk, phone, audio, attemptSpecificStartedAt);
      } catch (e: any) {
        this.logger.error(`[${contactId}] Error tryCallRaw ${trunk}: ${e.message}`);
        final = {
          success: false, causeNum: 'ERROR_INTERNO', causeMsg: 'Error originando',
          startedAt: attemptSpecificStartedAt, answeredAt: null, finishedAt: new Date()
        };
      }
      // Si contestaron (16) o está ocupado (17), no probar más troncales
      if (final.success || final.causeNum === '16' || final.causeNum === '17') {
        break;
      }
    }

    // LÓGICA CRÍTICA DE ESTADO:
    if (final.success) {
        // La llamada fue contestada.
        // NO la marcamos como SUCCESS (finalizada) todavía.
        // Solo actualizamos que fue contestada (answeredAt) y mantenemos CALLING.
        // El evento StasisEnd se encargará de ponerla en SUCCESS cuando cuelguen.
        this.logger.log(`[${contactId}] Contestada. Manteniendo estado CALLING hasta fin de llamada.`);
        await this.campaigns.updateContactStatusById(
            contactId, 
            'CALLING', // Mantenemos CALLING
            final.causeNum, 
            final.causeMsg, 
            final.startedAt, 
            final.answeredAt, 
            null // finishedAt es NULL porque sigue viva
        );
    } else {
        // La llamada falló (Ocupado, No contesta, Error).
        // Marcamos como FAILED inmediatamente para liberar el slot y permitir reintentos.
        await this.persist(
          contactId, 'FAILED', final.causeNum, final.causeMsg,
          initialCallAttemptStartedAt, final.answeredAt, final.finishedAt,
        ).catch(() => { });
    }
  }

  private async tryCallRaw(
    contactId: string, trunk: string, phone: string, audio: string,
    attemptStartedAt: Date
  ): Promise<CallResult> {
    const callId = uuidv4();
    // Guardamos flags iniciales
    this.flags.set(callId, { contactId, rang: false, up: false });
    
    if (contactId) {
      await this.campaigns.updateContactChannelId(contactId, callId);
    }
    
    return new Promise<CallResult>((resolve) => {
      let resolved = false;

      // Función helper para resolver la promesa una única vez
      const finish = (res: Omit<CallResult, 'startedAt' | 'answeredAt' | 'finishedAt'> & { answeredAt?: Date | null }) => {
        if (!resolved) {
          resolved = true;
          clearTimeout(timer);
          // OJO: No borramos this.flags(callId) si fue UP, porque StasisEnd lo necesita.
          // Solo lo borramos si falló (no up).
          const currentFlags = this.flags.get(callId);
          if (!currentFlags?.up) {
              this.flags.delete(callId);
          }
          
          resolve({
            ...res,
            startedAt: attemptStartedAt,
            answeredAt: res.answeredAt || null,
            finishedAt: new Date() // Solo relevante si falló
          });
        }
      };

      const timer = setTimeout(() => {
        this.logger.warn(`[${callId}] Timeout originate.`);
        // Intentar obtener causa del flag
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
          // Listeners específicos para este canal
          ch.on('ChannelDestroyed', (ev: any) => {
            const cause = ev.cause_code ?? ev.cause ?? -1;
            const currentFlags = this.flags.get(callId);
            finish(this.interpret(cause, currentFlags?.up || false));
          });

          ch.on('ChannelStateChange', (_ev: any, st: { state: string }) => {
            const f = this.flags.get(callId);
            if (f) {
              if (st.state === 'Ringing') f.rang = true;
              if (st.state === 'Up') {
                if (f.up) return; // Ya estaba arriba
                f.up = true;
                this.logger.log(`[${callId}] Llamada contestada (UP).`);
                // Resolvemos la promesa indicando éxito
                finish({ success: true, causeNum: '16', causeMsg: 'Contestada', answeredAt: new Date() });
              }
            }
          });
        })
        .catch((err: any) => {
          this.logger.error(`[${callId}] Error originate catch: ${err.message}`);
          finish({ success: false, causeNum: 'FAIL', causeMsg: err.message });
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
    // Si la causa es 16 pero no fue UP, es que colgaron antes de contestar o falló algo raro. Tratamos como fallo.
    return { success: false, causeNum: String(cause), causeMsg: msg };
  }

  private async generateTts(text: string): Promise<string | null> {
    const form = new FormData(); form.append('text', text);
    try {
      const { data } = await lastValueFrom(
        this.http.post<{ filename: string }>(
          this.configService.get<string>('TTS_URL'),
          form,
          { headers: form.getHeaders() },
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
      // Si el status es final, limpiamos el channelId en la DB
      const shouldClearChannelId = status === 'SUCCESS' || status === 'FAILED';
      await this.campaigns.updateContactStatusById(id, status, num, msg, startedAt, answeredAt, finishedAt, shouldClearChannelId);
    }
    catch (e: any) { this.logger.error(`Persist fail for contact ${id}: ${e.message}`); }
  }

  // Wrapper para compatibilidad si fuera necesario
  async updateContactStatusById(id: string, s: string, n?: string, m?: string, start?: Date, ans?: Date, fin?: Date) {
    return this.campaigns.updateContactStatusById(id, s, n, m, start, ans, fin);
  }
}