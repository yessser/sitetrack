import { Module } from '@nestjs/common';
import { CategoriesController, MaterialsController, UnitsController } from './catalogue.controllers';
import { CategoriesService } from './categories.service';
import { MaterialsService } from './materials.service';
import { UnitsService } from './units.service';

@Module({
  controllers: [UnitsController, CategoriesController, MaterialsController],
  providers: [UnitsService, CategoriesService, MaterialsService],
  exports: [MaterialsService],
})
export class CatalogueModule {}
