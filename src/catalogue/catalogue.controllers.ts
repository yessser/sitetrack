import { Body, Controller, Delete, Get, HttpCode, Param, ParseIntPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiCookieAuth, ApiTags } from '@nestjs/swagger';
import { type AuthUser, CurrentUser } from '../auth/current-user';
import { CATALOGUE_WRITERS, requireRole } from '../auth/roles';
import { CategoriesService } from './categories.service';
import {
  CategoryDto,
  CreateCategoryDto,
  CreateMaterialDto,
  CreateUnitDto,
  MaterialDto,
  MaterialListQueryDto,
  MaterialPageDto,
  UnitDto,
  UpdateCategoryDto,
  UpdateMaterialDto,
  UpdateUnitDto,
} from './dto/catalogue.dto';
import { MaterialsService } from './materials.service';
import { UnitsService } from './units.service';

// The catalogue is readable by everyone logged in; only store managers and
// SuperAdmins change it (403 for anyone else).

@ApiTags('catalogue')
@ApiCookieAuth()
@Controller('units')
export class UnitsController {
  constructor(private readonly units: UnitsService) {}

  @Get()
  list(): Promise<UnitDto[]> {
    return this.units.list();
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateUnitDto): Promise<UnitDto> {
    requireRole(user, ...CATALOGUE_WRITERS);
    return this.units.create(dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateUnitDto,
  ): Promise<UnitDto> {
    requireRole(user, ...CATALOGUE_WRITERS);
    return this.units.update(id, dto);
  }

  /** 409 while any material uses the unit. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number): Promise<void> {
    requireRole(user, ...CATALOGUE_WRITERS);
    await this.units.remove(id);
  }
}

@ApiTags('catalogue')
@ApiCookieAuth()
@Controller('categories')
export class CategoriesController {
  constructor(private readonly categories: CategoriesService) {}

  /** Every category as a flat list; nest them by parentId. */
  @Get()
  list(): Promise<CategoryDto[]> {
    return this.categories.list();
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateCategoryDto): Promise<CategoryDto> {
    requireRole(user, ...CATALOGUE_WRITERS);
    return this.categories.create(dto);
  }

  /** Rename and/or move. */
  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateCategoryDto,
  ): Promise<CategoryDto> {
    requireRole(user, ...CATALOGUE_WRITERS);
    return this.categories.update(id, dto);
  }

  /** 409 while it has subcategories or materials. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number): Promise<void> {
    requireRole(user, ...CATALOGUE_WRITERS);
    await this.categories.remove(id);
  }
}

@ApiTags('catalogue')
@ApiCookieAuth()
@Controller('materials')
export class MaterialsController {
  constructor(private readonly materials: MaterialsService) {}

  @Get()
  list(@Query() query: MaterialListQueryDto): Promise<MaterialPageDto> {
    return this.materials.list(query);
  }

  @Get(':id')
  get(@Param('id', ParseIntPipe) id: number): Promise<MaterialDto> {
    return this.materials.get(id);
  }

  @Post()
  create(@CurrentUser() user: AuthUser, @Body() dto: CreateMaterialDto): Promise<MaterialDto> {
    requireRole(user, ...CATALOGUE_WRITERS);
    return this.materials.create(dto);
  }

  @Patch(':id')
  update(
    @CurrentUser() user: AuthUser,
    @Param('id', ParseIntPipe) id: number,
    @Body() dto: UpdateMaterialDto,
  ): Promise<MaterialDto> {
    requireRole(user, ...CATALOGUE_WRITERS);
    return this.materials.update(id, dto);
  }

  /** Soft delete; the material disappears from the catalogue. */
  @Delete(':id')
  @HttpCode(204)
  async remove(@CurrentUser() user: AuthUser, @Param('id', ParseIntPipe) id: number): Promise<void> {
    requireRole(user, ...CATALOGUE_WRITERS);
    await this.materials.remove(id);
  }
}
