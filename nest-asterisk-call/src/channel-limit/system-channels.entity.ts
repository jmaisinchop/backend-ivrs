import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

@Entity()
export class SystemChannels {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column()
  totalChannels: number;
}
