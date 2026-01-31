import { IsString, IsInt, Min, Max, IsNotEmpty, IsBoolean, IsOptional } from 'class-validator';

export class DuplicateCampaignDto {
    @IsString()
    @IsNotEmpty()
    name: string;

    @IsString()
    @IsNotEmpty()
    startDate: string;

    @IsString()
    @IsNotEmpty()
    endDate: string;

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