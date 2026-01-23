import { Entity, PrimaryGeneratedColumn, Column } from 'typeorm';

export enum UserRole {
    ADMIN = 'ADMIN',
    SUPERVISOR = 'SUPERVISOR',
    CALLCENTER = 'CALLCENTER',
}

@Entity()
export class User {
    @PrimaryGeneratedColumn('uuid')
    id: string;

    @Column()
    firstName: string;

    @Column()
    lastName: string;

    @Column({ unique: true })
    email: string;

    @Column({ unique: true })
    username: string;

    @Column({ select: false })
    password: string;

    @Column({ type: 'enum', enum: UserRole, default: UserRole.CALLCENTER })
    role: UserRole;

    @Column({ nullable: true })
    currentToken: string;

    @Column({ default: true, comment: 'Permite el acceso al módulo de IVRS y campañas' })
    canAccessIvrs: boolean;


    @Column({ nullable: true, comment: 'Número de extensión o teléfono del supervisor' })
    extension: string;
}
