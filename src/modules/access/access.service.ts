import { Injectable } from '@nestjs/common';
import type { GrantResourceType, RoleGrant } from '@prisma/client';
import { AuditService } from '../../common/audit/audit.service';
import { ApiError, ErrorCode } from '../../common/errors';
import { isKnownPermission, PERMISSION_CATALOG } from '../../common/permissions/permissions';
import { PolicyService, type PolicyTarget } from '../../common/permissions/policy.service';
import { Clock } from '../../common/time/clock';
import type { Tx } from '../../common/transactions/tx';
import { PrismaService } from '../../infrastructure/prisma/prisma.service';

export interface CreateGrantInput {
  granteeId: string;
  resourceType: GrantResourceType;
  resourceId: string | null;
  permission: string;
  canPassOn?: boolean;
  furtherDelegation?: boolean;
  expiresAt?: Date | null;
}

const TOURNAMENT_ASSISTANT_LIMIT = 2;

/**
 * RoleGrant lifecycle: create (root or delegated), revoke (cascading), list.
 *
 * Delegation rules (DOC Decisions §45.6, Handoff §15):
 *  - the delegator must hold a *valid* source grant with `canPassOn`;
 *  - permission must be delegable and identical to the source;
 *  - scope may not widen (same resource, or an event of the source's club);
 *  - expiry may not outlive the source (a non-expiring child of an expiring source is refused);
 *  - a delegate only receives `canPassOn` if the source allows `furtherDelegation`;
 *  - no cycles (grantee cannot already be an ancestor in the chain), no self-grant.
 * Revoking a grant revokes every descendant in the same transaction; grants obtained
 * independently (different `sourceGrantId`) survive.
 */
@Injectable()
export class AccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly policy: PolicyService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** Server-owned catalogue for clients; listing it does not grant a permission. */
  catalog(resourceType?: GrantResourceType) {
    return Object.entries(PERMISSION_CATALOG)
      .filter(([, definition]) => !resourceType || definition.resources.includes(resourceType))
      .map(([permission, definition]) => ({
        permission,
        resources: [...definition.resources],
        delegable: definition.delegable,
      }));
  }

  private target(type: GrantResourceType, id: string | null): PolicyTarget {
    if (type === 'PLATFORM') return { type: 'PLATFORM' };
    if (!id)
      throw new ApiError(ErrorCode.VALIDATION, 'resourceId is required', { field: 'resourceId' });
    return { type, id } as PolicyTarget;
  }

  async create(actorId: string, input: CreateGrantInput, requestId?: string): Promise<RoleGrant> {
    if (!isKnownPermission(input.permission)) {
      throw new ApiError(ErrorCode.VALIDATION, 'Unknown permission', { field: 'permission' });
    }
    const def = PERMISSION_CATALOG[input.permission];
    if (!def.resources.includes(input.resourceType)) {
      throw new ApiError(ErrorCode.VALIDATION, 'Permission does not apply to this resource type', {
        field: 'resourceType',
      });
    }
    if (input.granteeId === actorId) {
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You cannot grant permissions to yourself');
    }
    const resourceId = input.resourceType === 'PLATFORM' ? null : input.resourceId;
    const target = this.target(input.resourceType, resourceId);
    const now = this.clock.now();
    if (input.expiresAt && input.expiresAt <= now) {
      throw new ApiError(ErrorCode.VALIDATION, 'expiresAt must be in the future', {
        field: 'expiresAt',
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const grantee = await tx.user.findUnique({
        where: { id: input.granteeId },
        select: { status: true },
      });
      if (!grantee || grantee.status !== 'ACTIVE') {
        throw new ApiError(ErrorCode.NOT_FOUND, 'Grantee not found');
      }

      const structural = await this.hasRootAuthority(actorId, target, input.permission, tx);
      let sourceGrantId: string | null = null;
      let canPassOn: boolean;
      let furtherDelegation: boolean;
      let expiresAt = input.expiresAt ?? null;

      if (structural) {
        canPassOn = def.delegable && !!input.canPassOn;
        furtherDelegation = canPassOn && !!input.furtherDelegation;
        if (input.resourceType === 'TOURNAMENT') {
          await this.assertAssistantLimit(tx, resourceId as string, input.granteeId, now);
        }
      } else {
        // Delegation path
        if (!def.delegable) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'This permission cannot be passed on');
        }
        const source = await this.findDelegationSource(tx, actorId, input);
        if (!source) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'You cannot pass on this permission');
        }
        // expiry: child may not outlive the source
        if (source.expiresAt) {
          if (!expiresAt || expiresAt > source.expiresAt) expiresAt = source.expiresAt;
        }
        if (await this.isAncestorGrantee(tx, source.id, input.granteeId)) {
          throw new ApiError(ErrorCode.ACCESS_DENIED, 'Delegation would create a cycle');
        }
        sourceGrantId = source.id;
        canPassOn = !!input.canPassOn && source.furtherDelegation;
        furtherDelegation = canPassOn && !!input.furtherDelegation && source.furtherDelegation;
      }

      const grant = await tx.roleGrant.create({
        data: {
          granteeId: input.granteeId,
          resourceType: input.resourceType,
          resourceId,
          permission: input.permission,
          canPassOn,
          furtherDelegation,
          grantedById: actorId,
          sourceGrantId,
          expiresAt,
        },
      });
      await this.audit.record(tx, {
        actorId,
        action: 'grant.create',
        targetType: 'RoleGrant',
        targetId: grant.id,
        requestId,
        metadata: {
          granteeId: grant.granteeId,
          resourceType: grant.resourceType,
          resourceId: grant.resourceId,
          permission: grant.permission,
          canPassOn: grant.canPassOn,
          delegated: sourceGrantId !== null,
          expiresAt: grant.expiresAt,
        },
      });
      return grant;
    });
  }

  /** Revoke a grant and everything delegated from it (same transaction). */
  async revoke(
    actorId: string,
    grantId: string,
    reason?: string,
    requestId?: string,
  ): Promise<{ revoked: number }> {
    return this.prisma.$transaction(async (tx) => {
      const grant = await tx.roleGrant.findUnique({ where: { id: grantId } });
      if (!grant || grant.revokedAt) throw new ApiError(ErrorCode.NOT_FOUND, 'Grant not found');
      const target = this.target(grant.resourceType, grant.resourceId);
      const allowed =
        grant.grantedById === actorId ||
        (await this.hasRootAuthority(actorId, target, grant.permission, tx));
      if (!allowed)
        throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');

      const now = this.clock.now();
      // Cascade to descendants with a recursive CTE.
      const ids = await tx.$queryRaw<{ id: string }[]>`
        WITH RECURSIVE tree AS (
          SELECT id FROM "RoleGrant" WHERE id = ${grantId}::uuid
          UNION ALL
          SELECT g.id FROM "RoleGrant" g JOIN tree t ON g."sourceGrantId" = t.id
        )
        SELECT id FROM tree`;
      const all = ids.map((r) => r.id);
      const res = await tx.roleGrant.updateMany({
        where: { id: { in: all }, revokedAt: null },
        data: { revokedAt: now, revokedById: actorId, revokedReason: reason ?? null },
      });
      await this.audit.record(tx, {
        actorId,
        action: 'grant.revoke',
        targetType: 'RoleGrant',
        targetId: grantId,
        requestId,
        metadata: { cascaded: res.count, reason },
      });
      return { revoked: res.count };
    });
  }

  async listForResource(
    actorId: string,
    resourceType: GrantResourceType,
    resourceId: string | null,
  ) {
    const target = this.target(resourceType, resourceId);
    let mayView = await this.hasRootAuthority(actorId, target, '', this.prisma);
    if (!mayView) {
      const mine = await this.policy.findValidGrant(
        actorId,
        resourceType,
        resourceType === 'PLATFORM' ? null : resourceId,
        Object.keys(PERMISSION_CATALOG),
      );
      mayView = mine.some((g) => g.canPassOn);
    }
    if (!mayView)
      throw new ApiError(ErrorCode.ACCESS_DENIED, 'You no longer have access to this action.');
    const now = this.clock.now();
    return this.prisma.roleGrant.findMany({
      where: {
        resourceType,
        resourceId: resourceType === 'PLATFORM' ? null : resourceId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async listMine(userId: string) {
    const now = this.clock.now();
    return this.prisma.roleGrant.findMany({
      where: {
        granteeId: userId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  // ── internals ──

  /** Structural authority that may create *root* grants for this permission. */
  private async hasRootAuthority(
    actorId: string,
    target: PolicyTarget,
    permission: string,
    tx: Tx,
  ): Promise<boolean> {
    if (target.type === 'PLATFORM' || target.type === 'VENUE') {
      // Only staff who manage staff / the catalogue create these roots.
      const needed = target.type === 'PLATFORM' ? 'admin.staff.manage' : 'admin.catalog.manage';
      return this.policy.can(actorId, needed, { type: 'PLATFORM' }, tx);
    }
    if (target.type === 'PITCH') {
      const pitch = await tx.pitch.findUnique({
        where: { id: target.id },
        select: { venueId: true },
      });
      if (!pitch) return false;
      return (
        (await this.policy.can(actorId, 'admin.catalog.manage', { type: 'PLATFORM' }, tx)) ||
        (await this.policy.can(actorId, 'pitch.manage', { type: 'PITCH', id: target.id }, tx))
      );
    }
    void permission;
    return this.policy.hasStructuralAuthority(actorId, target, tx);
  }

  private async findDelegationSource(tx: Tx, actorId: string, input: CreateGrantInput) {
    // Same-resource source
    const candidates: { resourceType: GrantResourceType; resourceId: string | null }[] = [
      {
        resourceType: input.resourceType,
        resourceId: input.resourceType === 'PLATFORM' ? null : input.resourceId,
      },
    ];
    // Event-scoped child of a club-level source
    if (input.resourceType === 'EVENT' && input.resourceId) {
      const ev = await tx.event.findUnique({
        where: { id: input.resourceId },
        select: { clubId: true },
      });
      if (ev?.clubId) candidates.push({ resourceType: 'CLUB', resourceId: ev.clubId });
    }
    for (const c of candidates) {
      const grants = await this.policy.findValidGrant(
        actorId,
        c.resourceType,
        c.resourceId,
        [input.permission],
        tx,
      );
      const usable = grants.find((g) => g.canPassOn);
      if (usable) return usable;
    }
    return null;
  }

  private async isAncestorGrantee(
    tx: Tx,
    sourceGrantId: string,
    granteeId: string,
  ): Promise<boolean> {
    let cursor: string | null = sourceGrantId;
    for (let depth = 0; cursor && depth < 32; depth++) {
      const g: { granteeId: string; sourceGrantId: string | null } | null =
        await tx.roleGrant.findUnique({
          where: { id: cursor },
          select: { granteeId: true, sourceGrantId: true },
        });
      if (!g) return false;
      if (g.granteeId === granteeId) return true;
      cursor = g.sourceGrantId;
    }
    return false;
  }

  private async assertAssistantLimit(tx: Tx, tournamentId: string, granteeId: string, now: Date) {
    const active = await tx.roleGrant.findMany({
      where: {
        resourceType: 'TOURNAMENT',
        resourceId: tournamentId,
        revokedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      select: { granteeId: true },
      distinct: ['granteeId'],
    });
    const ids = new Set(active.map((g) => g.granteeId));
    if (!ids.has(granteeId) && ids.size >= TOURNAMENT_ASSISTANT_LIMIT) {
      throw new ApiError(ErrorCode.CONFLICT, 'A tournament can have at most two assistants', {
        limit: TOURNAMENT_ASSISTANT_LIMIT,
      });
    }
  }
}
