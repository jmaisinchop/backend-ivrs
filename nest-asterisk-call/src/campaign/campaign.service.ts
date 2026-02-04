import { Injectable, forwardRef, Inject, BadRequestException, Logger, NotFoundException, OnModuleInit } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, In, LessThan, EntityManager, Not, IsNull } from 'typeorm';
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
import { DashboardGateway } from 'src/dashboard/dashboard.gateway';

dayjs.extend(customParseFormat);
dayjs.extend(isBetween);
dayjs.extend(isSameOrAfter);

interface ProcessingLock {
  timestamp: number;
  inProgress: boolean;
}

@Injectable()
export class CampaignService implements OnModuleInit {
  private readonly processingCampaigns = new Map<string, ProcessingLock>();
  private readonly logger = new Logger(CampaignService.name);
  private readonly PROCESSING_TIMEOUT = 30000;
  private readonly MAX_CONTACTS_PER_BATCH = 20;
  private readonly RETRY_BACKOFF_MS = 5000;

  constructor(
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
    @InjectRepository(Contact)
    private readonly contactRepo: Repository<Contact>,
    @Inject(forwardRef(() => AmiService))
    private readonly amiService: AmiService,
    private readonly channelLimitService: ChannelLimitService,
    private readonly dashboardGateway: DashboardGateway,
  ) { }

  async onModuleInit() {
    this.logger.log('Iniciando CampaignService. Limpiando contactos zombis y verificando consistencia...');

    await this.contactRepo.manager.transaction(async (manager) => {
      const zombieContacts = await manager
        .createQueryBuilder(Contact, 'c')
        .setLock('pessimistic_write')
        .where('c.callStatus = :status', { status: 'CALLING' })
        .getMany();

      if (zombieContacts.length > 0) {
        await manager
          .createQueryBuilder()
          .update(Contact)
          .set({
            callStatus: 'FAILED',
            hangupCode: 'SYSTEM_RESTART',
            hangupCause: 'Sistema reiniciado durante llamada',
            activeChannelId: null,
            finishedAt: new Date()
          })
          .where('callStatus = :status', { status: 'CALLING' })
          .execute();

        this.logger.warn(`Se marcaron ${zombieContacts.length} contactos zombis como FAILED.`);
      }
    });

    const runningCampaigns = await this.campaignRepo.find({
      where: { status: In(['RUNNING', 'PAUSED', 'SCHEDULED']) }
    });

    for (const campaign of runningCampaigns) {
      await this.channelLimitService.forceRecalculateUsedChannels(campaign.createdBy);
    }

    this.logger.log('Limpieza y verificación completada.');
  }

  @Cron('*/5 * * * *')
  async cleanupStalledProcessing() {
    const now = Date.now();
    const stalledCampaigns: string[] = [];

    for (const [campaignId, lock] of this.processingCampaigns.entries()) {
      if (lock.inProgress && (now - lock.timestamp) > this.PROCESSING_TIMEOUT) {
        stalledCampaigns.push(campaignId);
      }
    }

    if (stalledCampaigns.length > 0) {
      this.logger.warn(`Detectados ${stalledCampaigns.length} procesamiento(s) estancado(s). Limpiando...`);
      stalledCampaigns.forEach(id => this.processingCampaigns.delete(id));
    }
  }

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
      retryOnAnswer
    } = dto;

    const startLocal = dayjs(startDateStr, 'DD-MM-YYYY HH:mm:ss', true);
    const endLocal = dayjs(endDateStr, 'DD-MM-YYYY HH:mm:ss', true);

    if (!startLocal.isValid() || !endLocal.isValid()) {
      throw new BadRequestException('Fechas inválidas. Formato esperado: dd-MM-yyyy HH:mm:ss');
    }

    const canAssign = await this.channelLimitService.canAssignChannels(userId, concurrentCalls);

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
    } else if (now.isSameOrAfter(startLocal)) {
      status = 'PAUSED';
      this.logger.log(`Campaña ${name} creada con fecha de inicio en el pasado/presente. Estado inicial: PAUSED.`);
    }

    const campaign = this.campaignRepo.create({
      name,
      startDate: startLocal.toDate(),
      endDate: endLocal.toDate(),
      maxRetries,
      concurrentCalls,
      retryOnAnswer: retryOnAnswer || false,
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

      const batchSize = 500;
      for (let i = 0; i < originalCampaign.contacts.length; i += batchSize) {
        const batch = originalCampaign.contacts.slice(i, i + batchSize).map(contact => {
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

        await transactionalEntityManager.save(batch);
      }

      this.logger.log(`[DUPLICATE] ${originalCampaign.contacts.length} contactos copiados y reseteados exitosamente.`);

      return savedCampaign;
    });
  }

  async updateCampaign(campaignId: string, dto: UpdateCampaignDto): Promise<Campaign> {
    this.logger.log(`[${campaignId}] Solicitud de actualización recibida.`);

    const campaign = await this.campaignRepo.findOne({ where: { id: campaignId } });

    if (!campaign) {
      throw new NotFoundException(`Campaña con ID ${campaignId} no encontrada.`);
    }

    if (['COMPLETED', 'CANCELLED'].includes(campaign.status)) {
      throw new BadRequestException(`No se puede modificar una campaña que está ${campaign.status}.`);
    }

    const oldConcurrency = campaign.concurrentCalls;

    if (dto.concurrentCalls && dto.concurrentCalls !== oldConcurrency) {
      this.logger.log(`[${campaignId}] Cambio de concurrencia: ${oldConcurrency} -> ${dto.concurrentCalls}`);
      const diff = dto.concurrentCalls - oldConcurrency;

      if (diff > 0) {
        const canAssign = await this.channelLimitService.canAssignChannels(campaign.createdBy, diff);
        if (!canAssign) {
          throw new BadRequestException('No hay suficientes canales disponibles para aumentar la concurrencia.');
        }
        this.logger.log(`[${campaignId}] Reservando ${diff} canales adicionales.`);
        await this.channelLimitService.reserveChannels(campaign.createdBy, diff);
      } else if (diff < 0) {
        this.logger.log(`[${campaignId}] Liberando ${Math.abs(diff)} canales.`);
        await this.channelLimitService.releaseChannels(campaign.createdBy, Math.abs(diff));
      }
    }

    const updatedCampaign = this.campaignRepo.merge(campaign, dto);

    if (dto.startDate) {
      const startLocal = dayjs(dto.startDate, 'DD-MM-YYYY HH:mm:ss');
      if (!startLocal.isValid()) throw new BadRequestException('Formato de fecha de inicio inválido.');
      updatedCampaign.startDate = startLocal.toDate();
    }
    if (dto.endDate) {
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
    if (!camp) throw new NotFoundException('Campaña no encontrada');

    const contactEntities = contacts.map((c) =>
      this.contactRepo.create({
        identification: c.identification,
        name: c.name,
        phone: c.phone,
        message: c.message,
        campaign: camp,
      }),
    );

    const batchSize = 500;
    const results: Contact[] = [];

    for (let i = 0; i < contactEntities.length; i += batchSize) {
      const batch = contactEntities.slice(i, i + batchSize);
      const saved = await this.contactRepo.save(batch);
      results.push(...saved);
    }

    return results;
  }

  async startCampaign(campaignId: string): Promise<string> {
    const camp = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!camp) return 'Campaña no encontrada';

    if (['COMPLETED', 'CANCELLED'].includes(camp.status)) {
      return `Campaña en estado ${camp.status}, no se procesará`;
    }

    camp.status = 'RUNNING';
    await this.campaignRepo.save(camp);

    setImmediate(() => {
      this.processCampaign(camp.id).catch((error) => {
        this.logger.error(`Error al iniciar el procesamiento de la campaña ${camp.id}: ${error.message}`, error.stack);
      });
    });

    return camp.status === 'PAUSED'
      ? `Campaña ${camp.id} reanudada (RUNNING)`
      : `Campaña ${camp.id} iniciada manualmente (RUNNING)`;
  }

  async pauseCampaign(campaignId: string): Promise<string> {
    const camp = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!camp) return 'Campaña no encontrada';

    if (camp.status === 'COMPLETED' || camp.status === 'CANCELLED') {
      this.logger.log(`Campaña ${camp.id} ya está ${camp.status}, no se puede pausar`);
      return `Campaña ya está en ${camp.status}, no se puede pausar`;
    }

    camp.status = 'PAUSED';
    await this.campaignRepo.save(camp);
    return `⏸ Campaña ${camp.name} => PAUSED`;
  }

  async cancelCampaign(campaignId: string): Promise<string> {
    const camp = await this.campaignRepo.findOne({ where: { id: campaignId } });
    if (!camp) return 'Campaña no encontrada';

    if (camp.status === 'COMPLETED') {
      return 'Ya está COMPLETEDA, no se puede cancelar';
    }

    const oldStatus = camp.status;
    camp.status = 'CANCELLED';
    await this.campaignRepo.save(camp);

    if (oldStatus === 'RUNNING' || oldStatus === 'SCHEDULED' || oldStatus === 'PAUSED') {
      await this.channelLimitService.releaseChannels(camp.createdBy, camp.concurrentCalls);
    }
    return `Campaña ${camp.name} => CANCELADA`;
  }

  @Cron('0 * * * * *')
  async checkCampaigns(): Promise<void> {
    const now = dayjs();
    const campaignsToCheck = await this.campaignRepo.find({
      where: [
        { status: In(['SCHEDULED', 'RUNNING']) }
      ]
    });

    for (const camp of campaignsToCheck) {
      if (['COMPLETED', 'CANCELLED', 'PAUSED'].includes(camp.status) && camp.status !== 'RUNNING') {
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

        setImmediate(() => {
          this.processCampaign(camp.id).catch((error) => {
            this.logger.error(`Error al procesar campaña ${camp.id}: ${error.message}`, error.stack);
          });
        });
      }

      if (camp.status === 'RUNNING') {
        setImmediate(() => {
          this.processCampaign(camp.id).catch((error) => {
            this.logger.error(`Error al procesar campaña ${camp.id}: ${error.message}`, error.stack);
          });
        });
      }
    }
  }

  async processCampaign(campaignId: string): Promise<void> {
    const existingLock = this.processingCampaigns.get(campaignId);
    const now = Date.now();

    if (existingLock && existingLock.inProgress) {
      if (now - existingLock.timestamp < this.PROCESSING_TIMEOUT) {
        return;
      }
    }

    this.processingCampaigns.set(campaignId, { timestamp: now, inProgress: true });

    try {
      const camp = await this.campaignRepo.findOne({ where: { id: campaignId } });

      if (!camp || camp.status !== 'RUNNING') {
        this.processingCampaigns.delete(campaignId);
        return;
      }

      if (dayjs().isAfter(dayjs(camp.endDate))) {
        camp.status = 'COMPLETED';
        await this.campaignRepo.save(camp);
        await this.channelLimitService.releaseChannels(camp.createdBy, camp.concurrentCalls);
        this.processingCampaigns.delete(campaignId);
        return;
      }

      const activeCalls = await this.contactRepo.count({
        where: {
          campaign: { id: camp.id },
          callStatus: 'CALLING',
          activeChannelId: Not(IsNull())
        },
      });

      const freeSlots = Math.max(0, camp.concurrentCalls - activeCalls);

      if (freeSlots <= 0) {
        this.processingCampaigns.delete(campaignId);
        return;
      }

      const contactsToProcess = Math.min(freeSlots, this.MAX_CONTACTS_PER_BATCH);
      let processedCount = 0;

      const newContacts = await this.contactRepo.manager.transaction(async transactionalEntityManager => {
        const items = await transactionalEntityManager
          .createQueryBuilder(Contact, 'c')
          .setLock('pessimistic_write')
          .setOnLocked('skip_locked')
          .where('c.campaignId = :campaignId', { campaignId: camp.id })
          .andWhere('c.callStatus = :status', { status: 'NOT_CALLED' })
          .andWhere('c.attemptCount < :maxRetries', { maxRetries: camp.maxRetries })
          .orderBy('c.sequence', 'ASC')
          .limit(contactsToProcess)
          .getMany();

        for (const contact of items) {
          contact.callStatus = 'CALLING';
          contact.attemptCount = (contact.attemptCount || 0) + 1;
          contact.startedAt = new Date();
        }

        if (items.length > 0) {
          await transactionalEntityManager.save(items);
        }

        return items;
      });

      for (const contact of newContacts) {
        this.amiService.callWithTTS(contact.message, contact.phone, contact.id)
          .catch(err => {
            this.logger.error(`Error lanzando llamada a ${contact.id}: ${err.message}`);
            this.updateContactStatusById(
              contact.id,
              'FAILED',
              'ORIGINATE_ERROR',
              err.message,
              null,
              null,
              new Date(),
              true
            );
          });
        processedCount++;
      }

      const remainingSlots = freeSlots - processedCount;

      if (remainingSlots > 0) {
        const retryContacts = await this.contactRepo.manager.transaction(async transactionalEntityManager => {
          const items = await transactionalEntityManager
            .createQueryBuilder(Contact, 'c')
            .setLock('pessimistic_write')
            .setOnLocked('skip_locked')
            .where('c.campaignId = :campaignId', { campaignId: camp.id })
            .andWhere('c.callStatus = :status', { status: 'FAILED' })
            .andWhere('c.attemptCount < :maxRetries', { maxRetries: camp.maxRetries })
            .andWhere('c.finishedAt < :backoffTime', {
              backoffTime: new Date(Date.now() - this.RETRY_BACKOFF_MS)
            })
            .orderBy('c.finishedAt', 'ASC')
            .limit(Math.min(remainingSlots, this.MAX_CONTACTS_PER_BATCH - processedCount))
            .getMany();

          for (const contact of items) {
            contact.callStatus = 'CALLING';
            contact.attemptCount = (contact.attemptCount || 0) + 1;
            contact.startedAt = new Date();
          }

          if (items.length > 0) {
            await transactionalEntityManager.save(items);
          }

          return items;
        });

        for (const contact of retryContacts) {
          this.amiService.callWithTTS(contact.message, contact.phone, contact.id)
            .catch(err => {
              this.logger.error(`Error lanzando reintento a ${contact.id}: ${err.message}`);
              this.updateContactStatusById(
                contact.id,
                'FAILED',
                'ORIGINATE_ERROR',
                err.message,
                null,
                null,
                new Date(),
                true
              );
            });
        }
      }

      const currentlyCalling = await this.contactRepo.count({
        where: {
          campaign: { id: camp.id },
          callStatus: 'CALLING'
        }
      });

      const processable = await this.contactRepo.count({
        where: {
          campaign: { id: camp.id },
          attemptCount: LessThan(camp.maxRetries),
          callStatus: In(['NOT_CALLED', 'FAILED'])
        }
      });

      if (processable === 0 && currentlyCalling === 0) {
        this.logger.log(`Campaña ${camp.id} completada.`);
        camp.status = 'COMPLETED';
        await this.campaignRepo.save(camp);
        await this.channelLimitService.releaseChannels(camp.createdBy, camp.concurrentCalls);
      }

    } catch (error) {
      this.logger.error(`Error crítico procesando la campaña ${campaignId}: ${error.message}`, error.stack);
    } finally {
      this.processingCampaigns.delete(campaignId);
    }
  }

  async updateContactStatusById(
    contactId: string,
    status: string,
    causeNumber?: string,
    causeMsg?: string,
    startedAt?: Date | null,
    answeredAt?: Date | null,
    finishedAt?: Date | null,
    clearChannelId: boolean = false,
  ): Promise<void> {
    const contact = await this.contactRepo.findOne({
      where: { id: contactId },
      relations: ['campaign']
    });

    if (!contact) {
      return;
    }

    const campaign = contact.campaign;

    if (
      status === 'FAILED' &&
      causeNumber === '19' &&
      campaign.retryOnAnswer === true &&
      contact.attemptCount < campaign.maxRetries
    ) {
      this.logger.log(`[${contactId}] Reintento inmediato por 'No Contesto' programado con backoff.`);

      contact.attemptCount++;
      contact.callStatus = 'FAILED';
      contact.hangupCode = causeNumber;
      contact.hangupCause = causeMsg || null;
      contact.finishedAt = new Date();
      if (clearChannelId) {
        contact.activeChannelId = null;
      }
      await this.contactRepo.save(contact);

      setTimeout(() => {
        this.amiService.callWithTTS(contact.message, contact.phone, contact.id)
          .catch(err => {
            this.logger.error(`[${contact.id}] Falló reintento inmediato: ${err.message}`);
            this.contactRepo.update(contact.id, {
              callStatus: 'FAILED',
              hangupCause: 'Fallo reintento inmediato',
              activeChannelId: null
            });
          });
      }, this.RETRY_BACKOFF_MS);

      return;
    }

    contact.callStatus = status;
    contact.hangupCode = causeNumber || null;
    contact.hangupCause = causeMsg || null;
    if (startedAt) contact.startedAt = startedAt;
    if (answeredAt) contact.answeredAt = answeredAt;
    if (finishedAt) contact.finishedAt = finishedAt;

    if (clearChannelId) {
      contact.activeChannelId = null;
    }

    await this.contactRepo.save(contact);

    if (status === 'SUCCESS' || status === 'FAILED') {
      this.dashboardGateway.sendUpdate(
        {
          event: 'call-finished',
          campaignId: campaign.id,
          contactId: contact.id,
          status: status
        },
        campaign.createdBy
      );
    }

    if (['SUCCESS', 'FAILED'].includes(status) && contact.campaign.status === 'RUNNING') {
      setImmediate(() => {
        this.processCampaign(contact.campaign.id).catch((error) => {
          this.logger.error(`Error procesando campaña ${contact.campaign.id} después de finalizar contacto: ${error.message}`);
        });
      });
    }
  }

  async getCampaignById(campaignId: string) {
    return this.campaignRepo.findOne({
      where: { id: campaignId },
      relations: ['contacts'],
    });
  }

  async getAllCampaignsMinimal(userId: string, role: string, params: any) {
    const { page, limit, search, status } = params;
    const skip = (page - 1) * limit;

    const query = this.campaignRepo.createQueryBuilder('c')
      .select([
        'c.id',
        'c.name',
        'c.status',
        'c.startDate',
        'c.endDate',
        'c.concurrentCalls',
        'c.maxRetries',
        'c.createdBy'
      ]);

    if (role !== 'ADMIN' && role !== 'SUPERVISOR') {
      query.andWhere('c.createdBy = :userId', { userId });
    }

    if (search) {
      query.andWhere('c.name ILIKE :search', { search: `%${search}%` });
    }

    if (status && status !== 'ALL') {
      query.andWhere('c.status = :status', { status });
    }

    query
      .orderBy('c.startDate', 'DESC')
      .skip(skip)
      .take(limit);

    const [data, total] = await query.getManyAndCount();

    return {
      data,
      meta: {
        total,
        page,
        lastPage: Math.ceil(total / limit),
      }
    };
  }

  private buildRangeWhere(field: string, range: string) {
    if (range === 'day') return `${field} >= NOW() - INTERVAL '1 day'`;
    if (range === 'week') return `${field} >= NOW() - INTERVAL '7 days'`;
    return `${field} >= NOW() - INTERVAL '1 month'`;
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
      .where(dateRangeCondition)
      .andWhere("contact.callStatus IS NOT NULL AND contact.callStatus != 'CALLING'")
      .getCount();

    const success = await this.contactRepo
      .createQueryBuilder('contact')
      .innerJoin('contact.campaign', 'campaign')
      .where('contact.callStatus = :status', { status: 'SUCCESS' })
      .andWhere(dateRangeCondition)
      .getCount();

    return total === 0 ? 0 : (success / total) * 100;
  }

  async getTotalContacts(range = 'month'): Promise<number> {
    const dateRangeCondition = this.buildRangeWhere('campaign."startDate"', range);
    return this.contactRepo
      .createQueryBuilder('contact')
      .innerJoin('contact.campaign', 'campaign')
      .where(dateRangeCondition)
      .getCount();
  }

  async getMonthlyCallStats(range = 'month'): Promise<{ month: string; llamadas: number; exitosas: number }[]> {
    const dateRangeCondition = this.buildRangeWhere('c."startDate"', range);
    const rawResults = await this.contactRepo.query(`
      SELECT
        TO_CHAR(c."startDate", 'Mon YYYY') AS month,
        COUNT(contact.id) AS llamadas,
        COUNT(contact.id) FILTER (WHERE contact."callStatus" = 'SUCCESS') AS exitosas
      FROM contact
      INNER JOIN campaign c ON c.id = contact."campaignId"
      WHERE ${dateRangeCondition}
      GROUP BY month
      ORDER BY MIN(c."startDate")
    `);
    return rawResults.map(r => ({
      month: r.month,
      llamadas: parseInt(r.llamadas, 10),
      exitosas: parseInt(r.exitosas, 10)
    }));
  }

  async getCallStatusDistribution(range = 'month'): Promise<Record<string, number>> {
    const dateRangeCondition = this.buildRangeWhere('campaign."startDate"', range);
    const raw = await this.contactRepo
      .createQueryBuilder('contact')
      .innerJoin('contact.campaign', 'campaign')
      .select('COALESCE(contact.callStatus, \'UNKNOWN\')', 'callStatus')
      .addSelect('COUNT(*)', 'count')
      .where(dateRangeCondition)
      .andWhere("contact.callStatus IS NOT NULL OR contact.callStatus != 'CALLING'")
      .groupBy('COALESCE(contact.callStatus, \'UNKNOWN\')')
      .getRawMany();

    const result: Record<string, number> = {};
    raw.forEach((r) => {
      result[r.callStatus] = parseInt(r.count, 10);
    });
    return result;
  }

  async getLiveContacts(campaignId: string, status = 'ALL', limit = 50, offset = 0) {
    let statusFilter = '';
    const params: any[] = [campaignId, limit, offset];

    if (status !== 'ALL') {
      if (status === 'PENDING') {
        statusFilter = `AND (c."callStatus" IS NULL OR c."callStatus" NOT IN ('SUCCESS', 'FAILED', 'CALLING'))`;
      } else {
        statusFilter = `AND c."callStatus" = $4`;
        params.push(status);
      }
    }

    const rows = await this.contactRepo.query(
      `
      SELECT
        c.id, c.name, c.phone, c."callStatus", c."attemptCount",
        c."hangupCause", c."hangupCode"
      FROM contact c
      WHERE c."campaignId" = $1
        ${statusFilter}
      ORDER BY c.id DESC
      LIMIT $2 OFFSET $3
      `,
      params,
    );

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
    const params: any[] = [campaignId];

    if (status !== 'ALL') {
      if (status === 'PENDING') {
        statusFilter = `AND ("callStatus" IS NULL OR "callStatus" NOT IN ('SUCCESS', 'FAILED', 'CALLING'))`;
      } else {
        statusFilter = `AND "callStatus" = $2`;
        params.push(status);
      }
    }

    const [{ count }] = await this.contactRepo.query(
      `SELECT COUNT(*)::INT AS count
       FROM contact WHERE "campaignId" = $1 ${statusFilter}`,
      params,
    );
    return Math.max(1, Math.ceil(+count / limit));
  }

  // ✅ CORRECCIÓN: Se agregó relations: ['campaign'] para que contact.campaign.id
  //    esté disponible cuando se usa este método en callWithTTS (ami.service.ts).
  //    Sin esto, campaignId llegaba como '' a los flags y el post-call menu no se reproducía.
  async findContactById(contactId: string): Promise<Contact | null> {
    return this.contactRepo.findOne({
      where: { id: contactId },
      relations: ['campaign'],
    });
  }

  async updateContactChannelId(contactId: string, channelId: string): Promise<void> {
    await this.contactRepo.update({ id: contactId }, { activeChannelId: channelId });
  }

  async getCampaignContacts(campaignId: string) {
    return this.contactRepo
      .createQueryBuilder('c')
      .select([
        'c.id AS id',
        'c.name AS name',
        'c.phone AS phone',
        'c.identification AS identification',
        'c.callStatus AS status',
        'c.attemptCount AS retries',
        'c.message AS message'
      ])
      .where('c.campaignId = :campaignId', { campaignId })
      .orderBy('c.name', 'ASC')
      .limit(10000)
      .getRawMany();
  }
}