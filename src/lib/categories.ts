import type { Category } from "@/types/database";

type CategoryNode = Pick<Category, "id" | "parent_id">;

/**
 * Returns all descendant category IDs of `rootId` (excluding `rootId`),
 * using a visited set so malformed data can never trigger an infinite loop.
 */
export function getCategoryDescendantIds(categories: CategoryNode[], rootId: string): Set<string> {
  const childrenByParent = new Map<string, string[]>();
  for (const cat of categories) {
    if (!cat.parent_id) continue;
    const list = childrenByParent.get(cat.parent_id) ?? [];
    list.push(cat.id);
    childrenByParent.set(cat.parent_id, list);
  }

  const descendants = new Set<string>();
  const visited = new Set<string>([rootId]);
  const queue: string[] = [...(childrenByParent.get(rootId) ?? [])];

  while (queue.length > 0) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    descendants.add(id);
    const children = childrenByParent.get(id);
    if (children) {
      queue.push(...children);
    }
  }

  return descendants;
}

/**
 * Returns `[rootId, ...descendants]` for hierarchical category filtering and rollups.
 */
export function getCategoryAndDescendantIds(categories: CategoryNode[], rootId: string): string[] {
  return [rootId, ...getCategoryDescendantIds(categories, rootId)];
}

export function isCategoryDescendant(
  categories: CategoryNode[],
  candidateId: string,
  ancestorId: string
): boolean {
  if (!candidateId || !ancestorId) return false;
  if (candidateId === ancestorId) return true;
  return getCategoryDescendantIds(categories, ancestorId).has(candidateId);
}
