import { IsString, IsNotEmpty, IsInt, Min, Max, IsDateString, IsOptional, IsBoolean } from 'class-validator';

export class CreateCampaignDto {
  @IsString()
  @IsNotEmpty()
  name: string;

  @IsString()
  startDate: string; // Recibimos como string 'DD-MM-YYYY HH:mm:ss'

  @IsString()
  endDate: string; // Recibimos como string 'DD-MM-YYYY HH:mm:ss'

  @IsInt()
  @Min(0)
  maxRetries: number;

  @IsInt()
  @Min(1)
  concurrentCalls: number;

  @IsString()
  @IsOptional()
  message?: string;

  @IsBoolean()
  @IsOptional()
  retryOnAnswer?: boolean;
}