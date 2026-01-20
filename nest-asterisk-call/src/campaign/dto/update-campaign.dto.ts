import { IsString, IsOptional, IsInt, Min, Max, IsBoolean } from 'class-validator'; 

export class UpdateCampaignDto {
    @IsOptional()
    @IsString()
    name?: string;

    @IsOptional()
    @IsString() 
    startDate?: string;

    @IsOptional()
    @IsString()
    endDate?: string;

    @IsOptional()
    @IsInt()
    @Min(0)
    maxRetries?: number;

    @IsOptional()
    @IsInt()
    @Min(1)
    concurrentCalls?: number;

    @IsBoolean()
    @IsOptional()
    retryOnAnswer?: boolean;
}