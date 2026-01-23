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
    const entry = await this.channelLimitRepo.findOne({ where: { user: { id: userId } } });
    if (!entry) return false;
    return (entry.usedChannels + requested) <= entry.maxChannels;
  }

  /**
   * Reserva canales de forma ATÓMICA.
   * Realiza la suma directamente en la base de datos con una condición WHERE para asegurar
   * que no se exceda el límite en condiciones de alta concurrencia.
   */
  async reserveChannels(userId: string, amount: number): Promise<void> {
    // Intentamos actualizar directamente solo si el nuevo valor no excede el máximo
    const result = await this.channelLimitRepo
      .createQueryBuilder()
      .update(ChannelLimit)
      .set({
        usedChannels: () => `"usedChannels" + ${amount}`
      })
      .where('"userId" = :userId', { userId })
      .andWhere('("usedChannels" + :amount) <= "maxChannels"', { amount })
      .execute();

    if (result.affected === 0) {
      // Si no se actualizó ninguna fila, es porque no existe el usuario o se excedería el límite
      const limit = await this.getUserLimit(userId);
      const used = await this.getUsedChannels(userId);
      this.logger.warn(`Fallo al reservar ${amount} canales para ${userId}. Usados: ${used}, Max: ${limit}`);
      
      throw new BadRequestException(
        `No hay suficientes canales disponibles. (Max: ${limit}, Usados: ${used}, Solicitados: ${amount})`
      );
    }
  }

  /**
   * Libera canales de forma segura, evitando números negativos.
   */
  async releaseChannels(userId: string, amount: number): Promise<void> {
    await this.channelLimitRepo
      .createQueryBuilder()
      .update(ChannelLimit)
      .set({
        usedChannels: () => `GREATEST("usedChannels" - ${amount}, 0)` // Evita negativos
      })
      .where('"userId" = :userId', { userId })
      .execute();
  }

  async assignChannels(user: User, newMax: number): Promise<ChannelLimit> {
    const sys = await this.systemRepo.findOne({ where: {} });
    if (!sys) throw new Error('Debes configurar totalChannels primero en el sistema.');

    let entry = await this.channelLimitRepo.findOne({
      where: { user: { id: user.id } },
    });

    const { sum } = await this.channelLimitRepo
      .createQueryBuilder('cl')
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
      entry = this.channelLimitRepo.create({
        user,
        maxChannels: newMax,
        usedChannels: 0,
      });
    } else {
      // Permitimos cambiar el límite aunque esté en uso, pero advertimos si queda "overbooked"
      if (entry.usedChannels > newMax) {
        this.logger.warn(`Usuario ${user.id} tiene en uso ${entry.usedChannels}, pero su nuevo límite es ${newMax}. Se ajustará eventualmente.`);
      }
      entry.maxChannels = newMax;
    }

    return this.channelLimitRepo.save(entry);
  }

  async getAllLimits(): Promise<ChannelLimit[]> {
    return this.channelLimitRepo.find({ relations: ['user'] });
  }
}