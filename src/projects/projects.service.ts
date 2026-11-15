import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';
import type { AuthUser } from '../auth/current-user';
import { DB, type Db } from '../db/db.module';
import { projectMembers, projects } from '../db/schema';
import type { CreateProjectDto, PageQueryDto, UpdateProjectDto } from './dto/project.dto';
import type { ProjectAccess } from './project-access.service';

const memberCount = sql<number>`(select count(*)::int from ${projectMembers} where ${projectMembers.projectId} = ${projects.id})`;

const projectFields = {
  code: projects.code,
  name: projects.name,
  startDate: projects.startDate,
  endDate: projects.endDate,
  createdAt: projects.createdAt,
  updatedAt: projects.updatedAt,
};

@Injectable()
export class ProjectsService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async create(user: AuthUser, dto: CreateProjectDto) {
    this.assertDates(dto.startDate, dto.endDate);
    return this.db.transaction(async (tx) => {
      const [project] = await tx
        .insert(projects)
        .values({ name: dto.name, startDate: dto.startDate, endDate: dto.endDate, createdBy: user.userId })
        .returning({ id: projects.id, ...projectFields });
      await tx.insert(projectMembers).values({ projectId: project.id, userId: user.userId, adminSince: new Date() });
      const { id, ...rest } = project;
      return { ...rest, isAdmin: true, memberCount: 1 };
    });
  }

  async list(user: AuthUser, page: PageQueryDto) {
    const isSuperAdmin = user.role === 'super_admin';
    const myMembership = and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.userId));
    const where = isSuperAdmin
      ? isNull(projects.deletedAt)
      : and(isNull(projects.deletedAt), sql`${projectMembers.userId} is not null`);

    const base = this.db
      .select({
        ...projectFields,
        isAdmin: sql<boolean>`${projectMembers.adminSince} is not null`,
        memberCount,
        total: sql<number>`count(*) over ()::int`,
      })
      .from(projects)
      .leftJoin(projectMembers, myMembership)
      .where(where)
      .orderBy(asc(projects.id))
      .limit(page.limit)
      .offset(page.offset);

    const rows = await base;
    const total = rows[0]?.total ?? 0;
    return { items: rows.map(({ total: _, ...r }) => r), total, limit: page.limit, offset: page.offset };
  }

  async get(access: ProjectAccess) {
    const [project] = await this.db
      .select({ ...projectFields, memberCount })
      .from(projects)
      .where(eq(projects.id, access.projectId));
    return { ...project, isAdmin: access.isAdmin && access.isMember };
  }

  async update(access: ProjectAccess, dto: UpdateProjectDto) {
    const current = await this.get(access);
    this.assertDates(dto.startDate ?? current.startDate, dto.endDate ?? current.endDate);
    await this.db
      .update(projects)
      .set({ ...dto, updatedAt: new Date() })
      .where(eq(projects.id, access.projectId));
    return this.get(access);
  }

  async remove(access: ProjectAccess) {
    await this.db
      .update(projects)
      .set({ deletedAt: new Date() })
      .where(and(eq(projects.id, access.projectId), isNull(projects.deletedAt)));
  }

  private assertDates(start: string, end: string) {
    if (end < start) throw new BadRequestException('endDate must be on or after startDate');
  }
}
