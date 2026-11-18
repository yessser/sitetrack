import { applyDecorators } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { TASK_CHANGE_OPS, type TaskChangeOpValue } from '../task-batch';
import { IsOmittable, IsPlainDate, TASK_STATUSES, type TaskStatusValue, toBool } from './task.dto';

/** Most items one batch may hold, all lists together. */
export const MAX_BATCH_ITEMS = 5000;

// A task named in a batch: its ID, or the `ref` of a task created in the same batch.
const TaskRef = () => applyDecorators(IsString(), MinLength(1), MaxLength(64));

/** Task fields a batch can set (or expect). Omitted fields are left alone. */
export class TaskFieldsDto {
  /** @example "Pour level 2 slab" */
  @IsOmittable()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  /** @example "2026-03-01" */
  @IsOmittable()
  @IsPlainDate()
  startDate?: string;

  /** @example "2026-03-14" */
  @IsOmittable()
  @IsPlainDate()
  endDate?: string;

  /** Any move is allowed except back to not_started. */
  @ApiPropertyOptional({ enum: TASK_STATUSES })
  @IsOmittable()
  @IsIn(TASK_STATUSES)
  status?: TaskStatusValue;
}

export class BatchCreateDto {
  /**
   * The client's name for the new task, unique within the batch. Other items
   * of the batch can use it in place of an ID; the response maps it to the
   * real ID. Must not start with "PRJ-".
   * @example "draft-1"
   */
  @Matches(/^(?!PRJ-)[A-Za-z0-9_.:-]{1,64}$/, {
    message: 'ref must be 1-64 letters, digits or _ . : - and must not start with PRJ-',
  })
  ref!: string;

  /** @example "Pour level 2 slab" */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  /** @example "2026-03-01" */
  @IsPlainDate()
  startDate!: string;

  /** @example "2026-03-14" */
  @IsPlainDate()
  endDate!: string;
}

export class BatchUpdateDto {
  /** @example "PRJ-0042-T-0137" */
  @TaskRef()
  task!: string;

  @ValidateNested()
  @Type(() => TaskFieldsDto)
  set!: TaskFieldsDto;

  /**
   * The values the client last saw. A field that has since been changed by
   * someone else to something other than `set` makes the batch fail with a
   * conflict; without `expect`, the last write wins.
   */
  @IsOptional()
  @ValidateNested()
  @Type(() => TaskFieldsDto)
  expect?: TaskFieldsDto;
}

/** `task` waits on `dependsOn`. */
export class BatchLinkDto {
  /** @example "PRJ-0042-T-0137" */
  @TaskRef()
  task!: string;

  /** @example "PRJ-0042-T-0135" */
  @TaskRef()
  dependsOn!: string;
}

/**
 * Changes applied all together or not at all. Links are a set: adding a
 * link that exists, or removing one that doesn't, changes nothing.
 * Removing a task also drops every link to or from it.
 */
export class TaskBatchDto {
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BATCH_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BatchCreateDto)
  create?: BatchCreateDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BATCH_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BatchUpdateDto)
  update?: BatchUpdateDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BATCH_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BatchLinkDto)
  link?: BatchLinkDto[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BATCH_ITEMS)
  @ValidateNested({ each: true })
  @Type(() => BatchLinkDto)
  unlink?: BatchLinkDto[];

  /** @example ["PRJ-0042-T-0140"] */
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_BATCH_ITEMS)
  @IsString({ each: true })
  @MaxLength(64, { each: true })
  remove?: string[];
}

export class TaskBatchQueryDto {
  /** true: check the batch and show what it would do, without saving. */
  @ApiPropertyOptional({ type: 'boolean' })
  @IsOptional()
  @Transform(toBool)
  @IsBoolean()
  dryRun?: boolean;
}

export class TaskChangesQueryDto {
  /** The version the client is at: changes after it are returned. */
  @ApiProperty({ type: 'integer', minimum: 0 })
  @Type(() => Number)
  @IsInt()
  @Min(0)
  since!: number;
}

/** One entry of the project's task changelog. */
export class TaskChangeDto {
  /** The graph version the change produced; shared by every change of one batch. */
  version!: number;
  @ApiProperty({ enum: TASK_CHANGE_OPS })
  op!: TaskChangeOpValue;
  /** @example "PRJ-0042-T-0137" */
  task!: string;
  /** link / unlink only. @example "PRJ-0042-T-0135" */
  dependsOn?: string;
  /** create: every field. update: only the fields that changed, with their new values. */
  data?: TaskFieldsDto;
  /** update only: the values those fields had before. */
  prev?: TaskFieldsDto;
  /** User ID of who made the change. */
  by!: string;
  at!: Date;
}

export class TaskBatchResultDto {
  /** The project's graph version after the batch (unchanged by a dry run or a batch that changed nothing). */
  version!: number;
  /** ref of every created task -> its ID. @example {"draft-1": "PRJ-0042-T-0141"} */
  @ApiProperty({ type: 'object', additionalProperties: { type: 'string' } })
  refs!: Record<string, string>;
  /** What the batch changed, as written to the changelog. Items that changed nothing are left out. */
  changes!: TaskChangeDto[];
}

export class TaskChangesPageDto {
  /** Pass this as `since` next time. */
  version!: number;
  /** More changes are waiting: ask again right away with the new version. */
  hasMore!: boolean;
  changes!: TaskChangeDto[];
}

/** One problem with a rejected batch. Every problem is reported at once. */
export class TaskBatchErrorDto {
  /** The item at fault. @example "update[2]" */
  at!: string;
  /** The task as the item named it. */
  task?: string;
  /** @example "cycle" */
  code!: string;
  message!: string;
}

export class TaskSnapshotTaskDto {
  /** @example "PRJ-0042-T-0137" */
  code!: string;
  name!: string;
  startDate!: string;
  endDate!: string;
  @ApiProperty({ enum: TASK_STATUSES })
  status!: TaskStatusValue;
  isLate!: boolean;
  isBlocked!: boolean;
  updatedAt!: Date;
}

export class TaskSnapshotLinkDto {
  /** @example "PRJ-0042-T-0137" */
  task!: string;
  /** @example "PRJ-0042-T-0135" */
  dependsOn!: string;
}

/** Every live task and link of the project, as of `version`. */
export class TaskSnapshotDto {
  /** Poll GET changes?since=<version> to stay up to date. */
  version!: number;
  tasks!: TaskSnapshotTaskDto[];
  links!: TaskSnapshotLinkDto[];
}
