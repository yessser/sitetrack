import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { ListQueryDto } from '../../common/list';

// Units

export class CreateUnitDto {
  /** @example "bag" */
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name!: string;

  /** Unique, case-insensitive. @example "bag" */
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  symbol!: string;
}

export class UpdateUnitDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  name?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(20)
  symbol?: string;
}

export class UnitDto {
  id!: number;
  /** @example "cubic metre" */
  name!: string;
  /** @example "m³" */
  symbol!: string;
}

// Categories

export class CreateCategoryDto {
  /** Unique among its siblings, case-insensitive. @example "Cement" */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name!: string;

  /** Parent category; omit or null for a top-level category. */
  @ApiPropertyOptional({ type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  parentId?: number | null;
}

export class UpdateCategoryDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  name?: string;

  /** Move under another category; null moves it to the top level. Moving it inside its own subtree is rejected (409). */
  @ApiPropertyOptional({ type: 'integer', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  parentId?: number | null;
}

export class CategoryDto {
  id!: number;
  /** @example "Cement" */
  name!: string;
  /** Null for a top-level category. */
  parentId!: number | null;
}

// Materials

export class CreateMaterialDto {
  /** Not unique: variants such as 25 kg and 50 kg bags are separate materials. @example "Cement, OPC 50 kg bag" */
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name!: string;

  /** Any category, at any depth. */
  @IsInt()
  @Min(1)
  categoryId!: number;

  @IsInt()
  @Min(1)
  unitId!: number;
}

export class UpdateMaterialDto {
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsInt()
  @Min(1)
  categoryId?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  unitId?: number;
}

export const MATERIAL_SORTS = ['name'] as const;
export type MaterialSort = (typeof MATERIAL_SORTS)[number];

export class MaterialListQueryDto extends ListQueryDto {
  /** Only materials in this category or any of its subcategories. */
  @ApiPropertyOptional({ type: 'integer' })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  category?: number;

  @ApiPropertyOptional({ enum: MATERIAL_SORTS, default: 'name' })
  @IsOptional()
  @IsIn(MATERIAL_SORTS)
  sort: MaterialSort = 'name';
}

export class MaterialDto {
  id!: number;
  /** @example "Cement, OPC 50 kg bag" */
  name!: string;
  category!: CategoryDto;
  unit!: UnitDto;
  createdAt!: Date;
  updatedAt!: Date;
}

export class MaterialPageDto {
  items!: MaterialDto[];
  /** Total matching rows across all pages. */
  total!: number;
  limit!: number;
  offset!: number;
}
