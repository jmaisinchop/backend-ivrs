import { Injectable, forwardRef, Inject, BadRequestException, Logger, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan, EntityManager } from 'typeorm';
import { Cron } from '@nestjs/schedule';
import { UpdateCampaignDto } from './dto/update-campaign.dto';

import dayjs from 'dayjs';
import customParseFormat from 'dayjs/plugin/customParseFormat';
import isBetween from 'dayjs/plugin/isBetween';
import isSameOrAfter from 'dayjs/plugin/isSameOrAfter';

import { AmiService } from '../ami/ami.service';
import { Campaign } from './campaign.entity';
import { Contact } from './contact.entity';
import { ChannelLimitService } from 'src/channel-limit/channel-limit.service';
import { DuplicateCampaignDto } from './dto/duplicate-campaign.dto';
import { CreateCampaignDto } from './dto/create-campaign.dto';

dayjs.extend(customParseFormat);
dayjs.extend(isBetween);
dayjs.extend(isSameOrAfter); // 👈 Y AÑADE ESTA LÍNEA

@Injectable()
export class CampaignService {
  // Para evitar procesar la misma campaña en paralelo
  private processingCampaigns = new Set<string>();
  private readonly logger = new Logger(CampaignService.name); // MODIFICADO: Añadido Logger

  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Contact)
    private readonly contactRepo: Repository<Contact>,
    @Inject(forwardRef(() => AmiService))
    private readonly amiService: AmiService,
    private readonly channelLimitService: ChannelLimitService,
  ) { }

  async createCampaign(
    userId: string,
    dto: CreateCampaignDto
  ): Promise<Campaign> {

    const {
      name,
      startDate: startDateStr,
      endDate: endDateStr,
      maxRetries,
      concurrentCalls,
      retryOnAnswer // 👈 ¡Ya tenemos acceso al nuevo valor!
    } = dto;

    const startLocal = dayjs(startDateStr, 'DD-MM-YYYY HH:mm:ss', true);
    const endLocal = dayjs(endDateStr, 'DD-MM-YYYY HH:mm:ss', true);

    if (!startLocal.isValid() || !endLocal.isValid()) {
      throw new Error('Fechas inválidas. Formato esperado: dd-MM-yyyy HH:mm:ss');
    }

    const canAssign = await this.channelLimitService.canAssignChannels(
      userId,
      concurrentCalls,
    );
    if (!canAssign) {
      const max = await this.channelLimitService.getUserLimit(userId);
      const used = await this.channelLimitService.getUsedChannels(userId);
      const free = max - used;
      throw new BadRequestException(
        `No puedes crear esta campaña. ` +
        `Tienes asignados ${max} canales en total, ` +
        `${used} ya están en uso, libres: ${free}, ` +
        `y pides ${concurrentCalls}.`
      );
    }

    await this.channelLimitService.reserveChannels(userId, concurrentCalls);

    let status = 'SCHEDULED';
    const now = dayjs();
    if (dayjs().isAfter(endLocal)) {
      status = 'COMPLETED';
    } else if (now.isSameOrAfter(startLocal)) { // Si la fecha de inicio ya pasó o es ahora
      status = 'PAUSED'; // Establecer a PAUSED
      this.logger.log(`Campaña ${name} creada con fecha de inicio en el pasado/presente. Estado inicial: PAUSED.`);
    }

    const campaign = this.campaignRepo.create({
      name,
      startDate: startLocal.toDate(),
      endDate: endLocal.toDate(),
      maxRetries,
      concurrentCalls,
      retryOnAnswer: retryOnAnswer || false, // 👈 SE AÑADE LA PROPIEDAD AQUÍ
      status,
      createdBy: userId,
    });

    return this.campaignRepo.save(campaign);
  }
  async duplicateCampaign(
    originalCampaignId: string,
    userId: string,
    dto: DuplicateCampaignDto,
  ): Promise<Campaign> {
    this.logger.log(`[DUPLICATE] Solicitud para duplicar la campaña ${originalCampaignId}`);

    return this.campaignRepo.manager.transaction(async (transactionalEntityManager: EntityManager) => {
      const originalCampaign = await transactionalEntityManager.findOne(Campaign, {
        where: { id: originalCampaignId },
        relations: ['contacts'],
      });

      if (!originalCampaign) {
        throw new NotFoundException(`La campaña original con ID ${originalCampaignId} no existe.`);
      }
      if (!originalCampaign.contacts || originalCampaign.contacts.length === 0) {
        throw new BadRequestException('La campaña original no tiene contactos para duplicar.');
      }

      const canAssign = await this.channelLimitService.canAssignChannels(userId, dto.concurrentCalls);
      if (!canAssign) {
        throw new BadRequestException('No tienes suficientes canales disponibles para la nueva campaña duplicada.');
      }
      await this.channelLimitService.reserveChannels(userId, dto.concurrentCalls);

      let status = 'SCHEDULED';
      const now = dayjs();
      const startLocal = dayjs(dto.startDate, 'DD-MM-YYYY HH:mm:ss');
      const endLocal = dayjs(dto.endDate, 'DD-MM-YYYY HH:mm:ss');

      if (now.isAfter(endLocal)) {
        status = 'COMPLETED';
      } else if (now.isSameOrAfter(startLocal)) {
        status = 'PAUSED';
        this.logger.log(`[DUPLICATE] La nueva fecha de inicio está en el pasado. Se creará como PAUSED.`);
      }

      const newCampaign = transactionalEntityManager.create(Campaign, {
        ...dto,
        startDate: startLocal.toDate(),
        endDate: endLocal.toDate(),
        status: status,
        createdBy: userId,
      });

      const savedCampaign = await transactionalEntityManager.save(newCampaign);
      this.logger.log(`[DUPLICATE] Nueva campaña creada con ID ${savedCampaign.id} y estado inicial: ${status}`);

      const newContacts = originalCampaign.contacts.map(contact => {
        return transactionalEntityManager.create(Contact, {
          name: contact.name,
          phone: contact.phone,
          identification: contact.identification,
          message: contact.message,
          campaign: savedCampaign,
          attemptCount: 0,
          callStatus: 'NOT_CALLED',
          hangupCode: null,
          hangupCause: null,
          startedAt: null,
          answeredAt: null,
          finishedAt: null,
        });
      });

      // ✅ LA CORRECCIÓN ESTÁ AQUÍ: Reemplazamos el guardado masivo por un bucle.
      this.logger.log(`[DUPLICATE] Guardando ${newContacts.length} contactos uno por uno...`);
      for (const contact of newContacts) {
        await transactionalEntityManager.save(contact);
      }
      this.logger.log(`[DUPLICATE] ${newContacts.length} contactos copiados y reseteados exitosamente.`);

      return savedCampaign;
    });
  }

  async updateCampaign(campaignId: string, dto: UpdateCampaignDto): Promise<Campaign> {
    this.logger.log(`[${campaignId}] Solicitud de actualización recibida.`);

    // 1. BUSCAR LA CAMPAÑA Y VALIDAR SU ESTADO
    const campaign = await this.campaignRepo.findOne({ where: { id: campaignId } });

    if (!campaign) {
      throw new NotFoundException(`Campaña con ID ${campaignId} no encontrada.`);
    }

    if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) {
      throw new BadRequestException(`No se puede modificar una campaña que está ${campaign.status}.`);
    }

    const oldConcurrency = campaign.concurrentCalls;

    // 2. MANEJAR EL CAMBIO DE CONCURRENCIA (LA LÓGICA CLAVE)
    if (dto.concurrentCalls && dto.concurrentCalls !== oldConcurrency) {
      this.logger.log(`[${campaignId}] Cambio de concurrencia: ${oldConcurrency} -> ${dto.concurrentCalls}`);
      const diff = dto.concurrentCalls - oldConcurrency;

      if (diff > 0) { // AUMENTANDO CANALES
        const canAssign = await this.channelLimitService.canAssignChannels(campaign.createdBy, diff);
        if (!canAssign) {
          throw new BadRequestException('No hay suficientes canales disponibles para aumentar la concurrencia.');
        }
        this.logger.log(`[${campaignId}] Reservando ${diff} canales adicionales.`);
        await this.channelLimitService.reserveChannels(campaign.createdBy, diff);
      } else if (diff < 0) { // BAJANDO CANALES
        this.logger.log(`[${campaignId}] Liberando ${Math.abs(diff)} canales.`);
        await this.channelLimitService.releaseChannels(campaign.createdBy, Math.abs(diff));
      }
    }

    // 3. APLICAR LOS CAMBIOS Y GUARDAR LA ENTIDAD
    // Usamos 'merge' para aplicar solo los campos que vienen en el DTO a la entidad existente.
    const updatedCampaign = this.campaignRepo.merge(campaign, dto);

    if (dto.startDate) {
      // Usamos dayjs para interpretar el formato específico que envía el frontend
      const startLocal = dayjs(dto.startDate, 'DD-MM-YYYY HH:mm:ss');
      if (!startLocal.isValid()) throw new BadRequestException('Formato de fecha de inicio inválido.');
      updatedCampaign.startDate = startLocal.toDate();
    }
    if (dto.endDate) {
      // Hacemos lo mismo para la fecha de fin
      const endLocal = dayjs(dto.endDate, 'DD-MM-YYYY HH:mm:ss');
      if (!endLocal.isValid()) throw new BadRequestException('Formato de fecha de fin inválido.');
      updatedCampaign.endDate = endLocal.toDate();
    }

    this.logger.log(`[${campaignId}] Guardando cambios en la base de datos.`);
    return this.campaignRepo.save(updatedCampaign);
  }


  async addContactsToCampaign(
    campaignId: string,
    contacts: { name: string; phone: string; message: string, identification: string }[],
  ): Promise<Contact[]> {
    const camp = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!camp) throw new Error('Campaña no encontrada');

    const contactEntities = contacts.map((c) =>
      this.contactRepo.create({
        identification: c.identification,
        name: c.name,
        phone: c.phone,
        message: c.message,
        campaign: camp,
      }),
    );
    return this.contactRepo.save(contactEntities);
  }

  async startCampaign(campaignId: string): Promise<string> {
    const camp = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!camp) return '❌ Campaña no encontrada';

    if (['COMPLETED', 'CANCELLED'].includes(camp.status)) {
      return `☑️ Campaña en estado ${camp.status}, no se procesará`;
    }

    camp.status = 'RUNNING';
    await this.campaignRepo.save(camp);
    // Arrancamos procesamiento en background
    // La llamada a processCampaign ahora estará protegida por el semáforo interno.
    this.processCampaign(camp.id).catch((error) => {
      this.logger.error(`Error al iniciar el procesamiento de la campaña ${camp.id} desde startCampaign: ${error.message}`, error.stack);
    });
    return camp.status === 'PAUSED'
      ? `⏯ Campaña ${camp.id} reanudada (RUNNING)`
      : `▶️ Campaña ${camp.id} iniciada manualmente (RUNNING)`;
  }

  async pauseCampaign(campaignId: string): Promise<string> {
    const camp = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!camp) return '❌ Campaña no encontrada';

    if (camp.status === 'COMPLETED' || camp.status === 'CANCELLED') {
      this.logger.log(`Campaña ${camp.id} ya está ${camp.status}, no se puede pausar`);
      return `⚠️ Campaña ya está en ${camp.status}, no se puede pausar`;
    }

    camp.status = 'PAUSED';
    await this.campaignRepo.save(camp);
    return `⏸ Campaña ${camp.name} => PAUSED`;
  }

  async cancelCampaign(campaignId: string): Promise<string> {
    const camp = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!camp) return '❌ Campaña no encontrada';

    if (camp.status === 'COMPLETED') {
      return 'Ya está COMPLETEDA, no se puede cancelar';
    }

    const oldStatus = camp.status;
    camp.status = 'CANCELLED';
    await this.campaignRepo.save(camp);

    // Solo liberar canales si la campaña no estaba ya finalizada y si estaba usando canales (RUNNING o PAUSED)
    if (oldStatus === 'RUNNING' || oldStatus === 'SCHEDULED' || oldStatus === 'PAUSED') {
      await this.channelLimitService.releaseChannels(camp.createdBy, camp.concurrentCalls);
    }
    return `Campaña ${camp.name} => CANCELADA`;
  }

  @Cron('0 * * * * *')
  async checkCampaigns(): Promise<void> {
    const now = dayjs();
    // Considerar buscar solo campañas que podrían necesitar acción para optimizar
    const campaignsToCheck = await this.campaignRepo.find({
      where: [
        { status: In(['SCHEDULED', 'RUNNING']) }
      ]
    });

    for (const camp of campaignsToCheck) {
      // Si el procesamiento ya está en curso para esta campaña debido a otra llamada,
      // el semáforo en processCampaign lo manejará.
      // No es necesario verificar this.processingCampaigns.has(camp.id) aquí,
      // ya que processCampaign lo hará.

      if (['COMPLETED', 'CANCELLED', 'PAUSED'].includes(camp.status) && camp.status !== 'RUNNING') { // Corregido para permitir RUNNING
        continue;
      }

      const start = dayjs(camp.startDate);
      const end = dayjs(camp.endDate);

      if (now.isAfter(end) && camp.status !== 'COMPLETED' && camp.status !== 'CANCELLED') {
        this.logger.log(`Campaña ${camp.id} (${camp.name}) ha pasado su fecha de finalización. Marcando como COMPLETED.`);
        camp.status = 'COMPLETED';
        await this.campaignRepo.save(camp);
        await this.channelLimitService.releaseChannels(camp.createdBy, camp.concurrentCalls);
        continue;
      }

      if (camp.status === 'SCHEDULED' && now.isSameOrAfter(start) && now.isBefore(end)) {
        this.logger.log(`Campaña ${camp.id} (${camp.name}) programada está dentro de la ventana. Cambiando a RUNNING.`);
        camp.status = 'RUNNING';
        await this.campaignRepo.save(camp);
        // Intencionalmente llamamos a processCampaign después de cambiar a RUNNING
      }

      if (camp.status === 'RUNNING') {
        this.processCampaign(camp.id).catch((error) => {
          this.logger.error(`Error al procesar campaña ${camp.id} desde checkCampaigns: ${error.message}`, error.stack);
        });
      }
    }
  }

  /** =======================================================================
   * Mantiene el cupo de llamadas vivas de la campaña (MODIFICADO CON SEMÁFORO)
   * ==================================================================== */
  async processCampaign(campaignId: string): Promise<void> {
    // MODIFICADO: Inicio del semáforo
    if (this.processingCampaigns.has(campaignId)) {
      this.logger.warn(`El procesamiento para la campaña ${campaignId} ya está en curso. Omitiendo esta ejecución.`);
      return;
    }
    this.processingCampaigns.add(campaignId);
    // MODIFICADO: Fin del semáforo

    try {
      const camp = await this.campaignRepo.findOne({ where: { id: campaignId } });

      if (!camp) {
        this.logger.warn(`processCampaign: Campaña ${campaignId} no encontrada.`);
        // MODIFICADO: Asegurar liberación del semáforo en salida temprana
        this.processingCampaigns.delete(campaignId);
        return;
      }

      if (camp.status !== 'RUNNING') {
        this.logger.log(`processCampaign: Campaña ${campaignId} no está en RUNNING (estado actual: ${camp.status}). Omitiendo.`);
        // MODIFICADO: Asegurar liberación del semáforo en salida temprana
        this.processingCampaigns.delete(campaignId);
        return;
      }

      const now = dayjs();
      const startDate = dayjs(camp.startDate);
      const endDate = dayjs(camp.endDate);

      if (now.isBefore(startDate) || now.isAfter(endDate)) {
        this.logger.log(`processCampaign: Campaña ${campaignId} fuera de su ventana de tiempo. Marcando como COMPLETED.`);
        camp.status = 'COMPLETED';
        await this.campaignRepo.save(camp);
        await this.channelLimitService.releaseChannels(camp.createdBy, camp.concurrentCalls);
        // MODIFICADO: Asegurar liberación del semáforo en salida temprana
        this.processingCampaigns.delete(campaignId);
        return;
      }

      // 1) Calcula slots libres
      const activeCalls = await this.contactRepo.count({
        where: { campaign: { id: camp.id }, callStatus: 'CALLING' },
      });
      let freeSlots = camp.concurrentCalls - activeCalls;

      if (freeSlots <= 0) {
        this.logger.log(`processCampaign: Campaña ${campaignId} no tiene slots libres (activos: ${activeCalls}, concurrentes: ${camp.concurrentCalls}).`);
        // MODIFICADO: Asegurar liberación del semáforo en salida temprana
        this.processingCampaigns.delete(campaignId);
        return;
      }
      this.logger.log(`processCampaign: Campaña ${campaignId} tiene ${freeSlots} slots libres (activos: ${activeCalls}, concurrentes: ${camp.concurrentCalls}).`);


      // 2) FASE NOT_CALLED
      if (freeSlots > 0) {
        const notCalledContacts = await this.contactRepo.manager.transaction(async transactionalEntityManager => {
          const items = await transactionalEntityManager
            .createQueryBuilder(Contact, 'c')
            .setLock('pessimistic_write') // Bloqueo pesimista para la selección
            .where('c.campaignId = :campaignId', { campaignId: camp.id })
            .andWhere('(c.callStatus IS NULL OR c.callStatus = :notCalledStatus)', { notCalledStatus: 'NOT_CALLED' })
            .andWhere('c.attemptCount < :maxRetries', { maxRetries: camp.maxRetries })
            .orderBy('c.sequence', 'ASC') // Asegúrate que 'sequence' exista y esté poblado
            .take(freeSlots)
            .getMany();

          if (items.length > 0) {
            this.logger.log(`processCampaign: ${items.length} contactos NOT_CALLED encontrados para campaña ${campaignId}.`);
            for (const contact of items) {
              contact.callStatus = 'CALLING';
              contact.attemptCount = (contact.attemptCount || 0) + 1;
              await transactionalEntityManager.save(contact);
            }
          }
          return items;
        });

        for (const contact of notCalledContacts) {
          this.logger.log(`processCampaign: Iniciando llamada (NOT_CALLED) para contacto ${contact.id} (tel: ${contact.phone}) en campaña ${campaignId}.`);
          this.amiService.callWithTTS(contact.message, contact.phone, contact.id)
            .finally(() => {
              // Esta llamada recursiva ahora es segura debido al semáforo.
              // Evaluar si es la mejor estrategia o si es mejor depender
              // de updateContactStatusById y el cron job.
              this.processCampaign(campaignId).catch(e => this.logger.error(`Error en llamada recursiva (NOT_CALLED) a processCampaign para ${campaignId}: ${e.message}`, e.stack));
            });
        }
        // Recalcular freeSlots después de intentar llenar con NOT_CALLED
        const activeAfterNotCalled = await this.contactRepo.count({ where: { campaign: { id: camp.id }, callStatus: 'CALLING' } });
        freeSlots = camp.concurrentCalls - activeAfterNotCalled;
      }


      // 3) FASE FAILED (si aún quedan slots libres)
      if (freeSlots > 0) {
        const failedContactsToRetry = await this.contactRepo.manager.transaction(async transactionalEntityManager => {
          const items = await transactionalEntityManager
            .createQueryBuilder(Contact, 'c')
            .setLock('pessimistic_write')
            .where('c.campaignId = :campaignId', { campaignId: camp.id })
            .andWhere('c.callStatus = :failedStatus', { failedStatus: 'FAILED' })
            .andWhere('c.attemptCount < :maxRetries', { maxRetries: camp.maxRetries })
            .orderBy('c.sequence', 'ASC') // Asegúrate que 'sequence' exista y esté poblado
            .take(freeSlots)
            .getMany();

          if (items.length > 0) {
            this.logger.log(`processCampaign: ${items.length} contactos FAILED para reintentar encontrados para campaña ${campaignId}.`);
            for (const contact of items) {
              contact.callStatus = 'CALLING';
              contact.attemptCount = (contact.attemptCount || 0) + 1; // Ya se incrementó antes, o debería ser al marcar FAILED? Revisar lógica de reintentos.
              await transactionalEntityManager.save(contact);
            }
          }
          return items;
        });

        for (const contact of failedContactsToRetry) {
          this.logger.log(`processCampaign: Iniciando llamada (FAILED) para contacto ${contact.id} (tel: ${contact.phone}) en campaña ${campaignId}.`);
          this.amiService.callWithTTS(contact.message, contact.phone, contact.id)
            .finally(() => {
              // Misma consideración que arriba para la llamada recursiva.
              this.processCampaign(campaignId).catch(e => this.logger.error(`Error en llamada recursiva (FAILED) a processCampaign para ${campaignId}: ${e.message}`, e.stack));
            });
        }
      }

      // 4) Cierra campaña si ya no quedan contactos pendientes o en proceso y se han procesado todos los reintentos
      const pendingContacts = await this.contactRepo.count({
        where: [
          { campaign: { id: camp.id }, callStatus: In([null, 'NOT_CALLED', 'FAILED']), attemptCount: LessThan(camp.maxRetries) },
          { campaign: { id: camp.id }, callStatus: 'CALLING' } // También contar los que están actualmente llamando
        ]
      });

      // Otra forma de verificar si se completó:
      const totalContactsForCampaign = await this.contactRepo.count({ where: { campaign: { id: camp.id } } });
      const completedOrMaxRetriedContacts = await this.contactRepo.count({
        where: [
          { campaign: { id: camp.id }, callStatus: 'SUCCESS' },
          { campaign: { id: camp.id }, callStatus: 'FAILED', attemptCount: camp.maxRetries }, // Fallidos que alcanzaron max reintentos
          // Considerar otros estados terminales si existen
        ]
      });
      const currentlyCalling = await this.contactRepo.count({ where: { campaign: { id: camp.id }, callStatus: 'CALLING' } });


      if ((completedOrMaxRetriedContacts + currentlyCalling) >= totalContactsForCampaign && currentlyCalling === 0) {
        // Esta condición es más robusta: si la suma de contactos exitosos + fallidos (que llegaron a max_retries)
        // es igual al total de contactos de la campaña, Y no hay ninguna llamada activa, entonces se completa.
        const stillPotentiallyProcessable = await this.contactRepo.count({
          where: {
            campaign: { id: camp.id },
            attemptCount: LessThan(camp.maxRetries),
            callStatus: In([null, 'NOT_CALLED', 'FAILED'])
          }
        });

        if (stillPotentiallyProcessable === 0 && currentlyCalling === 0) {
          this.logger.log(`processCampaign: No quedan contactos procesables y ninguna llamada activa para campaña ${camp.id}. Marcando como COMPLETED.`);
          camp.status = 'COMPLETED';
          await this.campaignRepo.save(camp);
          await this.channelLimitService.releaseChannels(camp.createdBy, camp.concurrentCalls);
        }
      }

    } catch (error) {
      this.logger.error(`Error crítico procesando la campaña ${campaignId}: ${error.message}`, error.stack);
    } finally {
      // MODIFICADO: Asegurar liberación del semáforo al finalizar
      this.processingCampaigns.delete(campaignId);
      this.logger.log(`processCampaign: Procesamiento finalizado y semáforo liberado para campaña ${campaignId}.`);
    }
  }


  /** =======================================================================
   * AMI notifica resultado  →  actualiza contacto y rellena cupo (MODIFICADO)
   * ==================================================================== */
  async updateContactStatusById(
    contactId: string,
    status: string,
    causeNumber?: string,
    causeMsg?: string,
    startedAt?: Date | null,
    answeredAt?: Date | null,
    finishedAt?: Date | null,
  ): Promise<void> {
    const contact = await this.contactRepo.findOne({ where: { id: contactId }, relations: ['campaign'] });
    if (!contact) {
      this.logger.warn(`updateContactStatusById: Contacto ${contactId} no encontrado.`);
      return;
    }
    const campaign = contact.campaign;

    if (
      status === 'FAILED' &&
      causeNumber === '19' &&
      campaign.retryOnAnswer === true &&
      contact.attemptCount < campaign.maxRetries
    ) {
      this.logger.log(`[${contactId}] CAUSA 'NO CONTESTO'. Reintentando inmediatamente (Intento ${contact.attemptCount + 1}/${campaign.maxRetries}).`);

      contact.attemptCount++;
      contact.startedAt = startedAt ?? null;
      contact.answeredAt = answeredAt ?? null;
      contact.finishedAt = finishedAt ?? null;
      await this.contactRepo.save(contact);

      this.amiService.callWithTTS(contact.message, contact.phone, contact.id)
        .catch(err => {
          this.logger.error(`[${contact.id}] Falló el reintento inmediato: ${err.message}`);
          contact.callStatus = 'FAILED';
          contact.hangupCause = 'Fallo en reintento inmediato';
          this.contactRepo.save(contact);
        });

      return; // Detenemos la ejecución para no marcar como FAILED y llamar a otro.
    }

    // Lógica original para todos los demás casos
    contact.callStatus = status;
    contact.hangupCode = causeNumber || null;
    contact.hangupCause = causeMsg || null;
    contact.startedAt = startedAt ?? null;
    contact.answeredAt = answeredAt ?? null;
    contact.finishedAt = finishedAt ?? null;
    await this.contactRepo.save(contact);

    this.logger.log(
      `Contacto ${contactId} actualizado a estado ${status} ` +
      `(Causa: ${causeMsg || 'N/A'}) para campaña ${contact.campaign.id}. `
    );

    if (contact.campaign.status === 'RUNNING') {
      this.logger.log(`Campaña ${contact.campaign.id} está RUNNING, intentando rellenar cupo tras finalización de ${contactId}.`);
      this.processCampaign(contact.campaign.id);
    }
  }

  // ... (limitConcurrency - no modificado, pero su uso debe ser evaluado si es necesario) ...
  private async limitConcurrency<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
  ) {
    let index = 0;
    const running: Promise<void>[] = [];

    while (index < items.length || running.length > 0) { // Modificado para esperar a los que quedan corriendo
      while (running.length < concurrency && index < items.length) {
        const item = items[index++];
        const p = fn(item).finally(() => {
          running.splice(running.indexOf(p), 1);
        });
        running.push(p);
      }

      if (running.length > 0) { // Esperar si hay algo corriendo
        await Promise.race(running.map(p => p.catch(() => { }))); // Promise.race necesita que las promesas se resuelvan o rechacen
        // Añadimos .catch para evitar que un rechazo no manejado detenga Promise.race
      }
      // Si llenamos la concurrencia, o ya no hay más items para iniciar, esperamos a que termine al menos 1
      if (running.length >= concurrency && items.length > index) { // Condición original, pero puede ser redudante con el while externo
        await Promise.race(running.map(p => p.catch(() => { })));
      } else if (running.length > 0 && items.length <= index) { // Si no hay más items pero aún hay tareas corriendo
        await Promise.all(running.map(p => p.catch(() => { }))); // Esperar a todas las restantes
      } else if (running.length === 0 && items.length <= index) { // No hay más items y nada corriendo
        break;
      }

    }
    // await Promise.all(running); // Esta línea al final es la más importante si el loop anterior se simplifica
  }


  async getCampaignById(campaignId: string) {
    return this.campaignRepo.findOne({
      where: { id: campaignId },
      relations: ['contacts'], // Cuidado con cargar todos los contactos si son muchos
    });
  }

 async getAllCampaignsMinimal(
    userId: string,
    role: string
  ): Promise<{
    id: string;
    name: string;
    status: string;
    startDate: Date;
    endDate: Date;
    createdBy: string;
    maxRetries: number;
    concurrentCalls: number;
    retryOnAnswer: boolean;
  }[]> {
    const whereClause: any = {};
    if (role === 'CALLCENTER') {
      whereClause.createdBy = userId;
    }
    return this.campaignRepo.find({
      select: [
        'id',
        'name',
        'status',
        'startDate',
        'endDate',
        'createdBy',
        'maxRetries',
        'concurrentCalls',
        'retryOnAnswer', // ✅ El campo que faltaba
      ],
      where: whereClause,
      order: { startDate: 'DESC' },
    });
  }F

  private buildRangeWhere(field: string, range: string) {
    // Asegurarse que el 'field' sea seguro y no permita SQL Injection si viene de input de usuario.
    // Para este caso, field es controlado internamente.
    if (range === 'day') return `${field} >= NOW() - INTERVAL '1 day'`;
    if (range === 'week') return `${field} >= NOW() - INTERVAL '7 days'`;
    return `${field} >= NOW() - INTERVAL '1 month'`; // Default a 'month'
  }

  async getActiveCampaignCount(range = 'month'): Promise<number> {
    const dateRangeCondition = this.buildRangeWhere('campaign."startDate"', range);
    return this.campaignRepo
      .createQueryBuilder('campaign')
      .where('campaign.status = :status', { status: 'RUNNING' })
      .andWhere(dateRangeCondition)
      .getCount();
  }

  async getOngoingCallCount(range = 'month'): Promise<number> {
    const dateRangeCondition = this.buildRangeWhere('campaign."startDate"', range);
    return this.contactRepo
      .createQueryBuilder('contact')
      .innerJoin('contact.campaign', 'campaign')
      .where('contact.callStatus = :status', { status: 'CALLING' })
      .andWhere(dateRangeCondition)
      .getCount();
  }

  async getSuccessRate(range = 'month'): Promise<number> {
    const dateRangeCondition = this.buildRangeWhere('campaign."startDate"', range);

    const total = await this.contactRepo
      .createQueryBuilder('contact')
      .innerJoin('contact.campaign', 'campaign')
      .where(dateRangeCondition) // Contar todos los contactos de campañas en el rango
      .andWhere("contact.callStatus IS NOT NULL AND contact.callStatus != 'CALLING'") // Solo contar llamadas intentadas
      .getCount();

    const success = await this.contactRepo
      .createQueryBuilder('contact')
      .innerJoin('contact.campaign', 'campaign')
      .where('contact.callStatus = :status', { status: 'SUCCESS' })
      .andWhere(dateRangeCondition)
      .getCount();

    return total === 0 ? 0 : (success / total) * 100; // Devolver como porcentaje
  }

  async getTotalContacts(range = 'month'): Promise<number> {
    const dateRangeCondition = this.buildRangeWhere('campaign."startDate"', range);
    return this.contactRepo
      .createQueryBuilder('contact')
      .innerJoin('contact.campaign', 'campaign')
      .where(dateRangeCondition)
      .getCount();
  }

  async getMonthlyCallStats(
    range = 'month',
  ): Promise<{ month: string; llamadas: number; exitosas: number }[]> {
    const dateRangeCondition = this.buildRangeWhere('c."startDate"', range); // Alias 'c' para campaign
    // La consulta SQL es específica de PostgreSQL. Ajustar si es otra BD.
    const rawResults = await this.contactRepo.query(`
      SELECT
        TO_CHAR(c."startDate", 'Mon YYYY') AS month, -- Formato de mes y año
        COUNT(contact.id) AS llamadas, -- Contar todos los contactos asociados
        COUNT(contact.id) FILTER (WHERE contact."callStatus" = 'SUCCESS') AS exitosas
      FROM contact
      INNER JOIN campaign c ON c.id = contact."campaignId"
      WHERE ${dateRangeCondition}
      GROUP BY month
      ORDER BY MIN(c."startDate") -- Ordenar por la fecha real para asegurar orden cronológico
    `);
    return rawResults.map(r => ({
      month: r.month,
      llamadas: parseInt(r.llamadas, 10),
      exitosas: parseInt(r.exitosas, 10)
    }));
  }

  async getCallStatusDistribution(
    range = 'month',
  ): Promise<Record<string, number>> {
    const dateRangeCondition = this.buildRangeWhere('campaign."startDate"', range);
    const raw = await this.contactRepo
      .createQueryBuilder('contact')
      .innerJoin('contact.campaign', 'campaign')
      .select('COALESCE(contact.callStatus, \'UNKNOWN\')', 'callStatus') // Agrupar nulos como UNKNOWN
      .addSelect('COUNT(*)', 'count')
      .where(dateRangeCondition)
      .andWhere("contact.callStatus IS NOT NULL OR contact.callStatus != 'CALLING'") // Opcional: excluir llamadas en curso o no iniciadas
      .groupBy('COALESCE(contact.callStatus, \'UNKNOWN\')')
      .getRawMany();

    const result: Record<string, number> = {};
    raw.forEach((r) => {
      result[r.callStatus] = parseInt(r.count, 10);
    });
    return result;
  }

  async getLiveContacts(
    campaignId: string,
    status = 'ALL', // 'ALL', 'CALLING', 'SUCCESS', 'FAILED', 'PENDING'
    limit = 50,
    offset = 0,
  ) {
    let statusFilter = '';
    if (status !== 'ALL') {
      // Para PENDING, la lógica es más compleja que un simple filtro de estado
      if (status === 'PENDING') {
        statusFilter = `AND (c."callStatus" IS NULL OR c."callStatus" NOT IN ('SUCCESS', 'FAILED', 'CALLING'))`;
      } else {
        statusFilter = `AND c."callStatus" = '${status}'`; // ¡Cuidado con SQL Injection si 'status' no está validado!
        // Aquí se asume que 'status' viene de una lista controlada.
      }
    }

    const rows = await this.contactRepo.query(
      `
      SELECT
        c.id, c.name, c.phone, c."callStatus", c."attemptCount",
        c."hangupCause", c."hangupCode"
        -- c."createdAt", c."updatedAt" -- Podrías añadirlos si son útiles
      FROM contact c
      WHERE c."campaignId" = $1
        ${statusFilter}
      ORDER BY c.id DESC -- O por fecha de última actualización/creación si es más relevante
      LIMIT $2 OFFSET $3
      `,
      [campaignId, limit, offset],
    );

    // El resumen ya es correcto.
    const [{ total, calling, success, failed, pending }] =
      await this.contactRepo.query(
        `
        SELECT
          COUNT(*)::INT AS total,
          COUNT(*) FILTER (WHERE "callStatus"='CALLING')::INT AS calling,
          COUNT(*) FILTER (WHERE "callStatus"='SUCCESS')::INT AS success,
          COUNT(*) FILTER (WHERE "callStatus"='FAILED')::INT AS failed,
          COUNT(*) FILTER (
            WHERE "callStatus" IS NULL
               OR "callStatus" NOT IN('SUCCESS','FAILED','CALLING')
          )::INT AS pending
        FROM contact WHERE "campaignId" = $1
        `,
        [campaignId],
      );

    return { total, calling, success, failed, pending, rows };
  }

  async getPages(campaignId: string, status = 'ALL', limit = 50) {
    let statusFilter = '';
    if (status !== 'ALL') {
      if (status === 'PENDING') {
        statusFilter = `AND ("callStatus" IS NULL OR "callStatus" NOT IN ('SUCCESS', 'FAILED', 'CALLING'))`;
      } else {
        statusFilter = `AND "callStatus" = '${status}'`; // Validar 'status'
      }
    }

    const [{ count }] = await this.contactRepo.query(
      `SELECT COUNT(*)::INT AS count
       FROM contact WHERE "campaignId" = $1 ${statusFilter}`,
      [campaignId],
    );
    return Math.max(1, Math.ceil(+count / limit));
  }
}