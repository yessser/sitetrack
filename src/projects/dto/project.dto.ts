import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsDateString, IsInt, IsOptional, IsString, Max, MaxLength, Min, MinLength } from 'class-validator';

export class CreateProjectDto {
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsDateString({ strict: true })
  startDate!: string;

  @IsDateString({ strict: true })
  endDate!: string;
}

export class UpdateProjectDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  startDate?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  endDate?: string;
}

export class PageQueryDto {
  @ApiPropertyOptional({ type: 'integer', default: 50, minimum: 1, maximum: 200 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  limit = 50;

  @ApiPropertyOptional({ type: 'integer', default: 0, minimum: 0 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  offset = 0;
}

export class ProjectDto {
  /** @example "PRJ-0042" */
  code!: string;
  /** @example "North tower" */
  name!: string;
  /** @example "2026-03-01" */
  startDate!: string;
  /** @example "2026-12-15" */
  endDate!: string;
  /** Whether the caller is a project admin of this project. */
  isAdmin!: boolean;
  memberCount!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export class ProjectPageDto {
  items!: ProjectDto[];
  /** Total matching rows across all pages. */
  total!: number;
  limit!: number;
  offset!: number;
}

export class MemberDto {
  userId!: string;
  name!: string;
  email!: string;
  isAdmin!: boolean;
  /** When they became project admin; earlier = more senior. Null for regular members. */
  adminSince!: Date | null;
  joinedAt!: Date;
}
