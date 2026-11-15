import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import type { AuthUser } from '../auth/current-user';
import { DB, type Db } from '../db/db.module';
import { projectMembers, projects } from '../db/schema';

export interface ProjectAccess {
  projectId: number;
  code: string;
  isMember: boolean;
  isAdmin: boolean;
}

/**
 * The single gate every project-scoped route goes through.
 * Non-members get the same 404 as a project that does not exist, so a
 * guessed code never confirms anything. SuperAdmins pass everywhere and
 * act with project-admin rights.
 */
@Injectable()
export class ProjectAccessService {
  constructor(@Inject(DB) private readonly db: Db) {}

  async resolve(user: AuthUser, code: string, opts: { admin?: boolean } = {}): Promise<ProjectAccess> {
    const [row] = await this.db
      .select({
        projectId: projects.id,
        code: projects.code,
        memberId: projectMembers.userId,
        adminSince: projectMembers.adminSince,
      })
      .from(projects)
      .leftJoin(projectMembers, and(eq(projectMembers.projectId, projects.id), eq(projectMembers.userId, user.userId)))
      .where(and(eq(projects.code, code), isNull(projects.deletedAt)));

    const isSuperAdmin = user.role === 'super_admin';
    const isMember = row?.memberId != null;
    if (!row || (!isMember && !isSuperAdmin)) throw new NotFoundException('Project not found');

    const isAdmin = row.adminSince != null || isSuperAdmin;
    if (opts.admin && !isAdmin) throw new ForbiddenException('Only project admins can do this');

    return { projectId: row.projectId, code: row.code, isMember, isAdmin };
  }
}
