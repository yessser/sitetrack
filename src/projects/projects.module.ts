import { Module } from '@nestjs/common';
import { MembersService } from './members.service';
import { ProjectAccessService } from './project-access.service';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';

@Module({
  controllers: [ProjectsController],
  providers: [ProjectAccessService, ProjectsService, MembersService],
  exports: [ProjectAccessService],
})
export class ProjectsModule {}
