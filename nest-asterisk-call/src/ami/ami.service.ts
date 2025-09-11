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

      this.ari.on('StasisStart', (event: any, channel: any) => {
        this.handleStasisStart(event, channel);
      });

      await this.ari.start('stasis-app');
      this.logger.log('Conectado a ARI');
    } catch (err: any) {
      this.logger.error(`Error conectando a ARI: ${err.message}`);
      setTimeout(() => this.connectAri(), WS_RETRY_MS);
    }
  }

  private async handleStasisStart(event: any, channel: any) {
    this.logger.log(`[StasisStart] Canal ${channel.id} entró en la aplicación.`);
    
    const varResult = await channel.getChannelVar({ variable: 'SPY_LEG' }).catch(() => ({value: null}));
    const isSpyLeg = varResult.value === 'true';
    
    if (isSpyLeg) {
      this.logger.log(`[StasisStart] El canal ${channel.id} es una llamada para el supervisor. Contestando...`);
      try {
        await channel.answer();
        this.logger.log(`[StasisStart] Canal ${channel.id} contestado.`);
        
        const masterIdResult = await channel.getChannelVar({ variable: 'SPY_MASTER_ID' });
        const spyMasterId = masterIdResult.value;

        if (spyMasterId) {
            this.logger.log(`[StasisStart] Emitting 'supervisor_answered' para ${spyMasterId}`);
            this.ariEvents.emit(`supervisor_answered_${spyMasterId}`, { supervisorChannel: channel });
        } else {
            this.logger.error(`[StasisStart] No se encontró SPY_MASTER_ID en el canal ${channel.id}`);
        }
      } catch (err: any) {
        this.logger.error(`[StasisStart] Error al contestar el canal del supervisor ${channel.id}: ${err.message}`);
        const masterIdResult = await channel.getChannelVar({ variable: 'SPY_MASTER_ID' }).catch(() => ({value: null}));
        if(masterIdResult.value) {
            this.ariEvents.emit(`supervisor_failed_${masterIdResult.value}`, new Error('No se pudo contestar la llamada del supervisor.'));
        }
      }
    }
    // Lógica para llamadas de campaña (reproducción de audio)
    else if (channel.name.startsWith('SIP/')) { 
        const f = this.flags.get(channel.id);
        if (f && f.up) {
            const contact = await this.campaigns.findContactById(f.contactId);
            if(contact && contact.message) {
                const audio = await this.generateTts(contact.message).catch(() => null);
                if (audio) {
                    this.logger.log(`[StasisStart] Reproduciendo audio ${audio} en canal de campaña ${channel.id}`);
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
    this.logger.log(`[SPY:${callId}] Canal a espiar: ${channelToSpyId}`);

    return new Promise(async (resolve, reject) => {
        const cleanup = () => {
            this.ariEvents.removeAllListeners(`supervisor_answered_${callId}`);
            this.ariEvents.removeAllListeners(`supervisor_failed_${callId}`);
        };

        this.ariEvents.once(`supervisor_answered_${callId}`, async ({ supervisorChannel }) => {
            cleanup();
            this.logger.log(`[SPY:${callId}] Evento 'supervisor_answered' recibido para canal ${supervisorChannel.id}.`);
            try {
                // --- CORRECCIÓN FINAL ---
                // Cambiamos 'in' por 'both' para escuchar ambas direcciones del audio.
                const snoopChannel = await this.ari.channels.snoopChannel({
                    channelId: channelToSpyId, app: 'stasis-app', spy: 'both',
                });
                // --- FIN DE LA CORRECCIÓN ---

                this.logger.log(`[SPY:${callId}] Canal de espionaje creado: ${snoopChannel.id}`);

                const bridge = this.ari.Bridge();
                await bridge.create({ type: 'mixing' });
                this.logger.log(`[SPY:${callId}] Puente creado: ${bridge.id}`);

                await bridge.addChannel({ channel: [supervisorChannel.id, snoopChannel.id] });
                this.logger.log(`[SPY:${callId}] Canales añadidos al puente. Espionaje activo.`);

                supervisorChannel.once('StasisEnd', () => {
                    this.logger.log(`[SPY:${callId}] El supervisor colgó. Limpiando.`);
                    snoopChannel.hangup().catch(() => {});
                    bridge.destroy().catch(() => {});
                });
                
                resolve({ message: 'Conectado a la llamada.' });
            } catch (err: any) {
                this.logger.error(`[SPY:${callId}] Error al crear snoop/bridge: ${err.message}`);
                supervisorChannel.hangup().catch(() => {});
                reject(new Error('Error al conectar los canales de espionaje.'));
            }
        });

        this.ariEvents.once(`supervisor_failed_${callId}`, (err: Error) => {
            cleanup();
            this.logger.error(`[SPY:${callId}] Evento 'supervisor_failed' recibido: ${err.message}`);
            reject(err);
        });

        try {
            this.logger.log(`[SPY:${callId}] Originando llamada a extensión interna ${supervisorExtension}`);
            await this.ari.channels.originate({
                endpoint: `Local/${supervisorExtension}@from-internal`,
                callerId: 'Supervisor',
                app: 'stasis-app',
                variables: {
                    'SPY_LEG': 'true',
                    'SPY_MASTER_ID': callId,
                },
            });
        } catch (err: any) {
            this.ariEvents.emit(`supervisor_failed_${callId}`, err);
        }
    });
  }

  public async callWithTTS(text: string, phone: string, contactId: string): Promise<void> {
    this.logger.log(`[${contactId}] Inicio callWithTTS ${phone}`);
    const initialCallAttemptStartedAt = new Date();
    this.dashboardGateway.sendUpdate({ event: 'call-initiated' });
    await this.persist(contactId, 'CALLING', '', 'Calling', initialCallAttemptStartedAt, null, null).catch(() => { });

    const audio = await this.generateTts(text).catch(() => null);
    if (!audio) {
      this.dashboardGateway.sendUpdate({ event: 'call-finished' });
      await this.persist(contactId, 'FAILED', '', 'TTS ERROR', initialCallAttemptStartedAt, null, new Date()).catch(() => { });
      return;
    }
    this.logger.log(`[${contactId}] Audio listo (${audio})`);

    let final: CallResult = {
      success: false, causeNum: '', causeMsg: 'No trunks attempted',
      startedAt: initialCallAttemptStartedAt, answeredAt: null, finishedAt: new Date()
    };

    for (const trunk of this.trunks) {
      this.logger.log(`[${contactId}] Probando troncal ${trunk} con audio ${audio}`);
      let attemptSpecificStartedAt = new Date();
      try {
        final = await this.tryCallRaw(contactId, trunk, phone, audio, attemptSpecificStartedAt);
      } catch (e: any) {
        this.logger.error(`[${contactId}] Error catastrófico en tryCallRaw con troncal ${trunk}: ${e.message}`);
        final = {
          success: false, causeNum: 'ERROR_INTERNO', causeMsg: 'Error originando llamada',
          startedAt: attemptSpecificStartedAt, answeredAt: null, finishedAt: new Date()
        };
      }
      if (final.success || final.causeNum === '16' || final.causeNum === '17') {
        break;
      }
    }

    await this.persist(
      contactId, final.success ? 'SUCCESS' : 'FAILED', final.causeNum, final.causeMsg,
      initialCallAttemptStartedAt, final.answeredAt, final.finishedAt,
    ).catch(() => { });
    this.logger.log(`[${contactId}] Resultado final → ${final.causeMsg}`);
  }

  private async tryCallRaw(
    contactId: string, trunk: string, phone: string, audio: string,
    attemptStartedAt: Date
  ): Promise<CallResult> {
    const callId = uuidv4();
    this.flags.set(callId, { contactId, rang: false, up: false });
    this.logger.log(`[${callId}] Originando ${phone} via ${trunk} (Attempt started: ${attemptStartedAt.toISOString()})`);
    
    if (contactId) {
      await this.campaigns.updateContactChannelId(contactId, callId);
    }
    
    let ariChannel: any = null;
    let eventCauseCode = -1;
    let eventChannelDestroyed = false;
    let attemptAnsweredAt: Date | null = null;
    let attemptFinishedAt: Date | null = null;

    return new Promise<CallResult>((resolve) => {
      let isPromiseResolved = false;

      const resolveOnce = (result: Omit<CallResult, 'startedAt' | 'answeredAt' | 'finishedAt'>) => {
        if (!isPromiseResolved) {
          isPromiseResolved = true;
          if (!attemptFinishedAt) attemptFinishedAt = new Date();
          if (mainTimeoutId) clearTimeout(mainTimeoutId);
          this.flags.delete(callId);
          resolve({
            ...result,
            startedAt: attemptStartedAt,
            answeredAt: attemptAnsweredAt,
            finishedAt: attemptFinishedAt
          });
        }
      };

      const mainTimeoutId = setTimeout(() => {
        if (isPromiseResolved) return;
        this.logger.warn(`[${callId}] Timeout principal (${ORIGINATE_TIMEOUT_MS}ms) alcanzado.`);
        attemptFinishedAt = new Date();

        if (ariChannel && !eventChannelDestroyed) {
          this.logger.warn(`[${callId}] Forzando hangup del canal por timeout principal.`);
          ariChannel.hangup().catch((err: any) => {
            this.logger.error(`[${callId}] Error al colgar en timeout principal: ${err.message}`);
          });
        }
        const currentFlags = this.flags.get(callId) || { contactId, rang: false, up: false };
        resolveOnce(this.interpret(eventCauseCode, currentFlags.up, true));

      }, ORIGINATE_TIMEOUT_MS);

      this.ari.channels.originate({
        endpoint: `SIP/${trunk}/${phone}`,
        app: 'stasis-app',
        callerId: `IVR-${callId}`,
        timeout: 45,
        channelId: callId,
      })
        .then((ch: any) => {
          ariChannel = ch;

          ch.on('ChannelDestroyed', (ev: any) => {
            this.logger.log(`[${ch.id}] Evento: ChannelDestroyed, Causa: ${ev.cause}, Causa Num: ${ev.cause_code}`);
            eventChannelDestroyed = true;
            attemptFinishedAt = new Date();
            eventCauseCode = ev.cause_code ?? ev.cause ?? -1;
            const currentFlags = this.flags.get(ch.id) || { contactId, rang: false, up: false };
            resolveOnce(this.interpret(eventCauseCode, currentFlags.up));
          });

          ch.on('ChannelStateChange', (_ev: any, channelState: { id: string, state: string }) => {
            if (channelState.id !== ch.id) return;
            this.logger.log(`[${ch.id}] Evento: ChannelStateChange, Nuevo Estado: ${channelState.state}`);
            const f = this.flags.get(ch.id);
            if (f) {
              if (channelState.state === 'Ringing') f.rang = true;
              if (channelState.state === 'Up') {
                if (f.up) return;
                f.up = true;
                if (!attemptAnsweredAt) attemptAnsweredAt = new Date();
                this.logger.log(`[${ch.id}] Llamada contestada (${attemptAnsweredAt.toISOString()}).`);
                // La reproducción ahora se maneja en StasisStart
              }
            }
          });
        })
        .catch((err: any) => {
          this.logger.error(`[${callId}] Error al originar la llamada: ${err.message}`);
          attemptFinishedAt = new Date();
          resolveOnce({ success: false, causeNum: 'FAIL_ORIGINATE', causeMsg: `Error originando: ${err.message}` });
        });
    });
  }

  private interpret(cause: number, up: boolean, isTimeout: boolean = false): Omit<CallResult, 'startedAt' | 'answeredAt' | 'finishedAt'> {
    if (isTimeout) {
      if (!up && cause === -1) {
        return { success: false, causeNum: '19', causeMsg: CAUSES[19] || 'No contestó (Timeout)' };
      }
      if (up && cause === 16) {
        return { success: true, causeNum: '16', causeMsg: 'Llamada contestada' };
      }
      if (up && cause === -1) {
        return { success: false, causeNum: '-1', causeMsg: 'Llamada contestada pero finalizó por timeout sin causa Asterisk' };
      }
    }

    if (cause === 16 && up) {
      return { success: true, causeNum: '16', causeMsg: 'Llamada contestada' };
    }
    if (cause === 16 && !up) {
      return { success: false, causeNum: '16', causeMsg: CAUSES[19] || 'No contestó' };
    }

    const msg = CAUSES[cause] ?? `Fallo desconocido (Causa ${cause})`;
    return { success: false, causeNum: cause >= 0 ? `${cause}` : String(cause), causeMsg: msg };
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
      const shouldClearChannelId = status === 'SUCCESS' || status === 'FAILED';
      await this.campaigns.updateContactStatusById(id, status, num, msg, startedAt, answeredAt, finishedAt, shouldClearChannelId);
    }
    catch (e: any) { this.logger.error(`Persist fail for contact ${id}: ${e.message}`); }
  }

  async updateContactStatusById(
    id: string,
    s: string,
    n?: string,
    m?: string,
    startedAt?: Date | null,
    answeredAt?: Date | null,
    finishedAt?: Date | null
  ) {
    return this.campaigns.updateContactStatusById(id, s, n, m, startedAt, answeredAt, finishedAt);
  }
}