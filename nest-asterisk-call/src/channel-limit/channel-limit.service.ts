import { BadRequestException, Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChannelLimit } from './channel-limit.entity';
import { SystemChannels } from './system-channels.entity';
import { Campaign } from '../campaign/campaign.entity';
import { User } from '../user/user.entity';

@Injectable()
export class ChannelLimitService {
  constructor(
    @InjectRepository(ChannelLimit)
    private readonly channelLimitRepo: Repository<ChannelLimit>,
    @InjectRepository(SystemChannels)
    private readonly systemRepo: Repository<SystemChannels>,
    @InjectRepository(Campaign)
    private readonly campaignRepo: Repository<Campaign>,
  ) { }

  /** Límite total del sistema */
  async getSystemTotal(): Promise<number> {
    const sys = await this.systemRepo.findOne({ where: {} });
    return sys?.totalChannels || 0;
  }

  /** Canales en uso por todas las campañas activas del usuario */
  async getUsedChannels(userId: string): Promise<number> {
    const entry = await this.channelLimitRepo.findOne({
      where: { user: { id: userId } }
    });
    return entry?.usedChannels || 0;
  }

  /** Límite de canales asignado al usuario */
  async getUserLimit(userId: string): Promise<number> {
    const limit = await this.channelLimitRepo.findOne({ where: { user: { id: userId } } });
    return limit?.maxChannels || 0;
  }

  /** Valida si se pueden asignar `requested` canales adicionales */
  async canAssignChannels(userId: string, requested: number): Promise<boolean> {
    const max = await this.getUserLimit(userId);
    const used = await this.getUsedChannels(userId);
    return used + requested <= max;
  }

  /** Reserva canales: ya se cuenta dinámicamente, no hace nada */
  async reserveChannels(userId: string, amount: number): Promise<void> {
    const entry = await this.channelLimitRepo.findOne({
      where: { user: { id: userId } }
    });
    if (!entry) {
      throw new BadRequestException('No tienes límite de canales asignado');
    }
    entry.usedChannels = (entry.usedChannels || 0) + amount;
    if (entry.usedChannels > entry.maxChannels) {
      throw new BadRequestException(
        `Intentas usar ${entry.usedChannels} de ${entry.maxChannels} canales`
      );
    }
    await this.channelLimitRepo.save(entry);
  }

  /** Libera canales: no hace nada con cálculo dinámico */
  async releaseChannels(userId: string, amount: number): Promise<void> {
    const entry = await this.channelLimitRepo.findOne({
      where: { user: { id: userId } }
    });
    if (!entry) return;
    entry.usedChannels = Math.max(0, (entry.usedChannels || 0) - amount);
    await this.channelLimitRepo.save(entry);
  }

  /** Asigna o actualiza el máximo de canales para un usuario */
async assignChannels(user: User, newMax: number): Promise<ChannelLimit> {
  const sys = await this.systemRepo.findOne({ where: {} });
  if (!sys) throw new Error('Debes configurar totalChannels primero');

  // Límite actual (puede no existir)
  let entry = await this.channelLimitRepo.findOne({
    where: { user: { id: user.id } },
  });

  // Canales ya asignados a *otros* usuarios
  const { sum } = await this.channelLimitRepo
    .createQueryBuilder('cl')
    .select('COALESCE(SUM(cl.maxChannels),0)', 'sum')
    .where('cl.userId != :uid', { uid: user.id })
    .getRawOne<{ sum: string }>();

  const assignedByOthers = Number(sum);
  const available        = sys.totalChannels - assignedByOthers; // libres reales

  // 👉 La comparación correcta
  if (newMax > available) {
    throw new BadRequestException(
      `Solo quedan ${available} canales libres de ${sys.totalChannels}.`
    );
  }

  // Crear o actualizar la fila
  if (!entry) {
    entry = this.channelLimitRepo.create({
      user,
      maxChannels: newMax,
      usedChannels: 0,
    });
  } else {
    // Si vas a bajar el tope, evita dejar usedChannels > newMax
    if (entry.usedChannels > newMax) {
      throw new BadRequestException(
        `El usuario está usando ${entry.usedChannels} canales; no puedes fijar el límite en ${newMax}.`
      );
    }
    entry.maxChannels = newMax;
  }

  return this.channelLimitRepo.save(entry);
}



  async getAllLimits(): Promise<ChannelLimit[]> {
    return this.channelLimitRepo.find({ relations: ['user'] });
  }
}
