import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsBoolean,
  IsDateString,
  IsIn,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PageQueryDto } from '../../projects/dto/project.dto';

export const TASK_STATUSES = ['not_started', 'in_progress', 'done'] as const;
export type TaskStatusValue = (typeof TASK_STATUSES)[number];

export const TASK_ACTIONS = ['start', 'done', 'reopen'] as const;
export type TaskAction = (typeof TASK_ACTIONS)[number];

export const TASK_SORTS = ['code', 'name', 'startDate', 'endDate', 'dependents'] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

/**
 * A calendar date, YYYY-MM-DD. IsDateString alone also lets a full datetime
 * through, which would then compare wrongly against plain dates.
 */
export const IsPlainDate = () =>
  applyDecorators(
    Matches(/^\d{4}-\d{2}-\d{2}$/, { message: ({ property }) => `${property} must be a date (YYYY-MM-DD)` }),
    IsDateString({ strict: true }),
  );

/**
 * Optional, but not nullable: IsOptional skips the rules for null too, which
 * would let `{"name": null}` reach a NOT NULL column.
 */
export const IsOmittable = () => ValidateIf((_, value) => value !== undefined);

export class CreateTaskDto {
  /** @example "Pour level 2 slab" */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  @IsPlainDate()
  startDate!: string;

  @IsPlainDate()
  endDate!: string;

  /**
   * IDs of tasks in the same project this task waits on.
   * @example ["PRJ-0042-T-0135", "PRJ-0042-T-0136"]
   */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ArrayUnique()
  @IsString({ each: true })
  dependsOn?: string[];
}

export class AddDependencyDto {
  /**
   * ID of a task in the same project that this task will wait on.
   * @example "PRJ-0042-T-0135"
   */
  @IsString()
  dependsOn!: string;
}

// Status is not editable here: it only moves through the action endpoints.
export class UpdateTaskDto {
  @IsOmittable()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOmittable()
  @IsPlainDate()
  startDate?: string;

  @IsOmittable()
  @IsPlainDate()
  endDate?: string;
}

export function toBool({ value }: { value: unknown }) {
  return value === 'true' ? true : value === 'false' ? false : value;
}

export class TaskListQueryDto extends PageQueryDto {
  @ApiPropertyOptional({ enum: TASK_STATUSES })
  @IsOptional()
  @IsIn(TASK_STATUSES)
  status?: TaskStatusValue;

  /** true: only late tasks, false: only tasks that are not late. */
  @ApiPropertyOptional({ type: 'boolean' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  late?: boolean;

  /** true: only blocked tasks, false: only tasks that are not blocked. */
  @ApiPropertyOptional({ type: 'boolean' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  blocked?: boolean;

  /** Planned date range: keeps tasks whose planned dates overlap [from, to]. */
  @IsOptional()
  @IsDateString({ strict: true })
  from?: string;

  @IsOptional()
  @IsDateString({ strict: true })
  to?: string;

  /** Case-insensitive match on the name or the task ID. */
  @IsOptional()
  @IsString()
  @MaxLength(200)
  q?: string;

  @ApiPropertyOptional({ enum: TASK_SORTS, default: 'code' })
  @IsOptional()
  @IsIn(TASK_SORTS)
  sort: TaskSort = 'code';

  @ApiPropertyOptional({ enum: ['asc', 'desc'], default: 'asc' })
  @IsOptional()
  @IsIn(['asc', 'desc'])
  order: 'asc' | 'desc' = 'asc';
}

export class TaskDto {
  /** @example "PRJ-0042-T-0137" */
  code!: string;
  /** @example "Pour level 2 slab" */
  name!: string;
  /** @example "2026-03-01" */
  startDate!: string;
  /** @example "2026-03-14" */
  endDate!: string;
  @ApiProperty({ enum: TASK_STATUSES })
  status!: TaskStatusValue;
  /**
   * Derived, never set by hand: not done and the planned end date has passed,
   * or not started and the planned start date has passed (server date).
   */
  isLate!: boolean;
  /**
   * Derived, never set by hand: not done, and at least one task it waits on,
   * directly or indirectly, is not done.
   */
  isBlocked!: boolean;
  /**
   * IDs of the tasks it directly depends on, in ID order.
   * @example ["PRJ-0042-T-0135"]
   */
  dependsOn!: string[];
  /** How many tasks directly depend on it. */
  dependentsCount!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

/** A task reached by following dependencies from another task. */
export class TaskLinkDto {
  /** @example "PRJ-0042-T-0135" */
  code!: string;
  /** @example "Rebar level 2" */
  name!: string;
  @ApiProperty({ enum: TASK_STATUSES })
  status!: TaskStatusValue;
  /** Fewest dependency steps between the two tasks; 1 means a direct link. */
  steps!: number;
}

export class TaskDetailDto extends TaskDto {
  /** The status actions allowed right now. */
  @ApiProperty({ enum: TASK_ACTIONS, isArray: true })
  allowedActions!: TaskAction[];
  /** Every task it waits on, directly or indirectly, nearest first. */
  waitsOn!: TaskLinkDto[];
  /** Every task that waits on it, directly or indirectly, nearest first. */
  waitedBy!: TaskLinkDto[];
}

export class TaskPageDto {
  items!: TaskDto[];
  /** Total matching rows across all pages. */
  total!: number;
  limit!: number;
  offset!: number;
}
