import { IsString, IsOptional, IsEmail, MinLength, IsEnum, IsBoolean } from 'class-validator';
import { UserRole } from '../user.entity';

export class UpdateUserDto {
  @IsString()
  @IsOptional()
  firstName?: string;

  @IsString()
  @IsOptional()
  lastName?: string;

  @IsEmail()
  @IsOptional()
  email?: string;

  @IsEnum(UserRole)
  @IsOptional()
  role?: UserRole;

  @IsBoolean()
  @IsOptional()
  canAccessIvrs?: boolean;

  @IsBoolean()
  @IsOptional()
  canAccessWhatsapp?: boolean;
  
  @IsString()
  @IsOptional()
  extension?: string;
}