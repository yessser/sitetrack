import { IsUUID } from 'class-validator';

export class CreateInvitationDto {
  /** The registered user to invite. */
  @IsUUID()
  userId!: string;
}

export class ProjectInvitationDto {
  /** @example 17 */
  id!: number;
  inviteeId!: string;
  inviteeName!: string;
  inviteeEmail!: string;
  invitedById!: string;
  invitedByName!: string;
  /** @example "pending" */
  status!: 'pending' | 'accepted' | 'rejected' | 'withdrawn';
  createdAt!: Date;
}

export class MyInvitationDto {
  /** @example 17 */
  id!: number;
  /** @example "PRJ-0042" */
  projectCode!: string;
  /** @example "North tower" */
  projectName!: string;
  invitedById!: string;
  invitedByName!: string;
  /** Accept and Reject are only offered while pending. */
  status!: 'pending' | 'accepted' | 'rejected' | 'withdrawn';
  createdAt!: Date;
  /** When it was accepted, rejected or withdrawn. */
  answeredAt!: Date | null;
  /**
   * When the invitee first saw it, as it was before this request. Null means
   * new on this visit; listing marks the returned page as read.
   */
  readAt!: Date | null;
}

export class MyInvitationPageDto {
  items!: MyInvitationDto[];
  /** Total matching rows across all pages. */
  total!: number;
  limit!: number;
  offset!: number;
}

export class UnreadCountDto {
  /** Pending invitations the invitee has not seen yet. */
  count!: number;
}
