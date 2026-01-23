import { BadRequestException, Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelLimit } from './channel-limit.entity';
import { SystemChannels } from './system-channels.entity';
import { Campaign } from '../campaign/campaign.entity';
import { User } from '../user/user.entity';

@Injectable()
export class ChannelLimitService {
  private readonly logger = new Logger(ChannelLimitService.name);

  constructor(
    @InjectRepository(ChannelLimit)
    private readonly channelLimitRepo: Repository<ChannelLimit>,
    @InjectRepository(SystemChannels)
    private readonly systemRepo: Repository<SystemChannels>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
  ) { }

  async getSystemTotal(): Promise<number> {
    const sys = await this.systemRepo.findOne({ where: {} });
    return sys?.totalChannels || 0;
  }

  async getUsedChannels(userId: string): Promise<number> {
    const entry = await this.channelLimitRepo.findOne({
      where: { user: { id: userId } }
    });
    return entry?.usedChannels || 0;
  }

  async getUserLimit(userId: string): Promise<number> {
    const limit = await this.channelLimitRepo.findOne({ where: { user: { id: userId } } });
    return limit?.maxChannels || 0;
  }

  async canAssignChannels(userId: string, requested: number): Promise<boolean> {
    return await this.channelLimitRepo.manager.transaction(async (manager) => {
      const entry = await manager
        .createQueryBuilder(ChannelLimit, 'cl')
        .setLock('pessimistic_write')
        .where('cl.userId = :userId', { userId })
        .getOne();

      if (!entry) return false;
      return (entry.usedChannels + requested) <= entry.maxChannels;
    });
  }

  async reserveChannels(userId: string, amount: number): Promise<void> {
    await this.channelLimitRepo.manager.transaction(async (manager) => {
      const entry = await manager
        .createQueryBuilder(ChannelLimit, 'cl')
        .setLock('pessimistic_write')
        .where('cl.userId = :userId', { userId })
        .getOne();

      if (!entry) {
        throw new BadRequestException('No se encontró configuración de límite de canales para este usuario.');
      }

      const newUsed = entry.usedChannels + amount;
      if (newUsed > entry.maxChannels) {
        const available = entry.maxChannels - entry.usedChannels;
        throw new BadRequestException(
          `No hay suficientes canales disponibles. Disponibles: ${available}, Solicitados: ${amount}`
        );
      }

      entry.usedChannels = newUsed;
      await manager.save(entry);
      
      this.logger.log(`Reservados ${amount} canales para usuario ${userId}. Ahora usa ${newUsed}/${entry.maxChannels}`);
    });
  }

  async releaseChannels(userId: string, amount: number): Promise<void> {
    await this.channelLimitRepo.manager.transaction(async (manager) => {
      const entry = await manager
        .createQueryBuilder(ChannelLimit, 'cl')
        .setLock('pessimistic_write')
        .where('cl.userId = :userId', { userId })
        .getOne();

      if (!entry) {
        this.logger.warn(`Intento de liberar canales para usuario inexistente: ${userId}`);
        return;
      }

      entry.usedChannels = Math.max(0, entry.usedChannels - amount);
      await manager.save(entry);
      
      this.logger.log(`Liberados ${amount} canales para usuario ${userId}. Ahora usa ${entry.usedChannels}/${entry.maxChannels}`);
    });
  }

  async assignChannels(user: User, newMax: number): Promise<ChannelLimit> {
    return await this.channelLimitRepo.manager.transaction(async (manager) => {
      const sys = await manager.findOne(SystemChannels, { where: {} });
      if (!sys) {
        throw new BadRequestException('Debes configurar totalChannels primero en el sistema.');
      }

      const entry = await manager
        .createQueryBuilder(ChannelLimit, 'cl')
        .setLock('pessimistic_write')
        .where('cl.userId = :userId', { userId: user.id })
        .getOne();

      const { sum } = await manager
        .createQueryBuilder(ChannelLimit, 'cl')
        .select('COALESCE(SUM(cl.maxChannels),0)', 'sum')
        .where('cl.userId != :uid', { uid: user.id })
        .getRawOne<{ sum: string }>();

      const assignedByOthers = Number(sum);
      const available = sys.totalChannels - assignedByOthers;

      if (newMax > available) {
        throw new BadRequestException(
          `Solo quedan ${available} canales libres de ${sys.totalChannels} en el sistema global.`
        );
      }

      if (!entry) {
        const newEntry = manager.create(ChannelLimit, {
          user,
          maxChannels: newMax,
          usedChannels: 0,
        });
        return manager.save(newEntry);
      } else {
        if (entry.usedChannels > newMax) {
          this.logger.warn(
            `Usuario ${user.id} tiene en uso ${entry.usedChannels}, pero su nuevo límite es ${newMax}. ` +
            `Se requiere ajuste manual.`
          );
        }
        entry.maxChannels = newMax;
        return manager.save(entry);
      }
    });
  }

  async getAllLimits(): Promise<ChannelLimit[]> {
    return this.channelLimitRepo.find({ relations: ['user'] });
  }

  async forceRecalculateUsedChannels(userId: string): Promise<void> {
    await this.channelLimitRepo.manager.transaction(async (manager) => {
      const entry = await manager
        .createQueryBuilder(ChannelLimit, 'cl')
        .setLock('pessimistic_write')
        .where('cl.userId = :userId', { userId })
        .getOne();

      if (!entry) {
        this.logger.warn(`No se encontró configuración para usuario ${userId}`);
        return;
      }

      const { sum } = await manager
        .createQueryBuilder(Campaign, 'c')
        .select('COALESCE(SUM(c.concurrentCalls), 0)', 'sum')
        .where('c.createdBy = :userId', { userId })
        .andWhere('c.status IN (:...statuses)', { statuses: ['RUNNING', 'PAUSED', 'SCHEDULED'] })
        .getRawOne();

      const actualUsed = Number(sum || 0);
      
      if (entry.usedChannels !== actualUsed) {
        this.logger.warn(
          `Inconsistencia detectada para usuario ${userId}: ` +
          `DB reporta ${entry.usedChannels}, real es ${actualUsed}. Corrigiendo...`
        );
        entry.usedChannels = actualUsed;
        await manager.save(entry);
      }
    });
  }
}