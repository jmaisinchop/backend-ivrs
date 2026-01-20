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
    const max = await this.getUserLimit(userId);
    const used = await this.getUsedChannels(userId);
    return used + requested <= max;
  }

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

  async releaseChannels(userId: string, amount: number): Promise<void> {
    const entry = await this.channelLimitRepo.findOne({
      where: { user: { id: userId } }
    });
    if (!entry) return;
    entry.usedChannels = Math.max(0, (entry.usedChannels || 0) - amount);
    await this.channelLimitRepo.save(entry);
  }

async assignChannels(user: User, newMax: number): Promise<ChannelLimit> {
  const sys = await this.systemRepo.findOne({ where: {} });
  if (!sys) throw new Error('Debes configurar totalChannels primero');

  let entry = await this.channelLimitRepo.findOne({
    where: { user: { id: user.id } },
  });

  const { sum } = await this.channelLimitRepo
    .createQueryBuilder('cl')
    .select('COALESCE(SUM(cl.maxChannels),0)', 'sum')
    .where('cl.userId != :uid', { uid: user.id })
    .getRawOne<{ sum: string }>();

  const assignedByOthers = Number(sum);
  const available        = sys.totalChannels - assignedByOthers;

  if (newMax > available) {
    throw new BadRequestException(
      `Solo quedan ${available} canales libres de ${sys.totalChannels}.`
    );
  }

  if (!entry) {
    entry = this.channelLimitRepo.create({
      user,
      maxChannels: newMax,
      usedChannels: 0,
    });
  } else {
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
