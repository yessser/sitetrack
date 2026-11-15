import { desc, sql } from 'drizzle-orm';
import { index, integer, pgEnum, pgTable, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { projects } from './projects';
import { users } from './users';

export const invitationStatus = pgEnum('invitation_status', ['pending', 'accepted', 'rejected', 'withdrawn']);
export type InvitationStatus = (typeof invitationStatus.enumValues)[number];

// Invitations double as the notification feed: the Notifications screen is the
// invitations addressed to the current user.
export const invitations = pgTable(
  'invitations',
  {
    id: integer('id').primaryKey().generatedAlwaysAsIdentity(),
    projectId: integer('project_id')
      .notNull()
      .references(() => projects.id),
    inviteeId: uuid('invitee_id')
      .notNull()
      .references(() => users.id),
    invitedBy: uuid('invited_by')
      .notNull()
      .references(() => users.id),
    status: invitationStatus('status').notNull().default('pending'),
    // Set when the invitee first sees it in their list (or answers it).
    inviteeReadAt: timestamp('invitee_read_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    // When it left pending: accepted, rejected or withdrawn.
    answeredAt: timestamp('answered_at', { withTimezone: true }),
  },
  (t) => [
    // One pending invitation per person per project; also serves the Members screen.
    uniqueIndex('invitations_pending_unique')
      .on(t.projectId, t.inviteeId)
      .where(sql`${t.status} = 'pending'`),
    // My invitations, newest first, with a (created_at, id) cursor.
    index('invitations_invitee_feed_idx').on(t.inviteeId, desc(t.createdAt), desc(t.id)),
    // Unread count, polled by every page.
    index('invitations_invitee_unread_idx')
      .on(t.inviteeId)
      .where(sql`${t.status} = 'pending' and ${t.inviteeReadAt} is null`),
  ],
);

export type Invitation = typeof invitations.$inferSelect;
