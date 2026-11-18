import { Module } from '@nestjs/common';
import { ProjectsModule } from '../projects/projects.module';
import { TaskChangesController } from './task-changes.controller';
import { TaskChangesService, TaskChangesTrimmer } from './task-changes.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

@Module({
  imports: [ProjectsModule],
  controllers: [TaskChangesController, TasksController],
  providers: [TasksService, TaskChangesService, TaskChangesTrimmer],
})
export class TasksModule {}
