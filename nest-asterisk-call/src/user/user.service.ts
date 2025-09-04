import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { User } from './user.entity';
import * as bcrypt from 'bcrypt';
import { UpdateUserDto } from './dto/update-user.dto';

@Injectable()
export class UserService {
    constructor(
        @InjectRepository(User)
        private readonly userRepo: Repository<User>,
    ) { }

    /**
     * Busca un usuario por su nombre de usuario.
     * Pide explícitamente la contraseña, que está oculta por defecto en la entidad.
     */
    async findByUsername(username: string): Promise<User | undefined> {
        return this.userRepo.createQueryBuilder('user')
          .addSelect('user.password')
          .where('user.username = :username', { username })
          .getOne();
    }

    /**
     * Busca un usuario por su ID.
     */
    async findById(id: string): Promise<User | undefined> {
        return this.userRepo.findOne({ where: { id } });
    }

    /**
     * Crea un nuevo usuario.
     * Cifra la contraseña antes de guardarla.
     */
    async create(userDto: Partial<User>): Promise<User> {
        const salt = await bcrypt.genSalt(10);
        const passwordHash = await bcrypt.hash(userDto.password, salt);
        const newUser = this.userRepo.create({ ...userDto, password: passwordHash });
        return this.userRepo.save(newUser);
    }

    /**
     * Obtiene todos los usuarios.
     * Devuelve todos los campos excepto la contraseña (oculta en la entidad).
     */
    async getAll(): Promise<User[]> {
        return this.userRepo.find();
    }

    /**
     * Actualiza el token de sesión activa de un usuario.
     */
    async updateCurrentToken(userId: string, token: string | null): Promise<void> {
        await this.userRepo.update({ id: userId }, { currentToken: token });
    }

    /**
     * Actualiza la contraseña de un usuario.
     */
    async updatePassword(userId: string, newPassword: string): Promise<{ message: string }> {
        const user = await this.findById(userId);
        if (!user) {
            throw new NotFoundException('Usuario no encontrado');
        }

        const salt = await bcrypt.genSalt(10);
        user.password = await bcrypt.hash(newPassword, salt);

        await this.userRepo.save(user);

        return { message: 'Contraseña actualizada correctamente' };
    }

    /**
     * Actualiza los datos de un usuario (nombre, rol, permisos, etc.).
     */
    async update(id: string, updateUserDto: Partial<UpdateUserDto>): Promise<User> {
        const user = await this.findById(id);
        if (!user) {
            throw new NotFoundException(`Usuario con ID ${id} no encontrado.`);
        }
        
        // Aplica los cambios del DTO a la entidad encontrada
        Object.assign(user, updateUserDto);
        
        const updatedUser = await this.userRepo.save(user);
        // La contraseña no se devuelve porque está oculta en la entidad
        return updatedUser;
    }
}